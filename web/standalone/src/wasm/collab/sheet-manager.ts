import type * as Y from "yjs";
import {
  collabRoomId,
  fileToDoc,
  syncLayoutToY,
  type KicadDoc,
  type PresenceUser,
} from "@pcbjam/shared";
import { connectKicadDoc, type KicadDocSession } from "./index";
import { publishSkeleton } from "./presence";
import {
  bindKicadCollab,
  moduleItemsBridge,
  type KicadBinding,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "./kicad-binding";
import type { ProviderConfig, YjsProvider } from "./provider";
import { clog, cwarn } from "./debug";
import { destroyKicadDocSession } from "./doc-session-owner";
import { isTerminalOwnerJobError } from "../owner-job";

/**
 * Warm-pool multi-room collab manager for hierarchical schematics (subschemas).
 *
 * A hierarchical design references several `.kicad_sch` files; each is its own collab
 * room. This manager keeps EVERY discovered sheet's Y.Doc + provider connected for the
 * whole session (the "warm pool"), so the doc stays current over its open WebSocket
 * even when that sheet isn't on screen and switching sheets needs no reconnect.
 *
 * The C++ items bridge (`window.kicadCollab.onItems` / `kicadCollabApplyItems` /
 * `kicadCollabSnapshotItems`) is a SINGLETON tied to the editor's active screen, so at
 * most ONE room may be bound to the editor at a time. Navigation (the C++
 * `onSheetChanged` hook → {@link SheetCollabManager.switchTo}) re-routes that single
 * binding between already-warm docs; it does not tear down providers. The Phase-0 C++
 * change scopes the snapshot/diff to the active screen, so each room carries exactly its
 * own sheet's items and per-sheet seed/adopt is correct.
 *
 * Background sheets stay synced at the DATA layer (their doc accumulates remote edits)
 * but are not reflected in the editor's other-sheet view until you navigate in — at
 * which point the doc is already warm, so the merge into view is instant. Fully live
 * non-active-sheet VIEW updates would need a sheet-targeted C++ apply (a future upgrade
 * this design leaves open). Presence (per-room awareness) is likewise additive.
 */
export interface SheetCollabManager {
  /** Pre-connect (warm) a set of sheet files so later switches are instant. */
  connectAll(sheetPaths: string[]): Promise<void>;
  /** Bind the editor to `sheetPath` (driven by the C++ `onSheetChanged` hook). */
  switchTo(sheetPath: string): Promise<void>;
  /** Warm a sheet created mid-session (driven by the save hook on an unknown path). */
  onboard(sheetPath: string): Promise<void>;
  /**
   * Coarse non-item layout sync from a just-saved sheet file (miss 08B): title
   * block / paper / settings edits reconcile into the sheet's room doc, which
   * otherwise only carries them from seed time. No-op for unknown sheets.
   */
  syncLayoutFromSave(sheetPath: string, fileText: string): void;
  /** The currently-bound sheet, for drift-detection + presence wiring (null
   *  before first switch). `provider` carries the room's awareness. */
  active(): ActiveSheet | null;
  /** Tear down ALL bindings + providers + docs (session end / unmount). */
  destroy(): void;
}

/** The bound sheet's room: its doc (drift detection) + provider (presence). */
export interface ActiveSheet {
  sheetPath: string;
  doc: Y.Doc;
  provider: YjsProvider;
}

export interface SheetManagerOptions {
  /** The Emscripten Module exposing the v2 items bridge exports. */
  mod: KicadItemsModule;
  /** The global the C++ emit side calls into (`window.kicadCollab.onItems`). */
  win: KicadItemsWindow;
  /** Owning team's stable id (`"local"` when scope-less) — first room-id segment. */
  scopeId: string;
  /** Project uuid — keys each room as `collabRoomId(scopeId, projectId, sheetPath)`. */
  projectId: string;
  /** The env-selected Yjs provider config (same one the single-room path uses). */
  provider: ProviderConfig;
  /** Owning editor lifetime; aborts room handshakes which have not published. */
  signal?: AbortSignal;
  /** Test/diagnostic override for the initial provider sync deadline. */
  syncTimeoutMs?: number;
  /**
   * Lossless seed for an EMPTY room: the child `.kicad_sch` parsed from MEMFS
   * (`fileToDoc`), so a first-ever-opened sheet seeds its room from the file.
   */
  seedDocForPath: (sheetPath: string) => KicadDoc | undefined;
  /**
   * Called whenever the active sheet changes (or clears on destroy) so the host can
   * (re)start drift detection on the now-active doc.
   */
  onActiveChange?: (active: ActiveSheet | null) => void;
  /**
   * Presence identity (collab-presence 0003). When set, every PARKED room in the
   * warm pool carries a skeleton awareness state ({user, tool, sheetPath: the
   * sheet the user is ACTUALLY on}) so any sheet's roster can answer "who is in
   * this schematic, and where". The BOUND room's full presence (cursor/selection)
   * is owned by the host via onActiveChange → createPresence, which overwrites
   * the skeleton on rebind.
   */
  presenceUser?: PresenceUser;
  /**
   * Read-only viewer (read-only-viewer): every room's binding is created
   * read-only (never seeds, never pushes local edits — see bindKicadCollab)
   * and each connected room's initial awareness state is dropped so the
   * viewer stays out of rosters. Pass `presenceUser: undefined` alongside —
   * skeleton presence is a broadcast too.
   */
  readOnly?: boolean;
  log: (m: string) => void;
  /**
   * `docSource: "ydoc"` only: the entry sheet's room is already connected (and possibly
   * materialized from the doc). Adopted into the pool so its first bind baselines only.
   */
  initial?: { sheetPath: string; session: KicadDocSession; editorMatchesDoc: boolean };
}

/** One warm room. `binding` is non-null ONLY while this is the active sheet. */
interface Room {
  session: KicadDocSession;
  doc: Y.Doc;
  binding?: KicadBinding;
  /** Flipped on first activation (seeded/adopted into the editor at least once). */
  seeded: boolean;
  /** ydoc-entry sheet: its open file was materialized from this doc (baseline-only). */
  editorMatchesDoc: boolean;
  /** A remote update arrived while this sheet was parked → catch-up adopt on next bind. */
  dirty: boolean;
  /** Active only while parked: marks `dirty` on remote doc updates. */
  detachWatch?: () => void;
}

export function createSheetCollabManager(opts: SheetManagerOptions): SheetCollabManager {
  const { mod, win, scopeId, projectId, provider, seedDocForPath, log } = opts;
  const bridge = moduleItemsBridge(mod, win);
  const rooms = new Map<string, Room>();
  // In-flight connects, so connectAll() and switchTo() racing on the same sheet (api
  // mode, entry sheet) share ONE connection instead of opening the room twice.
  const connecting = new Map<string, Promise<Room>>();
  let activePath: string | null = null;
  let destroyed = false;
  // A manager is affine to the exact editor Module passed at construction.
  // Terminal native failure stops only editor binding/switch work; warm Yjs
  // rooms can remain useful until the manager's ordinary destroy lifecycle.
  let nativeSwitchStopped = false;
  const connectionAbort = new AbortController();
  const ownerWasAlreadyAborted = opts.signal?.aborted ?? false;
  const onOwnerAbort = () => {
    connectionAbort.abort(opts.signal?.reason);
    destroy();
  };
  if (!ownerWasAlreadyAborted) {
    opts.signal?.addEventListener("abort", onOwnerAbort, { once: true });
  }

  // Coalesce rapid navigations: only the LATEST requested sheet is actually bound, and
  // switches run one-at-a-time so concurrent `onSheetChanged` events can't interleave.
  let requestedPath: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  // Failed-switch retry backoff (bug 07): a failed ensureRoom used to leave the
  // editor unbound forever — every subsequent edit unsynced until the next manual
  // navigation. Event-driven retry, doubling 2s→30s, reset on any success.
  let retryDelayMs = 2000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  if (opts.initial) {
    const { sheetPath, session, editorMatchesDoc } = opts.initial;
    if (opts.readOnly) session.provider.awareness?.setLocalState(null);
    rooms.set(sheetPath, {
      session,
      doc: session.doc,
      seeded: false,
      editorMatchesDoc,
      dirty: false,
    });
  }
  if (ownerWasAlreadyAborted) onOwnerAbort();

  // Skeleton presence for every PARKED room (0003): mark this user as "in this
  // schematic, on `activePath`". The bound room is skipped — its full state is
  // published by the host's presence handle (rebound via onActiveChange).
  function publishSkeletons(): void {
    const user = opts.presenceUser;
    if (!user || !activePath) return;
    for (const [path, room] of rooms) {
      if (path === activePath) continue;
      const awareness = room.session.provider.awareness;
      if (awareness) publishSkeleton(awareness, user, "eeschema", activePath);
    }
  }

  async function ensureRoom(sheetPath: string): Promise<Room> {
    if (destroyed) throw new Error("sheet collab manager is destroyed");
    const existing = rooms.get(sheetPath);
    if (existing) return existing;
    const inflight = connecting.get(sheetPath);
    if (inflight) return inflight;

    const pending = (async () => {
      const session = await connectKicadDoc({
        provider,
        room: collabRoomId(scopeId, projectId, sheetPath),
        signal: connectionAbort.signal,
        syncTimeoutMs: opts.syncTimeoutMs,
      });
      // Teardown aborts the handshake. Keep this generation check too: a
      // provider constructor can finish after the abort before its wait starts.
      if (destroyed) {
        destroyKicadDocSession(session);
        throw new Error(`sheet room connected after destroy: ${sheetPath}`);
      }
      // Invisible observer (read-only-viewer): drop the provider's initial
      // empty awareness state before anyone can see it.
      if (opts.readOnly) session.provider.awareness?.setLocalState(null);
      const room: Room = {
        session,
        doc: session.doc,
        seeded: false,
        editorMatchesDoc: false,
        dirty: false,
      };
      rooms.set(sheetPath, room);
      log(`[sheet] warm room connected: ${sheetPath}`);
      // A room warmed after the first bind starts parked — give it a skeleton
      // right away so its roster shows this user without waiting for a switch.
      if (activePath && sheetPath !== activePath && opts.presenceUser) {
        const awareness = session.provider.awareness;
        if (awareness) {
          publishSkeleton(awareness, opts.presenceUser, "eeschema", activePath);
        }
      }
      return room;
    })();

    connecting.set(sheetPath, pending);
    try {
      return await pending;
    } finally {
      connecting.delete(sheetPath);
    }
  }

  // While a sheet is parked (no binding), any update to its doc is a remote edit (we
  // can't make local edits to a non-active screen). Flag it so the next bind catches up.
  function startWatch(room: Room): void {
    if (room.detachWatch) return;
    const onUpdate = () => {
      room.dirty = true;
    };
    room.doc.on("update", onUpdate);
    room.detachWatch = () => room.doc.off("update", onUpdate);
  }

  function detachBinding(room: Room): void {
    const binding = room.binding;
    if (!binding) return;
    // Clear identity before destroy. A pending seed continuation can then see
    // that another navigation already retired this exact binding.
    room.binding = undefined;
    binding.destroy();
    startWatch(room);
  }

  function detachBindingsExcept(sheetPath: string): void {
    for (const [path, room] of rooms) {
      if (path !== sheetPath) detachBinding(room);
    }
    if (activePath !== sheetPath) activePath = null;
  }

  async function doSwitch(sheetPath: string): Promise<void> {
    if (activePath === sheetPath) return;

    // Detach the OLD binding FIRST (before any await): the editor already navigated to
    // the new sheet, so the old binding's observer must stop applying remote edits onto
    // what is now the wrong (new) active screen. Its provider/doc stay warm.
    if (activePath) {
      const old = rooms.get(activePath);
      if (old) detachBinding(old);
    }
    activePath = null;

    const room = await ensureRoom(sheetPath);

    // Navigation can change while the room handshake is in flight. The room
    // remains useful in the warm pool, but only the latest requested sheet may
    // bind to the editor's singleton bridge.
    if (destroyed || requestedPath !== sheetPath) return;

    // Activating: stop tracking parked updates and bind the (warm) doc to the editor.
    room.detachWatch?.();
    room.detachWatch = undefined;

    const binding = bindKicadCollab(room.doc, bridge, { readOnly: opts.readOnly });
    room.binding = binding;
    const firstActivation = !room.seeded;

    try {
      if (firstActivation) {
        // First activation: file-seed an empty room, else adopt peer/server state.
        await binding.seed(seedDocForPath(sheetPath), {
          editorMatchesDoc: room.editorMatchesDoc,
        });
      } else if (room.dirty) {
        // Remote edits landed while parked: adopt to catch the editor's screen up.
        await binding.seed(undefined, { editorMatchesDoc: false });
      } else {
        // Clean revisit: the editor screen already matches the doc — baseline the differ
        // (rebound after the C++ rebaseline on navigation), no full re-apply.
        await binding.seed(undefined, { editorMatchesDoc: true });
      }
    } catch (err) {
      if (room.binding === binding) detachBinding(room);
      throw err;
    }

    // Snapshot/apply now waits for owner admission. Navigation or teardown can
    // supersede this switch while that ticket is queued. Do not publish a
    // stale binding after the await; its browser hook remains inert because
    // destroy() closes the binding before the next switch starts.
    if (
      destroyed ||
      requestedPath !== sheetPath ||
      room.binding !== binding
    ) {
      if (room.binding === binding) detachBinding(room);
      return;
    }

    if (firstActivation) {
      room.seeded = true;
      clog(`[sheet] seeded ${sheetPath} (editorMatchesDoc=${room.editorMatchesDoc})`);
    } else if (room.dirty) {
      clog(`[sheet] re-adopted ${sheetPath} (caught up parked remote edits)`);
    } else {
      clog(`[sheet] rebound ${sheetPath} (no apply)`);
    }

    room.dirty = false;
    room.editorMatchesDoc = false; // only meaningful for the first ydoc-entry seed
    activePath = sheetPath;
    opts.onActiveChange?.({ sheetPath, doc: room.doc, provider: room.session.provider });
    // AFTER the host rebound its full presence to the new room: refresh every
    // parked room's skeleton to point at the new sheet (incl. the old active
    // room, whose full state the host just cleared).
    publishSkeletons();
  }

  function switchTo(sheetPath: string): Promise<void> {
    if (destroyed || nativeSwitchStopped) return Promise.resolve();
    requestedPath = sheetPath;
    // The C++ navigation event means the singleton editor already targets this
    // sheet. Retire any old or still-seeding binding synchronously, before its
    // queued native projection can be delivered.
    const retiringActive = activePath !== null && activePath !== sheetPath;
    detachBindingsExcept(sheetPath);
    // The item binding is not the whole active-sheet lifetime. Presence,
    // comments, follow, drift, and project-path publication belong to the same
    // generation and must retire before the new room handshake/seed can wait.
    if (retiringActive) opts.onActiveChange?.(null);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const attempt = queue
      .then(() => {
        // Superseded by a newer navigation — skip this stale switch. The editor's active
        // screen always reflects `requestedPath`, so we only bind when they agree (the
        // seed/snapshot then reads the right screen).
        if (nativeSwitchStopped || requestedPath !== sheetPath) return;
        return doSwitch(sheetPath).then(() => {
          retryDelayMs = 2000; // bound succeeded — reset the backoff
        });
      })
      .catch((err) => {
        if (isTerminalOwnerJobError(err)) {
          nativeSwitchStopped = true;
          requestedPath = null;
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
          }
          cwarn(
            `[sheet] native switching stopped after terminal owner failure on ${sheetPath}`,
            err,
          );
          return;
        }
        cwarn(`[sheet] switchTo(${sheetPath}) failed`, err);
        // A document produced by a newer incompatible schema cannot become
        // bindable by retrying. Reject the caller (the initial boot turns this
        // into its version error) and do not create an endless timer loop.
        if ((err as { name?: string } | undefined)?.name === "SexprVersionError") {
          throw err;
        }
        // Still the sheet the editor shows and not yet bound → retry with backoff,
        // else the editor stays unbound and every edit silently never syncs.
        if (requestedPath === sheetPath && activePath !== sheetPath) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (
              !nativeSwitchStopped &&
              requestedPath === sheetPath &&
              activePath !== sheetPath
            ) {
              log(`[sheet] retrying switch to ${sheetPath}`);
              void switchTo(sheetPath).catch((retryErr) => {
                cwarn(`[sheet] retry of ${sheetPath} stopped`, retryErr);
              });
            }
          }, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 30000);
        }
      });
    // Keep the private serialization tail fulfilled so one operation failure
    // does not poison later navigation. A terminal Module failure instead
    // latches nativeSwitchStopped above; later events remain data-only.
    queue = attempt.catch(() => {});
    return attempt;
  }

  async function onboard(sheetPath: string): Promise<void> {
    if (destroyed) return;
    if (rooms.has(sheetPath)) return;
    log(`[sheet] onboarding new sheet ${sheetPath}`);
    try {
      await ensureRoom(sheetPath);
    } catch (err) {
      cwarn(`[sheet] onboard(${sheetPath}) failed`, err);
    }
  }

  function syncLayoutFromSave(sheetPath: string, fileText: string): void {
    const room = rooms.get(sheetPath);
    if (!room) return; // not a collab sheet (or still onboarding) — nothing to sync
    try {
      // Writing to a PARKED room's doc marks it dirty via startWatch — fine:
      // the diff-on-rebind adopt makes the catch-up cost the real delta only.
      if (syncLayoutToY(fileToDoc(fileText), room.doc, "layout-save")) {
        clog(`[sheet] layout save-sync: ${sheetPath} updated`);
      }
    } catch (err) {
      cwarn(`[sheet] layout save-sync failed for ${sheetPath}`, err);
    }
  }

  async function connectAll(sheetPaths: string[]): Promise<void> {
    if (destroyed) return;
    await Promise.all(
      sheetPaths.map((p) =>
        ensureRoom(p).catch((err) => {
          cwarn(`[sheet] failed to warm ${p}`, err);
          return null;
        }),
      ),
    );
  }

  function active(): ActiveSheet | null {
    if (!activePath) return null;
    const room = rooms.get(activePath);
    if (!room) return null;
    return { sheetPath: activePath, doc: room.doc, provider: room.session.provider };
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    opts.signal?.removeEventListener("abort", onOwnerAbort);
    connectionAbort.abort(
      new DOMException("The sheet collaboration manager was destroyed", "AbortError"),
    );
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    for (const [path, room] of rooms) {
      const detachWatch = room.detachWatch;
      room.detachWatch = undefined;
      try {
        detachWatch?.();
      } catch (err) {
        cwarn(`[sheet] detach watch for ${path} failed`, err);
      }

      // Invalidate identities before calling user/library destructors. Every
      // acquired resource then gets its own cleanup attempt: a throwing
      // binding or provider must not strand the room's socket or Y.Doc.
      const binding = room.binding;
      room.binding = undefined;
      try {
        binding?.destroy();
      } catch (err) {
        cwarn(`[sheet] destroy binding for ${path} failed`, err);
      }
      try {
        destroyKicadDocSession(room.session);
      } catch (err) {
        cwarn(`[sheet] destroy session for ${path} failed`, err);
      }
    }
    rooms.clear();
    connecting.clear();
    activePath = null;
    requestedPath = null;
    opts.onActiveChange?.(null);
  }

  return { connectAll, switchTo, onboard, syncLayoutFromSave, active, destroy };
}

