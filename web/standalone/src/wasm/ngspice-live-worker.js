/*
 * Worker-side wrapper of a LIVE simulation session: the ngspice_service module
 * again, in a Worker of its own, driven through its live* entry points
 * (wasm/ngspice-service/ngspice_live.cpp). The simulator window's Worker
 * (ngspice-worker.js) is a different instance and is not touched.
 *
 * One source, used by:
 *   - the standalone app (live-engine.ts, vite `?raw` import), and
 *   - the e2e harness (tests/kicad/sim-live-engine.spec.ts, read off disk).
 *
 * The host prepends one prelude line to the blob before this file's content:
 *   self.NGSPICE_GLUE_URL = "<absolute URL of ngspice_service.js>";
 *
 * Protocol:
 *   host -> worker  { id, cmd, ...args }
 *     start  { deck, files, inputs, parts, speed }  load the circuit and run it
 *            deck: string[]; files: [{ path, text }]; inputs: { name: value };
 *            parts: [{ name, bytes }]; speed: number (0 = as fast as it goes)
 *            It answers once the first time point is solved. A circuit that
 *            ngspice cannot run, or whose code part cannot be loaded, is an
 *            error with the reason in words.
 *     stop                       halt the run
 *     pause  { paused }
 *     speed  { speed }
 *     input  { name, value }     a value the user set; becomes a 1 ms ramp
 *     part   { name, bytes }     new code for a part, also while it runs
 *     frame                      one snapshot of all values
 *   worker -> host  { id, res }  res.error is set when the command failed
 *     frame: { t, points, load, achieved, lagging, running, latest, avg,
 *              names?, problem? }  names only when the list of vectors
 *              changed; problem: a code part could not be loaded, in words.
 *              The run is halted then (ngspice would go on without the part)
 *   worker -> host  { log: [[kind, text]], dropped }  console lines, batched.
 *     kind: "spice" (ngspice's console), "part" (a code part's own text),
 *           "problem" (the engine about a part), "run" (the run began / ended)
 *   worker -> host  { fatal }    the engine cannot go on; start a new Worker
 *   boot: one-shot { ready: true } | { bootError }.
 */
const GLUE = self.NGSPICE_GLUE_URL;

