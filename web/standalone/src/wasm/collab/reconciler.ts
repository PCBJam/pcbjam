import * as Y from "yjs";
import { clog } from "./debug";
import {
  type CollabBridge,
  type CollabDelta,
  type CollabItem,
  emptyDelta,
  isEmptyDelta,
} from "./types";

/**
 * The generic, schema-agnostic reconciler (features/yjs-bridge/0001 §4). It binds a
 * KiCad editor's bridge (snapshot/apply/onDelta) to a Y.Doc and keeps them in sync:
 *
 *   DOWN (model → Y):  bridge.onDelta → write changed items into the Y.Map, in a
 *                      transaction tagged with our local origin.
 *   UP   (Y → model):  observe the Y.Map; on remote-origin events, build a per-item
 *                      delta and call bridge.apply. Own-origin events are skipped
 *                      (standard Yjs echo-suppression).
 *
 * CRDT shape: a top-level Y.Map keyed by item uuid, each value a Y.Map of scalar
 * fields. (0001 names "Y.Array<Y.Map>"; a uuid-keyed Y.Map is the better fit for
 * id-stable items — O(1) by-id add/remove/change and no index-shift conflicts — and
 * the reconciler stays equally schema-agnostic.) Adding a C++ field needs zero JS
 * change here: fields are copied generically by name.
 */
export interface Reconciler {
  /**
   * Seed-once join (0001 §2). Reads the local model snapshot; if the shared doc is
   * empty this client seeds it, otherwise it adopts the shared doc into the local
   * model. Call once after the doc/provider are connected.
   */
  seed(): void;
  destroy(): void;
  /** The underlying items map (exposed for tests/inspection). */
  readonly items: Y.Map<Y.Map<unknown>>;
}

const ITEMS_KEY = "items";

function itemToYMap(item: CollabItem): Y.Map<unknown> {
  const ym = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(item)) {
    if (k === "id") continue; // id is the map key, not a field
    ym.set(k, v);
  }
  return ym;
}

/** Copy a delta item's fields into an existing/new Y.Map, writing only real changes. */
function upsertItem(items: Y.Map<Y.Map<unknown>>, item: CollabItem): void {
  let ym = items.get(item.id);
  if (!ym) {
    items.set(item.id, itemToYMap(item));
    return;
  }
  for (const [k, v] of Object.entries(item)) {
    if (k === "id") continue;
    if (ym.get(k) !== v) ym.set(k, v);
  }
}

function yMapToItem(id: string, ym: Y.Map<unknown>): CollabItem {
  const item: CollabItem = { id, type: String(ym.get("type") ?? "") };
  ym.forEach((v, k) => {
    item[k] = v;
  });
  item.id = id;
  return item;
}

function findId(
  items: Y.Map<Y.Map<unknown>>,
  target: Y.Map<unknown>,
): string | undefined {
  let found: string | undefined;
  items.forEach((ym, id) => {
    if (ym === target) found = id;
  });
  return found;
}

export function createReconciler(
  doc: Y.Doc,
  bridge: CollabBridge,
): Reconciler {
  const items = doc.getMap<Y.Map<unknown>>(ITEMS_KEY);
  // Opaque per-instance origin tag so we can distinguish our own writes from peers'.
  const ORIGIN = { local: true };

  // DOWN: local model change → Y.Doc
  bridge.onDelta((deltaJson: string) => {
    let delta: CollabDelta;
    try {
      delta = JSON.parse(deltaJson);
    } catch {
      clog("⬇ onDelta from wasm: UNPARSEABLE", deltaJson);
      return;
    }
    clog("⬇ onDelta from wasm (local edit):", {
      added: delta.added?.length ?? 0,
      changed: delta.changed?.length ?? 0,
      removed: delta.removed?.length ?? 0,
    });
    doc.transact(() => {
      for (const it of delta.added ?? []) upsertItem(items, it);
      for (const it of delta.changed ?? []) upsertItem(items, it);
      for (const id of delta.removed ?? []) items.delete(id);
    }, ORIGIN);
  });

  // UP: remote Y.Doc change → local model
  const observer = (events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === ORIGIN) {
      clog("⬆ Y change (own origin) - ignored");
      return; // our own echo — ignore
    }

    const delta = emptyDelta();
    const changedIds = new Set<string>();

    for (const ev of events) {
      if (ev.target === items) {
        // Top-level: items added / removed (or whole-entry replaced).
        (ev as Y.YMapEvent<Y.Map<unknown>>).changes.keys.forEach((change, id) => {
          if (change.action === "delete") {
            delta.removed.push(id);
          } else {
            const ym = items.get(id);
            if (ym) {
              if (change.action === "add") delta.added.push(yMapToItem(id, ym));
              else changedIds.add(id); // "update"
            }
          }
        });
      } else {
        // A child field map changed → that item changed.
        const ym = ev.target as Y.Map<unknown>;
        const id = findId(items, ym);
        if (id) changedIds.add(id);
      }
    }

    for (const id of changedIds) {
      const ym = items.get(id);
      if (ym) delta.changed.push(yMapToItem(id, ym));
    }

    if (!isEmptyDelta(delta)) {
      clog("⬆ remote Y change → apply to wasm:", {
        added: delta.added.length,
        changed: delta.changed.length,
        removed: delta.removed.length,
      });
      bridge.apply(JSON.stringify(delta));
    }
  };

  items.observeDeep(observer);

  function seed(): void {
    let snap: CollabDelta;
    try {
      snap = JSON.parse(bridge.snapshot());
    } catch {
      return;
    }

    clog(
      `seed: doc has ${items.size} item(s), local model has ${snap.added?.length ?? 0} →`,
      items.size === 0 ? "SEEDING doc (first tab)" : "ADOPTING doc (joining)",
    );

    if (items.size === 0) {
      // We're first: seed the shared doc from our local model. Our backfilled uuids win.
      doc.transact(() => {
        for (const it of snap.added) upsertItem(items, it);
      }, ORIGIN);
    } else {
      // Joining a populated doc: make the local model *match* it (seed-once authority).
      // We add/replace the doc's items and drop any local items not in the doc — this
      // resolves the never-saved-file cold-open race (0001 §2): a file with no uuids
      // gets random backfill, so our local uuids differ from the seeder's; adopting the
      // doc's identity (and removing our divergent copies) keeps both clients consistent.
      const docIds = new Set<string>();
      const added: CollabItem[] = [];
      items.forEach((ym, id) => {
        docIds.add(id);
        added.push(yMapToItem(id, ym));
      });
      const removed = (snap.added ?? [])
        .map((it) => it.id)
        .filter((id) => !docIds.has(id));
      bridge.apply(JSON.stringify({ added, changed: [], removed }));
    }
  }

  return {
    seed,
    destroy: () => items.unobserveDeep(observer),
    items,
  };
}