export interface SheetChangedWindow {
  kicadCollab?: { onSheetChanged?: (absPath: string) => void };
}

/**
 * Register the C++ → JS sheet-navigation sink (`window.kicadCollab.onSheetChanged`),
 * fired from eeschema's `DisplayCurrentSheet` with the now-active screen's file path.
 * Spread-merges so sibling hooks (onSave / onItems) registered before or after survive.
 */
export function registerSheetChangedHook(
  win: SheetChangedWindow,
  onSheetChanged: (absPath: string) => void,
): void {
  win.kicadCollab = { ...win.kicadCollab, onSheetChanged };
}

export interface SheetCreatedWindow {
  kicadCollab?: { onSheetCreated?: (absPath: string) => void };
}

/**
 * Register the C++ → JS sheet-CREATION sink (`window.kicadCollab.onSheetCreated`), fired
 * when eeschema adds a hierarchical sheet — the child .kicad_sch has just been written to
 * MEMFS by the hook. The handler registers that child with the backend + warms its room,
 * so a subsheet that's placed but never entered or saved still persists. Spread-merges so
 * sibling hooks survive.
 */
export function registerSheetCreatedHook(
  win: SheetCreatedWindow,
  onSheetCreated: (absPath: string) => void,
): void {
  win.kicadCollab = { ...win.kicadCollab, onSheetCreated };
}
