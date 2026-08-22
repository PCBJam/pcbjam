import * as Y from "yjs";
import {
  applyDeltaToY,
  canonicalizeKicadDocGraph,
  docDelta,
  deltaToItemsWire,
  isEmptyItemsWireDelta,
  isEmptyKicadDelta,
  itemsWireToDelta,
  kicadItemsMap,
  kicadLibSymbolsMap,
  kicadMetaMap,
  parseItemsWireDelta,
  rebaseKicadItems,
  seedDocToY,
  SEXPR_VERSION_SUPPORTED,
  upsertLibSymbolsToY,
  wireLibSymbols,
  Y_KDOC_REVERT_AT,
  Y_KDOC_REVERT_NONCE,
  Y_KDOC_REVERT_REASON,
  Y_KDOC_STATE,
  ydocHasState,
  ydocSexprVersion,
  yToDoc,
  yToItem,
  type ItemsWireDelta,
  type KicadDoc,
  type KicadItem,
  type KicadYItems,
  type Slot,
} from "@pcbjam/shared";
import { clog, cwarn } from "./debug";
import {
  decideNativeEmission,
  decideProjectionAck,
} from "./generated/projection-kernel.js";
import {
  createNativeItemsBridge,
  NativeItemsApplyError,
  type NativeItemsProtocolModule,
  type NativeItemsProtocolWindow,
} from "./native-items-bridge";
import { nonItemProjectionSignature } from "./projection-structure";

/**
 * The Slot-model collab binding (ysync 0008 Stage B) — the THIN RUNTIME over the
 * shared, transport-unaware building blocks. This module owns exactly what
 * `@pcbjam/shared` must not: the `observeDeep` subscription, the local-origin
 * echo policy, and seed-once authority. Everything data-shaped — wire schemas,
 * wire⇄delta conversion, Y reads/writes — is the shared lib.
 *
 *   DOWN (editor → Y): native shadow + emitted snapshot + current Y
 *                      → three-way rebase → applyDeltaToY.
 *   UP   (Y → editor): observe desired-state changes → one acknowledged,
 *                      level-triggered projection of the latest difference.
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

/**
 * Terminal projection boundary. The current native instance is retired. Most
 * failures can recreate directly from authoritative Yjs; an invalid authority
 * must be corrected first because a fresh editor cannot materialize it either.
 */
export const NATIVE_PROJECTION_FAILED_EVENT = "pcbjam:native-projection-failed";

export interface NativeProjectionFailure {
  readonly kind:
    | "native-apply"
    | "native-baseline"
    | "native-emission-order"
    | "invalid-y-state"
    | "unsupported-y-version"
    | "non-item-structure"
    | "internal-policy";
  readonly message: string;
  readonly status?: string;
  readonly recovery:
    | "recreate-from-yjs"
    | "repair-yjs-before-recreate"
    | "upgrade-client";
}

