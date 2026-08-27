import * as Y from "yjs";
import {
  applyDeltaToY,
  deltaFromYEvents,
  deltaToItemsWire,
  isEmptyItemsWireDelta,
  isEmptyKicadDelta,
  itemsWireToDelta,
  kicadItemsMap,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  seedDocToY,
  SEXPR_VERSION_SUPPORTED,
  upsertLibSymbolsToY,
  wireItemUuids,
  wireLibSymbols,
  Y_KDOC_META,
  Y_KDOC_REVERT_AT,
  Y_KDOC_REVERT_NONCE,
  Y_KDOC_REVERT_REASON,
  Y_KDOC_SEED_NONCE,
  ydocHasState,
  ydocIsHollow,
  ydocSexprVersion,
  yToItemUnchecked,
  type ItemsWireDelta,
  type KicadDoc,
  type KicadItem,
  type KicadYItems,
} from "@pcbjam/shared";
import { clog, cwarn } from "./debug";

/**
 * The Slot-model collab binding (ysync 0008 Stage B) — the THIN RUNTIME over the
 * shared, transport-unaware building blocks. This module owns exactly what
 * `@pcbjam/shared` must not: the `observeDeep` subscription, the local-origin
 * echo policy, and seed-once authority. Everything data-shaped — wire schemas,
 * wire⇄delta conversion, Y reads/writes — is the shared lib.
 *
 *   DOWN (editor → Y): bridge.onItems(json) → itemsWireToDelta(wire, Y items)
 *                      → applyDeltaToY (transaction tagged with our origin).
 *   UP   (Y → editor): items.observeDeep → skip own origin → deltaFromYEvents
 *                      → deltaToItemsWire (full subtree sexprs) → bridge.applyItems.
 *
 * The bridge speaks the v2 "items" wire: per-item s-expr + parent uuid — the C++
 * exports kicadCollabSnapshotItems / kicadCollabApplyItems / onItems (Stage C).
 * Until those land in the wasm, the binding is exercised by unit tests with a
 * fake editor bridge (kicad-binding.test.ts).
 */

/**
 * Window event fired when the backend rolled this doc back to its last valid
 * state (kicad-validity 0001 B3). detail: { reason?: string; at?: string }.
 */
export const DOC_REVERTED_EVENT = "pcbjam:doc-reverted";

/** The v2 per-item s-expr bridge (Stage C C++ contract), runtime-adapted. */
export interface KicadItemsBridge {
  /** Full current model as an all-`added` ItemsWireDelta JSON. */
  snapshotItems(): string;
  /** Apply a remote ItemsWireDelta JSON (per-item Parse + splice by uuid). */
  applyItems(json: string): void;
  /** Register the local-edit emit hook (Format changed items → JSON). */
  onItems(cb: (json: string) => void): void;
}

export interface KicadBinding {
  /**
   * Seed-once join: if the shared doc holds no items this client seeds it —
   * from `seedDoc` (the FULL `KicadDoc` parsed from the opened file via
   * `fileToDoc`; writes meta + layout + items so `docToFile` can regenerate the
   * file from the Y.Doc alone — ysync 0005/0007) when given, else from the
   * editor snapshot (items only). Otherwise the editor adopts the doc (doc
   * authority — local-only roots are removed, doc roots applied). Call once
   * after the doc/provider are connected.
   *
   * `editorMatchesDoc`: the editor's open file WAS materialized from this doc
   * (docToFile — the Y.Doc-load path), so the adopt re-apply would be a no-op
   * full-document blob apply; skip it and just baseline the wasm differ.
   */
  seed(seedDoc?: KicadDoc, opts?: { editorMatchesDoc?: boolean }): void;
  destroy(): void;
  /** The underlying kdoc items map (exposed for tests/inspection). */
  readonly items: KicadYItems;
}

/**
 * The doc uses an s-expr encoding this build cannot write (ysync 0009 §5's
 * client skew guard). Binding anyway would mix versions in one doc — a v1
 * writer against a v2 doc corrupts the granularity contract — so the bind is
 * REFUSED; the app surfaces this as "update required".
 */
