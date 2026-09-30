/**
 * Project sidecar rooms (proposal 21 WP5): the open project's `.kicad_pro`
 * (JSON, per-key merge) and the board's `.kicad_dru` (custom rules, per-region
 * text merge) as live Yjs rooms instead of save-time CAS uploads.
 *
 *  - local → room: KiCad writes these files WHOLE (File→Save, and — through the
 *    native project check — every Board/Schematic Setup OK). The save hook hands
 *    the text here; it is patched into the room relative to the baseline this
 *    tab last agreed on, so a peer's concurrent edit of another key / rule
 *    survives. The first save into an empty room seeds it.
 *  - room → local: a peer's change renders to text, lands in MEMFS and the
 *    editor reloads it natively (project settings / DRC rules) — no reload of
 *    the page, no save needed.
 *
 * Watches are passive pulls (the gateway answers from the at-rest state and
 * re-pulls on `touched`), exactly like the sibling-schematic mirror; a write
 * activates the room first.
 */
import { collabRoomId, sidecarCodecFor, type SidecarCodec } from "@pcbjam/shared";
import { copySegment } from "@/lib/copy-context";
import { memfsFilePath } from "../constants";
import { restageFile } from "../kicad-runner";
import { cwarn } from "./debug";
import { connectKicadDoc, type KicadDocSession } from "./index";
import type { ProviderConfig } from "./provider";

const RESTAGE_DEBOUNCE_MS = 300;

export interface SidecarRooms {
  /** Is `relPath` synced through a connected sidecar room? (save policy "room") */
  isRoomPath(relPath: string): boolean;
  /** A saved sidecar file's text: patch it into its room. False = not ours. */
  onSaved(relPath: string, text: string): boolean;
  destroy(): void;
}

interface Watch {
  path: string;
  codec: SidecarCodec;
  session: KicadDocSession;
  /** The text this tab last agreed on (staged / saved / restaged). */
  baseline: string | undefined;
  timer?: ReturnType<typeof setTimeout>;
}

/** The sidecar paths of an open document: its project file, and a board's rules file. */
export function sidecarPathsFor(tool: string, targetPath: string | undefined): string[] {
  if (!targetPath) return [];
  const stem = targetPath.replace(/\.kicad_(pcb|sch)$/, "");
  if (stem === targetPath) return [];
  if (tool === "pcbnew") return [`${stem}.kicad_pro`, `${stem}.kicad_dru`];
  if (tool === "eeschema") return [`${stem}.kicad_pro`];
  return [];
}

export async function startSidecarRooms(opts: {
  win: {
    FS?: {
      readFile(path: string, o?: { encoding: "utf8" }): string | Uint8Array;
      writeFile?(path: string, data: Uint8Array): void;
      mkdirTree?(path: string): void;
    };
  };
  slug: string;
  scopeId: string;
  projectId: string;
  paths: readonly string[];
  provider: ProviderConfig;
  log: (m: string) => void;
  /** A peer's version was restaged into MEMFS: reload it natively. */
  onRestaged: (relPath: string, text: string) => void;
  /** Where a room path lives in MEMFS (default: the project's staging tree). */
  memfsPathOf?: (relPath: string) => string;
  /** Test seam. */
  connect?: typeof connectKicadDoc;
}): Promise<SidecarRooms> {
  const connect = opts.connect ?? connectKicadDoc;
  const pathOf = opts.memfsPathOf ?? ((relPath: string) => memfsFilePath(opts.slug, relPath));
  const watches = new Map<string, Watch>();
  let destroyed = false;

  const readStaged = (relPath: string): string | undefined => {
    try {
      const v = opts.win.FS?.readFile(pathOf(relPath), { encoding: "utf8" });
      return typeof v === "string" ? v : v ? new TextDecoder().decode(v) : undefined;
    } catch {
      return undefined; // not created yet (a board without custom rules)
    }
  };

  const pullRemote = (w: Watch): void => {
    try {
      const text = w.codec.render(w.session.doc);
      if (text === null || text === w.baseline) return;
      w.baseline = text;
      if (opts.memfsPathOf && opts.win.FS?.writeFile) {
        const dest = pathOf(w.path);
        opts.win.FS.mkdirTree?.(dest.slice(0, dest.lastIndexOf("/")));
        opts.win.FS.writeFile(dest, new TextEncoder().encode(text));
      } else {
        restageFile(opts.win as never, opts.slug, w.path, new TextEncoder().encode(text), opts.log);
      }
      opts.onRestaged(w.path, text);
    } catch (err) {
      cwarn(`[sidecar-room] ${w.path}: remote render failed`, err);
    }
  };

  await Promise.all(
    opts.paths.map(async (path) => {
      const codec = sidecarCodecFor(path);
      if (!codec) return;
      try {
        const session = await connect({
          provider: opts.provider,
          room: collabRoomId(opts.scopeId, opts.projectId, path, copySegment()),
          passive: true,
          passiveSync: true,
        });
        if (destroyed) {
          session.provider.destroy();
          session.doc.destroy();
          return;
        }
        session.provider.awareness?.setLocalState(null); // data-only observer
        const w: Watch = { path, codec, session, baseline: readStaged(path) };
        watches.set(path, w);
        // The staged copy came from the file route (which materializes the room),
        // but the room may have moved on since — catch up once.
        pullRemote(w);
        session.doc.on("update", (_u: Uint8Array, _origin: unknown, _doc: unknown, txn: { local: boolean }) => {
          if (txn.local || destroyed) return;
          if (w.timer) clearTimeout(w.timer);
          w.timer = setTimeout(() => {
            w.timer = undefined;
            if (!destroyed) pullRemote(w);
          }, RESTAGE_DEBOUNCE_MS);
        });
        opts.log(`[sidecar-room] watching ${path}`);
      } catch (err) {
        // No room ⇒ the file keeps the plain upload path (isRoomPath false).
        cwarn(`[sidecar-room] ${path}: connect failed — keeping the upload path`, err);
      }
    }),
  );

  return {
    isRoomPath: (relPath) => watches.has(relPath),
    onSaved(relPath, text) {
      const w = watches.get(relPath);
      if (!w || destroyed) return false;
      const write = (): void => {
        try {
          if (w.codec.patch(w.session.doc, text, w.codec.isEmpty(w.session.doc) ? undefined : w.baseline, "sidecar-save")) {
            opts.log(`[sidecar-room] ${relPath}: saved into its room`);
          }
          w.baseline = text;
        } catch (err) {
          cwarn(`[sidecar-room] ${relPath}: save patch failed`, err);
        }
      };
      // A write IS demand: a passively-watched doc syncs before we patch it.
      const activate = w.session.provider.activate?.();
      if (activate) void activate.then(write).catch((err) => cwarn(`[sidecar-room] ${relPath}: activate failed`, err));
      else write();
      return true;
    },
    destroy() {
      destroyed = true;
      for (const w of watches.values()) {
        if (w.timer) clearTimeout(w.timer);
        try {
          w.session.provider.destroy();
          w.session.doc.destroy();
        } catch {
          /* best-effort */
        }
      }
      watches.clear();
    },
  };
}
