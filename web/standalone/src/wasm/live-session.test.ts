import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedRun } from "@pcbjam/shared/sim-library";

// The engine's module pulls the worker script in as text and asks where the
// wasm lives; neither is needed here (the session gets a made-up engine).
vi.mock("./ngspice-live-worker.js?raw", () => ({ default: "" }));
vi.mock("./wasm-assets", () => ({ resolveWasmBase: async () => "http://wasm.test" }));

import type { LiveEngine, LiveEngineOptions, LiveFrame } from "./live-engine";
import {
  createLiveSession,
  leftOutNote,
  hasToolbarButton,
  LIVE_BUTTON_ID,
  LIVE_BUTTON_PLAY,
  LIVE_BUTTON_STOP,
  type LiveSessionState,
  type ToolbarButtonModule,
} from "./live-session";
import type { SimPartsReader, SimSymbolsModule } from "./sim-parts";

const prepared = (over: Partial<PreparedRun> = {}): PreparedRun => ({
  deck: ["* test", "R1 a 0 1k", ".tran 1m 100000 0 1m", ".end"],
  files: [{ path: "/sim-library/led/model.lib", text: "* led" }],
  inputs: [],
  signals: [],
  codeParts: [],
  placed: [],
  notSimulated: [],
  notes: [],
  errors: [],
  plan: [],
  parts: new Map(),
  ...over,
});

const frame = (over: Partial<LiveFrame> = {}): LiveFrame => ({
  t: 1, points: 1000, load: 0.02, achieved: 1, lagging: false, running: true, problem: null,
  names: [], latest: new Float64Array(0), avg: new Float64Array(0),
  ...over,
});

