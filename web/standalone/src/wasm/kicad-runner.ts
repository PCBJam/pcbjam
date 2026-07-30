import type { Tool } from "@pcbjam/shared";
import { FILELESS_TOOLS } from "@pcbjam/shared";
import { defaultKicadPro } from "../lib/new-file";
import { memfsFilePath, memfsProjectDir } from "./constants";
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
 * Drive a project into an already-booting tool runtime (booted into `win` by
 * bootKicadTool — the top-level window). Waits for the Emscripten FS, syncs the
 * project tree into MEMFS, then auto-opens the target file.
 */
export async function driveProjectIntoTool(
  win: ToolWindow,
  opts: DriveOptions,
): Promise<void> {
  const { log, onStatus } = opts;

  onStatus("Waiting for runtime…");
  const fsReady = await waitFor(
    () => !!(win.FS && typeof win.FS.writeFile === "function"),
    90000,
  );
  if (!fsReady) throw new Error("runtime did not initialize (no FS) in 90s");

  onStatus("Loading project files…");
  await syncProjectToMemfs(win, opts);
  synthesizeProjectFile(win, opts);

  if (opts.targetPath && !FILELESS_TOOLS.has(opts.tool)) {
    onStatus("Opening file…");
    const abs = memfsFilePath(opts.slug, opts.targetPath);
    const result = await openFileInTool(win, abs, { log });
    log(`[open] result: ${result}`);
  }
  onStatus("");
}
