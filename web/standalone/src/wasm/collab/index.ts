import * as Y from "yjs";
import type { KicadDoc } from "@pcbjam/shared";
import { clog } from "./debug";
import {
  connectProvider,
  type ProviderConfig,
  type YjsProvider,
} from "./provider";
import { createReconciler, type Reconciler } from "./reconciler";
import type { CollabBridge } from "./types";
import {
  bindKicadCollab,
  moduleItemsBridge,
  SexprVersionError,
  type KicadBinding,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "./kicad-binding";

export type { CollabBridge, CollabDelta, CollabItem } from "./types";
export { createReconciler } from "./reconciler";
export { connectBroadcastChannel } from "./broadcast-transport";
export {
  connectProvider,
  type ProviderConfig,
  type ProviderKind,
  type YjsProvider,
} from "./provider";
export { bindKicadCollab, moduleItemsBridge, SexprVersionError };
export type { KicadBinding, KicadItemsModule, KicadItemsWindow };
export type { KicadItemsBridge } from "./kicad-binding";

/** The subset of the Emscripten Module the collab bridge needs (embind functions). */
export interface CollabModule {
  kicadCollabSnapshot(): string;
  kicadCollabApply(deltaJson: string): void;
}

/** The window slot the C++ emit side calls into. */
export interface CollabWindow {
  kicadCollab?: { onDelta: (deltaJson: string) => void };
}

export function moduleBridge(mod: CollabModule, win: CollabWindow): CollabBridge {
  return {
    snapshot: () => mod.kicadCollabSnapshot(),
    apply: (deltaJson) => mod.kicadCollabApply(deltaJson),
    onDelta: (cb) => {
      win.kicadCollab = { onDelta: cb };
      clog("registered window.kicadCollab.onDelta (wasm emit sink)");
    },
  };
}

export interface StartCollabOptions {
  /** Which Yjs provider to use + its endpoint/params (env-selected upstream). */
  provider: ProviderConfig;
  /** Room id — see @pcbjam/shared `collabRoomId`. Identifies one shared doc. */
  room: string;
  /**
   * The full `KicadDoc` parsed from the opened file (`fileToDoc`) — when the
   * room is empty, the Y.Doc is seeded from THIS (meta + layout + items, so the
   * file is recoverable from the doc alone — ysync 0005) instead of the editor
   * snapshot. Ignored by the legacy scalar `startCollab`.
   */
  seedDoc?: KicadDoc;
  /** Read-only viewer (read-only-viewer): see `bindKicadCollab`. */
  readOnly?: boolean;
}

export interface CollabHandle {
  doc: Y.Doc;
  reconciler: Reconciler;
  provider: YjsProvider;
  destroy(): void;
}

/**
 * Wire a running KiCad wasm Module into a collaborative session:
 * Module ⇄ Y.Doc ⇄ provider. Returns once the initial seed/adopt has run. The
 * editor must already have its document loaded (so kicadCollabSnapshot reflects
 * it), so that — if this is the first/only client — `seed()` captures it.
 *
 * Seed-vs-adopt: after `provider.whenSynced()` the Y.Doc holds the authoritative
 * state (the server's, a peer tab's, or — first ever — empty). `seed()` then
 * seeds from the local model if the doc is empty, else adopts the shared doc.
 */
export async function startCollab(
  mod: CollabModule,
  win: CollabWindow,
  opts: StartCollabOptions,
): Promise<CollabHandle> {
  clog("startCollab:", opts.provider.kind, "room =", opts.room);
  const doc = new Y.Doc();
  const bridge = moduleBridge(mod, win);
  const reconciler = createReconciler(doc, bridge);
  const provider = await connectProvider(doc, opts.provider, { room: opts.room });

  await provider.whenSynced();
  reconciler.seed();
  clog("startCollab: ready; doc items =", reconciler.items.size);

  return {
    doc,
    reconciler,
    provider,
    destroy() {
      reconciler.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}

export interface KicadCollabHandle {
  doc: Y.Doc;
  binding: KicadBinding;
  provider: YjsProvider;
  destroy(): void;
}

/** A provider-connected, initial-state-synced Y.Doc, not yet bound to an editor. */
export interface KicadDocSession {
  doc: Y.Doc;
  provider: YjsProvider;
}

/** The connect path exceeded its deadline (import + construct + initial sync). */
export class CollabConnectTimeoutError extends Error {
  constructor(room: string, timeoutMs: number) {
    super(`collab connect to ${room} exceeded ${timeoutMs}ms`);
    this.name = "CollabConnectTimeoutError";
  }
}

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Connect a fresh Y.Doc to a provider room and wait for its authoritative
 * initial state. Used standalone by the Y.Doc-load path (materialize the file
 * from the doc BEFORE any editor exists), and as the first half of
 * `startKicadCollab`.
 *
 * The deadline + abort signal cover the WHOLE path — the provider module's
 * lazy import, provider construction, and the initial sync (findings C-3: a
 * stalled chunk fetch or a `whenSynced` that never fires used to escape every
 * timeout). On failure/timeout/abort, everything partially built is destroyed
 * (findings C-1: no orphaned doc or socket), including a provider whose
 * construction resolves only after the race was lost.
 */
export async function connectKicadDoc(opts: {
  provider: ProviderConfig;
  room: string;
  /** Owner teardown (unmount, boot failure) — cancels + destroys partials. */
  signal?: AbortSignal;
  /** Whole-path deadline; defaults to 30s. */
  timeoutMs?: number;
  /** Gateway transport (load-path-rework 0003): register interest without
   *  demanding doc state — the warm pool's parked sheets. `whenSynced` then
   *  resolves on subscription, and `provider.activate?.()` is the real sync
   *  barrier before any bind/read/write of the doc. */
  passive?: boolean;
}): Promise<KicadDocSession> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  // An already-aborted owner never gets a session — even one that could
  // connect instantly (Promise.race settles in array order for pre-settled
  // promises, so the guard must run before any construction).
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new Error("collab connect aborted");
  }
  const doc = new Y.Doc();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const fail = new Promise<never>((_, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error("collab connect aborted"));
      return;
    }
    onAbort = () =>
      reject(opts.signal?.reason ?? new Error("collab connect aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => reject(new CollabConnectTimeoutError(opts.room, timeoutMs)),
      timeoutMs,
    );
  });
  // The failure promise only ever loses a race on the success path — silence
  // its rejection so a post-success abort can't surface as unhandled.
  fail.catch(() => {});

  const providerPromise = connectProvider(doc, opts.provider, {
    room: opts.room,
    passive: opts.passive,
  });
  providerPromise.catch(() => {}); // may lose the race and reject later

  let provider: YjsProvider | undefined;
  try {
    provider = await Promise.race([providerPromise, fail]);
    await Promise.race([provider.whenSynced(), fail]);
    return { doc, provider };
  } catch (err) {
    if (provider) {
      provider.destroy();
    } else {
      // Construction may still be in flight (or racing this very catch) —
      // whenever it lands, the late provider self-destroys.
      providerPromise.then((p) => p.destroy()).catch(() => {});
    }
    doc.destroy();
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Bind a running editor to an already-synced doc session (second half of
 * `startKicadCollab`). `editorMatchesDoc` marks the Y.Doc-load path: the open
 * file was materialized from this very doc, so seed only baselines the differ
 * instead of re-applying the full document.
 */
export function attachKicadCollab(
  mod: KicadItemsModule,
  win: KicadItemsWindow,
  session: KicadDocSession,
  opts?: { seedDoc?: KicadDoc; editorMatchesDoc?: boolean; readOnly?: boolean },
): KicadCollabHandle {
  if (opts?.readOnly) {
    // Invisible observer: drop the provider's initial empty awareness state so
    // the viewer never appears in anyone's roster (the sync server drops these
    // frames from read-only connections too — this keeps the client quiet).
    session.provider.awareness?.setLocalState(null);
  }
  const bridge = moduleItemsBridge(mod, win);
  let binding: KicadBinding | undefined;
  try {
    binding = bindKicadCollab(session.doc, bridge, {
      readOnly: opts?.readOnly,
    });
    binding.seed(opts?.seedDoc, { editorMatchesDoc: opts?.editorMatchesDoc });
  } catch (err) {
    // A partially-attached binding must not survive a seed throw (findings
    // C-2): it already owns the global DOWN hook + doc observers, and the
    // handle that could destroy it would never reach the caller. The SESSION
    // stays alive — its owner decides (degrade / retry / teardown).
    if (binding) binding.destroy();
    else bridge.destroy?.();
    throw err;
  }
  if (!binding) throw new Error("collaboration binding construction returned no binding");
  clog("attachKicadCollab: ready; doc items =", binding.items.size);

  return {
    doc: session.doc,
    binding,
    provider: session.provider,
    destroy() {
      binding.destroy();
      session.provider.destroy();
      session.doc.destroy();
    },
  };
}

/**
 * The Slot-model counterpart of `startCollab` (ysync 0008): wires the v2 items
 * bridge (kicadCollabSnapshotItems / ApplyItems / onItems — Stage C exports) into
 * a Y.Doc holding the canonical `KicadDoc` representation. Same provider +
 * seed-once flow as the legacy path; supersedes it once the wasm speaks the
 * items wire (Stage D).
 */
export async function startKicadCollab(
  mod: KicadItemsModule,
  win: KicadItemsWindow,
  opts: StartCollabOptions,
): Promise<KicadCollabHandle> {
  clog("startKicadCollab:", opts.provider.kind, "room =", opts.room);
  const session = await connectKicadDoc({ provider: opts.provider, room: opts.room });
  return attachKicadCollab(mod, win, session, {
    seedDoc: opts.seedDoc,
    readOnly: opts.readOnly,
  });
}
