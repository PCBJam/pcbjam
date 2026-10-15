/**
 * Plot outputs reach the project (overlay-system 0007 P1: Gerbers and drill files).
 *
 * KiCad's Plot and Generate Drill Files dialogs write straight to MEMFS. Only
 * the document saves fire `kicadCollab.onSave`, so a plot reported "Done." and
 * left nothing in the project: no file row, no download, gone on reload, and
 * GerbView (its own page) could not open it.
 *
 * Every fclose of the editor ends in `FS.close(stream)`, so this wraps it. A
 * Gerber, Gerber job or Excellon file closed after writing under the project's
 * folder is remembered; once the burst settles (a plot writes one file per
 * layer) each one is read back and handed to `save`, one burst at a time so a
 * re-plot never lands before the plot it replaces. Files the page stages
 * itself (boot, a lazy folder, a peer's plot restaged by files-watch) are
 * written with `FS.writeFile`, which KiCad never calls: closes inside it are
 * not KiCad's and are skipped. Bytes this page already uploaded are not sent
 * again.
 */
import { memfsProjectDir } from "./constants";
import type { SaveOutcome } from "./save-flow";

/** Quiet time after the last output file closes before the burst uploads. */
export const PLOT_OUTPUT_SETTLE_MS = 500;

/** The fabrication outputs the project accepts (contract KICAD_UPLOAD_EXTENSIONS). */
const PLOT_OUTPUT_EXTENSIONS = [".gbr", ".gbrjob", ".drl"];

/** The emscripten FSStream fields this reads. */
interface ClosedStream {
  path?: string;
  isWrite?: boolean;
}

export interface PlotOutputWindow {
  FS?: {
    close(stream: ClosedStream): unknown;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array | string, opts?: unknown): unknown;
  };
}

export interface PlotOutputCapture {
  /** Put `FS` back and drop what has not been read yet. */
  stop(): void;
}

export function isPlotOutput(relPath: string): boolean {
  const base = (relPath.split("/").pop() ?? "").toLowerCase();
  return PLOT_OUTPUT_EXTENSIONS.some((ext) => base.length > ext.length && base.endsWith(ext));
}

function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function capturePlotOutputs(opts: {
  win: PlotOutputWindow;
  slug: string;
  save: (relPath: string, bytes: Uint8Array) => Promise<SaveOutcome>;
  log: (m: string) => void;
  onStatus?: (text: string) => void;
}): PlotOutputCapture | null {
  const fs = opts.win.FS;
  if (!fs) return null;
  const prefix = `${memfsProjectDir(opts.slug)}/`;
  const pending = new Set<string>();
  // What this page last uploaded per output path.
  const known = new Map<string, Uint8Array>();
  // Depth of the page's own FS.writeFile calls (staging, restage).
  let pageWrites = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uploads: Promise<void> = Promise.resolve();
  let stopped = false;

  const upload = async (batch: Array<[string, Uint8Array]>): Promise<void> => {
    const fresh = batch.filter(([relPath, bytes]) => !sameBytes(bytes, known.get(relPath)));
    if (stopped || !fresh.length) return;
    const what = fresh.length === 1 ? fresh[0]![0] : `${fresh.length} fabrication files`;
    opts.onStatus?.(`Saving ${what} to the project…`);
    const results = await Promise.all(
      fresh.map(async ([relPath, bytes]) => {
        let outcome: SaveOutcome;
        try {
          outcome = await opts.save(relPath, bytes);
        } catch (err) {
          outcome = { kind: "unknown", message: `Save failed: ${relPath} - ${String(err)}` };
        }
        return { relPath, bytes, outcome };
      }),
    );
    if (stopped) return;
    let failure: string | undefined;
    for (const { relPath, bytes, outcome } of results) {
      if (outcome.kind === "committed") {
        known.set(relPath, bytes);
        opts.log(`[plot-outputs] ${relPath} saved (${bytes.length} bytes)`);
        continue;
      }
      const message = outcome.message ?? `Save failed: ${relPath}`;
      opts.log(`[plot-outputs] ${relPath} not saved: ${message}`);
      failure ??= message;
    }
    opts.onStatus?.(failure ?? `Saved ${what} to the project ✓`);
  };

  const flush = (): void => {
    timer = undefined;
    if (stopped) return;
    // Read now: these are the bytes of this burst, not of a later re-plot.
    const batch: Array<[string, Uint8Array]> = [];
    for (const relPath of pending) {
      try {
        batch.push([relPath, fs.readFile(prefix + relPath).slice()]);
      } catch (err) {
        opts.log(`[plot-outputs] ${relPath} is gone before upload: ${String(err)}`);
      }
    }
    pending.clear();
    if (batch.length) uploads = uploads.then(() => upload(batch));
  };

  const original = fs.close;
  const close = function (this: unknown, stream: ClosedStream): unknown {
    const result = original.call(this, stream);
    const path = stream?.path;
    if (!stopped && pageWrites === 0 && stream?.isWrite && path?.startsWith(prefix)) {
      const relPath = path.slice(prefix.length);
      if (isPlotOutput(relPath)) {
        pending.add(relPath);
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, PLOT_OUTPUT_SETTLE_MS);
      }
    }
    return result;
  };
  fs.close = close;
  const originalWriteFile = fs.writeFile;
  const writeFile = function (this: unknown, ...args: Parameters<typeof originalWriteFile>): unknown {
    pageWrites++;
    try {
      return originalWriteFile.apply(this, args);
    } finally {
      pageWrites--;
    }
  };
  fs.writeFile = writeFile;

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      // A later wrapper may sit on top; then ours stays a pass-through.
      if (fs.close === close) fs.close = original;
      if (fs.writeFile === writeFile) fs.writeFile = originalWriteFile;
    },
  };
}
