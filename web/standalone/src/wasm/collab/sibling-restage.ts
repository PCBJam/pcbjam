import { collabRoomId, docToFile, ydocHasState, ydocIsHollow, yToDoc } from "@pcbjam/shared";
import type * as Y from "yjs";
import { restageFile } from "../kicad-runner";
import { connectKicadDoc, type KicadDocSession } from "./index";
import type { ProviderConfig } from "./provider";

/**
 * Live sibling-document mirror for pcbnew sessions (project-sync 0001 bug 3).
 *
 * Boot stages every project file into MEMFS exactly once (kicad-runner
 * syncProjectToMemfs) — and since the files route materializes from the ydoc,
 * that snapshot is room-fresh at fetch time. A sheet can therefore only drift
 * from its MEMFS copy while SOMEONE IS EDITING IT — and whoever does sits in
 * the project presence room announcing which document their tab has open
 * (PresenceState.sheetPath). So instead of eagerly holding one board-room
 * WebSocket per sibling schematic for the whole session, this watches the
 * presence roster and connects a sheet's room only while a peer (including the
 * same user's other tab) actually has it open — a solo session holds ZERO
 * sibling sockets. On connect it restages once (the peer may have edited
 * between our boot fetch and now), then re-materializes into MEMFS on updates,
 * debounced like the lib refresh. When the peer leaves, the socket lingers
 * briefly (reload flaps), flushes a final restage, and closes.
 *
 * Without a presence room (provider "none", connect failure) it falls back to
 * the eager mode: every in-scope sheet is watched for the whole session.
 *
 * MEMFS-only: nothing is uploaded and no editor poke is needed — pcbnew reads
 * the schematic from MEMFS when the sync runs. Accepted v1 gaps: a sheet
 * created by a peer mid-session (path not in the boot file list), and a peer
 * whose edit lands between our boot fetch and their presence entry reaching us
 * (a seconds-wide window during boot; the next load heals it).
 */

const RESTAGE_DEBOUNCE_MS = 400;
/** How long a watch outlives its last announcing peer (reload/nav flaps). */
const CLOSE_LINGER_MS = 30_000;

export interface SiblingRestageHandle {
  destroy(): void;
}

/**
 * The slice of `CrossAppHandle` this consumes (structural, so tests fake it):
 * the project-presence roster + its change feed.
 */
export interface SiblingPresence {
  peers(): Array<{ state: { sheetPath?: string } }>;
  subscribe(cb: () => void): () => void;
}

