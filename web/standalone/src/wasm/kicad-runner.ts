import type { Tool } from "@pcbjam/shared";
import { FILELESS_TOOLS, toolForFile } from "@pcbjam/shared";
import { defaultKicadPro } from "../lib/new-file";
import { memfsFilePath } from "./constants";
import { mark } from "./load-trace";
import { prescanBoardModels } from "./libs/models-bridge";
import { openFileInTool } from "./open-flow";
import { runOwnerJob } from "./owner-job";

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
  /** True only while this project source still belongs to the current tool
   *  lifetime. The owner gateway evaluates it immediately before delivery, so
   *  a fetch completed by an old mount cannot publish into a replacement
   *  runtime. */
  isCurrent?: () => boolean;
  log: (msg: string) => void;
  onStatus: (text: string) => void;
  /** Uncover the wx UI when an exact owned open is waiting for modal input. */
  onOpenInputDialog?: (visible: boolean) => void;
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

function canTouchToolNative(win: ToolWindow): boolean {
  const runtime = win as ToolWindow & {
    __wxNativeIntegrityUnknown?: boolean;
    __wxScheduler?: {
      dead?: boolean;
      canTouchNative?: () => boolean;
    };
  };
  if (runtime.__wxNativeIntegrityUnknown) return false;
  const scheduler = runtime.__wxScheduler;
  if (!scheduler) return true; // staging also supports non-scheduler tool diets
  return typeof scheduler.canTouchNative === "function"
    ? scheduler.canTouchNative()
    : !scheduler.dead;
}

function touchToolNative<T>(win: ToolWindow, site: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const runtime = win as ToolWindow & {
      __wxScheduler?: {
        _terminalizeNativeTrap?: (site: string, error: unknown) => boolean;
      };
    };
    runtime.__wxScheduler?._terminalizeNativeTrap?.(site, error);
    throw error;
  }
}

/**
 * Write one project file into the tool's MEMFS.
 *
 * This is the synchronous primitive. Call it only from a closure which already
 * owns the current native operation, or in a tool diet with no scheduler.
 * Delayed browser sources must use {@link restageBytesFileAsOwner} or
 * {@link restageTextFileAsOwner}; checking `canTouchNative` is a lifetime gate,
 * not execution-owner admission.
 */
export function restageFile(
  win: ToolWindow,
  slug: string,
  relPath: string,
  bytes: Uint8Array,
  log: (msg: string) => void,
): void {
  if (!canTouchToolNative(win)) return;
  const fs = getFS(win);
  const dest = memfsFilePath(slug, relPath);
  touchToolNative(win, "project MEMFS write trapped", () => {
    fs.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
    fs.writeFile(dest, bytes);
  });
  log(`[memfs] wrote ${dest} (${bytes.length} bytes)`);
}

const BYTE_STRING_CHUNK = 0x8000;

/** Copy mutable fetch output into an immutable, exactly reversible gateway
 * argument. Owner jobs deliberately reject reference-shaped arguments: an
 * external Uint8Array could change after enqueue and its retained object graph
 * could not be bounded. This string packs two bytes into each code unit, so
 * the scheduler's conservative two-bytes-per-code-unit estimate matches the
 * input size instead of halving the 16 MiB payload limit. */
function bytesToRetainedString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const codeUnits = new Array<number>(BYTE_STRING_CHUNK);
  for (let offset = 0; offset < bytes.length; ) {
    let used = 0;
    while (used < BYTE_STRING_CHUNK && offset < bytes.length) {
      const low = bytes[offset++]!;
      const high = offset < bytes.length ? bytes[offset++]! : 0;
      codeUnits[used++] = low | (high << 8);
    }
    chunks.push(String.fromCharCode(...codeUnits.slice(0, used)));
  }
  return chunks.join("");
}

function retainedStringToBytes(value: string, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0, offset = 0; i < value.length; i++) {
    const codeUnit = value.charCodeAt(i);
    bytes[offset++] = codeUnit & 0xff;
    if (offset < byteLength) bytes[offset++] = codeUnit >>> 8;
  }
  return bytes;
}

