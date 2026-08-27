/**
 * Stub/production parity tripwire (findings group E guardrail). The e2e
 * harness drives hand-maintained MIRRORS of the worker services
 * (tests/kicad/utils/{ngspice,occ}-service.ts) while production ships
 * web/standalone/src/wasm/{ngspice,occ}-service.ts — a fix landed in one copy
 * and not the other silently invalidates what the browser specs claim to
 * prove. Until the copies collapse into one shared lifecycle module (the
 * deferred refactor), this tool pins the load-bearing invariants both sides
 * must share, parsing ACTUAL VALUES — never comment text.
 * Run: npm run findings-e:parity
 */
import { strict as assert } from "node:assert";
import {
  ngspiceWorkerConstants,
  parseConstants,
  readRepoFile,
} from "./lib/worker-constants.js";

const prodNgspice = readRepoFile("web/standalone/src/wasm/ngspice-service.ts");
const prodOcc = readRepoFile("web/standalone/src/wasm/occ-service.ts");
const stubNgspice = readRepoFile("tests/kicad/utils/ngspice-service.ts");
const stubOcc = readRepoFile("tests/kicad/utils/occ-service.ts");
const bootTs = readRepoFile("web/standalone/src/wasm/boot.ts");
const workerJs = readRepoFile("web/standalone/src/wasm/ngspice-worker.js");

// --- credit window: worker ≡ production host ≡ harness stub -----------------
// The host queue caps must EQUAL the worker's credit window or the protocol
// retires healthy workers ("event-frame queue exceeded credit").
const worker = ngspiceWorkerConstants();
const hostCaps = ["MAX_QUEUED_EVENT_FRAMES", "MAX_QUEUED_EVENT_BYTES"] as const;
const prodCaps = parseConstants(prodNgspice, hostCaps, "production ngspice-service.ts");
const stubCaps = parseConstants(stubNgspice, hostCaps, "stub ngspice-service.ts");
assert.equal(prodCaps.MAX_QUEUED_EVENT_FRAMES, worker.MAX_EVENT_UNACKED_FRAMES,
  "credit window FRAMES: production host must equal the worker");
assert.equal(prodCaps.MAX_QUEUED_EVENT_BYTES, worker.MAX_EVENT_UNACKED_UTF8_BYTES,
  "credit window BYTES: production host must equal the worker");
assert.deepEqual(stubCaps, prodCaps,
  "credit window: the harness stub must equal the production host");

// --- E-19: the frame ack survives a throwing handler (both copies) ----------
for (const [label, src] of [
  ["production ngspice-service.ts", prodNgspice],
  ["stub ngspice-service.ts", stubNgspice],
] as const) {
  const start = src.indexOf("const dispatchEvt");
  const end = src.indexOf("deliverTerminalEvents", start);
  assert.ok(start >= 0 && end > start, `${label}: dispatchEvt body not found`);
  const body = src.slice(start, end);
  assert.ok(/finally\s*\{[\s\S]{0,80}?ackEvent\(/.test(body),
    `E-19 REGRESSION (${label}): dispatchEvt must ack the owned frame in a `
      + "finally — a throwing handler leaked one credit unit per throw");
}

// --- E-20: the terminal notice's pendingEvents are consumed (both copies) ---
for (const [label, src] of [
  ["production ngspice-service.ts", prodNgspice],
  ["stub ngspice-service.ts", stubNgspice],
] as const) {
  assert.ok(src.includes("deliverTerminalEvents(data.pendingEvents)"),
    `E-20 (${label}): the fatal branch must deliver the worker's accepted-`
      + "prefix pendingEvents before retiring");
}
assert.ok(workerJs.includes("postMessage({ fatal: reason, pendingEvents })"),
  "E-20 (ngspice-worker.js): the terminal notice must carry the deferred frames");

// --- E-10: retirement synthesizes the controlled exit (both copies) ---------
assert.ok(/kind: "exit", status: 1, immediate: true, quit: false/.test(prodNgspice),
  "E-10 (production): retireWorker must synthesize the controlled exit");
assert.ok(/kind: 'exit', status: 1, immediate: true, quit: false/.test(stubNgspice),
  "E-10 (stub): retireWorker must synthesize the controlled exit");

// --- E-10 recovery: the worker guards pre-init engine access ----------------
assert.ok(workerJs.includes("let engineReady") && workerJs.includes("ensureEngine("),
  "E-10 (ngspice-worker.js): pre-init reads must answer empty shapes and "
    + "writes must lazy-init the fresh engine");

// --- E-22 / E-1: a boot deadline exists in all four lifecycle copies --------
for (const [label, src] of [
  ["production ngspice-service.ts", prodNgspice],
  ["production occ-service.ts", prodOcc],
  ["stub ngspice-service.ts", stubNgspice],
  ["stub occ-service.ts", stubOcc],
] as const) {
  assert.ok(src.includes("bootTimer") && src.includes("boot timed out after"),
    `E-22 REGRESSION (${label}): the boot deadline is gone — a wedged worker `
      + "boot hangs every request with zero evidence");
}

// --- E-14: boot wires Module.onAbort to the scheduler's terminal latch ------
assert.ok(/onAbort[\s\S]{0,600}?terminalize\?\.\(\s*"emscripten abort"/.test(bootTs),
  "E-14 (boot.ts): Module.onAbort must latch __wxScheduler.terminalize — the "
    + "authoritative abort notification");

console.log("service-stub-parity: all green");
