import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ngspice-live-worker.js?raw", () => ({ default: "// fake live worker" }));
vi.mock("./wasm-assets", () => ({
  resolveWasmBase: vi.fn(async () => "/wasm"),
}));

import {
  circuitOf,
  createLiveEngine,
  liveWorkerBlobParts,
  type LiveCircuit,
  type LiveEngine,
  type LiveEngineOptions,
  type LiveLogLine,
} from "./live-engine";
import { resolveWasmBase } from "./wasm-assets";
import { FakeWorker, waitForWorker } from "./test-utils/fake-worker";

const mockedResolveWasmBase = vi.mocked(resolveWasmBase);

const BOOT_TIMEOUT_MS = 1_000;
const RESPONSE_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 5_000;

const CIRCUIT: LiveCircuit = {
  deck: ["* keys", "V1 vcc 0 dc 5", "XSW1 vcc btn PJ_BUTTON", ".tran 1m 100000 0 1m", ".end"],
  files: [{ path: "/sim-library/push-button/model.lib", text: ".subckt PJ_BUTTON 1 2\n.ends" }],
  inputs: { "v.xsw1.vctl": 0 },
  parts: [{ name: "demo-counter", bytes: new Uint8Array([0, 97, 115, 109]) }],
};

interface Sent {
  id: number;
  cmd: string;
  [key: string]: unknown;
}

const sent = (worker: FakeWorker, call: number): Sent =>
  worker.postMessage.mock.calls[call]![0] as Sent;

const lastSent = (worker: FakeWorker): Sent =>
  sent(worker, worker.postMessage.mock.calls.length - 1);

/** Answer the worker's latest command. */
const answer = (worker: FakeWorker, res: Record<string, unknown> = { ok: true }): void =>
  worker.emitMessage({ id: lastSent(worker).id, res });

/** Wait until the worker got its n-th command. */
const commands = (worker: FakeWorker, n: number): Promise<void> =>
  vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(n));

function engineWith(options: LiveEngineOptions = {}): LiveEngine {
  return createLiveEngine({
    bootTimeoutMs: BOOT_TIMEOUT_MS,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
    startTimeoutMs: START_TIMEOUT_MS,
    ...options,
  });
}

/** Start `circuit` on a fresh worker and let it come up. */
async function running(
  engine: LiveEngine,
  workerIndex = 0,
  circuit: LiveCircuit = CIRCUIT,
): Promise<FakeWorker> {
  const started = engine.start(circuit);
  const worker = await waitForWorker(workerIndex);
  worker.emitMessage({ ready: true });
  await commands(worker, 1);
  answer(worker);
  await started;
  return worker;
}

