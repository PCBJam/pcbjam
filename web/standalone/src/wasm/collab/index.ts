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
import { destroyKicadDocSession } from "./doc-session-owner";

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
export { createKicadDocSessionOwner, destroyKicadDocSession } from "./doc-session-owner";
export type { KicadBinding, KicadItemsModule, KicadItemsWindow };
export type { KicadItemsBridge } from "./kicad-binding";

/** The subset of the Emscripten Module the collab bridge needs (embind functions). */
export interface CollabModule {
  kicadCollabSnapshot(): Promise<string>;
  kicadCollabApply(deltaJson: string): Promise<void>;
}

/** The window slot the C++ emit side calls into. */
export interface CollabWindow {
  kicadCollab?: { onDelta: (deltaJson: string) => void };
}

export function moduleBridge(mod: CollabModule, win: CollabWindow): CollabBridge {
  const guardedCall = <T,>(
    fn: Function,
    args: unknown[],
    isCurrent: (() => boolean) | undefined,
    direct: () => T | Promise<T>,
  ): T | Promise<T> => {
    if (!isCurrent) return direct();
    if (!isCurrent()) return Promise.reject(new Error("stale collaborative projection"));
    const guarded = (
      fn as Function & {
        __wxGuardedCall?: (values: unknown[], guard: () => boolean) => Promise<unknown>;
      }
    ).__wxGuardedCall;
    return guarded ? (guarded(args, isCurrent) as Promise<T>) : direct();
  };
  return {
    snapshot: (isCurrent) =>
      guardedCall<string>(
        mod.kicadCollabSnapshot,
        [],
        isCurrent,
        () => mod.kicadCollabSnapshot(),
      ),
    apply: (deltaJson, isCurrent) =>
      guardedCall<void>(
        mod.kicadCollabApply,
        [deltaJson],
        isCurrent,
        () => mod.kicadCollabApply(deltaJson),
      ),
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
  /** Exact owner lifetime. Aborting it cancels an unfinished provider sync. */
  signal?: AbortSignal;
  /** Test/diagnostic override for the initial provider sync deadline. */
  syncTimeoutMs?: number;
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
  const session = await connectKicadDoc({
    provider: opts.provider,
    room: opts.room,
    signal: opts.signal,
    syncTimeoutMs: opts.syncTimeoutMs,
  });
  const { doc, provider } = session;
  const bridge = moduleBridge(mod, win);
  let reconciler: Reconciler | undefined;
  let retired = false;
  const retire = () => {
    if (retired) return;
    retired = true;
    try {
      reconciler?.destroy();
    } finally {
      destroyKicadDocSession(session);
    }
  };
  const onAbort = () => retire();
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (retired) throw signalReason(opts.signal!);
    reconciler = createReconciler(doc, bridge);
    await reconciler.seed();
    if (retired) throw signalReason(opts.signal!);
  } catch (err) {
    retire();
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (!reconciler) throw new Error("collaboration reconciler did not initialize");
  clog("startCollab: ready; doc items =", reconciler.items.size);

  return {
    doc,
    reconciler,
    provider,
    destroy() {
      retire();
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

/** A room may reconnect forever after construction, but boot may not wait forever. */
export const DEFAULT_PROVIDER_SYNC_TIMEOUT_MS = 30_000;
export const MAX_PROVIDER_SYNC_TIMEOUT_MS = 0x7fffffff;

export class ProviderSyncTimeoutError extends Error {
  constructor(
    readonly room: string,
    readonly timeoutMs: number,
  ) {
    super(`provider synchronization timed out after ${timeoutMs} ms for room ${room}`);
    this.name = "ProviderSyncTimeoutError";
  }
}

function signalReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The collaborative session was aborted", "AbortError");
}

/**
 * Connect a fresh Y.Doc to a provider room and wait for its authoritative
 * initial state. Used standalone by the Y.Doc-load path (materialize the file
 * from the doc BEFORE any editor exists), and as the first half of
 * `startKicadCollab`.
 */
export async function connectKicadDoc(opts: {
  provider: ProviderConfig;
  room: string;
  /** The lifetime which owns this not-yet-published provider/doc pair. */
  signal?: AbortSignal;
  /** Finite deadline for initial authoritative state; defaults to 30 seconds. */
  syncTimeoutMs?: number;
}): Promise<KicadDocSession> {
  const timeoutMs = opts.syncTimeoutMs ?? DEFAULT_PROVIDER_SYNC_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_PROVIDER_SYNC_TIMEOUT_MS
  ) {
    throw new RangeError(
      `syncTimeoutMs must be between 0 and ${MAX_PROVIDER_SYNC_TIMEOUT_MS}; got ${timeoutMs}`,
    );
  }

  const doc = new Y.Doc();
  let provider: YjsProvider | undefined;
  const waitAbort = new AbortController();
  const onOwnerAbort = () => waitAbort.abort(signalReason(opts.signal!));
  opts.signal?.addEventListener("abort", onOwnerAbort, { once: true });
  if (opts.signal?.aborted) onOwnerAbort();
  const timeout = setTimeout(
    () => waitAbort.abort(new ProviderSyncTimeoutError(opts.room, timeoutMs)),
    timeoutMs,
  );
  let detachAbortRace = () => {};
  try {
    const abortRace = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(signalReason(waitAbort.signal));
      detachAbortRace = () => waitAbort.signal.removeEventListener("abort", rejectAbort);
      if (waitAbort.signal.aborted) rejectAbort();
      else waitAbort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const connecting = connectProvider(doc, opts.provider, {
      room: opts.room,
      signal: waitAbort.signal,
    }).then(
      (candidate) => {
        // Import/constructor work cannot be force-cancelled. If the owning
        // lifetime or deadline won, make the late provider inert immediately.
        if (waitAbort.signal.aborted) {
          candidate.destroy();
          throw signalReason(waitAbort.signal);
        }
        return candidate;
      },
    );
    provider = await Promise.race([connecting, abortRace]);
    await provider.whenSynced({ signal: waitAbort.signal });
    return { doc, provider };
  } catch (err) {
    if (provider) destroyKicadDocSession({ provider, doc });
    else doc.destroy();
    throw err;
  } finally {
    detachAbortRace();
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onOwnerAbort);
  }
}

/**
 * Bind a running editor to an already-synced doc session (second half of
 * `startKicadCollab`). `editorMatchesDoc` marks the Y.Doc-load path: the open
 * file was materialized from this very doc, so seed only baselines the differ
 * instead of re-applying the full document.
 */
export async function attachKicadCollab(
  mod: KicadItemsModule,
  win: KicadItemsWindow,
  session: KicadDocSession,
  opts?: {
    seedDoc?: KicadDoc;
    editorMatchesDoc?: boolean;
    readOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<KicadCollabHandle> {
  let binding: KicadBinding;
  try {
    if (opts?.readOnly) {
      // Invisible observer: drop the provider's initial empty awareness state so
      // the viewer never appears in anyone's roster (the sync server drops these
      // frames from read-only connections too — this keeps the client quiet).
      session.provider.awareness?.setLocalState(null);
    }
    binding = bindKicadCollab(session.doc, moduleItemsBridge(mod, win), {
      readOnly: opts?.readOnly,
    });
  } catch (err) {
    // Ownership transfers at function entry. In particular, a synchronous
    // version refusal happens before `binding` and the normal retire closure
    // exist, so the raw provider/doc must still be retired here.
    destroyKicadDocSession(session);
    throw err;
  }
  let retired = false;
  const retire = () => {
    if (retired) return;
    retired = true;
    try {
      binding.destroy();
    } finally {
      destroyKicadDocSession(session);
    }
  };
  const onAbort = () => retire();
  if (opts?.signal?.aborted) onAbort();
  else opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (retired) throw signalReason(opts!.signal!);
    await binding.seed(opts?.seedDoc, { editorMatchesDoc: opts?.editorMatchesDoc });
    if (retired) throw signalReason(opts!.signal!);
  } catch (err) {
    retire();
    throw err;
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
  }
  clog("attachKicadCollab: ready; doc items =", binding.items.size);

  return {
    doc: session.doc,
    binding,
    provider: session.provider,
    destroy() {
      retire();
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
  const session = await connectKicadDoc({
    provider: opts.provider,
    room: opts.room,
    signal: opts.signal,
    syncTimeoutMs: opts.syncTimeoutMs,
  });
  return await attachKicadCollab(mod, win, session, {
    seedDoc: opts.seedDoc,
    readOnly: opts.readOnly,
    signal: opts.signal,
  });
}