/** Resolves or rejects when the test says so. */
function gate<T>() {
  let open!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

function setup(over: { prepare?: SimPartsReader["prepare"]; watchMs?: number; frameMs?: number } = {}) {
  const notes: string[] = [];
  const button = vi.fn((_id: string, _tooltip: string, _icon: string) => true);
  const mod: SimSymbolsModule & ToolbarButtonModule = {
    kicadSimSymbols: () => "{}",
    kicadSimNetlist: () => "{}",
    kicadSchToolbarButton: button,
  };
  const prepare = vi.fn(over.prepare ?? (async () => prepared()));
  const reader = { base: "http://lib.test", prepare } as unknown as SimPartsReader;

  let engineOptions!: LiveEngineOptions;
  const engine = {
    state: "idle",
    crashes: 0,
    lastCrash: null,
    start: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    setSpeed: vi.fn(async () => {}),
    setInput: vi.fn(async () => {}),
    setPart: vi.fn(async () => {}),
    frame: vi.fn(async (): Promise<LiveFrame | null> => frame()),
    dispose: vi.fn(),
  };
  const errors: string[] = [];
  const states: LiveSessionState[] = [];
  const session = createLiveSession({
    mod,
    reader,
    onError: (text) => errors.push(text),
    onNote: (text) => notes.push(text),
    onState: (state) => states.push(state),
    watchMs: over.watchMs ?? 250,
    frameMs: over.frameMs ?? 50,
    createEngine: (options) => {
      engineOptions = options;
      return engine as unknown as LiveEngine;
    },
  });
  /** A click on the toolbar button, as the editor tells it. */
  const press = (id = LIVE_BUTTON_ID) => mod.onHostToolbarButton!(id);
  /** Let what a click started run to its end. */
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return { mod, button, prepare, engine, errors, notes, states, session, press, settle, engineOptions: () => engineOptions };
}

const PLAY = [LIVE_BUTTON_ID, LIVE_BUTTON_PLAY.tooltip, LIVE_BUTTON_PLAY.icon];
const STOP = [LIVE_BUTTON_ID, LIVE_BUTTON_STOP.tooltip, LIVE_BUTTON_STOP.icon];

describe("live session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the Play button and starts nothing", () => {
    const { button, prepare, engine, session } = setup();
    expect(button.mock.calls).toEqual([PLAY]);
    expect(session.state).toBe("idle");
    expect(session.run).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
  });

  it("Play reads the schematic, runs its circuit and shows Stop", async () => {
    const { mod, button, prepare, engine, session, states, press, settle, errors } = setup();
    press();
    await settle();
    expect(prepare).toHaveBeenCalledWith(mod);
    expect(engine.start).toHaveBeenCalledWith({
      deck: ["* test", "R1 a 0 1k", ".tran 1m 100000 0 1m", ".end"],
      files: [{ path: "/sim-library/led/model.lib", text: "* led" }],
      inputs: {},
      parts: [],
    });
    expect(session.state).toBe("running");
    expect(session.run?.deck).toHaveLength(4);
    expect(states).toEqual(["starting", "running"]);
    // Play stays while it starts: the button changes once
    expect(button.mock.calls).toEqual([PLAY, STOP]);
    expect(errors).toEqual([]);
  });

  it("Stop halts the run and shows Play again", async () => {
    const { button, engine, session, states, press, settle } = setup();
    press();
    await settle();
    press();
    await settle();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("idle");
    expect(session.run).toBeNull();
    expect(states).toEqual(["starting", "running", "stopping", "idle"]);
    expect(button.mock.calls).toEqual([PLAY, STOP, PLAY]);
    // and it plays again
    press();
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(session.state).toBe("running");
  });

  it("clicks while it starts are not a second start or a stop", async () => {
    const wait = gate<PreparedRun>();
    const { prepare, engine, session, press, settle } = setup({ prepare: () => wait.promise });
    press();
    press();
    press();
    await settle();
    expect(session.state).toBe("starting");
    expect(prepare).toHaveBeenCalledTimes(1);
    wait.open(prepared());
    await settle();
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    expect(session.state).toBe("running");
  });

  it("what the netlist step found stops the start, in its words", async () => {
    const { button, engine, session, errors, press, settle } = setup({
      prepare: async () => prepared({ errors: ["D1: pin A has no net", "U3: no part with the id 'nope'"] }),
    });
    press();
    await settle();
    expect(engine.start).not.toHaveBeenCalled();
    expect(session.state).toBe("idle");
    expect(errors).toEqual(["Live simulation did not start: D1: pin A has no net; U3: no part with the id 'nope'"]);
    expect(button.mock.calls, "the button was Play all along").toEqual([PLAY]);
  });

  it("a circuit the simulator does not run is said with the simulator's reason", async () => {
    const { engine, session, errors, states, press, settle } = setup();
    engine.start.mockRejectedValueOnce(
      new Error("ngspice did not run the circuit: Error on line 4 or its substitute: / q1 c b 0 npn / could not find a valid modelname"));
    press();
    await settle();
    expect(session.state).toBe("idle");
    expect(states).toEqual(["starting", "idle"]);
    expect(errors).toEqual([
      "Live simulation did not start: ngspice did not run the circuit: Error on line 4 or its substitute: / q1 c b 0 npn / could not find a valid modelname",
    ]);
    // the next click tries again
    press();
    await settle();
    expect(session.state).toBe("running");
  });

  it("a library that cannot be reached is said", async () => {
    const { session, errors, press, settle } = setup({
      prepare: async () => {
        throw new Error("the simulation library could not be reached (http://lib.test/current.json: 503)");
      },
    });
    press();
    await settle();
    expect(session.state).toBe("idle");
    expect(errors).toEqual([
      "Live simulation did not start: the simulation library could not be reached (http://lib.test/current.json: 503)",
    ]);
  });

  it("a crash while it runs is said once, and the button is Play again", async () => {
    const { button, session, errors, press, settle, engineOptions } = setup();
    press();
    await settle();
    engineOptions().onCrash!("the simulation engine stopped working: unreachable");
    expect(session.state).toBe("idle");
    expect(session.run).toBeNull();
    expect(errors).toEqual(["Live simulation stopped: the simulation engine stopped working: unreachable"]);
    expect(button.mock.calls).toEqual([PLAY, STOP, PLAY]);
  });

  it("a crash while it starts is said by the start alone", async () => {
    const { engine, errors, press, settle, engineOptions } = setup();
    engine.start.mockImplementationOnce(async () => {
      engineOptions().onCrash!("the simulation engine did not start within 120000 ms");
      throw new Error("the simulation engine did not start within 120000 ms");
    });
    press();
    await settle();
    expect(errors).toEqual(["Live simulation did not start: the simulation engine did not start within 120000 ms"]);
  });

  it("looks at the running circuit: a part's problem ends the run with its words", async () => {
    const { engine, session, errors, press, settle } = setup({ watchMs: 250 });
    press();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(engine.frame).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("running");
    expect(session.lastFrame?.t).toBe(1);

    engine.frame.mockResolvedValueOnce(frame({ running: false, problem: "code part 'adc' is not what was loaded: its bytes changed in memory" }));
    await vi.advanceTimersByTimeAsync(250);
    expect(session.state).toBe("idle");
    expect(errors).toEqual(["Live simulation stopped: code part 'adc' is not what was loaded: its bytes changed in memory"]);
    // nothing is looked at any more
    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.frame).toHaveBeenCalledTimes(2);
  });

  it("a run that ends by itself is said with the simulator's last error line", async () => {
    const { engine, session, errors, press, settle, engineOptions } = setup();
    press();
    await settle();
    engineOptions().onLog!([
      ["spice", "Doing analysis at TEMP = 27.000000 and TNOM = 27.000000"],
      ["spice", "doAnalyses: TRAN:  Timestep too small; time = 0.31, timestep = 1e-18"],
      ["run", "ended"],
    ], 0);
    engine.frame.mockResolvedValueOnce(frame({ running: false }));
    await vi.advanceTimersByTimeAsync(250);
    expect(session.state).toBe("idle");
    expect(errors).toEqual([
      "Live simulation stopped by itself: doAnalyses: TRAN:  Timestep too small; time = 0.31, timestep = 1e-18",
    ]);

    // without such a line it still says that it stopped; a line of the run before is not used
    press();
    await settle();
    engine.frame.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(250);
    expect(errors[1]).toBe("Live simulation stopped by itself.");
  });

  it("a stop that fails still ends up with nothing running", async () => {
    const { engine, session, errors, press, settle } = setup();
    press();
    await settle();
    engine.stop.mockRejectedValueOnce(new Error("the run did not stop"));
    press();
    await settle();
    expect(session.state).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("another button's click goes to who listened before, and dispose puts things back", async () => {
    const button = vi.fn(() => true);
    const others: string[] = [];
    const before = (id: string) => { others.push(id); };
    const mod: SimSymbolsModule & ToolbarButtonModule = {
      kicadSimSymbols: () => "{}",
      kicadSchToolbarButton: button,
      onHostToolbarButton: before,
    };
    const engine = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), frame: vi.fn(async () => frame()), dispose: vi.fn() };
    const session = createLiveSession({
      mod,
      reader: { prepare: async () => prepared() } as unknown as SimPartsReader,
      onError: () => {},
      createEngine: () => engine as unknown as LiveEngine,
    });
    mod.onHostToolbarButton!("com.example.other");
    expect(others).toEqual(["com.example.other"]);
    expect(engine.start).not.toHaveBeenCalled();

    session.dispose();
    expect(mod.onHostToolbarButton).toBe(before);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(button.mock.calls).toEqual([PLAY, [LIVE_BUTTON_ID, "", ""]]);
    session.dispose(); // twice is once
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose while it starts: the late start changes nothing", async () => {
    const wait = gate<PreparedRun>();
    const { mod, button, engine, session, errors, states, press, settle } = setup({ prepare: () => wait.promise });
    press();
    await settle();
    session.dispose();
    wait.open(prepared());
    await settle();
    expect(engine.start).not.toHaveBeenCalled();
    expect(session.state).toBe("idle");
    expect(states).toEqual(["starting"]);
    expect(errors).toEqual([]);
    expect(button.mock.calls).toEqual([PLAY, [LIVE_BUTTON_ID, "", ""]]);
    // the editor no longer tells this session about clicks, and a click by hand does nothing
    expect(mod.onHostToolbarButton).toBeUndefined();
    await session.click();
    expect(engine.start).not.toHaveBeenCalled();
  });

  // --- the values, for the widgets on the sheet ------------------------------

  it("hands every look at the running circuit to who listens, and looks faster meanwhile", async () => {
    const { engine, session, press, settle } = setup({ watchMs: 250, frameMs: 50 });
    press();
    await settle();
    expect(session.state).toBe("running");
    // nobody listens: one look per 250 ms
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.frame).toHaveBeenCalledTimes(2);

    const seen: number[] = [];
    engine.frame.mockImplementation(async () => frame({ t: engine.frame.mock.calls.length }));
    const off = session.onFrame((f) => seen.push(f.t));
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.frame).toHaveBeenCalledTimes(6); // four more in 200 ms
    expect(seen).toEqual([3, 4, 5, 6]);

    // nobody listens any more: slow again, and the listener hears nothing
    off();
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.frame).toHaveBeenCalledTimes(8);
    expect(seen).toEqual([3, 4, 5, 6]);
    off(); // twice is once
  });

  it("a listener from before Play hears the run, and nothing after Stop", async () => {
    const { session, press, settle } = setup({ frameMs: 50 });
    const seen: LiveFrame[] = [];
    session.onFrame((f) => seen.push(f));
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual([]); // nothing runs
    press();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.length).toBe(2);
    press(); // Stop
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    expect(seen.length).toBe(2);
  });

  it("the look that ends the run is not handed on, and a listener that throws stops nothing", async () => {
    const { engine, session, errors, press, settle } = setup({ frameMs: 50 });
    const seen: number[] = [];
    session.onFrame(() => {
      throw new Error("a widget broke");
    });
    session.onFrame((f) => seen.push(f.t));
    press();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([1, 1]); // the second listener still hears
    expect(session.state).toBe("running");
    engine.frame.mockImplementation(async () => frame({ t: 2, running: false }));
    await vi.advanceTimersByTimeAsync(50);
    expect(session.state).toBe("idle");
    expect(seen).toEqual([1, 1]);
    expect(errors).toEqual(["Live simulation stopped by itself."]);
  });

  it("an editor that is gone does not make dispose throw", () => {
    const { button, session } = setup();
    button.mockImplementationOnce(() => {
      throw new Error("the module is gone");
    });
    expect(() => session.dispose()).not.toThrow();
  });
});

