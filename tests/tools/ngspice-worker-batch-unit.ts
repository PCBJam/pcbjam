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

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const workerSource = readFileSync(
  path.join(repo, "web/standalone/src/wasm/ngspice-worker.js"),
  "utf8",
);

type Frame = {
  id?: number;
  evt?: { kind: string; lines?: string[]; finished?: boolean };
  fatal?: string;
  res?: { error?: string };
  eventSequence?: number;
  eventBytes?: number;
};

type WorkerHarness = {
  frames: Frame[];
  emit(kind: number, text: string, a: number, b: number): void;
  message(data: unknown): Promise<void>;
};

async function createWorkerHarness(): Promise<WorkerHarness> {
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
// 1,025 synchronous lines cannot wait for a microtask: 512, 512 flush on the
// line bound, and the final line flushes at the queued microtask.
for (let i = 0; i < 1_025; ++i) bounded.emit(0, `line-${i}`, 0, 0);
assert.deepEqual(
  bounded.frames.map((frame) => frame.evt?.lines?.length),
  [512, 512],
);
await Promise.resolve();
assert.deepEqual(
  bounded.frames.map((frame) => frame.evt?.lines?.length),
  [512, 512, 1],
);
assert.deepEqual(
  bounded.frames.flatMap((frame) => frame.evt?.lines ?? []),
  Array.from({ length: 1_025 }, (_, i) => `line-${i}`),
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
assert.ok(bounded.frames[0]!.eventBytes! <= 1024 * 1024);
await Promise.resolve();
assert.equal(bounded.frames[1]!.evt!.lines!.length, 1);
assert.ok(bounded.frames[1]!.eventBytes! <= 1024 * 1024);
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
assert.ok(stormEvents.length <= 64);
assert.ok(
  stormEvents.reduce((sum, frame) => sum + frame.eventBytes!, 0)
    <= 8 * 1024 * 1024,
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
for (let i = 0; i < 80; ++i) {
  paced.emit(2, "", i % 2, 0); // bg toggles: one frame per emit, no batching
}
await Promise.resolve();
assert.equal(paced.frames.filter((f) => f.fatal).length, 0,
  "a full window with a live consumer must not be terminal");
assert.equal(paced.frames.filter((f) => f.evt).length, 64,
  "exactly the credit window is in flight");
await acknowledgeAll(paced);
await Promise.resolve();
const pacedEvents = paced.frames.filter((f) => f.evt);
assert.equal(pacedEvents.length, 80, "deferred frames drained after acks");
assert.deepEqual(
  pacedEvents.map((f) => f.evt!.finished),
  Array.from({ length: 80 }, (_, i) => !(i % 2 === 0)),
  "deferred frames preserve emission order",
);
console.log("ok   a full credit window defers and drains in order, never terminal");

const oversize = await createWorkerHarness();
assert.throws(
  () => oversize.emit(0, "y".repeat(1024 * 1024), 0, 0),
  /ngspice event line exceeds 1048576 UTF-8 bytes/,
);
assert.deepEqual(oversize.frames, [{
  fatal: "ngspice event line exceeds 1048576 UTF-8 bytes",
}]);
assert.throws(
  () => oversize.emit(0, "late", 0, 0),
  /ngspice event line exceeds 1048576 UTF-8 bytes/,
);
await oversize.message({ id: 91, req: { kind: "running" } });
assert.deepEqual(oversize.frames.at(-1), {
  id: 91,
  res: { error: "ngspice event line exceeds 1048576 UTF-8 bytes" },
});
console.log("ok   a single over-limit line is never retained and terminalizes requests");

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
