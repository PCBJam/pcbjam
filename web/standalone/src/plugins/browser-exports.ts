/**
 * Plugin exports in the browser (plugins 0029, the `pluginBrowserExports` toggle).
 *
 * `exports.run` / `exports.runMany` otherwise run kicad_tools on the server: a
 * container that may be asleep, the board copied over and loaded again, the
 * outputs written to R2 and read back. Here the editor's own KiCad runs the
 * same four exporters (one implementation, wasm/bindings/fab_export.h) on the
 * board it already has open, into MEMFS, and the files go straight to the
 * plugin host. The board is the one on screen. Export options (plugins 0027)
 * reach KiCad as the words kicad_tools takes for them, read by the same parser.
 *
 * KiCad holds the page's thread while it writes, so a small notice goes up
 * first and stays until the files are read back. Its spinner animates on the
 * compositor, so it keeps turning while the thread is busy. One export runs at
 * a time, whichever plugin asked.
 */
import { EXPORT_LIMITS, type ExportOptions } from '@pcbjam/plugin-platform/api';

/** What the plugin host takes (BrowserExportRun in pcbjam-shared's browser-exports.ts). */
export interface BrowserExportRun { kind: string; files: { name: string; bytes: Uint8Array }[] }

interface FabModule { kicadFabExport?: (outDir: string, kindsCsv: string, optionWords: string) => string }
interface MemFs {
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
}
interface FabResult {
  ok: boolean;
  error?: string;
  ms?: number;
  exports?: { kind: string; ok: boolean; ms: number; files: { name: string; size: number }[]; messages: string }[];
}

const engine = () => window as unknown as { Module?: FabModule; FS?: MemFs };

/** Whether this editor build can export (an older engine has no binding: the server exports then). */
export function browserExportsAvailable(): boolean {
  const { Module, FS } = engine();
  return typeof Module?.kicadFabExport === 'function' && !!FS;
}

/** The server's error codes (plugin-exports.ts), so a plugin handles both paths the same way. */
const failed = (message: string) => Object.assign(new Error(message), { code: 'EXPORT_FAILED' });
const unavailable = (message: string) => Object.assign(new Error(message), { code: 'EXPORT_UNAVAILABLE' });

/**
 * Export options as the words kicad_tools takes, the ones the server builds for the same options.
 * An option left at its default adds no word. The host has checked the options against the
 * method's schema (EXPORT_OPTIONS); KiCad refuses a word it does not know (BAD_OPTIONS).
 */
export function exportOptionWords(options: ExportOptions | undefined): string[] {
  const words: string[] = [];
  const gerbers = options?.gerbers, drill = options?.drill;
  if (gerbers?.layers) words.push('--layers', gerbers.layers.join(','));
  if (gerbers?.canonicalNames) words.push('--canonical-names');
  if (gerbers?.protelExtensions === false) words.push('--no-protel-ext');
  if (gerbers?.jobFile === false) words.push('--no-job-file');
  if (gerbers?.zeroMaskExpansion) words.push('--zero-mask-expansion');
  if (gerbers?.zeroMaskMinWidth) words.push('--zero-mask-min-width');
  if (gerbers?.precision !== undefined) words.push('--precision', String(gerbers.precision));
  if (drill?.separatePlated) words.push('--separate-plated');
  if (drill?.minimalHeader) words.push('--minimal-header');
  if (drill?.routeOvalHoles) words.push('--route-oval-holes');
  return words;
}

/** Why KiCad would not start (pcbFabExport in pcbnew_embind.cpp). */
const REFUSED: Record<string, string> = {
  NO_EDITOR: 'Open the board in the PCB editor, then try again.',
  BUSY: 'The board is still opening. Try again in a moment.',
  TOOL_ACTIVE: 'Finish or cancel what you are doing on the board, then try again.',
};

/**
 * Lets the notice reach the screen before KiCad takes the thread. A hidden tab
 * paints nothing and gets no animation frames, so it does not wait for one.
 */
const painted = () => new Promise<void>(resolve => {
  if (document.visibilityState !== 'visible') { resolve(); return; }
  const timer = setTimeout(resolve, 250);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
});

/** Long enough that a fast export reads as a notice, not a flicker. */
const MIN_NOTICE_MS = 350;

let runs = 0;
/** The export before this one: KiCad writes one set of files at a time. */
let last: Promise<unknown> = Promise.resolve();

export function runBrowserExports(kinds: string[], signal: AbortSignal, options?: ExportOptions): Promise<BrowserExportRun[]> {
  const mine = last.then(() => exportNow(kinds, signal, options));
  last = mine.catch(() => { /* the next export runs whatever became of this one */ });
  return mine;
}

