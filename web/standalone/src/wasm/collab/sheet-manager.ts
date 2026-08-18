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
  // destroy() ran — a connect resolving after it must tear its session down
  // instead of registering a leaked socket+doc (findings C-1).
  let destroyed = false;

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

  async function ensureRoom(
    sheetPath: string,
    connectOpts?: { passive?: boolean },
  ): Promise<Room> {
    const existing = rooms.get(sheetPath);
    if (existing) return existing;
    const inflight = connecting.get(sheetPath);
    if (inflight) return inflight;

    const pending = (async () => {
      const session = await connectKicadDoc({
        provider,
        room: collabRoomId(scopeId, projectId, sheetPath),
        passive: connectOpts?.passive,
      });
      if (destroyed) {
        // The manager died while this connect was in flight (unmount during
        // connectAll's warm fan-out) — the session must not outlive it.
        session.provider.destroy();
        session.doc.destroy();
        throw new Error(`sheet manager destroyed while connecting ${sheetPath}`);
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
      // Gateway transport: a `touched` hint means the doc changed server-side
      // while this subscription was passive — same catch-up contract as the
      // parked-update watch.
      session.provider.onTouched?.(() => {
        room.dirty = true;
      });
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

  async function doSwitch(sheetPath: string): Promise<void> {
    if (activePath === sheetPath) return;

    // Detach the OLD binding FIRST (before any await): the editor already navigated to
    // the new sheet, so the old binding's observer must stop applying remote edits onto
    // what is now the wrong (new) active screen. Its provider/doc stay warm.
    const hadActive = activePath !== null;
    if (activePath) {
      const old = rooms.get(activePath);
      if (old?.binding) {
        old.binding.destroy();
        old.binding = undefined;
        startWatch(old);
      }
    }
    activePath = null;
    // Clear the HOST's per-sheet callbacks BEFORE the connect window too
    // (findings C-4): presence push/release, comment pins, follow-user fit and
    // drift checks were still subscribed to the OLD room while the new sheet
    // connected and seeded — each could drive the editor (now showing the new
    // sheet) from old-room state. onActiveChange(null) is the same host
    // contract destroy() already uses; the host rebinds after the seed below.
    if (hadActive) opts.onActiveChange?.(null);

    const room = await ensureRoom(sheetPath);
    if (destroyed) return;
    // Gateway transport: a passively-warmed sheet holds no doc state yet —
    // activate() is the real sync barrier (no-op for other providers and on
    // revisits). Runs BEFORE the watch detaches so catch-up updates still
    // mark `dirty` for the adopt decision below.
    await room.session.provider.activate?.();
    if (destroyed) return;

    // Activating: stop tracking parked updates and bind the (warm) doc to the editor.
    room.detachWatch?.();
    room.detachWatch = undefined;

    const binding = bindKicadCollab(room.doc, bridge, { readOnly: opts.readOnly });
    room.binding = binding;

    if (!room.seeded) {
      // First activation: file-seed an empty room, else adopt peer/server state.
      binding.seed(seedDocForPath(sheetPath), { editorMatchesDoc: room.editorMatchesDoc });
      room.seeded = true;
      clog(`[sheet] seeded ${sheetPath} (editorMatchesDoc=${room.editorMatchesDoc})`);
    } else if (room.dirty) {
      // Remote edits landed while parked: adopt to catch the editor's screen up.
      binding.seed(undefined, { editorMatchesDoc: false });
      clog(`[sheet] re-adopted ${sheetPath} (caught up parked remote edits)`);
    } else {
      // Clean revisit: the editor screen already matches the doc — baseline the differ
      // (rebound after the C++ rebaseline on navigation), no full re-apply.
      binding.seed(undefined, { editorMatchesDoc: true });
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
    requestedPath = sheetPath;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const attempt = queue
      .then(() => {
        // Superseded by a newer navigation — skip this stale switch. The editor's active
        // screen always reflects `requestedPath`, so we only bind when they agree (the
        // seed/snapshot then reads the right screen).
        if (requestedPath !== sheetPath) return;
        return doSwitch(sheetPath).then(() => {
          retryDelayMs = 2000; // bound succeeded — reset the backoff
        });
      })
      .catch((err: unknown) => {
        cwarn(`[sheet] switchTo(${sheetPath}) failed`, err);
        // Terminal version skew (findings C-5): retrying cannot make an
        // incompatible doc encoding bindable. No retry timer — rethrow so the
        // caller surfaces it (boot converts it into the user-visible version
        // error instead of reporting "connected" with no binding). A gateway
        // subscription rejection (invalid-file 409 — load-path-rework 0003)
        // is terminal the same way: the flag only clears on a new upload.
        const name = (err as { name?: string } | null)?.name;
        if (name === "SexprVersionError" || name === "CollabSubRejectedError") {
          throw err;
        }
        // Still the sheet the editor shows and not yet bound → retry with backoff,
        // else the editor stays unbound and every edit silently never syncs.
        if (!destroyed && requestedPath === sheetPath && activePath !== sheetPath) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (requestedPath === sheetPath && activePath !== sheetPath) {
              log(`[sheet] retrying switch to ${sheetPath}`);
              void switchTo(sheetPath);
            }
          }, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 30000);
        }
      });
    // The terminal rejection must reach the CALLER, but must not poison the
    // serialization queue for later explicit navigation.
    queue = attempt.catch(() => {});
    return attempt;
  }

  async function onboard(sheetPath: string): Promise<void> {
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
    const write = (): void => {
      try {
        // Writing to a PARKED room's doc marks it dirty via startWatch — fine:
        // the diff-on-rebind adopt makes the catch-up cost the real delta only.
        if (syncLayoutToY(fileToDoc(fileText), room.doc, "layout-save")) {
          clog(`[sheet] layout save-sync: ${sheetPath} updated`);
        }
      } catch (err) {
        cwarn(`[sheet] layout save-sync failed for ${sheetPath}`, err);
      }
    };
    // Gateway transport: a passively-warmed doc is empty — writing into it
    // would push partial state. A save IS write demand, so sync first.
    const activate = room.session.provider.activate?.();
    if (activate) {
      void activate.then(write).catch((err) => {
        cwarn(`[sheet] layout save-sync activate failed for ${sheetPath}`, err);
      });
    } else {
      write();
    }
  }

  async function connectAll(sheetPaths: string[]): Promise<void> {
    await Promise.all(
      sheetPaths.map((p) =>
        // Passive on the gateway (load-path-rework 0003): warm-all becomes
        // pure registration — awareness + touched hints flow, but no
        // BoardRoom wakes for a sheet nobody opens or edits.
        ensureRoom(p, { passive: true }).catch((err) => {
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
    destroyed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    for (const [path, room] of rooms) {
      try {
        room.detachWatch?.();
        room.binding?.destroy();
        room.session.provider.destroy();
        room.doc.destroy();
      } catch (err) {
        cwarn(`[sheet] destroy ${path} failed`, err);
      }
    }
    rooms.clear();
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
