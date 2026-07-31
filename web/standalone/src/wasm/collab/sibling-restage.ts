import { collabRoomId, docToFile, ydocHasState, yToDoc } from "@pcbjam/shared";
import type * as Y from "yjs";
import { restageFile } from "../kicad-runner";
import { connectKicadDoc, type KicadDocSession } from "./index";
import type { ProviderConfig } from "./provider";

/**
 * Live sibling-document mirror for pcbnew sessions (project-sync 0001 bug 3).
 *
 * Boot stages every project file into MEMFS exactly once (kicad-runner
 * syncProjectToMemfs), so the `.kicad_sch` a PCB session would sync from is a
 * page-load snapshot while collaborators keep editing it in its own room. This
 * subscribes — as an invisible, data-only observer — to every sibling sheet's
 * collab room and re-materializes the file into MEMFS on updates, debounced
 * like the lib refresh (synced-source scheduleEditorReload). It also restages
 * once right after connect: the room is the source of truth since ysync, so it
 * can already be ahead of the API snapshot boot fetched (unsaved collab edits
 * live only in the room).
 *
 * MEMFS-only: nothing is uploaded and no editor poke is needed — pcbnew reads
 * the schematic from MEMFS when the sync runs. A sheet created by a peer
 * mid-session is not picked up (its path isn't in the boot file list); v1
 * accepts that gap.
 */

const RESTAGE_DEBOUNCE_MS = 400;

export interface SiblingRestageHandle {
  destroy(): void;
}

export async function startSiblingRestage(opts: {
  win: ToolWindow;
  slug: string;
  scopeId: string;
  projectId: string;
  files: { path: string }[];
  /** The opened `.kicad_pcb` — scopes the watch to ITS KiCad project. */
  targetPath?: string;
  provider: ProviderConfig;
  log: (m: string) => void;
}): Promise<SiblingRestageHandle> {
  const { win, slug, log } = opts;
  // Only the opened board's own KiCad project can be synced from: pcbnew's
  // "update from schematic" reads the sheets next to the .kicad_pcb (same
  // directory tree). A backend project holding SEVERAL KiCad projects (a
  // repo of boards) must not fan out one room per schematic repo-wide —
  // that held ~27 idle board-room sockets for an 8-board repo. Sheets a
  // project references OUTSIDE its directory (rare ../ sheet paths) fall
  // back to the boot snapshot — same gap v1 already accepts for new sheets.
  const dir = opts.targetPath
    ? opts.targetPath.slice(0, opts.targetPath.lastIndexOf("/") + 1)
    : "";
  const sheetPaths = opts.files
    .map((f) => f.path)
    .filter((p) => p.endsWith(".kicad_sch") && p.startsWith(dir));

  const sessions: KicadDocSession[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let destroyed = false;

  const restageFromDoc = (sheetPath: string, doc: Y.Doc) => {
    try {
      // An empty room means no one ever seeded this sheet — the boot-staged
      // API snapshot is the freshest copy there is; leave it alone.
      if (!ydocHasState(doc)) return;
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

  await Promise.all(
    sheetPaths.map(async (sheetPath) => {
      try {
        const session = await connectKicadDoc({
          provider: opts.provider,
          room: collabRoomId(opts.scopeId, opts.projectId, sheetPath),
        });
        if (destroyed) {
          session.provider.destroy();
          session.doc.destroy();
          return;
        }
        // Data-only observer: never appear in the sheet's presence roster
        // (mirrors the sheet-manager's read-only invisible-observer handling).
        session.provider.awareness?.setLocalState(null);
        sessions.push(session);
        session.doc.on("update", () => schedule(sheetPath, session.doc));
        log(`[sibling] watching ${sheetPath}`);
        restageFromDoc(sheetPath, session.doc);
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