export class SexprVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `update required: document uses s-expr encoding v${version}; ` +
        `this build supports v${SEXPR_VERSION_SUPPORTED.join(", v")}`,
    );
    this.name = "SexprVersionError";
  }
}

export function bindKicadCollab(
  doc: Y.Doc,
  bridge: KicadItemsBridge,
  opts?: {
    /**
     * Read-only viewer (read-only-viewer): the binding never writes the Y.Doc —
     * the DOWN hook is inert (zero local-edit pushes even if a wasm gate were
     * bypassed) and seed() skips both seeding branches (a viewer must never
     * author a room). The UP observer and the adopt branch stay live, so
     * remote edits keep rendering. The sync server enforces the same thing
     * server-side; this keeps the client honest and quiet.
     */
    readOnly?: boolean;
  },
): KicadBinding {
  const readOnly = opts?.readOnly === true;
  // Version skew guard — callers bind AFTER the provider's initial sync, so the
  // doc's version is authoritative here (an empty room reads as v1 and is
  // stamped CURRENT by the first write). A read-only viewer never writes, but
  // it must not adopt a doc it can't correctly render either, so still guard.
  const version = ydocSexprVersion(doc);
  if (!SEXPR_VERSION_SUPPORTED.includes(version)) throw new SexprVersionError(version);
  const items = kicadItemsMap(doc);
  // Opaque per-instance origin tag so we can distinguish our own writes from peers'.
  const ORIGIN = { local: true };
  // Remote events arriving BEFORE seed() (e.g. the provider's initial state sync)
  // must not stream into the editor item-by-item: the editor already holds the
  // opened file, so that would be a redundant full-document blob apply (observed
  // to trap eeschema's paste path in the real app). seed()'s adopt branch covers
  // everything those early events contained.
  let seeded = false;
  // Flipped by destroy(): the DOWN hook (window.kicadCollab.onItems) can't be
  // unregistered from the C++ side, so a stale emit after destroy — e.g. in the
  // sheet-switch gap, when C++ has already rebaselined to the NEW sheet — must
  // be dropped here or it writes the new sheet's items into the OLD room (bug 07).
  let destroyed = false;
  // Concurrent double-seed arbitration cleanup (bug 06); set by the file-seed branch.
  let detachSeedArbitration: (() => void) | undefined;

  /**
   * Plain snapshot of the Y items (the `current`/`view` the conversions need).
   * Unchecked reads (opt 12): this runs on every local emit AND every remote
   * batch; the zod walk of each body tree dominated at scale. The wire parse
   * zod-validates at the trust boundary; seed/materialize keep checked reads.
   */
  const itemsView = (): Record<string, KicadItem> => {
    const view: Record<string, KicadItem> = {};
    items.forEach((ym, uuid) => {
      view[uuid] = yToItemUnchecked(ym);
    });
    return view;
  };

  /** kdoc_libsymbols reader for the apply direction (miss 08). */
  const libDefs = (libId: string): string | undefined =>
    kicadLibSymbolsMap(doc).get(libId);

  // A wire entry the conversion could not resolve to an item (typically the
  // sender serializing an unlifted child → item-less board envelope). The
  // conversion skips it so the rest of the batch survives; log it loudly —
  // this line is also the breadcrumb for the still-open question of how a
  // child reaches the sender's serializer unlifted.
  const warnSkip = (w: { sexpr: string }, err: unknown): void =>
    cwarn("wire entry skipped (un-resolvable):", err, w.sexpr.slice(0, 200));

  // DOWN: local editor change → Y.Doc
  bridge.onItems((json: string) => {
    if (readOnly) return; // viewer: local state never reaches the doc
    if (destroyed) return; // stale hook (bug 07) — a destroyed binding is inert
    let wire: ItemsWireDelta;
    try {
      wire = parseItemsWireDelta(json);
    } catch (err) {
      cwarn("⬇ onItems from wasm: UNPARSEABLE", err, json);
      return;
    }
    // This handler runs synchronously inside the C++ emit; a throw escaping it
    // unwinds through embind as a bare pageerror AND discards the whole batch
    // after the sender already rebaselined (the batch-loss bug). Entry-level
    // failures are already skipped inside the conversion; this catch is the
    // backstop for everything else.
    try {
      const delta = itemsWireToDelta(wire, itemsView(), warnSkip);
      // Library definitions the blob carried (a placed symbol's lib_symbols
      // context — miss 08): store them alongside the items, same transaction.
      const defs = wireLibSymbols(wire);
      if (isEmptyKicadDelta(delta) && Object.keys(defs).length === 0) return;
      clog("⬇ onItems (local edit):", {
        added: delta.added.length,
        updated: delta.updated.length,
        removed: delta.removed.length,
      });
      doc.transact(() => {
        applyDeltaToY(doc, delta, ORIGIN);
        upsertLibSymbolsToY(doc, defs, ORIGIN);
      }, ORIGIN);
    } catch (err) {
      cwarn("⬇ onItems from wasm: batch failed to apply", err);
    }
  });

  // UP: remote Y change → editor. The subscription + origin policy live HERE
  // (the runtime); the event→delta computation is the shared default impl.
  const observer = (events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === ORIGIN) return; // our own echo — ignore
    if (!seeded) return; // pre-seed state sync — seed()'s adopt covers it
    const delta = deltaFromYEvents(items, events);
    if (isEmptyKicadDelta(delta)) return;
    const wire = deltaToItemsWire(delta, itemsView(), libDefs);
    if (isEmptyItemsWireDelta(wire)) return;
    clog("⬆ remote Y change → apply to editor:", {
      added: wire.added.length,
      changed: wire.changed.length,
      removed: wire.removed.length,
    });
    try {
      bridge.applyItems(JSON.stringify(wire));
    } catch (err) {
      // Symmetric with the DOWN hook's backstop above (findings C-7): a throw
      // here would otherwise unwind through Yjs's transaction cleanup inside
      // the provider's applyUpdate. Log, then re-surface on a clean stack so
      // the global terminal-error classifier (WasmTool promote) still sees a
      // wasm death — without corrupting the doc's observer bookkeeping.
      cwarn("⬆ remote Y change: apply to editor failed", err);
      const report =
        (globalThis as { reportError?: (e: unknown) => void }).reportError ??
        ((e: unknown) =>
          setTimeout(() => {
            throw e;
          }, 0));
      report(err);
    }
  };
  items.observeDeep(observer);

  // Validity-revert notice (kicad-validity 0001 B3): the backend stamps
  // kdoc_meta.revertNonce when it rolls the doc back to the last valid state
  // (the content itself arrives through the normal item sync above). Watched
  // like seedNonce; surfaced as a window event for the shell's toast. The
  // nonce is deduped so a reconnect replaying the same marker stays silent.
  const revMeta = doc.getMap(Y_KDOC_META);
  let lastRevertNonce = revMeta.get(Y_KDOC_REVERT_NONCE);
  const onRevertMeta = () => {
    const nonce = revMeta.get(Y_KDOC_REVERT_NONCE);
    if (nonce === undefined || nonce === lastRevertNonce) return;
    lastRevertNonce = nonce;
    clog("doc reverted by backend:", revMeta.get(Y_KDOC_REVERT_REASON));
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(DOC_REVERTED_EVENT, {
          detail: {
            reason: revMeta.get(Y_KDOC_REVERT_REASON),
            at: revMeta.get(Y_KDOC_REVERT_AT),
          },
        }),
      );
    }
  };
  revMeta.observe(onRevertMeta);

  function seed(seedDoc?: KicadDoc, opts?: { editorMatchesDoc?: boolean }): void {
    seeded = true; // open the UP gate; everything below runs synchronously
    // `ydocHasState` (meta + layout + items), NOT `items.size`: a populated
    // drawing sheet (pl_editor .kicad_wks) has zero uuid items, so an items-only
    // check would mis-classify a seeded room as empty and re-seed/clobber it.
    // A HOLLOW doc (layout/meta, zero items, never seeded — a save-all's
    // layout sync into a room nobody had entered) counts as empty here:
    // adopting it would remove every item on the sheet the editor just
    // showed (the "subsheet renders then goes blank" bug), and a file
    // materialized from it is title-block-only.
    const hollow = ydocIsHollow(doc);
    if (hollow) clog("seed: doc is HOLLOW (layout only, never seeded) → treating as empty");
    if (opts?.editorMatchesDoc && ydocHasState(doc) && !hollow) {
      // The editor opened exactly this doc's content (Y.Doc-load path): no
      // adopt apply needed. snapshotItems() still runs to BASELINE the wasm
      // differ — otherwise the first local edit would re-emit the full model.
      clog(`seed: editor matches doc (${items.size} item(s)) → baseline only, no apply`);
      try {
        bridge.snapshotItems();
      } catch (err) {
        cwarn("seed: snapshotItems baseline failed", err);
      }
      return;
    }
    if ((!ydocHasState(doc) || hollow) && seedDoc) {
      if (readOnly) {
        // A viewer never authors a room. The editor keeps showing the file it
        // opened; when a writer later seeds this room, the (now-open) UP
        // observer streams their state in.
        clog("seed: read-only viewer on an empty room — not seeding");
        return;
      }
      // First tab, file-seeded: write the FULL doc (meta + layout + items) so
      // the Y.Doc — not the editor snapshot — is the lossless source of truth
      // (the file is recoverable via docToFile). The editor already opened the
      // same file, so no applyItems is needed.
      clog(
        `seed: doc empty → SEEDING from file (${Object.keys(seedDoc.items).length} item(s), root ${seedDoc.root})`,
      );
      // Arbitrated seed (bug 06): the empty-room check above is check-then-act,
      // so a peer may be seeding concurrently. seedDocToY stamps our nonce; if a
      // FOREIGN nonce wins the meta LWW merge, our layout inserts are retracted
      // (kdoc_items converges per key on its own) leaving the winner's single
      // clean sequence.
      const nonce = `${doc.clientID}:${Math.random().toString(36).slice(2)}`;
      const retract = seedDocToY(seedDoc, doc, ORIGIN, nonce);
      const meta = doc.getMap(Y_KDOC_META);
      const onMeta = () => {
        const winner = meta.get(Y_KDOC_SEED_NONCE);
        if (winner !== undefined && winner !== nonce) {
          detachSeedArbitration?.();
          detachSeedArbitration = undefined;
          retract();
          clog("seed: concurrent double-seed lost LWW — retracted our layout inserts");
        }
      };
      meta.observe(onMeta);
      detachSeedArbitration = () => meta.unobserve(onMeta);
      // snapshotItems() does double duty here. Its side effects register the
      // C++ change listener (bug 01 — without it this tab would receive but
      // never SEND) and rebaseline the wasm differ. Its RESULT re-upserts the
      // item bodies in the EDITOR's serialization: the file's formatting and
      // the writer's normalized output can differ textually, and every future
      // emit/drift-compare uses the writer's form — keeping file-formatted
      // bodies would false-positive drift-detect on every file-seeded room
      // and defeat upsertYItem's no-op skip. Meta + layout stay file-derived.
      try {
        const wire = parseItemsWireDelta(bridge.snapshotItems());
        const local = itemsWireToDelta(wire, itemsView(), warnSkip);
        if (!isEmptyKicadDelta(local)) applyDeltaToY(doc, local, ORIGIN);
      } catch (err) {
        cwarn("seed: post-file-seed baseline failed", err);
      }
      return;
    }

    let wire: ItemsWireDelta;
    try {
      wire = parseItemsWireDelta(bridge.snapshotItems());
    } catch (err) {
      cwarn("seed: snapshotItems unparseable", err);
      return;
    }

    const hasState = ydocHasState(doc) && !hollow;

    if (!hasState) {
      if (readOnly) {
        clog("seed: read-only viewer on an empty room — not snapshot-seeding");
        return;
      }
      // First tab, no file source: seed the shared doc from the editor model.
      const local = itemsWireToDelta(wire, {}, warnSkip);
      clog(`seed: doc empty → SEEDING from editor snapshot (${local.added.length} item(s))`);
      doc.transact(() => {
        applyDeltaToY(doc, local, ORIGIN);
        upsertLibSymbolsToY(doc, wireLibSymbols(wire), ORIGIN);
        // Stamp the seed marker like the file path does: a seeded-then-emptied
        // sheet must stay distinguishable from a hollow one (ydocIsHollow).
        doc.getMap(Y_KDOC_META).set(
          Y_KDOC_SEED_NONCE,
          `${doc.clientID}:${Math.random().toString(36).slice(2)}`,
        );
      }, ORIGIN);
      return;
    }

    // Joining a populated doc: the editor adopts it (seed-once authority, same
    // rationale as the scalar reconciler §2 — divergent local uuids from a
    // never-saved cold open must yield to the doc's identity). Diff the editor
    // snapshot against the doc VIEW and apply only the DIFFERENCE (opt 13):
    // identical items cost nothing, the apply commit (and its undo entry — the
    // adopt undo-bomb, miss 09) shrinks to the real changed set, and a clean
    // rebind degrades to baseline-only.
    const view = itemsView();
    const editorDelta = itemsWireToDelta(wire, view, warnSkip); // editor state vs doc view
    const editorUuids = wireItemUuids(wire, warnSkip);

    // Doc authority, inverted per class:
    //  - doc-only ROOTS → add to the editor (their sexprs embed descendants;
    //    a doc-only CHILD makes its shared parent's body differ → covered below);
    //  - items that DIFFER → re-apply the doc's version, lifted to their root
    //    (the C++ upsert replaces roots; a bare child apply would mis-parent);
    //  - editor-only ROOTS → remove (editor-only children disappear with their
    //    parent's re-apply).
    const liftToRoot = (uuid: string): string => {
      let cur = uuid;
      while (view[cur]?.parent != null) cur = view[cur]!.parent!;
      return cur;
    };
    const docOnly = Object.entries(view)
      .filter(([uuid, it]) => it.parent === null && !editorUuids.has(uuid))
      .map(([uuid, it]) => ({ uuid, ...it }));
    const changedRoots = [
      ...new Set(
        editorDelta.updated.filter((it) => it.uuid in view).map((it) => liftToRoot(it.uuid)),
      ),
    ]
      .filter((uuid) => !docOnly.some((it) => it.uuid === uuid))
      .map((uuid) => ({ uuid, ...view[uuid]! }));
    const removed = editorDelta.added
      .filter((it) => it.parent === null && !(it.uuid in view))
      .map((it) => it.uuid);

    const adoptWire = deltaToItemsWire(
      { added: docOnly, updated: changedRoots, removed },
      view,
      libDefs,
    );

    clog(
      `seed: doc has ${items.size} item(s) → ADOPTING diff:`,
      `+${adoptWire.added.length} ~${adoptWire.changed.length} -${adoptWire.removed.length}`,
    );
    if (isEmptyItemsWireDelta(adoptWire)) return; // editor already matches — baseline only
    bridge.applyItems(JSON.stringify(adoptWire));
  }

  return {
    seed,
    destroy: () => {
      destroyed = true; // gates the DOWN hook — see bug 07 note above
      detachSeedArbitration?.();
      detachSeedArbitration = undefined;
      items.unobserveDeep(observer);
      revMeta.unobserve(onRevertMeta);
    },
    items,
  };
}

// ── Live wasm adapter ─────────────────────────────────────────────────────────

/** The Stage C Module exports + window hook, as the browser exposes them. */
export interface KicadItemsModule {
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(json: string): void;
}

export interface KicadItemsWindow {
  kicadCollab?: { onItems?: (json: string) => void };
}

/** Adapt a live wasm Module + window to the bridge interface. */
export function moduleItemsBridge(
  mod: KicadItemsModule,
  win: KicadItemsWindow,
): KicadItemsBridge {
  return {
    snapshotItems: () => mod.kicadCollabSnapshotItems(),
    applyItems: (json) => mod.kicadCollabApplyItems(json),
    onItems: (cb) => {
      // Preserve any sibling hooks (e.g. the legacy onDelta) on the global.
      win.kicadCollab = { ...win.kicadCollab, onItems: cb };
    },
  };
}
