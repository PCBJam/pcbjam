/*
 * Worker-side wrapper for the ngspice_service MODULARIZE module — the SINGLE
 * source of truth for the worker boot, shared verbatim by:
 *   - the standalone app provider (ngspice-service.ts, vite `?raw` import), and
 *   - the e2e harness stub (tests/kicad/utils/ngspice-service.ts, read off disk).
 *
 * The host prepends one prelude line to the blob before this file's content:
 *   self.NGSPICE_GLUE_URL = "<absolute URL of ngspice_service.js>";
 *
 * Protocol (docs/features/ngspice-split/):
 *   host -> worker  { id, req }   req.kind: init | circ | command |
 *                                 get_vec_info | cur_plot | all_plots |
 *                                 all_vecs | running | cm_input_path
 *   worker -> host  { id, res }
 *   worker -> host  { evt }       unsolicited event stream:
 *     { evt: { kind: "char"|"stat", lines: [...] } }  batched console/status
 *     { evt: { kind: "bg", finished: bool } }         BGThreadRunning
 *     { evt: { kind: "exit", status, immediate, quit } } ControlledExit
 *   boot: one-shot { ready: true } | { bootError }.
 */
const GLUE = self.NGSPICE_GLUE_URL;

// PTHREAD CHILD REALM (emscripten 6): the glue spawns pthread workers
// (ngspice's bg_run thread) from _scriptName = self.location.href — THIS
// wrapper blob (mainScriptUrlOrBlob was removed upstream). Load the glue (its
// tail self-instantiates into pthread-child mode) and get out of the way; see
// occ-worker.js for the full story.
if (globalThis.name === "em-pthread") {
  importScripts(GLUE);
} else {

self.addEventListener("error", (e) =>
  console.error("[ngspice_service] worker error:", e.message, e.filename, e.lineno));
self.addEventListener("unhandledrejection", (e) =>
  console.error("[ngspice_service] unhandled rejection:", e.reason));

importScripts(GLUE);

const modP = NgspiceService({
  onAbort: (what) => console.error("[ngspice_service] ABORT:", what),
  // (emscripten 6 removed mainScriptUrlOrBlob; pthread children re-run this
  // wrapper blob instead — handled by the em-pthread branch at the top.)
  // A blob: worker has no http base URL — absolutize every asset path against
  // the glue's URL or the .wasm fetch dies with "Failed to parse URL".
  locateFile: (f) => new URL(f, GLUE).href,
  print: (s) => console.log("[ngspice_service]", s),
  printErr: (s) => console.warn("[ngspice_service]", s),
});

// --- event stream -----------------------------------------------------------
// char/stat lines are batched per microtask: a chatty simulation can emit
// thousands of SendChar lines per second, and one postMessage per line would
// swamp the editor's main thread. bg/exit events flush the pending batch first
// so relative order is preserved.
const EVT_CHAR = 0, EVT_STAT = 1, EVT_BG = 2, EVT_EXIT = 3;
let pendingLines = null; // { kind, lines } of the open batch
let flushQueued = false;

function flushLines() {
  flushQueued = false;
  if (pendingLines) {
    const batch = pendingLines;
    pendingLines = null;
    postMessage({ evt: { kind: batch.kind, lines: batch.lines } });
  }
}

function onEmit(kind, text, a, b) {
  if (kind === EVT_CHAR || kind === EVT_STAT) {
    const k = kind === EVT_CHAR ? "char" : "stat";
    if (pendingLines && pendingLines.kind !== k) flushLines();
    if (!pendingLines) pendingLines = { kind: k, lines: [] };
    pendingLines.lines.push(text);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flushLines);
    }
    return;
  }
  flushLines();
  if (kind === EVT_BG) {
    postMessage({ evt: { kind: "bg", finished: !!a } });
  } else if (kind === EVT_EXIT) {
    postMessage({ evt: { kind: "exit", status: a, immediate: !!(b & 1), quit: !!(b & 2) } });
  }
}

modP.then((mod) => {
  mod.ngspiceEmit = onEmit;
  postMessage({ ready: true });
}, (e) => postMessage({ bootError: String(e) }));

// --- request dispatch -------------------------------------------------------
onmessage = async (e) => {
  const { id, req } = e.data;
  if (typeof id !== "number") return;
  let res;
  const transfer = [];
  try {
    const mod = await modP;
    switch (req.kind) {
      case "init":
        res = { ret: mod.init() };
        break;
      case "circ":
        res = { ret: mod.circ(req.lines, req.files ?? []) };
        break;
      case "command":
        res = { ret: mod.command(req.cmd) };
        break;
      case "get_vec_info": {
        const vi = mod.getVecInfo(req.name);
        // The module returns views over its (shared) heap; copy into fresh
        // non-shared arrays so they can be transferred out.
        const real = vi.real ? new Float64Array(vi.real) : null;
        const comp = vi.comp ? new Float64Array(vi.comp) : null;
        res = { found: vi.found, vname: vi.vname, vtype: vi.vtype,
                flags: vi.flags, length: vi.length, real, comp };
        if (real) transfer.push(real.buffer);
        if (comp) transfer.push(comp.buffer);
        break;
      }
      case "cur_plot":
        res = { name: mod.curPlot() };
        break;
      case "all_plots":
        res = { names: mod.allPlots() };
        break;
      case "all_vecs":
        res = { names: mod.allVecs(req.plot) };
        break;
      case "running":
        res = { running: mod.running() };
        break;
      case "cm_input_path":
        mod.cmInputPath(req.path ?? "");
        res = { ok: true };
        break;
      default:
        res = { error: "ngspice_service: unknown request kind " + req.kind };
    }
  } catch (err) {
    res = { error: "ngspice_service worker: " + err };
  }
  postMessage({ id, res }, transfer);
};

} // end non-pthread (top service) realm
