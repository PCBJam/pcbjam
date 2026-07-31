import type { Tool } from "@pcbjam/shared";
import { FILELESS_TOOLS, toolForFile } from "@pcbjam/shared";
import { defaultKicadPro } from "../lib/new-file";
import { memfsFilePath, memfsProjectDir } from "./constants";
import { mark } from "./load-trace";
import { prescanBoardModels } from "./libs/models-bridge";
import { openFileInTool } from "./open-flow";

/**
 * The only thing the editor needs to know about a file to sync it into MEMFS:
 * its project-relative POSIX path. Both the contract loader (whose ProjectFile
 * is a superset of this) and the local-folder loader satisfy it.
 */
export interface ToolFile {
  path: string;
}

export interface DriveOptions {
  tool: Tool;
  slug: string;
  files: ToolFile[];
  targetPath?: string;
  fetchBytes: (relPath: string) => Promise<Uint8Array>;
  log: (msg: string) => void;
  onStatus: (text: string) => void;
  /** Per-file staging progress (files fetched+written so far, total) — drives
   *  the boot overlay's "Project files — n/m" line. Reported once up front
   *  with done=0 so the line appears as soon as staging starts. */
  onFileProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (performance.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function getFS(win: ToolWindow): EmscriptenFS {
  const fs = win.FS ?? win.Module?.FS;
  if (!fs) throw new Error("Emscripten FS not available");
  return fs as EmscriptenFS;
}

/**
 * Write one project file into the tool's MEMFS. Shared by the boot-time
 * whole-tree staging below and the live sibling re-stage (collab/sibling-restage):
 * a peer's schematic edits must land in MEMFS so "Update PCB from Schematic"
 * reads current data, not the page-load snapshot.
 */
export function restageFile(
  win: ToolWindow,
  slug: string,
  relPath: string,
  bytes: Uint8Array,
  log: (msg: string) => void,
): void {
  const fs = getFS(win);
  const dest = memfsFilePath(slug, relPath);
  fs.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
  fs.writeFile(dest, bytes);
  log(`[memfs] wrote ${dest} (${bytes.length} bytes)`);
}

/** How many project files are fetched at once by the MEMFS staging below.
 *  Matches the lib presync's default: enough to hide per-request latency on a
 *  many-file project, low enough not to starve the parallel wasm download. */
const STAGE_CONCURRENCY = 8;

/**
 * Mirror the whole project tree into the tool's MEMFS (sync-whole-tree).
 *
 * Fetches run CONCURRENTLY (bounded by STAGE_CONCURRENCY): a project with a
 * few hundred files — an uploaded repo, say — spent one full request
 * round-trip per file when this was serial, which dominated the open on any
 * real-latency connection. The writes themselves are synchronous FS calls on
 * distinct paths, so they can land in whatever order the fetches complete.
 */
async function syncProjectToMemfs(win: ToolWindow, opts: DriveOptions): Promise<void> {
  getFS(win).mkdirTree(memfsProjectDir(opts.slug));

  let staged = 0;
  opts.onFileProgress?.(0, opts.files.length);
  const queue = [...opts.files];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const bytes = await opts.fetchBytes(file.path);
      restageFile(win, opts.slug, file.path, bytes, opts.log);
      opts.onFileProgress?.(++staged, opts.files.length);
      // 3D models: prefetch every model this board references (R2 → IDB → MEMFS)
      // so the 3D viewer's first open resolves locally. Fire-and-forget — project
      // open never waits on it; a ref that misses falls back to the C++ per-model
      // ensure. No-op unless a model source is installed (bootKicadTool).
      if (file.path.endsWith(".kicad_pcb")) {
        const text = new TextDecoder().decode(bytes);
        void prescanBoardModels(text).catch((e) =>
          opts.log(`[3d] prescan failed: ${String(e)}`),
        );
      }
    }
  };
  // One rejection fails the stage (same as the serial loop did), but let the
  // in-flight siblings settle first so a failure can't leave a fetch writing
  // into MEMFS after the caller has moved on.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(STAGE_CONCURRENCY, opts.files.length) }, worker),
  );
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

/**
 * KiCad expects a `<stem>.kicad_pro` next to a board/schematic; without one it
 * runs on an in-memory defaults project, so nothing project-scoped (netclasses,
 * ERC/DRC exclusions, text variables) persists — and the settings save paths
 * are gated on the file existing at all. pcbjam projects historically carry no
 * project file (docs/features/project-sync/0001), so seed a minimal one into
 * MEMFS for the target document when the project doesn't provide its own.
 * MEMFS-only: it is not added to the project file list or uploaded.
 */
function synthesizeProjectFile(win: ToolWindow, opts: DriveOptions): void {
  const match = (opts.targetPath ?? "").match(/^(.*)\.kicad_(pcb|sch)$/);
  if (!match) return;
  const proPath = `${match[1]}.kicad_pro`;
  if (opts.files.some((f) => f.path === proPath)) return;
  const fileName = proPath.slice(proPath.lastIndexOf("/") + 1);
  const bytes = new TextEncoder().encode(defaultKicadPro(fileName));
  getFS(win).writeFile(memfsFilePath(opts.slug, proPath), bytes);
  opts.log(`[memfs] synthesized ${proPath} (project has no project file)`);
}