/** The v2 per-item s-expr bridge (Stage C C++ contract), runtime-adapted. */
export interface KicadItemsBridge {
  /** Full current model as an all-`added` ItemsWireDelta JSON. */
  snapshotItems(): string;
  /** Apply a remote ItemsWireDelta JSON (per-item Parse + splice by uuid). */
  applyItems(json: string): void | PromiseLike<void>;
  /** Register the local-edit emit hook (Format changed items → JSON). */
  onItems(cb: (json: string) => void): void;
  /** Release this binding's native owner generation and pending tickets. */
  destroy?(): void;
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
    /** App-free/test observer; the browser also receives the exported event. */
    onProjectionFailure?: (failure: NativeProjectionFailure) => void;
  },
): KicadBinding {
  const readOnly = opts?.readOnly === true;
  // Version skew guard — callers bind AFTER the provider's initial sync, so the
  // doc's version is authoritative here (an empty room reads as v1 and is
  // stamped CURRENT by the first write). A read-only viewer never writes, but
  // it must not adopt a doc it can't correctly render either, so still guard.
  const version = ydocSexprVersion(doc);
  if (!SEXPR_VERSION_SUPPORTED.includes(version)) throw new SexprVersionError(version);
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
  let items = kicadItemsMap(doc);

  /** Last native state we can account for: snapshots, local emits, and ACKed applies. */
  let nativeShadow: Record<string, KicadItem> | null = null;
  /** Last non-item structure known to be open in this native instance. */
  let nativeStructure: string | null = null;
  let projectionDirty = false;
  let projectionInFlight = false;
  let projectionTerminal = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;

  const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function";

  const applyItemsDelta = (
    current: Record<string, KicadItem>,
    delta: ReturnType<typeof docDelta>,
  ): Record<string, KicadItem> => {
    const next = { ...current };
    for (const keyed of [...delta.added, ...delta.updated]) {
      const { uuid, ...item } = keyed;
      next[uuid] = item;
    }
    for (const uuid of delta.removed) delete next[uuid];
    return next;
  };

  /**
   * Materialize the desired item replica. Full file-backed docs go through
   * yToDoc, which validates shape and deterministically repairs graph links.
   * Editor-snapshot-seeded rooms have no root/layout metadata, so give their
   * validated items a synthetic layout solely for the same graph repair pass.
   */
  const projectionView = (): {
    items: Record<string, KicadItem>;
    structure: string | null;
  } => {
    const currentVersion = ydocSexprVersion(doc);
    if (!SEXPR_VERSION_SUPPORTED.includes(currentVersion)) {
      throw new SexprVersionError(currentVersion);
    }
    if (typeof kicadMetaMap(doc).get("root") === "string") {
      const complete = yToDoc(doc);
      return {
        items: complete.items,
        structure: nonItemProjectionSignature(complete),
      };
    }

    const raw: Record<string, KicadItem> = {};
    kicadItemsMap(doc).forEach((ym, uuid) => {
      raw[uuid] = yToItem(ym);
    });
    const layout: Slot[] = Object.entries(raw)
      .filter(([, item]) => item.parent === null)
      .map(([uuid]): Slot => ({ item: uuid }));
    return {
      items: canonicalizeKicadDocGraph({ root: "kicad_items", items: raw, layout }).items,
      structure: null,
    };
  };

  const itemsView = (): Record<string, KicadItem> => projectionView().items;

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

  const snapshotView = (): {
    wire: ItemsWireDelta;
    view: Record<string, KicadItem>;
  } => {
    const wire = parseItemsWireDelta(bridge.snapshotItems());
    const delta = itemsWireToDelta(wire, {}, warnSkip);
    return { wire, view: applyItemsDelta({}, delta) };
  };

  const refreshNativeShadow = (context: string): ItemsWireDelta | null => {
    try {
      const snapshot = snapshotView();
      nativeShadow = snapshot.view;
      return snapshot.wire;
    } catch (err) {
      cwarn(`${context}: native snapshot failed`, err);
      return null;
    }
  };

  /** Drop descendant removals when their native root is already removed. */
  const projectionDelta = (
    from: Record<string, KicadItem>,
    to: Record<string, KicadItem>,
  ): ReturnType<typeof docDelta> => {
    const delta = docDelta({ items: from }, { items: to });
    const removed = new Set(delta.removed);
    delta.removed = delta.removed.filter((uuid) => {
      const seen = new Set<string>([uuid]);
      let parent = from[uuid]?.parent ?? null;
      while (parent !== null && !seen.has(parent)) {
        if (removed.has(parent)) return false;
        seen.add(parent);
        parent = from[parent]?.parent ?? null;
      }
      return true;
    });
    return delta;
  };

  const failProjection = (
    kind: NativeProjectionFailure["kind"],
    error: unknown,
    status?: string,
    recovery: NativeProjectionFailure["recovery"] = "recreate-from-yjs",
  ): void => {
    if (destroyed || projectionTerminal) return;
    projectionTerminal = true;
    projectionDirty = false;
    projectionInFlight = false;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failure: NativeProjectionFailure = {
      kind,
      message,
      status,
      recovery,
    };
    const recoveryLog =
      recovery === "repair-yjs-before-recreate"
        ? "repair authoritative Yjs before recreation"
        : recovery === "upgrade-client"
          ? "upgrade the client before recreation"
          : "recreate from authoritative Yjs";
    cwarn(`native projection terminal; retire this instance and ${recoveryLog}`, failure);

    // Stop native ingress immediately. The binding observers remain installed
    // only until the shell tears the collaboration handle down; both destroy
    // paths are idempotent.
    bridge.destroy?.();
    try {
      opts?.onProjectionFailure?.(failure);
    } catch (callbackError) {
      cwarn("native projection failure observer threw", callbackError);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<NativeProjectionFailure>(NATIVE_PROJECTION_FAILED_EVENT, {
          detail: failure,
        }),
      );
    }
  };

  const retryableNativeFailure = (error: unknown): boolean => {
    if (!(error instanceof NativeItemsApplyError) || !error.retryable) return false;
    // Do not trust an arbitrary ACK's retryable bit. These are the only states
    // whose contract guarantees native did not mutate.
    return (
      error.status === "busy" ||
      error.status === "unavailable" ||
      error.status === "submission-failed"
    );
  };

  /**
   * A projection/adoption read failed because the authoritative Y state cannot
   * be materialized by this client. Keep this distinct from failure to read the
   * native baseline: recreating native cannot repair Y, while a future schema
   * requires a newer client rather than rewriting the room.
   */
  const failAuthoritativeState = (error: unknown): void => {
    const unsupportedVersion = error instanceof SexprVersionError;
    failProjection(
      unsupportedVersion ? "unsupported-y-version" : "invalid-y-state",
      error,
      unsupportedVersion ? "unsupported-version" : "materialization-failed",
      unsupportedVersion ? "upgrade-client" : "repair-yjs-before-recreate",
    );
  };

  const scheduleRetry = (err: unknown): void => {
    projectionDirty = true;
    retryAttempt += 1;
    if (retryTimer !== undefined || destroyed || projectionTerminal) return;
    const delay = Math.min(2_000, 25 * 2 ** Math.min(retryAttempt - 1, 6));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      pumpProjection();
    }, delay);
    if (retryAttempt >= 6) {
      cwarn("native projection remains unavailable; retaining latest desired state", err);
    }
  };

  const finishProjection = (wire: ItemsWireDelta, err?: unknown): void => {
    projectionInFlight = false;
    if (destroyed || projectionTerminal) return;

    if (err !== undefined) {
      const retryable = retryableNativeFailure(err);
      const action = decideProjectionAck(true, true, projectionDirty, false, retryable);
      if (action === 3) {
        cwarn("⬆ native apply was not entered; retrying the latest desired state", err);
        scheduleRetry(err);
        return;
      }
      if (action === 4) {
        failProjection(
          "native-apply",
          err,
          err instanceof NativeItemsApplyError ? err.status : undefined,
        );
        return;
      }
      failProjection(
        "internal-policy",
        new Error(`verified projection policy returned invalid failure action ${action}`),
      );
      return;
    }

    // The ACK belongs to this exact submitted wire and fires only after native
    // commit. Advance the shadow by that wire. Taking an ACK-time snapshot here
    // would erase the base needed to distinguish concurrent local intent.
    try {
      if (nativeShadow === null) throw new Error("acknowledged projection has no native shadow");
      nativeShadow = applyItemsDelta(
        nativeShadow,
        itemsWireToDelta(wire, nativeShadow, warnSkip),
      );
    } catch (shadowError) {
      failProjection("internal-policy", shadowError);
      return;
    }

    retryAttempt = 0;
    const action = decideProjectionAck(true, true, projectionDirty, true, false);
    if (action === 2) pumpProjection();
    else if (action !== 1) {
      failProjection(
        "internal-policy",
        new Error(`verified projection policy returned invalid success action ${action}`),
      );
    }
  };

  function pumpProjection(): void {
    if (
      destroyed ||
      projectionTerminal ||
      !seeded ||
      projectionInFlight ||
      !projectionDirty
    ) return;

    if (nativeShadow === null && refreshNativeShadow("native projection") === null) {
      failProjection(
        "native-baseline",
        new Error("native projection has no readable baseline"),
      );
      return;
    }

    let desired: ReturnType<typeof projectionView>;
    try {
      desired = projectionView();
    } catch (err) {
      // A fresh native owner cannot hydrate from an authority that cannot be
      // materialized. Retire this owner exactly once without throwing through
      // Y.applyUpdate, and make the repair-before-recreate boundary observable.
      failAuthoritativeState(err);
      return;
    }

    if (
      nativeStructure !== null &&
      desired.structure !== null &&
      nativeStructure !== desired.structure
    ) {
      failProjection(
        "non-item-structure",
        new Error(
          "remote root/layout/library structure cannot be hot-applied; native rehydration is required",
        ),
      );
      return;
    }

    projectionDirty = false;
    const delta = projectionDelta(nativeShadow!, desired.items);
    if (isEmptyKicadDelta(delta)) return;
    const wire = deltaToItemsWire(delta, desired.items, libDefs);
    if (isEmptyItemsWireDelta(wire)) return;

    clog("⬆ desired Y state → apply to editor:", {
      added: wire.added.length,
      changed: wire.changed.length,
      removed: wire.removed.length,
    });
    projectionInFlight = true;
    let completion: void | PromiseLike<void>;
    try {
      completion = bridge.applyItems(JSON.stringify(wire));
    } catch (err) {
      finishProjection(wire, err);
      return;
    }

    if (isPromiseLike(completion)) {
      Promise.resolve(completion).then(
        () => finishProjection(wire),
        (err: unknown) => finishProjection(wire, err),
      );
    } else {
      finishProjection(wire);
    }
  }

  const requestProjection = (): void => {
    if (destroyed || projectionTerminal) return;
    projectionDirty = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    pumpProjection();
  };

  // DOWN: local editor change → Y.Doc
  bridge.onItems((json: string) => {
    if (destroyed || projectionTerminal) return;
    if (!seeded) {
      // seed() snapshots the complete native state, including this edit. Never
      // publish against an authority decision that has not happened yet.
      nativeShadow = null;
      return;
    }
    const emissionAction = decideNativeEmission(projectionInFlight);
    const failAmbiguousEmission = (cause?: unknown): boolean => {
      if (emissionAction !== 4) return false;
      const detail = cause instanceof Error ? ` (${cause.message})` : "";
      failProjection(
        "native-emission-order",
        new Error(
          "native emitted an item transition before the outstanding projection " +
            `was acknowledged; its order is ambiguous${detail}`,
        ),
        "emission-before-ack",
      );
      return true;
    };
    if (readOnly) {
      // The UI normally gates this. If it is bypassed, rebaseline what actually
      // changed and let doc authority project back over it.
      if (refreshNativeShadow("read-only local edit recovery") === null) {
        failProjection("native-baseline", new Error("read-only recovery snapshot failed"));
        return;
      }
      if (failAmbiguousEmission()) return;
      requestProjection();
      return;
    }
    let wire: ItemsWireDelta;
    try {
      wire = parseItemsWireDelta(json);
    } catch (err) {
      cwarn("⬇ onItems from wasm: UNPARSEABLE", err, json);
      if (failAmbiguousEmission(err)) return;
      if (refreshNativeShadow("unparseable local edit recovery") === null) {
        failProjection("native-baseline", err);
        return;
      }
      requestProjection();
      return;
    }
    // This handler runs synchronously inside the C++ emit; a throw escaping it
    // unwinds through embind as a bare pageerror AND discards the whole batch
    // after the sender already rebaselined (the batch-loss bug). Entry-level
    // failures are already skipped inside the conversion; this catch is the
    // backstop for everything else.
    try {
      if (nativeShadow === null && refreshNativeShadow("local edit") === null) {
        failProjection("native-baseline", new Error("local edit has no native baseline"));
        return;
      }
      const base = nativeShadow!;
      const localDelta = itemsWireToDelta(wire, base, warnSkip);
      const local = applyItemsDelta(base, localDelta);
      const current = itemsView();
      const merged = rebaseKicadItems(base, local, current);
      const delta = docDelta({ items: current }, { items: merged });
      // Library definitions the blob carried (a placed symbol's lib_symbols
      // context — miss 08): store them alongside the items, same transaction.
      const defs = wireLibSymbols(wire);
      // The editor has already committed its local operation before emitting.
      // Record that actual state even when the rebased Y delta is a no-op.
      nativeShadow = local;
      if (isEmptyKicadDelta(delta) && Object.keys(defs).length === 0) {
        failAmbiguousEmission();
        return;
      }
      clog("⬇ onItems (local edit):", {
        added: delta.added.length,
        updated: delta.updated.length,
        removed: delta.removed.length,
      });
      doc.transact(() => {
        applyDeltaToY(doc, delta, ORIGIN);
        upsertLibSymbolsToY(doc, defs, ORIGIN);
      }, ORIGIN);
      // A native emission before ACK violates the ordering contract. We still
      // preserve its parseable intent above, but cannot know whether it belongs
      // before or after the submitted wire. The generated policy therefore
      // retires this generation instead of guessing a shadow and echoing.
      if (failAmbiguousEmission()) return;
      // A stale local snapshot may need a corrective projection (the disjoint
      // remote fields preserved by the rebase). Avoid re-entering native code
      // from inside its own emit callback.
      queueMicrotask(requestProjection);
    } catch (err) {
      cwarn("⬇ onItems from wasm: batch failed to apply", err);
      if (failAmbiguousEmission(err)) return;
      if (refreshNativeShadow("local batch recovery") === null) {
        failProjection("native-baseline", err);
        return;
      }
      requestProjection();
    }
  });

  // UP is level-triggered: events merely say "desired state may have changed".
  // The acknowledged pump computes the latest complete difference from the
  // native shadow. This makes event loss/coalescing harmless and bounds the
  // native queue to one request plus one dirty latest state.
  const observer = (_events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === ORIGIN) return; // our own echo — ignore
    if (!seeded) return; // pre-seed state sync — seed()'s adopt covers it
    requestProjection();
  };
  items.observeDeep(observer);

  // v3 swaps the complete active state at one root key. Observe the root deeply
  // so a pointer replacement is rebound atomically and so layout/library-only
  // updates also wake the level-triggered projector.
  const stateRoot = doc.getMap<unknown>(Y_KDOC_STATE);
  const onState = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    txn: Y.Transaction,
  ): void => {
    try {
      const nextItems = kicadItemsMap(doc);
      if (nextItems !== items) {
        items.unobserveDeep(observer);
        items = nextItems;
        items.observeDeep(observer);
      }
      rebindRevertMeta();
    } catch (err) {
      cwarn("kdoc active state is incomplete; waiting for a valid replacement", err);
    }
    if (!seeded) return;

    const touchesNonItems = events.some((event) => {
      const path = event.path;
      // A top-level active-pointer swap is the complete structure. Below the
      // active state, only the `items` subtree is hot-applicable.
      return path.length < 2 || path[0] !== "active" || path[1] !== "items";
    });
    if (txn.origin === ORIGIN || txn.origin === "layout-save") {
      if (touchesNonItems) {
        try {
          const structure = projectionView().structure;
          if (structure !== null) nativeStructure = structure;
        } catch (err) {
          failAuthoritativeState(err);
        }
      }
      return;
    }
    requestProjection();
  };
  stateRoot.observeDeep(onState);

  // Validity-revert notice (kicad-validity 0001 B3): the backend stamps
  // kdoc_meta.revertNonce when it rolls the doc back to the last valid state
  // (the content itself arrives through the normal item sync above). Watched
  // like seedNonce; surfaced as a window event for the shell's toast. The
  // nonce is deduped so a reconnect replaying the same marker stays silent.
  let revMeta = kicadMetaMap(doc);
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

  function rebindRevertMeta(): void {
    const nextMeta = kicadMetaMap(doc);
    if (nextMeta === revMeta) return;
    revMeta.unobserve(onRevertMeta);
    revMeta = nextMeta;
    revMeta.observe(onRevertMeta);
    onRevertMeta();
  }

  function seed(seedDoc?: KicadDoc, opts?: { editorMatchesDoc?: boolean }): void {
    seeded = true; // open the UP gate; everything below runs synchronously
    if (seedDoc) nativeStructure = nonItemProjectionSignature(seedDoc);
    // `ydocHasState` (meta + layout + items), NOT `items.size`: a populated
    // drawing sheet (pl_editor .kicad_wks) has zero uuid items, so an items-only
    // check would mis-classify a seeded room as empty and re-seed/clobber it.
    if (opts?.editorMatchesDoc && ydocHasState(doc)) {
      // The editor opened exactly this doc's content (Y.Doc-load path): no
      // adopt apply needed. snapshotItems() still runs to BASELINE the wasm
      // differ — otherwise the first local edit would re-emit the full model.
      clog(`seed: editor matches doc (${items.size} item(s)) → baseline only, no apply`);
      try {
        nativeStructure = projectionView().structure;
      } catch (err) {
        failAuthoritativeState(err);
        return;
      }
      if (refreshNativeShadow("seed baseline") === null) {
        failProjection("native-baseline", new Error("seed baseline snapshot failed"));
      }
      return;
    }
    if (!ydocHasState(doc) && seedDoc) {
      if (readOnly) {
        // A viewer never authors a room. The editor keeps showing the file it
        // opened; when a writer later seeds this room, the (now-open) UP
        // observer streams their state in.
        clog("seed: read-only viewer on an empty room — not seeding");
        if (refreshNativeShadow("read-only seed baseline") === null) {
          failProjection("native-baseline", new Error("read-only seed baseline failed"));
        }
        return;
      }
      // First tab, file-seeded: write the FULL doc (meta + layout + items) so
      // the Y.Doc — not the editor snapshot — is the lossless source of truth
      // (the file is recoverable via docToFile). The editor already opened the
      // same file, so no applyItems is needed.
      clog(
        `seed: doc empty → SEEDING from file (${Object.keys(seedDoc.items).length} item(s), root ${seedDoc.root})`,
      );
      // v3 arbitrates the whole detached state at one active pointer, so a
      // concurrent first seed selects one complete document rather than
      // independently merging its items/layout/meta into a hybrid.
      const nonce = `${doc.clientID}:${Math.random().toString(36).slice(2)}`;
      seedDocToY(seedDoc, doc, ORIGIN, nonce);
      // snapshotItems() does double duty here. Its side effects register the
      // C++ change listener (bug 01 — without it this tab would receive but
      // never SEND) and rebaseline the wasm differ. Its RESULT re-upserts the
      // item bodies in the EDITOR's serialization: the file's formatting and
      // the writer's normalized output can differ textually, and every future
      // emit/drift-compare uses the writer's form — keeping file-formatted
      // bodies would false-positive drift-detect on every file-seeded room
      // and defeat upsertYItem's no-op skip. Meta + layout stay file-derived.
      try {
        const wire = refreshNativeShadow("post-file-seed baseline");
        if (!wire) {
          failProjection("native-baseline", new Error("post-file-seed baseline failed"));
          return;
        }
        let authorityItems: Record<string, KicadItem>;
        try {
          authorityItems = itemsView();
        } catch (err) {
          failAuthoritativeState(err);
          return;
        }
        const local = itemsWireToDelta(wire, authorityItems, warnSkip);
        if (!isEmptyKicadDelta(local)) applyDeltaToY(doc, local, ORIGIN);
      } catch (err) {
        cwarn("seed: post-file-seed baseline failed", err);
        failProjection("native-baseline", err);
      }
      return;
    }

    let wire: ItemsWireDelta;
    try {
      const snapshot = snapshotView();
      wire = snapshot.wire;
      nativeShadow = snapshot.view;
    } catch (err) {
      cwarn("seed: snapshotItems unparseable", err);
      failProjection("native-baseline", err);
      return;
    }

    const hasState = ydocHasState(doc);

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
      }, ORIGIN);
      return;
    }

    // Joining a populated doc: doc authority wins. The same acknowledged pump
    // used for live updates computes the minimal root-lifted adopt difference.
    if (nativeStructure === null) {
      // Legacy/app-less callers may only supply the item snapshot. Production
      // passes either seedDoc or editorMatchesDoc. Baseline the current
      // structure here so subsequent remote structural drift still fails
      // closed instead of remaining silently stale.
      try {
        nativeStructure = projectionView().structure;
      } catch (err) {
        failAuthoritativeState(err);
        return;
      }
    }
    clog(`seed: doc has ${items.size} item(s) → adopting latest desired state`);
    requestProjection();
  }

  return {
    seed,
    destroy: () => {
      if (destroyed) return;
      destroyed = true; // gates the DOWN hook — see bug 07 note above
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      items.unobserveDeep(observer);
      stateRoot.unobserveDeep(onState);
      revMeta.unobserve(onRevertMeta);
      bridge.destroy?.();
    },
    get items() {
      return items;
    },
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
  opts?: { ackTimeoutMs?: number },
): KicadItemsBridge {
  return createNativeItemsBridge(
    mod as NativeItemsProtocolModule,
    win as NativeItemsProtocolWindow,
    opts,
  );
}