// PTHREAD CHILD REALM: the glue spawns its thread workers (ngspice's bg_run
// thread) from this very blob. Load the glue and get out of the way; see
// ngspice-worker.js.
if (globalThis.name === "em-pthread") {
  importScripts(GLUE);
} else {

let dead = false;
function fatal(why) {
  if (dead) return;
  dead = true;
  try { postMessage({ fatal: String(why) }); } catch { /* the host is gone */ }
}

// An error nobody caught, here or in the simulation thread (a trap inside a
// code part ends up here through the glue's thread error handler): the engine
// is in an unknown state. Say so; the host starts a new Worker.
self.addEventListener("error", (e) => {
  // the glue rethrows a thread's error event as it is: the words are inside it
  const thrown = e.error;
  fatal((thrown && thrown.message) || e.message || "worker error");
});
self.addEventListener("unhandledrejection", (e) =>
  fatal("unhandled rejection: " + String(e.reason && e.reason.message || e.reason)));

importScripts(GLUE);

// --- console lines ----------------------------------------------------------
// Batched: a chatty circuit prints thousands of lines a second. One batch every
// LOG_FLUSH_MS, at most LOG_BATCH_LINES of LOG_LINE_CHARS each; what does not
// fit is counted, not kept.
const EVT_CHAR = 0, EVT_STAT = 1, EVT_BG = 2, EVT_EXIT = 3, EVT_PART = 4;
const LOG_FLUSH_MS = 50;
const LOG_BATCH_LINES = 200;
const LOG_LINE_CHARS = 2000;
let pendingLog = [];
let droppedLog = 0;
let flushTimer = 0;

function flushLog() {
  flushTimer = 0;
  if (!pendingLog.length && !droppedLog) return;
  const log = pendingLog, dropped = droppedLog;
  pendingLog = [];
  droppedLog = 0;
  try { postMessage({ log, dropped }); } catch { /* the host is gone */ }
}

function pushLog(kind, text) {
  if (pendingLog.length >= LOG_BATCH_LINES) {
    droppedLog++;
  } else {
    const line = String(text);
    pendingLog.push([kind, line.length > LOG_LINE_CHARS ? line.slice(0, LOG_LINE_CHARS) + " ..." : line]);
  }
  if (!flushTimer) flushTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

// While a start is under way: what ngspice wrote to its error stream, and
// whether the run's thread came up and went again. The lines of a run arrive
// between its "began" and its "ended", in order.
let startLines = null;
let runBegan = false;
let runEnded = false;

function onEmit(kind, text, a) {
  if (kind === EVT_STAT) return;              // progress lines: a live run needs none
  if (kind === EVT_CHAR) {
    if (!text) return;
    // ngspice marks every line with the stream it wrote it to
    const stream = /^(stdout|stderr) /.exec(text);
    const line = stream ? text.slice(stream[0].length) : text;
    if (startLines && stream && stream[1] === "stderr" && startLines.length < 200) startLines.push(line);
    pushLog("spice", line);
  } else if (kind === EVT_PART) {
    if (text) pushLog(a === 2 ? "problem" : "part", text);
  } else if (kind === EVT_BG) {
    if (!a) runBegan = true;
    else if (runBegan) runEnded = true;
    pushLog("run", a ? "ended" : "began");
  } else if (kind === EVT_EXIT) {
    // ngspice asks to be unloaded: nothing more can be run in this instance
    flushLog();
    fatal("ngspice gave up (status " + a + ")");
  }
}

const modP = NgspiceService({
  onAbort: (what) => fatal("abort: " + what),
  // A blob: worker has no http base URL: every asset path is made absolute against
  // the glue's URL.
  locateFile: (f) => new URL(f, GLUE).href,
  print: (s) => console.log("[ngspice_live]", s),
  printErr: (s) => console.warn("[ngspice_live]", s),
  ngspiceEmit: onEmit,
}).then((mod) => {
  if (typeof mod.liveInit !== "function")
    throw new Error("this ngspice_service build has no live engine");
  const rc = mod.liveInit();
  if (rc !== 0) throw new Error("ngSpice_Init returned " + rc);
  return mod;
});

modP.then(
  () => postMessage({ ready: true }),
  (e) => postMessage({ bootError: String(e && e.message || e) }),
);

// --- commands ---------------------------------------------------------------
const STOP_WAIT_MS = 5000;
const FIRST_POINT_WAIT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sentGen = -1;

// Halt the run and wait until its thread is gone. A run whose thread has not
// come up yet cannot be halted (liveStop answers -1): wait for it here, where
// the event loop keeps turning, because a thread from the pool needs this
// Worker's event loop to come up at all.
async function stopRun(mod) {
  const until = performance.now() + STOP_WAIT_MS;
  let askAgain = 0;
  while (mod.liveRunState() !== 0 && performance.now() < until) {
    if (performance.now() >= askAgain) {
      mod.liveStop();
      askAgain = performance.now() + 200;
    }
    await sleep(10);
  }
  return mod.liveRunState() === 0;
}

// ngspice's own words for why a circuit does not run: its first error line
// and the two that follow (it often names the line and the cause after it).
function reason(what) {
  const lines = startLines ?? [];
  const from = lines.findIndex((line) => /error/i.test(line));
  return from < 0 ? what + " (see the log)" : what + ": " + lines.slice(from, from + 3).join(" / ");
}

async function start(mod, m) {
  if (!Array.isArray(m.deck) || !m.deck.length) return { error: "no circuit" };
  if (!(await stopRun(mod))) return { error: "the last run did not stop" };
  for (const part of m.parts ?? []) mod.liveRegisterPart(part.name, part.bytes);
  startLines = [];
  try {
    const rc = mod.liveCirc(m.deck, m.files ?? []);
    if (rc !== 0) return { error: reason("ngspice did not take the circuit") };
    for (const [name, value] of Object.entries(m.inputs ?? {})) mod.liveSetInput(name, value);
    mod.liveSetSpeed(typeof m.speed === "number" ? m.speed : 1);
    sentGen = -1;
    runBegan = false;
    runEnded = false;
    const started = mod.liveStart();
    if (started !== 0) return { error: reason("the run did not start") };

    // ngspice says "fine" to a circuit it cannot run (a subcircuit or a model
    // nobody defines, no operating point) and to a run it cannot start. What
    // tells them apart: a good run solves its first time point, a bad one
    // ends before that.
    const until = performance.now() + FIRST_POINT_WAIT_MS;
    for (;;) {
      // The points first, the problem after: the simulation thread goes on
      // between the two reads, and a part's problem is always there before the
      // run's first point. The other order could miss it and say "fine".
      const points = mod.livePoints();
      const problem = mod.liveProblem();
      if (problem) {
        await stopRun(mod);
        return { error: problem };
      }
      if (points > 0) return { ok: true };
      if (mod.liveRunState() === 0) {
        // its last lines are still on their way
        for (let i = 0; i < 100 && !runEnded; i++) await sleep(5);
        return { error: reason("ngspice did not run the circuit") };
      }
      if (performance.now() > until) {
        await stopRun(mod);
        return { error: "the circuit did not reach its first time point in " + FIRST_POINT_WAIT_MS / 1000 + " s" };
      }
      await sleep(5);
    }
  } finally {
    startLines = null;
  }
}

self.onmessage = async (e) => {
  const m = e.data ?? {};
  if (typeof m.id !== "number") return;
  if (dead) {
    postMessage({ id: m.id, res: { error: "the engine has stopped working" } });
    return;
  }
  let res = { ok: true };
  const transfer = [];
  try {
    const mod = await modP;
    switch (m.cmd) {
      case "start":
        res = await start(mod, m);
        break;
      case "stop":
        if (!(await stopRun(mod))) res = { error: "the run did not stop" };
        break;
      case "pause":
        mod.liveSetPaused(!!m.paused);
        break;
      case "speed":
        mod.liveSetSpeed(Number(m.speed));
        break;
      case "input":
        mod.liveSetInput(String(m.name), Number(m.value));
        break;
      case "part":
        mod.liveRegisterPart(String(m.name), m.bytes);
        break;
      case "frame": {
        const s = mod.liveSnapshot();
        // The module returns views over its (shared) heap; copy into fresh
        // arrays so they can be transferred out.
        const latest = Float64Array.from(s.latest), avg = Float64Array.from(s.avg);
        res = { t: s.t, points: s.points, load: s.load, achieved: s.achieved,
                lagging: s.lagging, running: s.running, latest, avg };
        if (s.gen !== sentGen) {
          res.names = mod.liveNames();
          sentGen = s.gen;
        }
        if (s.problem) {
          res.problem = s.problem;
          res.running = !(await stopRun(mod));
        }
        transfer.push(latest.buffer, avg.buffer);
        break;
      }
      default:
        res = { error: "unknown command " + m.cmd };
    }
  } catch (err) {
    res = { error: String(err && err.message || err) };
  }
  postMessage({ id: m.id, res }, transfer);
};

} // end non-pthread (top service) realm