describe("live engine", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    mockedResolveWasmBase.mockReset();
    mockedResolveWasmBase.mockResolvedValue("/wasm");
    vi.stubGlobal("window", { location: { href: "https://pcbjam.test/editor" } });
    vi.stubGlobal("Worker", FakeWorker);
    let nextBlob = 1;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:live-test-${nextBlob++}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts nothing until the first start", async () => {
    const engine = engineWith();
    expect(engine.state).toBe("idle");
    await expect(engine.frame()).resolves.toBeNull();
    await engine.setInput("v.xsw1.vctl", 1);
    await engine.setSpeed(2);
    await engine.stop();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mockedResolveWasmBase).not.toHaveBeenCalled();
    expect(engine.state).toBe("idle");
  });

  it("the worker is the live wrapper in front of the service's glue", () => {
    expect(liveWorkerBlobParts("https://cdn.test/wasm/ngspice_service.js")).toEqual([
      'self.NGSPICE_GLUE_URL = "https://cdn.test/wasm/ngspice_service.js";\n',
      "// fake live worker",
    ]);
  });

  it("start boots a worker and hands it the whole circuit", async () => {
    const engine = engineWith();
    const started = engine.start(CIRCUIT);
    expect(engine.state).toBe("starting");
    const worker = await waitForWorker(0);
    expect(mockedResolveWasmBase).toHaveBeenCalledWith("ngspice_service");
    // nothing is sent before the worker says it is ready
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emitMessage({ ready: true });
    await commands(worker, 1);
    expect(sent(worker, 0)).toEqual({
      id: expect.any(Number),
      cmd: "start",
      deck: CIRCUIT.deck,
      files: CIRCUIT.files,
      inputs: { "v.xsw1.vctl": 0 },
      parts: [{ name: "demo-counter", bytes: CIRCUIT.parts[0]!.bytes }],
      speed: 1,
    });
    answer(worker);
    await started;
    expect(engine.state).toBe("running");
    expect(engine.crashes).toBe(0);
  });

  it("a circuit ngspice does not take is an error, not a crash", async () => {
    const engine = engineWith();
    const started = engine.start(CIRCUIT);
    const worker = await waitForWorker(0);
    worker.emitMessage({ ready: true });
    await commands(worker, 1);
    answer(worker, { error: "ngspice did not take the circuit (see the log)" });
    await expect(started).rejects.toThrow("ngspice did not take the circuit");
    expect(engine.state).toBe("stopped");
    expect(engine.crashes).toBe(0);
    expect(worker.terminate).not.toHaveBeenCalled();
    await expect(engine.frame()).resolves.toBeNull();
  });

  it("inputs, pause and speed go to the running circuit", async () => {
    const engine = engineWith();
    const worker = await running(engine);

    const input = engine.setInput("v.xsw1.vctl", 1);
    await commands(worker, 2);
    expect(sent(worker, 1)).toMatchObject({ cmd: "input", name: "v.xsw1.vctl", value: 1 });
    answer(worker);
    await input;

    const paused = engine.setPaused(true);
    await commands(worker, 3);
    expect(sent(worker, 2)).toMatchObject({ cmd: "pause", paused: true });
    answer(worker);
    await paused;
    expect(engine.state).toBe("paused");

    const resumed = engine.setPaused(false);
    await commands(worker, 4);
    answer(worker);
    await resumed;
    expect(engine.state).toBe("running");

    const speed = engine.setSpeed(0.25);
    await commands(worker, 5);
    expect(sent(worker, 4)).toMatchObject({ cmd: "speed", speed: 0.25 });
    answer(worker);
    await speed;

    // "as fast as it goes" is 0, whatever is asked for
    const fast = engine.setSpeed(Number.NaN);
    await commands(worker, 6);
    expect(sent(worker, 5)).toMatchObject({ cmd: "speed", speed: 0 });
    answer(worker);
    await fast;
  });

  it("a frame carries the values, and the names from the frame that had them", async () => {
    const engine = engineWith();
    const worker = await running(engine);

    const first = engine.frame();
    // a second ask while the first is on its way is the same ask
    expect(engine.frame()).toBe(first);
    await commands(worker, 2);
    expect(sent(worker, 1)).toMatchObject({ cmd: "frame" });
    answer(worker, {
      t: 0.5, points: 520, load: 0.03, achieved: 1, lagging: false, running: true,
      latest: new Float64Array([5, 0.009]), avg: new Float64Array([5, 0.008]),
      names: ["vcc", "v.xd1.vsense#branch"],
    });
    await expect(first).resolves.toEqual({
      t: 0.5, points: 520, load: 0.03, achieved: 1, lagging: false, running: true, problem: null,
      names: ["vcc", "v.xd1.vsense#branch"],
      latest: new Float64Array([5, 0.009]), avg: new Float64Array([5, 0.008]),
    });

    const second = engine.frame();
    await commands(worker, 3);
    answer(worker, {
      t: 0.53, points: 551, load: 0.04, achieved: 1, lagging: true, running: true,
      latest: new Float64Array([5, 0]), avg: new Float64Array([5, 0.004]),
    });
    const frame = await second;
    expect(frame?.names).toEqual(["vcc", "v.xd1.vsense#branch"]);
    expect(frame?.lagging).toBe(true);
    expect(engine.state).toBe("running");
  });

  it("a run that ended by itself reads as stopped, with the reason when a part is behind it", async () => {
    const engine = engineWith();
    const worker = await running(engine);
    const asked = engine.frame();
    await commands(worker, 2);
    answer(worker, {
      t: 0, points: 1, load: 0, achieved: 0, lagging: false, running: false,
      latest: new Float64Array(0), avg: new Float64Array(0), names: [],
      problem: "no code part named 'demo-counter' is loaded",
    });
    const frame = await asked;
    expect(frame?.running).toBe(false);
    expect(frame?.problem).toBe("no code part named 'demo-counter' is loaded");
    expect(engine.state).toBe("stopped");
    expect(engine.crashes).toBe(0);
    await expect(engine.frame()).resolves.toBeNull();
  });

  it("restart runs the same circuit with the inputs and the speed as they are now", async () => {
    const engine = engineWith();
    const worker = await running(engine);

    const input = engine.setInput("v.xsw1.vctl", 1);
    await commands(worker, 2);
    answer(worker);
    await input;
    const speed = engine.setSpeed(2);
    await commands(worker, 3);
    answer(worker);
    await speed;
    const part = engine.setPart("demo-counter", new Uint8Array([9, 9]));
    await commands(worker, 4);
    expect(sent(worker, 3)).toMatchObject({ cmd: "part", name: "demo-counter" });
    answer(worker);
    await part;

    const again = engine.restart();
    await commands(worker, 5);
    expect(sent(worker, 4)).toMatchObject({
      cmd: "start",
      deck: CIRCUIT.deck,
      inputs: { "v.xsw1.vctl": 1 },
      parts: [{ name: "demo-counter", bytes: new Uint8Array([9, 9]) }],
      speed: 2,
    });
    answer(worker);
    await again;
    expect(engine.state).toBe("running");
    // the same worker: nothing crashed
    expect(FakeWorker.instances).toHaveLength(1);
    // the circuit that was handed in is not written to
    expect(CIRCUIT.inputs).toEqual({ "v.xsw1.vctl": 0 });
  });

  it("stop halts the run and keeps the circuit for a restart", async () => {
    const engine = engineWith();
    const worker = await running(engine);
    const stopped = engine.stop();
    await commands(worker, 2);
    expect(sent(worker, 1)).toMatchObject({ cmd: "stop" });
    answer(worker);
    await stopped;
    expect(engine.state).toBe("stopped");
    await expect(engine.frame()).resolves.toBeNull();

    // an input set now is kept, not sent
    await engine.setInput("v.xsw1.vctl", 1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);

    const again = engine.restart();
    await commands(worker, 3);
    expect(sent(worker, 2)).toMatchObject({ cmd: "start", inputs: { "v.xsw1.vctl": 1 } });
    answer(worker);
    await again;
    expect(engine.state).toBe("running");
  });

  it("a fatal notice throws the worker away; restart runs the circuit on a new one", async () => {
    const onCrash = vi.fn();
    const engine = engineWith({ onCrash });
    const worker = await running(engine);
    const input = engine.setInput("v.xsw1.vctl", 1);
    await commands(worker, 2);
    answer(worker);
    await input;

    const asked = engine.frame();
    await commands(worker, 3);
    worker.emitMessage({ fatal: "unreachable" });

    await expect(asked).rejects.toThrow("the simulation engine stopped working: unreachable");
    expect(engine.state).toBe("crashed");
    expect(engine.crashes).toBe(1);
    expect(engine.lastCrash).toBe("the simulation engine stopped working: unreachable");
    expect(onCrash).toHaveBeenCalledExactlyOnceWith("the simulation engine stopped working: unreachable");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:live-test-1");
    await expect(engine.frame()).resolves.toBeNull();
    // what the dead worker still says is not heard
    worker.emitMessage({ fatal: "again" });
    expect(engine.crashes).toBe(1);

    const again = engine.restart();
    const fresh = await waitForWorker(1);
    expect(fresh).not.toBe(worker);
    fresh.emitMessage({ ready: true });
    await commands(fresh, 1);
    expect(sent(fresh, 0)).toMatchObject({
      cmd: "start",
      deck: CIRCUIT.deck,
      files: CIRCUIT.files,
      inputs: { "v.xsw1.vctl": 1 },
    });
    answer(fresh);
    await again;
    expect(engine.state).toBe("running");
    expect(engine.crashes).toBe(1);
  });

  it("an error event of the worker is a crash", async () => {
    const onCrash = vi.fn();
    const engine = engineWith({ onCrash });
    const worker = await running(engine);
    worker.emitError("RuntimeError: memory access out of bounds");
    expect(engine.state).toBe("crashed");
    expect(onCrash).toHaveBeenCalledExactlyOnceWith(
      "the simulation engine stopped working: RuntimeError: memory access out of bounds",
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("an answer that does not come is a crash", async () => {
    vi.useFakeTimers();
    const engine = engineWith();
    const started = engine.start(CIRCUIT);
    await vi.advanceTimersByTimeAsync(0);
    const worker = FakeWorker.instances[0]!;
    worker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    answer(worker);
    await started;

    const asked = engine.frame();
    const failed = expect(asked).rejects.toThrow(
      `the simulation engine did not answer "frame" within ${RESPONSE_TIMEOUT_MS} ms`,
    );
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await failed;
    expect(engine.state).toBe("crashed");
    expect(engine.crashes).toBe(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("a worker that never comes up is a crash, and the next start tries a new one", async () => {
    vi.useFakeTimers();
    const engine = engineWith();
    const started = engine.start(CIRCUIT);
    const failed = expect(started).rejects.toThrow(
      `the simulation engine did not start within ${BOOT_TIMEOUT_MS} ms`,
    );
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
    await failed;
    expect(engine.state).toBe("crashed");
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);

    const again = engine.restart();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = FakeWorker.instances[1]!;
    fresh.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    answer(fresh);
    await again;
    expect(engine.state).toBe("running");
  });

  it("a worker that says it could not start is a crash with its words", async () => {
    const engine = engineWith();
    const started = engine.start(CIRCUIT);
    const worker = await waitForWorker(0);
    worker.emitMessage({ bootError: "this ngspice_service build has no live engine" });
    await expect(started).rejects.toThrow(
      "the simulation engine did not start: this ngspice_service build has no live engine",
    );
    expect(engine.state).toBe("crashed");
    expect(engine.crashes).toBe(1);
  });

  it("a run that cannot be stopped costs the worker", async () => {
    const engine = engineWith();
    const worker = await running(engine);
    const stopped = engine.stop();
    await commands(worker, 2);
    answer(worker, { error: "the run did not stop" });
    await expect(stopped).rejects.toThrow("the run did not stop");
    expect(engine.state).toBe("crashed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("an answer to an older run does not change a newer one", async () => {
    const engine = engineWith();
    const worker = await running(engine);
    const asked = engine.frame();
    await commands(worker, 2);
    const frameId = lastSent(worker).id;
    const again = engine.restart();
    await commands(worker, 3);
    // the old frame says "not running"; it is about the run before this one
    worker.emitMessage({ id: frameId, res: { t: 3, running: false } });
    await expect(asked).resolves.toBeNull();
    expect(engine.state).toBe("starting");
    answer(worker);
    await again;
    expect(engine.state).toBe("running");
  });

  it("console lines are handed on in batches", async () => {
    const onLog = vi.fn();
    const engine = engineWith({ onLog });
    const worker = await running(engine);
    const lines: LiveLogLine[] = [["spice", "Warning: singular matrix"], ["part", "demo-counter: hello"]];
    worker.emitMessage({ log: lines, dropped: 3 });
    expect(onLog).toHaveBeenCalledExactlyOnceWith(lines, 3);
  });

  it("dispose throws the worker away without calling it a crash", async () => {
    const onCrash = vi.fn();
    const engine = engineWith({ onCrash });
    const worker = await running(engine);
    const asked = engine.frame();
    await commands(worker, 2);
    engine.dispose();
    await expect(asked).rejects.toThrow("the simulation engine was closed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(engine.state).toBe("idle");
    expect(engine.crashes).toBe(0);
    expect(onCrash).not.toHaveBeenCalled();
    await expect(engine.restart()).rejects.toThrow("there is no circuit to run");
  });
});

describe("circuitOf", () => {
  const logic = new Uint8Array([0, 97, 115, 109]);
  const deck = {
    deck: ["* x", ".end"],
    files: [{ path: "/sim-library/push-button/model.lib", text: "x" }],
    inputs: [
      {
        ref: "SW1", partId: "push-button", vector: "v.xsw1.vctl", initial: 0,
        input: { name: "pressed", type: "momentary" as const, source: "Vctl", released: 0, held: 1 },
      },
      {
        ref: "RV1", partId: "potentiometer", vector: "v.xrv1.vpos", initial: 0.5,
        input: { name: "position", type: "range" as const, source: "Vpos", min: 0, max: 1, default: 0.5 },
      },
    ],
    codeParts: [{ partId: "demo-counter", kind: "part-wasm" as const, logic }],
    errors: [] as string[],
  };

  it("names the inputs by the simulator's names and the code by the part's id", () => {
    expect(circuitOf(deck)).toEqual({
      deck: ["* x", ".end"],
      files: [{ path: "/sim-library/push-button/model.lib", text: "x" }],
      inputs: { "v.xsw1.vctl": 0, "v.xrv1.vpos": 0.5 },
      parts: [{ name: "demo-counter", bytes: logic }],
    });
  });

  it("does not hand on a circuit the netlist step found errors in", () => {
    expect(() => circuitOf({ ...deck, errors: ["U1: the library part \"x\" is not loaded", "second"] }))
      .toThrow('U1: the library part "x" is not loaded; second');
  });

  it("says so when a part needs an emulator", () => {
    expect(() =>
      circuitOf({ ...deck, codeParts: [{ partId: "esp32-c3-wroom-02", kind: "emulator" as const, logic: null }] }),
    ).toThrow("esp32-c3-wroom-02: a part that runs an emulator cannot be simulated yet");
  });
});