/**
 * Re-stage fetched bytes at the explicit Emscripten runtime boundary.
 *
 * This is an explicit two-phase boundary. Before boot.ts publishes
 * `__pcbjamNativeRuntimeReady === true`, Emscripten has created MEMFS but has
 * not installed the native entry exports. The short write runs directly in
 * that phase; JavaScript run-to-completion guarantees it finishes before the
 * runtime callback and main can run. After the explicit edge, the same write
 * uses the Ordinary owner gateway. Scheduler or FS existence is never used as
 * a readiness signal. `isCurrent` is checked immediately before either form
 * of publication, so obsolete project lifetimes cannot write stale bytes.
 */
export function restageBytesFileAsOwner(
  win: ToolWindow,
  slug: string,
  relPath: string,
  bytes: Uint8Array,
  log: (msg: string) => void,
  isCurrent?: () => boolean,
): Promise<void> {
  const retainedBytes = bytesToRetainedString(bytes);
  return restageRetainedBytesAtRuntimeBoundary(
    win,
    slug,
    relPath,
    retainedBytes,
    bytes.length,
    log,
    isCurrent,
  );
}

function restageRetainedBytesAtRuntimeBoundary(
  win: ToolWindow,
  slug: string,
  relPath: string,
  retainedBytes: string,
  byteLength: number,
  log: (msg: string) => void,
  isCurrent?: () => boolean,
): Promise<void> {
  if (win.__pcbjamNativeRuntimeReady !== true) {
    try {
      if (isCurrent && !isCurrent()) {
        return Promise.reject(
          Object.assign(
            new Error(
              `[wasm-owner] project MEMFS restage: ${relPath} rejected for a stale resource`,
            ),
            { code: "WX_MUTATOR_STALE" },
          ),
        );
      }
      restageFile(
        win,
        slug,
        relPath,
        retainedStringToBytes(retainedBytes, byteLength),
        log,
      );
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return runOwnerJob(
    win,
    `project MEMFS restage: ${relPath}`,
    [slug, relPath, retainedBytes, byteLength] as const,
    (currentSlug, currentPath, currentBytes, currentByteLength) => {
      restageFile(
        win,
        currentSlug,
        currentPath,
        retainedStringToBytes(currentBytes, currentByteLength),
        log,
      );
    },
    isCurrent,
  );
}

/**
 * Re-stage a text project file as Ordinary execution-owner work.
 *
 * The text is retained as the gateway argument so its memory counts against
 * the bounded owner queue. Encoding and the actual MEMFS write happen inside
 * the admitted owner. `isCurrent` is checked immediately before native
 * delivery, which lets a latest-value producer cancel a superseded body
 * without ever writing the obsolete content.
 */
export function restageTextFileAsOwner(
  win: ToolWindow,
  slug: string,
  relPath: string,
  text: string,
  log: (msg: string) => void,
  isCurrent?: () => boolean,
): Promise<void> {
  return runOwnerJob(
    win,
    `sibling MEMFS restage: ${relPath}`,
    [text] as const,
    (currentText) => {
      restageFile(
        win,
        slug,
        relPath,
        new TextEncoder().encode(currentText),
        log,
      );
    },
    isCurrent,
  );
}

/** Read one staged project file back as Ordinary execution-owner work.
 *  Counterpart of {@link restageFile}; used post-open to inspect the target
 *  document (e.g. which lib nicknames it references). */
export async function readStagedFileAsOwner(
  win: ToolWindow,
  slug: string,
  relPath: string,
): Promise<Uint8Array | null> {
  try {
    return await runOwnerJob(
      win,
      `project MEMFS read: ${relPath}`,
      [memfsFilePath(slug, relPath)] as const,
      (path) => {
        const fs = getFS(win) as unknown as {
          readFile(path: string): Uint8Array;
        };
        return fs.readFile(path);
      },
    );
  } catch {
    return null;
  }
}

/**
 * Lib-table nicknames the document references: placed symbols (`lib_id`),
 * board footprints (`footprint`), and the embedded `lib_symbols` cache
 * (`symbol "NICK:NAME"`). Text scan, not a parse — nicknames land in quoted
 * `NICK:NAME` tokens in all three shapes, and a stray match only costs a
 * no-op realtime upgrade for a name that resolves to nothing.
 */
export function usedLibNicknames(text: string): string[] {
  const out = new Set<string>();
  const re = /\((?:lib_id|footprint|symbol)\s+"([^":]+):[^"]*"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[1]!);
  return [...out];
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
 * real-latency connection. A completed body enters the staging publication
 * lane; after native readiness that lane uses the execution-owner FIFO. The
 * fetch which produced it stays outside both. Each worker waits for its exact
 * publication tail before retaining another body, which bounds staging
 * publications to STAGE_CONCURRENCY without making the requests serial.
 */
async function syncProjectToMemfs(win: ToolWindow, opts: DriveOptions): Promise<void> {
  if (!canTouchToolNative(win)) return;

  let staged = 0;
  opts.onFileProgress?.(0, opts.files.length);
  const queue = [...opts.files];
  // Keep only one project body in the scheduler's bounded payload queue. The
  // fetch workers can still hold one completed body each, but eight individually
  // valid files must not collide with the gateway's aggregate 16 MiB limit.
  // A rejection advances the lane so in-flight sibling fetches can settle; the
  // allSettled result below still propagates the first failure to the caller.
  let publicationTail = Promise.resolve();
  const publish = (file: ToolFile, bytes: Uint8Array): Promise<void> => {
    // Take immutable ownership at receipt. A fetch adapter may reuse or mutate
    // its view while this body waits behind an earlier publication.
    const retainedBytes = bytesToRetainedString(bytes);
    const byteLength = bytes.length;
    const publication = publicationTail.then(() =>
      restageRetainedBytesAtRuntimeBoundary(
        win,
        opts.slug,
        file.path,
        retainedBytes,
        byteLength,
        opts.log,
        opts.isCurrent,
      ),
    );
    publicationTail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  };
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const bytes = await opts.fetchBytes(file.path);
      if (!canTouchToolNative(win)) return;
      await publish(file, bytes);
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
async function synthesizeProjectFile(win: ToolWindow, opts: DriveOptions): Promise<void> {
  if (!canTouchToolNative(win)) return;
  const match = (opts.targetPath ?? "").match(/^(.*)\.kicad_(pcb|sch)$/);
  if (!match) return;
  const proPath = `${match[1]}.kicad_pro`;
  if (opts.files.some((f) => f.path === proPath)) return;
  const fileName = proPath.slice(proPath.lastIndexOf("/") + 1);
  const bytes = new TextEncoder().encode(defaultKicadPro(fileName));
  await restageBytesFileAsOwner(
    win,
    opts.slug,
    proPath,
    bytes,
    () => {},
    opts.isCurrent,
  );
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
    onInputDialog: opts.onOpenInputDialog,
    open: () => {
      // Feature-detect HERE, not before the call: embind registers the Module
      // functions during runtime init, which lands AFTER the Emscripten FS is
      // ready — i.e. after we get here from driveProjectIntoTool. Probing any
      // earlier always misses and silently degrades to the single-file open
      // (openFileInTool's frame wait is what guarantees the exports exist).
      const mod = win.Module as
        | {
            kicadOpenFiles?: (json: string) => Promise<boolean> | boolean;
            kicadOpenFile?: (path: string) => Promise<boolean> | boolean;
          }
        | undefined;
      if (typeof mod?.kicadOpenFiles === "function") {
        opts.log(`[open] gerbview: opening ${abs.length} file(s) from ${opts.targetPath}`);
        return mod.kicadOpenFiles(JSON.stringify(abs));
      }
      opts.log(
        "[open] gerbview bundle has no kicadOpenFiles — opening the clicked layer only",
      );
      return mod?.kicadOpenFile?.(abs[0]!);
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
  await synthesizeProjectFile(win, opts);

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
    result = await openFileInTool(win, abs, {
      log,
      onInputDialog: opts.onOpenInputDialog,
    });
    log(mark("open:settled", `result=${result}`));
    log(`[open] result: ${result}`);
  }
  onStatus("");
  return result;
}