describe("hasToolbarButton", () => {
  it("is true only for an editor build with the binding", () => {
    expect(hasToolbarButton({ kicadSchToolbarButton: () => true })).toBe(true);
    expect(hasToolbarButton({ kicadSimSymbols: () => "" })).toBe(false);
    expect(hasToolbarButton(undefined)).toBe(false);
  });
});

describe("symbols a run leaves out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are named once the circuit runs, and the circuit runs", async () => {
    const { session, press, settle, notes, errors } = setup({ prepare: async () => prepared({ notSimulated: ["Q1", "U1"] }) });
    press();
    await settle();
    expect(session.state).toBe("running");
    expect(notes).toEqual(["Not simulated, nothing has a model for them: Q1, U1. The rest of the circuit runs."]);
    expect(errors).toEqual([]);
  });

  it("are not named when nothing is left out, or when the circuit does not start", async () => {
    const fine = setup();
    fine.press();
    await fine.settle();
    expect(fine.notes).toEqual([]);

    const refused = setup({ prepare: async () => prepared({ notSimulated: ["Q1"] }) });
    refused.engine.start.mockRejectedValueOnce(new Error("ngspice did not run the circuit"));
    refused.press();
    await refused.settle();
    expect(refused.session.state).toBe("idle");
    expect(refused.notes).toEqual([]);
    expect(refused.errors).toEqual(["Live simulation did not start: ngspice did not run the circuit"]);
  });

  it("one is named by itself, many are counted", () => {
    expect(leftOutNote([])).toBeNull();
    expect(leftOutNote(["Q1"])).toBe("Q1 is not simulated: nothing has a model for it. The rest of the circuit runs.");
    expect(leftOutNote(["J1", "J2", "J3", "J4", "J5", "J6"])).toContain("J1, J2, J3, J4, J5, J6. The rest");
    expect(leftOutNote(["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8"])).toContain("J1, J2, J3, J4, J5, J6 and 2 more. The rest");
  });
});
