import * as Y from "yjs";
import { clog } from "./debug";
import { classifyOwnerJobFailure } from "../owner-job";
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
  seed(): Promise<void>;
  destroy(): void;
  /** The underlying items map (exposed for tests/inspection). */
  readonly items: Y.Map<Y.Map<unknown>>;
}

const ITEMS_KEY = "items";
const MAX_IMMEDIATE_RECONCILIATION_PASSES = 32;
const MAX_CONSECUTIVE_PROJECTION_FAILURES = 8;

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
  let seeded = false;
  let destroyed = false;
  let generation = 1;
  let remoteVersion = 0;
  let projectedVersion = 0;
  let projectionDirty = false;
  // Retain at most one transaction-derived payload. If another Yjs
  // transaction arrives before native projection settles, discard that
  // payload and reconcile once from the authoritative Y.Doc.
  let pendingProjection:
    | { targetVersion: number; deltaJson: string | undefined }
    | undefined;
  let projectionScheduled = false;
  let projectionRunning = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 100;
  let projectionStopped = false;
  let projectionCircuitOpen = false;
  let consecutiveProjectionFailures = 0;
  let seedPromise: Promise<void> | undefined;
  const generationGuard = (captured = generation) =>
    () => !destroyed && generation === captured;

  const authorityDelta = (snap: CollabDelta): CollabDelta => {
    const docIds = new Set<string>();
    const added: CollabItem[] = [];
    items.forEach((ym, id) => {
      docIds.add(id);
      added.push(yMapToItem(id, ym));
    });
    const removed = (snap.added ?? [])
      .map((it) => it.id)
      .filter((id) => !docIds.has(id));
    return { added, changed: [], removed };
  };

  const reconcileProjection = async (isCurrent: () => boolean): Promise<void> => {
    for (let pass = 0; pass < MAX_IMMEDIATE_RECONCILIATION_PASSES && isCurrent(); pass++) {
      projectionDirty = false;
      const snap = JSON.parse(await bridge.snapshot(isCurrent)) as CollabDelta;
      if (!isCurrent()) return;
      const targetVersion = remoteVersion;
      await bridge.apply(JSON.stringify(authorityDelta(snap)), isCurrent);
      if (!isCurrent()) return;
      projectedVersion = targetVersion;
      if (!projectionDirty && projectedVersion === remoteVersion) return;
    }
    if (isCurrent()) {
      throw new Error(
        `collaborative projection did not settle after ${MAX_IMMEDIATE_RECONCILIATION_PASSES} passes`,
      );
    }
  };

  const scheduleProjectionDrain = (): void => {
    if (
      destroyed ||
      !seeded ||
      projectionScheduled ||
      projectionRunning ||
      retryTimer ||
      projectionStopped ||
      projectionCircuitOpen
    ) {
      return;
    }
    projectionScheduled = true;
    queueMicrotask(() => {
      projectionScheduled = false;
      void drainProjection();
    });
  };

  const requestAuthoritativeProjection = (): void => {
    if (projectionStopped) return;
    projectionDirty = true;
    pendingProjection = undefined;
    scheduleProjectionDrain();
  };

  const armRetry = (): void => {
    if (
      destroyed ||
      !seeded ||
      retryTimer ||
      projectionStopped ||
      projectionCircuitOpen
    ) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requestAuthoritativeProjection();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };

  const stopProjection = (kind: "stale" | "terminal", error: unknown): void => {
    projectionStopped = true;
    projectionDirty = false;
    pendingProjection = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    clog(`remote projection stopped after ${kind} owner failure`, error);
  };

  const handleProjectionFailure = (error: unknown): void => {
    const kind = classifyOwnerJobFailure(error);
    if (kind === "stale" || kind === "terminal") {
      stopProjection(kind, error);
      return;
    }

    if (kind === "backpressure") {
      clog("remote projection owner queue is full; scheduling bounded retry", error);
      armRetry();
      return;
    }

    consecutiveProjectionFailures++;
    if (consecutiveProjectionFailures >= MAX_CONSECUTIVE_PROJECTION_FAILURES) {
      projectionCircuitOpen = true;
      projectionDirty = false;
      pendingProjection = undefined;
      clog(
        `remote projection paused after ${consecutiveProjectionFailures} consecutive failures; ` +
          "a newer Yjs transaction will retry",
        error,
      );
      return;
    }
    clog("remote projection failed; scheduling authoritative reconciliation", error);
    armRetry();
  };

  async function drainProjection(): Promise<void> {
    if (
      destroyed ||
      !seeded ||
      projectionRunning ||
      retryTimer ||
      projectionStopped ||
      projectionCircuitOpen
    ) {
      return;
    }
    const isCurrent = generationGuard();
    projectionRunning = true;
    try {
      while (isCurrent() && (projectionDirty || pendingProjection)) {
        if (projectionDirty) {
          pendingProjection = undefined;
          await reconcileProjection(isCurrent);
          continue;
        }

        const next = pendingProjection!;
        pendingProjection = undefined;
        if (next.targetVersion !== projectedVersion + 1) {
          projectionDirty = true;
          continue;
        }
        if (next.deltaJson !== undefined) {
          try {
            await bridge.apply(next.deltaJson, isCurrent);
            if (!isCurrent()) return;
          } catch (err) {
            if (!isCurrent()) return;
            if (classifyOwnerJobFailure(err) !== "other") throw err;
            projectionDirty = true;
            clog("remote apply failed; reconciling from Y.Doc", err);
            continue;
          }
        }
        projectedVersion = next.targetVersion;
      }
      if (isCurrent()) {
        retryMs = 100;
        consecutiveProjectionFailures = 0;
      }
    } catch (err) {
      if (!isCurrent()) return;
      projectionDirty = true;
      pendingProjection = undefined;
      handleProjectionFailure(err);
    } finally {
      projectionRunning = false;
      if (
        isCurrent() &&
        !retryTimer &&
        !projectionStopped &&
        !projectionCircuitOpen &&
        (projectionDirty || pendingProjection)
      ) {
        scheduleProjectionDrain();
      }
    }
  }

  const requestIncrementalProjection = (
    targetVersion: number,
    deltaJson: string | undefined,
  ): void => {
    if (
      projectionDirty ||
      pendingProjection ||
      projectionRunning ||
      retryTimer
    ) {
      requestAuthoritativeProjection();
      return;
    }
    pendingProjection = { targetVersion, deltaJson };
    scheduleProjectionDrain();
  };

  // DOWN: local model change → Y.Doc
  bridge.onDelta((deltaJson: string) => {
    if (destroyed) return;
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
      clog("⬆ Y change (own origin) — ignored");
      return; // our own echo — ignore
    }
    const targetVersion = ++remoteVersion;
    if (projectionStopped) return;
    if (projectionCircuitOpen) {
      projectionCircuitOpen = false;
      consecutiveProjectionFailures = 0;
      retryMs = 100;
      // This transaction is also the wake edge for every state change which
      // failed before the circuit opened. Rebuild from full Y.Doc authority;
      // an incremental delta for only this event would lose the earlier ones.
      requestAuthoritativeProjection();
      return;
    }
    if (!seeded) {
      projectionDirty = true;
      return;
    }

    // Do not derive and retain another payload while one native projection is
    // pending. The current Y.Doc already contains every transaction needed for
    // one authoritative catch-up pass.
    if (
      projectionDirty ||
      pendingProjection ||
      projectionRunning ||
      retryTimer
    ) {
      requestAuthoritativeProjection();
      return;
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
      requestIncrementalProjection(targetVersion, JSON.stringify(delta));
    } else {
      requestIncrementalProjection(targetVersion, undefined);
    }
  };

  items.observeDeep(observer);

  async function performSeed(): Promise<void> {
    const isCurrent = generationGuard();
    const snap = JSON.parse(await bridge.snapshot(isCurrent)) as CollabDelta;
    if (!isCurrent()) return;

    clog(
      `seed: doc has ${items.size} item(s), local model has ${snap.added?.length ?? 0} →`,
      items.size === 0 ? "SEEDING doc (first tab)" : "ADOPTING doc (joining)",
    );

    if (items.size === 0) {
      // We're first: seed the shared doc from our local model. Our backfilled uuids win.
      doc.transact(() => {
        for (const it of snap.added) upsertItem(items, it);
      }, ORIGIN);
      projectedVersion = remoteVersion;
    } else {
      // Joining a populated doc: make the local model *match* it (seed-once authority).
      // We add/replace the doc's items and drop any local items not in the doc — this
      // resolves the never-saved-file cold-open race (0001 §2): a file with no uuids
      // gets random backfill, so our local uuids differ from the seeder's; adopting the
      // doc's identity (and removing our divergent copies) keeps both clients consistent.
      projectionDirty = false;
      const targetVersion = remoteVersion;
      await bridge.apply(JSON.stringify(authorityDelta(snap)), isCurrent);
      if (!isCurrent()) return;
      projectedVersion = targetVersion;
    }

    if (projectionDirty || projectedVersion !== remoteVersion) {
      await reconcileProjection(isCurrent);
    }
    if (isCurrent()) seeded = true;
  }

  function seed(): Promise<void> {
    return (seedPromise ??= performSeed());
  }

  return {
    seed,
    destroy: () => {
      destroyed = true;
      generation++;
      seeded = false;
      projectionStopped = true;
      projectionCircuitOpen = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      pendingProjection = undefined;
      projectionDirty = false;
      items.unobserveDeep(observer);
    },
    items,
  };
}
