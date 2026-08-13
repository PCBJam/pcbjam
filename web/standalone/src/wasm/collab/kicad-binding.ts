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
  ydocSexprVersion,
  yToItemUnchecked,
  type ItemsWireDelta,
  type KicadDoc,
  type KicadItem,
  type KicadYItems,
} from "@pcbjam/shared";
import { clog, cwarn } from "./debug";
import { classifyOwnerJobFailure } from "../owner-job";

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

// Do not let a permanently busy room keep one projection promise alive
// forever. A live failure enters the bounded retry lane below. A seed failure
// propagates so its owner can tear the binding down and retry cleanly.
const MAX_IMMEDIATE_RECONCILIATION_PASSES = 32;
const MAX_CONSECUTIVE_PROJECTION_FAILURES = 8;

/** The v2 per-item s-expr bridge (Stage C C++ contract), runtime-adapted. */
export interface KicadItemsBridge {
  /** Full current model as an all-`added` ItemsWireDelta JSON. */
  snapshotItems(isCurrent?: () => boolean): string | Promise<string>;
  /** Apply a remote ItemsWireDelta JSON (per-item Parse + splice by uuid). */
  applyItems(json: string, isCurrent?: () => boolean): void | Promise<void>;
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
  seed(seedDoc?: KicadDoc, opts?: { editorMatchesDoc?: boolean }): Promise<void>;
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
  let bindingGeneration = 1;
  // Yjs transactions are atomic, but their projection into the editor can wait
  // in the native owner gateway. Track that asynchronous projection separately
  // so a failed or overtaken delta is repaired from the authoritative Y.Doc.
  let remoteVersion = 0;
  let projectedVersion = 0;
  let projectionDirty = false;
  // Keep at most one derived transaction while native code is available. If a
  // second transaction arrives before that projection finishes, discard the
  // derived payload and reconcile once from the authoritative Y.Doc. This is a
  // level signal: a parked native owner cannot create an unbounded closure and
  // serialized-wire backlog.
  let pendingProjection:
    | { targetVersion: number; wireJson: string | undefined }
    | undefined;
  let projectionScheduled = false;
  let projectionRunning = false;
  let projectionRetry: ReturnType<typeof setTimeout> | undefined;
  let projectionRetryMs = 100;
  let projectionStopped = false;
  let projectionCircuitOpen = false;
  let consecutiveProjectionFailures = 0;
  let seedPromise: Promise<void> | undefined;
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

  const generationGuard = (generation = bindingGeneration) =>
    () => !destroyed && bindingGeneration === generation;