/**
 * Every gerber/drill sibling of `targetPath`, in stable filename order.
 *
 * A fabrication set is a stack — copper layers, mask, silk, edge cuts, plus the
 * Excellon drill files — and they are conventionally emitted into one folder.
 * Opening only the clicked layer shows a near-empty canvas, so the clicked
 * FOLDER is the real unit. `toolForFile` owns the extension list (it is what
 * decided this route is gerbview in the first place); drill files come along
 * because GerbView routes them to the Excellon loader itself.
 */
export function gerberSiblings(files: ToolFile[], targetPath: string): string[] {
  const slash = targetPath.lastIndexOf("/");
  const dir = slash < 0 ? "" : targetPath.slice(0, slash + 1);
  const inDir = files
    .map((f) => f.path)
    .filter((path) => {
      if (!path.startsWith(dir)) return false;
      if (path.slice(dir.length).includes("/")) return false; // nested deeper
      return toolForFile(path) === "gerbview";
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // The clicked file always opens, even if its extension is unusual enough that
  // toolForFile missed it (the route named it, so the user meant it).
  return inDir.includes(targetPath) ? inDir : [targetPath, ...inDir];
}

/**
 * Open a whole gerber set in GerbView. Prefers the multi-file embind entry
 * (`kicadOpenFiles`); a bundle predating it falls back to the single-file open
 * of just the clicked layer, which is the old behavior and still renders.
 */
async function openGerberSet(
  win: ToolWindow,
  opts: DriveOptions,
): Promise<"programmatic" | "ui" | "failed"> {
  const paths = gerberSiblings(opts.files, opts.targetPath!);
  const abs = paths.map((path) => memfsFilePath(opts.slug, path));
  return openFileInTool(win, abs[0]!, {
    log: opts.log,
    open: () => {
      // Feature-detect HERE, not before the call: embind registers the Module
      // functions during runtime init, which lands AFTER the Emscripten FS is
      // ready — i.e. after we get here from driveProjectIntoTool. Probing any
      // earlier always misses and silently degrades to the single-file open
      // (openFileInTool's frame wait is what guarantees the exports exist).
      const mod = win.Module as
        | {
            kicadOpenFiles?: (json: string) => boolean;
            kicadOpenFile?: (path: string) => unknown;
          }
        | undefined;
      if (typeof mod?.kicadOpenFiles === "function") {
        opts.log(`[open] gerbview: opening ${abs.length} file(s) from ${opts.targetPath}`);
        mod.kicadOpenFiles(JSON.stringify(abs));
        return;
      }
      opts.log(
        "[open] gerbview bundle has no kicadOpenFiles — opening the clicked layer only",
      );
      mod?.kicadOpenFile?.(abs[0]!);
    },
  });
}

/**
 * Drive a project into an already-booting tool runtime (booted into `win` by
 * bootKicadTool — the top-level window). Waits for the Emscripten FS, syncs the
 * project tree into MEMFS, then auto-opens the target file.
 *
 * Returns the open outcome: "failed" means the load never settled — the caller
 * must NOT drive further bare embind entries that walk the model (collab
 * snapshot, presence bind); they'd race the still-parked open chain and can
 * trap ("indirect call signature mismatch"). "none" = no open was attempted
 * (fileless tool / no target).
 */
export async function driveProjectIntoTool(
  win: ToolWindow,
  opts: DriveOptions,
): Promise<"programmatic" | "ui" | "failed" | "none"> {
  const { log, onStatus } = opts;

  onStatus("Waiting for runtime…");
  log(mark("fs:wait"));
  const fsReady = await waitFor(
    () => !!(win.FS && typeof win.FS.writeFile === "function"),
    90000,
  );
  if (!fsReady) throw new Error("runtime did not initialize (no FS) in 90s");

  log(mark("fs:ready"));
  onStatus("Loading project files…");
  await syncProjectToMemfs(win, opts);
  log(mark("stage:done", `${opts.files.length} file(s)`));
  synthesizeProjectFile(win, opts);

  let result: "programmatic" | "ui" | "failed" | "none" = "none";
  if (opts.targetPath && opts.tool === "gerbview") {
    // GerbView boots fileless, but a project route can still name a gerber —
    // and a single layer on its own is not a useful view, so open the whole
    // fabrication set that lives beside it (see openGerberSet).
    onStatus("Opening gerbers…");
    result = await openGerberSet(win, opts);
    log(`[open] result: ${result}`);
  } else if (opts.targetPath && !FILELESS_TOOLS.has(opts.tool)) {
    onStatus("Opening file…");
    const abs = memfsFilePath(opts.slug, opts.targetPath);
    // The open window is where the prod crash lives: OpenProjectFiles runs the
    // footprint-library preload INLINE on the main thread, and the GAL refresh
    // timer re-arms every 100 ms until first paint. Bracketing it is what lets a
    // crash report be placed inside or outside that window.
    log(mark("open:start", opts.targetPath));
    result = await openFileInTool(win, abs, { log });
    log(mark("open:settled", `result=${result}`));
    log(`[open] result: ${result}`);
  }
  onStatus("");
  return result;
}
