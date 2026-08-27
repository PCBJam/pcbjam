/**
 * Behavioral reducer for ngspice-worker.js output batching and transport
 * credits. It executes the production worker source in a VM with a synchronous
 * fake native module, where queued microtasks cannot hide retained bursts.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ngspiceWorkerConstants } from "./lib/worker-constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const workerSource = readFileSync(
  path.join(repo, "web/standalone/src/wasm/ngspice-worker.js"),
  "utf8",
);

// The transport numbers, parsed from the PRODUCTION worker source — the
// reducer must never hardcode copies that go stale when the protocol moves.
const C = ngspiceWorkerConstants();
const BATCH_LINES = C.MAX_EVENT_BATCH_LINES!;
const BATCH_BYTES = C.MAX_EVENT_BATCH_UTF8_BYTES!;
const WINDOW_FRAMES = C.MAX_EVENT_UNACKED_FRAMES!;
const WINDOW_BYTES = C.MAX_EVENT_UNACKED_UTF8_BYTES!;

type Frame = {
  id?: number;
  evt?: { kind: string; lines?: string[]; finished?: boolean };
  fatal?: string;
  pendingEvents?: Array<{ evt?: { kind: string; lines?: string[] }; eventBytes?: number }>;
  res?: { error?: string };
  eventSequence?: number;
  eventBytes?: number;
};

type WorkerHarness = {
  frames: Frame[];
  emit(kind: number, text: string, a: number, b: number): void;
  message(data: unknown): Promise<void>;
};

async function createWorkerHarness(
  moduleOverrides: Record<string, any> = {},
): Promise<WorkerHarness> {
  const frames: Frame[] = [];
  let messageHandler!: (event: { data: unknown }) => Promise<void>;
  const module: Record<string, any> = {
    init: () => 0,
    circ: () => 0,
    command: () => 0,
    getVecInfo: () => ({ found: false }),
    curPlot: () => "",
    allPlots: () => [],
    allVecs: () => [],
    running: () => false,
    cmInputPath: () => undefined,
    ...moduleOverrides,
  };
  const workerGlobal: Record<string, unknown> = {
    NGSPICE_GLUE_URL: "https://pcbjam.test/ngspice_service.js",
    addEventListener: () => undefined,
  };
  Object.defineProperty(workerGlobal, "onmessage", {
    set(value) { messageHandler = value as typeof messageHandler; },
  });
  const context = vm.createContext({
    self: workerGlobal,
    console,
    Blob,
    URL,
    RangeError,
    String,
    Number,
    Map,
    JSON,
    Promise,
    TextEncoder,
    queueMicrotask,
    importScripts: () => undefined,
    NgspiceService: () => Promise.resolve(module),
    postMessage: (frame: Frame) => frames.push(structuredClone(frame)),
    structuredClone,
  });

  vm.runInContext(workerSource, context, { filename: "ngspice-worker.js" });
  await Promise.resolve();
  assert.equal(typeof module.ngspiceEmit, "function");
  assert.equal(typeof messageHandler, "function");
  frames.length = 0; // discard ready
  return {
    frames,
    emit: module.ngspiceEmit,
    message: (data) => messageHandler({ data }),
  };
}

async function acknowledgeAll(harness: WorkerHarness): Promise<void> {
  for (const frame of harness.frames) {
    if (!frame.eventSequence) continue;
    await harness.message({
      eventAck: {
        sequence: frame.eventSequence,
        bytes: frame.eventBytes,
      },
    });
  }
}

async function main(): Promise<void> {
const bounded = await createWorkerHarness();
// Two full batches plus one synchronous line cannot wait for a microtask:
// both flush on the line bound, and the final line flushes at the queued
// microtask.
const floodLines = 2 * BATCH_LINES + 1;
for (let i = 0; i < floodLines; ++i) bounded.emit(0, `line-${i}`, 0, 0);
assert.deepEqual(
  bounded.frames.map((frame) => frame.evt?.lines?.length),
  [BATCH_LINES, BATCH_LINES],
);
await Promise.resolve();
assert.deepEqual(
  bounded.frames.map((frame) => frame.evt?.lines?.length),
  [BATCH_LINES, BATCH_LINES, 1],
);
assert.deepEqual(
  bounded.frames.flatMap((frame) => frame.evt?.lines ?? []),
  Array.from({ length: floodLines }, (_, i) => `line-${i}`),
);
await acknowledgeAll(bounded);
console.log("ok   synchronous output flushes in bounded ordered line chunks");

bounded.frames.length = 0;
const wide = "x".repeat(400_000);
bounded.emit(0, `${wide}-0`, 0, 0);
bounded.emit(0, `${wide}-1`, 0, 0);
bounded.emit(0, `${wide}-2`, 0, 0); // crossing line flushes first two
assert.equal(bounded.frames.length, 1);
assert.deepEqual(
  bounded.frames[0]!.evt!.lines!.map((line) => line.at(-1)),
  ["0", "1"],
);
assert.ok(bounded.frames[0]!.eventBytes! <= BATCH_BYTES);
await Promise.resolve();
assert.equal(bounded.frames[1]!.evt!.lines!.length, 1);
assert.ok(bounded.frames[1]!.eventBytes! <= BATCH_BYTES);
await acknowledgeAll(bounded);
console.log("ok   UTF-8 byte pressure flushes before retaining the crossing line");

const storm = await createWorkerHarness();
const chunk = "z".repeat(900_000);
for (let i = 0; i < 100_000; ++i) {
  try {
    storm.emit(0, `${chunk}-${i}`, 0, 0);
  } catch {
    // Continue attempts deliberately: terminal state must remain inert and
    // must never post another retained frame.
  }
}
await Promise.resolve();
const stormEvents = storm.frames.filter((frame) => frame.evt);
assert.ok(stormEvents.length <= WINDOW_FRAMES);
assert.ok(
  stormEvents.reduce((sum, frame) => sum + frame.eventBytes!, 0)
    <= WINDOW_BYTES,
);
assert.equal(storm.frames.filter((frame) => frame.fatal).length, 1);
assert.match(storm.frames.find((frame) => frame.fatal)!.fatal!, /deferred/);
console.log("ok   100,000 synchronous chunk attempts cannot exceed transport credit");

// A FULL credit window is backpressure, not a fault: frames beyond the window
// defer (bounded) and drain IN ORDER as acks free credit. The regression this
// pins: the first shipped shape terminally stopped the stream at 64 in-flight
// frames, killing a live simulation whenever the main thread lagged one
// window behind (observed as "event transport exceeded 64 frames" ending the
// eeschema second-run spec).
const paced = await createWorkerHarness();
const pacedTotal = WINDOW_FRAMES + 16;
for (let i = 0; i < pacedTotal; ++i) {
  paced.emit(2, "", i % 2, 0); // bg toggles: one frame per emit, no batching
}
await Promise.resolve();
assert.equal(paced.frames.filter((f) => f.fatal).length, 0,
  "a full window with a live consumer must not be terminal");
assert.equal(paced.frames.filter((f) => f.evt).length, WINDOW_FRAMES,
  "exactly the credit window is in flight");
await acknowledgeAll(paced);
await Promise.resolve();
const pacedEvents = paced.frames.filter((f) => f.evt);
assert.equal(pacedEvents.length, pacedTotal, "deferred frames drained after acks");
assert.deepEqual(
  pacedEvents.map((f) => f.evt!.finished),
  Array.from({ length: pacedTotal }, (_, i) => !(i % 2 === 0)),
  "deferred frames preserve emission order",
);
console.log("ok   a full credit window defers and drains in order, never terminal");

const oversize = await createWorkerHarness();
const oversizeFatal = `ngspice event line exceeds ${BATCH_BYTES} UTF-8 bytes`;
assert.throws(
  () => oversize.emit(0, "y".repeat(BATCH_BYTES), 0, 0),
  new RegExp(oversizeFatal),
);
assert.deepEqual(oversize.frames, [{
  fatal: oversizeFatal,
  pendingEvents: [],
}]);
assert.throws(
  () => oversize.emit(0, "late", 0, 0),
  new RegExp(oversizeFatal),
);
await oversize.message({ id: 91, req: { kind: "running" } });
assert.deepEqual(oversize.frames.at(-1), {
  id: 91,
  res: { error: oversizeFatal },
});
console.log("ok   a single over-limit line is never retained and terminalizes requests");

// E-20: the oversize-line path promises "every earlier line was accepted …
// transfer it before refusing this line". With the credit window FULL, that
// flush can only DEFER — the terminal stop must ship the deferred frames
// inside the fatal notice instead of wiping them (they are typically the last
// diagnostics explaining why the run died).
const prefixed = await createWorkerHarness();
for (let i = 0; i < WINDOW_FRAMES; ++i) prefixed.emit(2, "", i % 2, 0); // fill the window
prefixed.emit(0, "accepted-1", 0, 0);
prefixed.emit(0, "accepted-2", 0, 0);
prefixed.emit(0, "accepted-3", 0, 0); // open batch, flush still queued
assert.throws(
  () => prefixed.emit(0, "y".repeat(BATCH_BYTES), 0, 0),
  new RegExp(oversizeFatal),
);
const terminalNotice = prefixed.frames.find((frame) => frame.fatal);
assert.ok(terminalNotice, "terminal notice posted");
const deliveredLines = [
  ...prefixed.frames.flatMap((frame) => frame.evt?.lines ?? []),
  ...(terminalNotice!.pendingEvents ?? [])
    .flatMap((entry) => entry.evt?.lines ?? []),
];
for (const line of ["accepted-1", "accepted-2", "accepted-3"]) {
  assert.ok(deliveredLines.includes(line),
    `accepted line "${line}" must reach the host despite the terminal stop`);
}
console.log("ok   the accepted prefix survives a terminal stop under a full window");

// E-10 recovery: a REPLACEMENT worker serves engine reads before its first
// init (the editor's crash-recovery finish pulls vectors right after a
// worker death). An uninitialized engine traps on those entries — and a
// trapped engine then hangs later requests, parking the finish chain. The
// worker must answer the empty shapes itself, never touching the engine.
const engineTrap = () => {
  throw new Error("RuntimeError: indirect call to null (uninitialized engine)");
};
const preInit = await createWorkerHarness({
  getVecInfo: engineTrap, curPlot: engineTrap, allPlots: engineTrap,
  allVecs: engineTrap, running: engineTrap,
});
await preInit.message({ id: 1, req: { kind: "get_vec_info", name: "time" } });
assert.deepEqual(preInit.frames.at(-1), { id: 1, res: { found: false } });
await preInit.message({ id: 2, req: { kind: "cur_plot" } });
assert.deepEqual(preInit.frames.at(-1), { id: 2, res: { name: "" } });
await preInit.message({ id: 3, req: { kind: "all_plots" } });
assert.deepEqual(preInit.frames.at(-1), { id: 3, res: { names: [] } });
await preInit.message({ id: 4, req: { kind: "running" } });
assert.deepEqual(preInit.frames.at(-1), { id: 4, res: { running: false } });
// After init, reads reach the engine again (the trapping fake IS called).
await preInit.message({ id: 5, req: { kind: "init" } });
assert.deepEqual(preInit.frames.at(-1), { id: 5, res: { ret: 0 } });
await preInit.message({ id: 6, req: { kind: "get_vec_info", name: "time" } });
assert.match(
  (preInit.frames.at(-1) as { res?: { error?: string } }).res!.error!,
  /uninitialized engine/,
);
console.log("ok   engine reads answer their empty shapes before the first init");

// …and engine WRITES lazy-init the fresh engine (the editor issues
// cm_input_path/circ before its validate() re-init), with the init request
// idempotent per worker engine.
let lazyInits = 0;
const lazy = await createWorkerHarness({
  init: () => { lazyInits++; return 0; },
});
await lazy.message({ id: 1, req: { kind: "circ", lines: ["*", ".end"] } });
assert.equal(lazyInits, 1, "first write initialized the engine");
assert.deepEqual(lazy.frames.at(-1), { id: 1, res: { ret: 0 } });
await lazy.message({ id: 2, req: { kind: "init" } });
assert.equal(lazyInits, 1, "init is idempotent per worker engine");
assert.deepEqual(lazy.frames.at(-1), { id: 2, res: { ret: 0 } });
console.log("ok   engine writes lazy-init a fresh engine; init is idempotent");

const ackMismatch = await createWorkerHarness();
ackMismatch.emit(2, "", 0, 0);
const credited = ackMismatch.frames[0]!;
await assert.rejects(
  ackMismatch.message({
    eventAck: {
      sequence: credited.eventSequence,
      bytes: credited.eventBytes! + 1,
    },
  }),
  /acknowledgment did not match an exact frame/,
);
assert.equal(ackMismatch.frames.filter((frame) => frame.fatal).length, 1);
console.log("ok   acknowledgment must match the exact sequence and byte lease");

console.log("ngspice-worker-batch-unit: all green");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