  const buildAdoptWire = (
    editorWire: ItemsWireDelta,
    view: Record<string, KicadItem>,
  ): ItemsWireDelta => {
    const editorDelta = itemsWireToDelta(editorWire, view, warnSkip);
    const editorUuids = wireItemUuids(editorWire, warnSkip);
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
        editorDelta.updated
          .filter((it) => it.uuid in view)
          .map((it) => liftToRoot(it.uuid)),
      ),
    ]
      .filter((uuid) => !docOnly.some((it) => it.uuid === uuid))
      .map((uuid) => ({ uuid, ...view[uuid]! }));
    const removed = editorDelta.added
      .filter((it) => it.parent === null && !(it.uuid in view))
      .map((it) => it.uuid);
    return deltaToItemsWire(
      { added: docOnly, updated: changedRoots, removed },
      view,
      libDefs,
    );
  };

  const applyDocAuthority = async (
    editorWire: ItemsWireDelta,
    isCurrent: () => boolean,
  ): Promise<void> => {
    if (!isCurrent()) return;
    projectionDirty = false;
    const view = itemsView();
    const targetVersion = remoteVersion;
    const adoptWire = buildAdoptWire(editorWire, view);
    clog(
      `seed: doc has ${items.size} item(s) → ADOPTING diff:`,
      `+${adoptWire.added.length} ~${adoptWire.changed.length} -${adoptWire.removed.length}`,
    );
    if (!isEmptyItemsWireDelta(adoptWire)) {
      await bridge.applyItems(JSON.stringify(adoptWire), isCurrent);
    }
    if (isCurrent()) projectedVersion = targetVersion;
  };

  const reconcileProjection = async (isCurrent: () => boolean): Promise<void> => {
    for (let pass = 0; pass < MAX_IMMEDIATE_RECONCILIATION_PASSES && isCurrent(); pass++) {
      projectionDirty = false;
      const wire = parseItemsWireDelta(await bridge.snapshotItems(isCurrent));
      if (!isCurrent()) return;
      await applyDocAuthority(wire, isCurrent);
      if (
        isCurrent() &&
        !projectionDirty &&
        projectedVersion === remoteVersion
      ) {
        return;
      }
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
      projectionRetry ||
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

  const armProjectionRetry = (): void => {
    if (
      destroyed ||
      !seeded ||
      projectionRetry ||
      projectionStopped ||
      projectionCircuitOpen
    ) {
      return;
    }
    projectionRetry = setTimeout(() => {
      projectionRetry = undefined;
      requestAuthoritativeProjection();
    }, projectionRetryMs);
    projectionRetryMs = Math.min(projectionRetryMs * 2, 5000);
  };

  const stopProjection = (kind: "stale" | "terminal", error: unknown): void => {
    projectionStopped = true;
    projectionDirty = false;
    pendingProjection = undefined;
    if (projectionRetry) clearTimeout(projectionRetry);
    projectionRetry = undefined;
    cwarn(`remote projection stopped after ${kind} owner failure`, error);
  };

  const handleProjectionFailure = (error: unknown): void => {
    const kind = classifyOwnerJobFailure(error);
    if (kind === "stale" || kind === "terminal") {
      stopProjection(kind, error);
      return;
    }

    if (kind === "backpressure") {
      cwarn("remote projection owner queue is full; scheduling bounded retry", error);
      armProjectionRetry();
      return;
    }

    consecutiveProjectionFailures++;
    if (consecutiveProjectionFailures >= MAX_CONSECUTIVE_PROJECTION_FAILURES) {
      projectionCircuitOpen = true;
      projectionDirty = false;
      pendingProjection = undefined;
      cwarn(
        `remote projection paused after ${consecutiveProjectionFailures} consecutive failures; ` +
          "a newer Yjs transaction will retry",
        error,
      );
      return;
    }
    cwarn("remote projection failed; scheduling authoritative reconciliation", error);
    armProjectionRetry();
  };

  async function drainProjection(): Promise<void> {
    if (
      destroyed ||
      !seeded ||
      projectionRunning ||
      projectionRetry ||
      projectionStopped ||
      projectionCircuitOpen
    ) {
      return;
    }
    const generation = bindingGeneration;
    const isCurrent = generationGuard(generation);
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
        if (next.wireJson !== undefined) {
          try {
            await bridge.applyItems(next.wireJson, isCurrent);
            if (!isCurrent()) return;
          } catch (err) {
            if (!isCurrent()) return;
            if (classifyOwnerJobFailure(err) !== "other") throw err;
            projectionDirty = true;
            cwarn("remote applyItems failed; reconciling from Y.Doc", err);
            continue;
          }
        }
        projectedVersion = next.targetVersion;
      }
      if (isCurrent()) {
        projectionRetryMs = 100;
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
        !projectionRetry &&
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
    wireJson: string | undefined,
  ): void => {
    // Anything already waiting or running means the payload was derived from a
    // view that can be overtaken. Keep no second payload; one authoritative
    // reconciliation covers every transaction represented by remoteVersion.
    if (
      projectionDirty ||
      pendingProjection ||
      projectionRunning ||
      projectionRetry
    ) {
      requestAuthoritativeProjection();
      return;
    }
    pendingProjection = { targetVersion, wireJson };
    scheduleProjectionDrain();
  };

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
    const targetVersion = ++remoteVersion;
    if (projectionStopped) return;
    if (projectionCircuitOpen) {
      projectionCircuitOpen = false;
      consecutiveProjectionFailures = 0;
      projectionRetryMs = 100;
      // Cover both this transaction and every state change missed before the
      // circuit opened. A delta derived only from this event is insufficient.
      requestAuthoritativeProjection();
      return;
    }
    if (!seeded) {
      projectionDirty = true;
      return; // seed() reconciles every transaction that arrived behind its barrier
    }
    // Once native projection has started, the Y.Doc is the only payload we
    // retain. Later transactions only raise the same level signal. Do this
    // check before deriving a delta or serializing item bodies.
    if (
      projectionDirty ||
      pendingProjection ||
      projectionRunning ||
      projectionRetry
    ) {
      requestAuthoritativeProjection();
      return;
    }
    const delta = deltaFromYEvents(items, events);
    if (isEmptyKicadDelta(delta)) {
      requestIncrementalProjection(targetVersion, undefined);
      return;
    }
    const wire = deltaToItemsWire(delta, itemsView(), libDefs);
    if (isEmptyItemsWireDelta(wire)) {
      requestIncrementalProjection(targetVersion, undefined);
      return;
    }
    clog("⬆ remote Y change → apply to editor:", {
      added: wire.added.length,
      changed: wire.changed.length,
      removed: wire.removed.length,
    });
    requestIncrementalProjection(targetVersion, JSON.stringify(wire));
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

  async function performSeed(
    seedDoc?: KicadDoc,
    opts?: { editorMatchesDoc?: boolean },
  ): Promise<void> {
    const isCurrent = generationGuard();
    const versionAtStart = remoteVersion;
    // `ydocHasState` (meta + layout + items), NOT `items.size`: a populated
    // drawing sheet (pl_editor .kicad_wks) has zero uuid items, so an items-only
    // check would mis-classify a seeded room as empty and re-seed/clobber it.
    if (opts?.editorMatchesDoc && ydocHasState(doc)) {
      // The editor opened exactly this doc's content (Y.Doc-load path): no
      // adopt apply needed. snapshotItems() still runs to BASELINE the wasm
      // differ — otherwise the first local edit would re-emit the full model.
      clog(`seed: editor matches doc (${items.size} item(s)) → baseline only, no apply`);
      await bridge.snapshotItems(isCurrent);
      projectedVersion = versionAtStart;
    } else if (!ydocHasState(doc) && seedDoc) {
      if (readOnly) {
        // A viewer never authors a room. The editor keeps showing the file it
        // opened; when a writer later seeds this room, the UP observer streams
        // their state in after this initial barrier opens.
        clog("seed: read-only viewer on an empty room — not seeding");
        projectedVersion = remoteVersion;
      } else {
        // First tab, file-seeded: write the FULL doc (meta + layout + items) so
        // the Y.Doc — not the editor snapshot — is the lossless source of truth.
        clog(
          `seed: doc empty → SEEDING from file (${Object.keys(seedDoc.items).length} item(s), root ${seedDoc.root})`,
        );
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
        const wire = parseItemsWireDelta(await bridge.snapshotItems(isCurrent));
        if (!isCurrent()) return;
        const local = itemsWireToDelta(wire, itemsView(), warnSkip);
        if (!isEmptyKicadDelta(local)) applyDeltaToY(doc, local, ORIGIN);
        projectedVersion = versionAtStart;
      }
    } else {
      const wire = parseItemsWireDelta(await bridge.snapshotItems(isCurrent));
      if (!isCurrent()) return;
      const hasState = ydocHasState(doc);
      if (!hasState) {
        if (readOnly) {
          clog("seed: read-only viewer on an empty room — not snapshot-seeding");
        } else {
          const local = itemsWireToDelta(wire, {}, warnSkip);
          clog(`seed: doc empty → SEEDING from editor snapshot (${local.added.length} item(s))`);
          doc.transact(() => {
            applyDeltaToY(doc, local, ORIGIN);
            upsertLibSymbolsToY(doc, wireLibSymbols(wire), ORIGIN);
          }, ORIGIN);
        }
        projectedVersion = remoteVersion;
      } else {
        await applyDocAuthority(wire, isCurrent);
      }
    }

    if (!isCurrent()) return;
    if (projectionDirty || projectedVersion !== remoteVersion) {
      await reconcileProjection(isCurrent);
    }
    if (isCurrent()) seeded = true;
  }

  function seed(
    seedDoc?: KicadDoc,
    opts?: { editorMatchesDoc?: boolean },
  ): Promise<void> {
    return (seedPromise ??= performSeed(seedDoc, opts));
  }

  return {
    seed,
    destroy: () => {
      destroyed = true; // gates the DOWN hook — see bug 07 note above
      bindingGeneration++;
      seeded = false;
      projectionStopped = true;
      projectionCircuitOpen = false;
      if (projectionRetry) clearTimeout(projectionRetry);
      projectionRetry = undefined;
      pendingProjection = undefined;
      projectionDirty = false;
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
  kicadCollabSnapshotItems(): Promise<string>;
  kicadCollabApplyItems(json: string): Promise<void>;
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
    snapshotItems: (isCurrent) =>
      guardedModuleCall<string>(
        mod.kicadCollabSnapshotItems,
        [],
        isCurrent,
        () => mod.kicadCollabSnapshotItems(),
      ),
    applyItems: (json, isCurrent) =>
      guardedModuleCall<void>(
        mod.kicadCollabApplyItems,
        [json],
        isCurrent,
        () => mod.kicadCollabApplyItems(json),
      ),
    onItems: (cb) => {
      // Preserve any sibling hooks (e.g. the legacy onDelta) on the global.
      win.kicadCollab = { ...win.kicadCollab, onItems: cb };
    },
  };
}

type GuardedModuleFunction = Function & {
  __wxGuardedCall?: (args: unknown[], isCurrent: () => boolean) => Promise<unknown>;
};

/**
 * Scheduler builds expose a guarded-call hook on wrapped stateful exports. It
 * checks the resource generation immediately before native delivery. Legacy
 * builds execute these exports synchronously, so an admission-time check is
 * sufficient there.
 */
function guardedModuleCall<T>(
  fn: Function,
  args: unknown[],
  isCurrent: (() => boolean) | undefined,
  direct: () => T | Promise<T>,
): T | Promise<T> {
  if (!isCurrent) return direct();
  if (!isCurrent()) {
    return Promise.reject(new Error("stale collaborative projection"));
  }
  const guarded = (fn as GuardedModuleFunction).__wxGuardedCall;
  if (guarded) return guarded(args, isCurrent) as Promise<T>;
  return direct();
}