interface Watch {
  session?: KicadDocSession;
  connecting?: Promise<void>;
  linger?: ReturnType<typeof setTimeout>;
  /**
   * Connect failed — retry on a doubling-backoff timer (1s→30s), never on
   * roster churn (findings C-6: a failed first dial used to latch `failed`
   * forever, so a peer editing through a transient outage left MEMFS stale
   * for the whole session).
   */
  retry?: ReturnType<typeof setTimeout>;
  retryDelayMs?: number;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

export async function startSiblingRestage(opts: {
  win: ToolWindow;
  slug: string;
  scopeId: string;
  projectId: string;
  files: { path: string }[];
  /** The opened `.kicad_pcb` — scopes the watch to ITS KiCad project. */
  targetPath?: string;
  /** Project presence roster; omitted ⇒ eager mode (watch every sheet). */
  presence?: SiblingPresence;
  provider: ProviderConfig;
  log: (m: string) => void;
}): Promise<SiblingRestageHandle> {
  const { win, slug, log } = opts;
  // Only the opened board's own KiCad project can be synced from: pcbnew's
  // "update from schematic" reads the sheets next to the .kicad_pcb (same
  // directory tree). A backend project holding SEVERAL KiCad projects (a
  // repo of boards) must not fan out repo-wide — that held ~27 idle
  // board-room sockets for an 8-board repo. Sheets a project references
  // OUTSIDE its directory (rare ../ sheet paths) fall back to the boot
  // snapshot — same gap v1 already accepts for new sheets.
  const dir = opts.targetPath
    ? opts.targetPath.slice(0, opts.targetPath.lastIndexOf("/") + 1)
    : "";
  const sheetPaths = opts.files
    .map((f) => f.path)
    .filter((p) => p.endsWith(".kicad_sch") && p.startsWith(dir));
  const sheetSet = new Set(sheetPaths);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let destroyed = false;

  const restageFromDoc = (sheetPath: string, doc: Y.Doc) => {
    try {
      // An empty room means no one ever seeded this sheet — the boot-staged
      // API snapshot is the freshest copy there is; leave it alone.
      if (!ydocHasState(doc)) return;
      // A hollow doc (layout only, never seeded) would restage a title-block-only
      // file over the real one — the staged copy is the freshest there is.
      if (ydocIsHollow(doc)) return;
      const text = docToFile(yToDoc(doc));
      restageFile(win, slug, sheetPath, new TextEncoder().encode(text), log);
    } catch (err) {
      log(`[sibling] restage failed for ${sheetPath}: ${String(err)}`);
    }
  };

  const schedule = (sheetPath: string, doc: Y.Doc) => {
    const prev = timers.get(sheetPath);
    if (prev) clearTimeout(prev);
    timers.set(
      sheetPath,
      setTimeout(() => {
        timers.delete(sheetPath);
        if (!destroyed) restageFromDoc(sheetPath, doc);
      }, RESTAGE_DEBOUNCE_MS),
    );
  };

  const openSession = async (sheetPath: string): Promise<KicadDocSession | null> => {
    const session = await connectKicadDoc({
      provider: opts.provider,
      room: collabRoomId(opts.scopeId, opts.projectId, sheetPath),
    });
    if (destroyed) {
      session.provider.destroy();
      session.doc.destroy();
      return null;
    }
    // Data-only observer: never appear in the sheet's presence roster
    // (mirrors the sheet-manager's read-only invisible-observer handling).
    session.provider.awareness?.setLocalState(null);
    session.doc.on("update", () => schedule(sheetPath, session.doc));
    log(`[sibling] watching ${sheetPath}`);
    restageFromDoc(sheetPath, session.doc);
    return session;
  };

  /* ------------------------- eager fallback (no presence room) ------------ */

  if (!opts.presence) {
    const sessions: KicadDocSession[] = [];
    await Promise.all(
      sheetPaths.map(async (sheetPath) => {
        try {
          const session = await openSession(sheetPath);
          if (session) sessions.push(session);
        } catch (err) {
          log(`[sibling] room connect failed for ${sheetPath}: ${String(err)}`);
        }
      }),
    );
    return {
      destroy() {
        destroyed = true;
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        for (const s of sessions) {
          s.provider.destroy();
          s.doc.destroy();
        }
        sessions.length = 0;
      },
    };
  }

  /* ------------------------- presence-driven mode ------------------------- */

  const presence = opts.presence;
  const watches = new Map<string, Watch>();

  const closeNow = (sheetPath: string, w: Watch, flushPending: boolean) => {
    const t = timers.get(sheetPath);
    if (t) {
      clearTimeout(t);
      timers.delete(sheetPath);
      // A debounced restage was pending — run it before dropping the doc, or
      // the peer's last burst of edits never reaches MEMFS.
      if (flushPending && w.session) restageFromDoc(sheetPath, w.session.doc);
    }
    if (w.linger) clearTimeout(w.linger);
    if (w.retry) clearTimeout(w.retry);
    w.session?.provider.destroy();
    w.session?.doc.destroy();
    watches.delete(sheetPath);
  };

  /** Is this sheet still announced by some peer right now? */
  const wanted = (sheetPath: string): boolean =>
    presence.peers().some((p) => p.state.sheetPath === sheetPath);

  const dial = (sheetPath: string, watch: Watch): void => {
    watch.connecting = (async () => {
      try {
        const session = await openSession(sheetPath);
        if (session) {
          watch.session = session;
          watch.retryDelayMs = undefined; // success resets the backoff
        }
      } catch (err) {
        log(`[sibling] room connect failed for ${sheetPath}: ${String(err)}`);
        const delay = watch.retryDelayMs ?? RETRY_BASE_MS;
        watch.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
        if (!destroyed) {
          watch.retry = setTimeout(() => {
            watch.retry = undefined;
            if (destroyed || watch.session || watch.connecting) return;
            // Re-dial only while this exact watch is live and a peer still
            // has the sheet open — a released/lingering watch stays quiet.
            if (watches.get(sheetPath) === watch && wanted(sheetPath)) {
              dial(sheetPath, watch);
            }
          }, delay);
        }
      } finally {
        watch.connecting = undefined;
      }
    })();
  };

  const reconcile = () => {
    if (destroyed) return;
    const open = new Set<string>();
    for (const p of presence.peers()) {
      const sp = p.state.sheetPath;
      if (sp && sheetSet.has(sp)) open.add(sp);
    }
    for (const sheetPath of open) {
      const w = watches.get(sheetPath);
      if (w?.linger) {
        clearTimeout(w.linger);
        w.linger = undefined;
      }
      if (!w) {
        const watch: Watch = {};
        watches.set(sheetPath, watch);
        dial(sheetPath, watch);
      }
    }
    for (const [sheetPath, w] of watches) {
      if (open.has(sheetPath) || w.linger) continue;
      w.linger = setTimeout(() => {
        if (destroyed) return;
        log(`[sibling] releasing ${sheetPath} (no peer has it open)`);
        closeNow(sheetPath, w, true);
      }, CLOSE_LINGER_MS);
    }
  };

  const unsubscribe = presence.subscribe(reconcile);
  reconcile();
  log(
    `[sibling] presence-scoped watch over ${sheetPaths.length} sheet(s) — ` +
      `connecting only while a peer has one open`,
  );

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const [sheetPath, w] of [...watches]) closeNow(sheetPath, w, false);
    },
  };
}