async function exportNow(kinds: string[], signal: AbortSignal, options: ExportOptions | undefined): Promise<BrowserExportRun[]> {
  signal.throwIfAborted();
  const { Module, FS } = engine();
  if (!Module?.kicadFabExport || !FS) throw unavailable('This editor cannot export here. Reload PCBJam.');
  const notice = showExportNotice();
  const shown = performance.now();
  // Outside the project folder: plot-outputs.ts uploads Gerbers closed under it.
  const dir = `/tmp/pcbjam-fab-${Date.now()}-${runs++}`;
  try {
    await painted();
    signal.throwIfAborted();
    const started = performance.now();
    // One word per line: a layer name has no line break in it (EXPORT_OPTIONS).
    const result = JSON.parse(Module.kicadFabExport(dir, kinds.join(','), exportOptionWords(options).join('\n'))) as FabResult;
    const exported = performance.now();
    // Never the plain files for a caller that asked for options.
    if (result.error === 'BAD_OPTIONS') throw failed('Export failed: this editor does not know the export options asked for. Reload PCBJam.');
    if (!result.exports) throw unavailable(REFUSED[result.error ?? ''] ?? 'The export could not start. Try again.');
    for (const run of result.exports)
      if (!run.ok) throw failed('Export failed' + (kinds.length > 1 ? ' (' + run.kind + ')' : '') + (run.messages.trim() ? ': ' + run.messages.trim().slice(0, 300) : ''));
    // Sizes first: nothing over the limit is copied out of KiCad's memory.
    const total = result.exports.reduce((sum, run) => sum + run.files.reduce((n, file) => n + file.size, 0), 0);
    if (total > EXPORT_LIMITS.bundleBytes) throw failed('Export exceeds 32 MiB');
    const out = result.exports.map(run => ({
      kind: run.kind,
      files: run.files.map(file => ({ name: file.name, bytes: FS.readFile(`${dir}/${run.kind}/${file.name}`) })),
    }));
    console.info('[browser-exports]', JSON.stringify({
      kinds, kicadMs: Math.round(exported - started), readMs: Math.round(performance.now() - exported),
      perKind: Object.fromEntries(result.exports.map(run => [run.kind, Math.round(run.ms)])),
      files: out.reduce((n, run) => n + run.files.length, 0), bytes: total,
    }));
    const left = MIN_NOTICE_MS - (performance.now() - shown);
    if (left > 0) await new Promise(resolve => setTimeout(resolve, left));
    signal.throwIfAborted();
    return out;
  } finally {
    removeTree(FS, dir);
    notice.remove();
  }
}

function removeTree(fs: MemFs, dir: string) {
  const quiet = (step: () => void) => { try { step(); } catch { /* not written, or already gone */ } };
  let kinds: string[] = [];
  quiet(() => { kinds = fs.readdir(dir).filter(name => name !== '.' && name !== '..'); });
  for (const kind of kinds) {
    let names: string[] = [];
    quiet(() => { names = fs.readdir(`${dir}/${kind}`).filter(name => name !== '.' && name !== '..'); });
    for (const name of names) quiet(() => fs.unlink(`${dir}/${kind}/${name}`));
    quiet(() => fs.rmdir(`${dir}/${kind}`));
  }
  quiet(() => fs.rmdir(dir));
}

/**
 * A small card at the top of the window, over a clear layer that keeps clicks
 * from piling up while KiCad works (no dimming). Removed when the files are read.
 */
function showExportNotice() {
  const layer = document.createElement('div');
  layer.setAttribute('role', 'status');
  layer.setAttribute('aria-live', 'polite');
  layer.dataset.testid = 'browser-export-notice';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;cursor:progress;display:flex;justify-content:center;align-items:flex-start;pointer-events:auto;';
  layer.innerHTML = `
    <style>
      @keyframes pcbjam-export-spin { to { transform: rotate(360deg); } }
      @keyframes pcbjam-export-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    </style>
    <div style="margin-top:72px;display:flex;align-items:center;gap:12px;padding:12px 16px;max-width:calc(100vw - 32px);
                border-radius:var(--radius, 0.5rem);border:1px solid hsl(var(--border, 214.3 31.8% 91.4%));
                background:hsl(var(--card, 0 0% 100%));color:hsl(var(--card-foreground, 222.2 84% 4.9%));
                box-shadow:0 8px 24px rgba(0,0,0,.14);font:13px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;
                animation:pcbjam-export-in 120ms ease-out;">
      <span aria-hidden="true" style="width:16px;height:16px;flex:none;border-radius:50%;
                  border:2px solid hsl(var(--muted-foreground, 215.4 16.3% 46.9%) / .25);
                  border-top-color:hsl(var(--primary, 222.2 47.4% 11.2%));
                  will-change:transform;animation:pcbjam-export-spin .8s linear infinite;"></span>
      <span>
        <strong style="display:block;font-weight:600;">Generating fabrication files</strong>
        <span style="color:hsl(var(--muted-foreground, 215.4 16.3% 46.9%));">KiCad is writing them in your browser. The editor will respond again in a moment.</span>
      </span>
    </div>`;
  document.body.appendChild(layer);
  return layer;
}
