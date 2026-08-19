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
 *   host -> worker  { eventAck: { sequence, bytes } }  releases event credit
 *   worker -> host  { id, res }
 *   worker -> host  { evt, eventSequence, eventBytes }  unsolicited events:
 *     { evt: { kind: "char"|"stat", lines: [...] } }  batched console/status
 *     { evt: { kind: "bg", finished: bool } }         BGThreadRunning
 *     { evt: { kind: "exit", status, immediate, quit } } ControlledExit
 *   worker -> host  { fatal }     terminal event-transport failure
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
// swamp the editor's main thread. A native call can emit synchronously for the
// whole request, so a microtask is not itself a memory bound. Measure the exact
// UTF-8 size of JSON.stringify(lines) before retaining each line and flush at
// either limit. bg/exit events flush first so relative order is preserved.
// E-6: batches are cut at MAX_EVENT_BATCH_* and posting is gated by the
// MAX_EVENT_UNACKED_* credit window — the host acks each frame with its exact
// { sequence, bytes } after taking ownership.
const EVT_CHAR = 0, EVT_STAT = 1, EVT_BG = 2, EVT_EXIT = 3;
const MAX_EVENT_BATCH_LINES = 512;
const MAX_EVENT_BATCH_UTF8_BYTES = 1024 * 1024;
const MAX_EVENT_UNACKED_FRAMES = 64;
const MAX_EVENT_UNACKED_UTF8_BYTES = 8 * 1024 * 1024;
let pendingLines = null; // { kind, lines, utf8Bytes } of the open batch
let flushQueued = false;
let eventStreamFailure = null;
let nextEventSequence = 1;
let unackedEventBytes = 0;
const unackedEvents = new Map();

function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; ++i) {
    const unit = text.charCodeAt(i);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        ++i;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Exact byte count for one JSON string without allocating its serialized form.
// Modern JSON.stringify escapes lone surrogates as \udxxx; paired surrogates
// become one four-byte UTF-8 scalar. Control characters use either a two-byte
// short escape or a six-byte \u00xx escape.
function jsonStringUtf8Bytes(text) {
  let bytes = 2; // opening and closing quotes
  for (let i = 0; i < text.length; ++i) {
    const unit = text.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) {
      bytes += 2;
    } else if (unit <= 0x1f) {
      bytes += unit === 0x08 || unit === 0x09 || unit === 0x0a
        || unit === 0x0c || unit === 0x0d ? 2 : 6;
    } else if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        ++i;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function flushLines() {
  flushQueued = false;
  if (pendingLines) {
    const batch = pendingLines;
    pendingLines = null;
    postEvent({ kind: batch.kind, lines: batch.lines });
  }
}

function stopEventStream(reason) {
  if (!eventStreamFailure) {
    // Detach the not-yet-transferred batch before reporting terminal state.
    // Frames already posted remain bounded by the unacknowledged credit set.
    pendingLines = null;
    flushQueued = false;
    eventStreamFailure = reason;
    postMessage({ fatal: reason });
  }
  throw new RangeError(eventStreamFailure);
}

function postEvent(evt) {
  const eventBytes = utf8Bytes(JSON.stringify(evt));
  if (unackedEvents.size >= MAX_EVENT_UNACKED_FRAMES
      || eventBytes > MAX_EVENT_UNACKED_UTF8_BYTES
      || unackedEventBytes > MAX_EVENT_UNACKED_UTF8_BYTES - eventBytes) {
    stopEventStream(
      `ngspice event transport exceeded ${MAX_EVENT_UNACKED_FRAMES} frames or `
        + `${MAX_EVENT_UNACKED_UTF8_BYTES} unacknowledged UTF-8 bytes`);
  }
  if (nextEventSequence > Number.MAX_SAFE_INTEGER) {
    stopEventStream("ngspice event sequence space exhausted");
  }

  const eventSequence = nextEventSequence++;
  unackedEvents.set(eventSequence, eventBytes);
  unackedEventBytes += eventBytes;
  try {
    postMessage({ evt, eventSequence, eventBytes });
  } catch (error) {
    unackedEvents.delete(eventSequence);
    unackedEventBytes -= eventBytes;
    stopEventStream(`ngspice event postMessage failed: ${String(error)}`);
  }
}

function acknowledgeEvent(ack) {
  const sequence = ack && ack.sequence;
  const bytes = ack && ack.bytes;
  const retained = unackedEvents.get(sequence);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(bytes)
      || retained === undefined || retained !== bytes
      || bytes < 0 || bytes > unackedEventBytes) {
    stopEventStream("ngspice event acknowledgment did not match an exact frame");
  }
  unackedEvents.delete(sequence);
  unackedEventBytes -= bytes;
}

function onEmit(kind, text, a, b) {
  if (eventStreamFailure) throw new RangeError(eventStreamFailure);
  if (kind === EVT_CHAR || kind === EVT_STAT) {
    const k = kind === EVT_CHAR ? "char" : "stat";
    const line = String(text);
    const lineBytes = jsonStringUtf8Bytes(line);
    if (lineBytes + 2 > MAX_EVENT_BATCH_UTF8_BYTES) {
      // Every earlier line was accepted while capacity existed. Transfer it
      // before refusing this line, which is measured but never retained.
      flushLines();
      stopEventStream(
        `ngspice event line exceeds ${MAX_EVENT_BATCH_UTF8_BYTES} UTF-8 bytes`);
    }
    if (pendingLines && pendingLines.kind !== k) flushLines();
    if (pendingLines) {
      const nextBytes = pendingLines.utf8Bytes + 1 + lineBytes;
      if (pendingLines.lines.length >= MAX_EVENT_BATCH_LINES
          || nextBytes > MAX_EVENT_BATCH_UTF8_BYTES) {
        flushLines();
      }
    }
    if (!pendingLines) pendingLines = { kind: k, lines: [], utf8Bytes: 2 };
    pendingLines.utf8Bytes += (pendingLines.lines.length ? 1 : 0) + lineBytes;
    pendingLines.lines.push(line);
    if (pendingLines.lines.length >= MAX_EVENT_BATCH_LINES
        || pendingLines.utf8Bytes >= MAX_EVENT_BATCH_UTF8_BYTES) {
      flushLines();
    }
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flushLines);
    }
    return;
  }
  flushLines();
  if (kind === EVT_BG) {
    postEvent({ kind: "bg", finished: !!a });
  } else if (kind === EVT_EXIT) {
    postEvent({ kind: "exit", status: a, immediate: !!(b & 1), quit: !!(b & 2) });
  }
}

modP.then((mod) => {
  mod.ngspiceEmit = onEmit;
  postMessage({ ready: true });
}, (e) => postMessage({ bootError: String(e) }));

// --- request dispatch -------------------------------------------------------
self.onmessage = async (e) => {
  const { id, req, eventAck } = e.data;
  if (eventAck) {
    acknowledgeEvent(eventAck);
    return;
  }
  if (typeof id !== "number") return;
  if (eventStreamFailure) {
    postMessage({ id, res: { error: eventStreamFailure } });
    return;
  }
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
