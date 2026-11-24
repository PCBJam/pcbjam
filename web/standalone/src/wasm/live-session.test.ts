import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedRun } from "@pcbjam/shared/sim-library";

// The engine's module pulls the worker script in as text and asks where the
// wasm lives; neither is needed here (the session gets a made-up engine).
vi.mock("./ngspice-live-worker.js?raw", () => ({ default: "" }));
vi.mock("./esp-emu-adapter.js?raw", () => ({ default: "" }));
vi.mock("./wasm-assets", () => ({ resolveWasmBase: async () => "http://wasm.test" }));

import type { LiveCircuit, LiveEngine, LiveEngineOptions, LiveFrame } from "./live-engine";
import {
  createLiveSession,
  leftOutNote,
  hasToolbarButton,
  LIVE_BUTTON_ID,
  LIVE_BUTTON_PLAY,
  LIVE_BUTTON_STOP,
  powerNote,
  heatNote,
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
  power: { byName: [], noVolts: [], assumed: [], noPower: [], unfed: [] },
  wires: [],
  notOnWire: [],
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
  const abouts: string[] = [];
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
    onNote: (text, about) => { notes.push(text); abouts.push(about); },
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
  return { mod, button, prepare, engine, errors, notes, abouts, states, session, press, settle, engineOptions: () => engineOptions };
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

describe("where the power of a run comes from", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const none = { byName: [], noVolts: [], assumed: [], noPower: [], unfed: [] };

  it("is said once the circuit runs, in a notice of its own", async () => {
    const power = { ...none, byName: [{ net: "+5V", volts: 5 }] };
    const { session, press, settle, notes, abouts, errors } = setup({ prepare: async () => prepared({ notSimulated: ["U1"], power }) });
    press();
    await settle();
    expect(session.state).toBe("running");
    expect(notes).toEqual([
      "U1 is not simulated: nothing has a model for it. The rest of the circuit runs.",
      "+5V is powered with 5 V, by its name.",
    ]);
    expect(abouts).toEqual(["left-out", "power"]);
    expect(errors).toEqual([]);
  });

  it("is not said when the schematic draws all of it, or when the circuit does not start", async () => {
    const drawn = setup();
    drawn.press();
    await drawn.settle();
    expect(drawn.notes).toEqual([]);

    const refused = setup({ prepare: async () => prepared({ power: { ...none, noVolts: ["VCC"] } }) });
    refused.engine.start.mockRejectedValueOnce(new Error("ngspice did not run the circuit"));
    refused.press();
    await refused.settle();
    expect(refused.notes).toEqual([]);
  });

  it("names the wires powered by their names, with the voltage each got", () => {
    expect(powerNote(none)).toBeNull();
    expect(powerNote({ ...none, byName: [{ net: "+5V", volts: 5 }] })).toBe("+5V is powered with 5 V, by its name.");
    expect(powerNote({ ...none, byName: [{ net: "-12V", volts: -12 }, { net: "+3V3", volts: 3.3 }, { net: "GNDA", volts: 0 }] }))
      .toBe("Powered by their names: -12V with -12 V, +3V3 with 3.3 V, GNDA with 0 V.");
    const many = ["+1V0", "+1V2", "+1V8", "+2V5", "+3V3", "+5V", "+9V", "+12V"].map((net) => ({ net, volts: 1 }));
    expect(powerNote({ ...none, byName: many })).toContain("+5V with 1 V and 2 more.");
  });

  it("names the supply wires that stay without power, and what powers one", () => {
    expect(powerNote({ ...none, noVolts: ["VCC"] }))
      .toBe("VCC is not powered: its name does not say a voltage. A battery or a voltage source on the wire powers it.");
    expect(powerNote({ ...none, noVolts: ["VCC", "VDD"] }))
      .toBe("Not powered, their names do not say a voltage: VCC, VDD. A battery or a voltage source on a wire powers it.");
  });

  it("names the chips that have nothing on a supply pin, with the pins", () => {
    expect(powerNote({ ...none, noPower: [{ ref: "U1", pins: ["4", "8"] }] })).toBe("U1 has no power: nothing is connected to its supply pins 4 and 8.");
    expect(powerNote({ ...none, noPower: [{ ref: "U2", pins: ["8"] }] })).toBe("U2 has no power: nothing is connected to its supply pin 8.");
    expect(powerNote({ ...none, noPower: [{ ref: "U1", pins: ["4", "8"] }, { ref: "U2", pins: ["8"] }] }))
      .toBe("No power, nothing is connected to their supply pins: U1 (4, 8), U2 (8).");
  });

  it("names the regulators that no source reaches, with the input pin", () => {
    expect(powerNote({ ...none, unfed: [{ ref: "U1", pins: ["3"] }] })).toBe("U1 gives no power: no source reaches its input (pin 3).");
    expect(powerNote({ ...none, unfed: [{ ref: "U1", pins: ["3"] }, { ref: "U2", pins: ["1"] }] }))
      .toBe("Give no power, no source reaches their inputs: U1 (3), U2 (1).");
    // a real board: its power comes in through a connector, and the regulator's output wire says its voltage
    expect(powerNote({ ...none, byName: [{ net: "+3V3", volts: 3.3 }], noVolts: ["VBUS"], unfed: [{ ref: "U1", pins: ["3"] }] })).toBe(
      "+3V3 is powered with 3.3 V, by its name. VBUS is not powered: its name does not say a voltage. A battery or a voltage source on the wire powers it. "
      + "U1 gives no power: no source reaches its input (pin 3).",
    );
  });

  it("names the batteries that run with a voltage their value does not say", () => {
    const bt2 = { ref: "BT2", label: "Voltage", value: "1.5", unit: "V" };
    expect(powerNote({ ...none, assumed: [bt2] })).toBe("BT2 runs with 1.5 V: its value does not say the voltage.");
    expect(powerNote({ ...none, assumed: [bt2, { ref: "BT4", label: "Voltage", value: "9", unit: "V" }] }))
      .toBe("BT2 runs with 1.5 V, BT4 runs with 9 V: their values do not say it.");
  });

  it("is one notice for all of it", () => {
    expect(powerNote({ byName: [{ net: "+5V", volts: 5 }], noVolts: ["VCC"], assumed: [{ ref: "BT1", label: "Voltage", value: "9", unit: "V" }], noPower: [{ ref: "U1", pins: ["8"] }], unfed: [] })).toBe(
      "+5V is powered with 5 V, by its name. VCC is not powered: its name does not say a voltage. A battery or a voltage source on the wire powers it. "
      + "U1 has no power: nothing is connected to its supply pin 8. BT1 runs with 9 V: its value does not say the voltage.",
    );
  });
});

describe("the heat of a run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const box = { name: "BOX", node: "/BOX", heat: ["R5"], feel: ["TH1"], air: ["M1"] };

  it("is not talked about when every symbol is on the wires it names", async () => {
    expect(heatNote([])).toBeNull();
    const { press, settle, notes } = setup({ prepare: async () => prepared({ wires: [box] }) });
    press();
    await settle();
    expect(notes).toEqual([]);
  });

  it("is talked about when a symbol names heat wires and is on none", async () => {
    expect(heatNote([{ ref: "R5", said: "OVEN", why: "wires", title: "Heater", problem: { why: "no-wire", name: "OVEN" } }]))
      .toBe('R5 is on no heat wire: no wire of the schematic is called "OVEN". A wire has the name of the label on it, and something has to be connected to it.');
    expect(heatNote([{ ref: "M1", said: "BOX", why: "wires", title: "Fan", problem: { why: "count", needs: 2 } }]))
      .toBe("M1 is on no heat wires: Fan has 2 thermal pins, so it takes the names of 2 wires.");
    expect(heatNote([{ ref: "LA1", said: "BOX", why: "part", title: "Lamp" }])).toBe("LA1 is on no heat wire: Lamp has no thermal pin.");
    expect(heatNote([{ ref: "R1", said: "BOX", why: "no-part" }])).toBe("R1 is on no heat wire: only a part of the simulation library has a thermal pin.");
    const { session, press, settle, notes, abouts, errors } = setup({ prepare: async () => prepared({ wires: [box], notOnWire: [{ ref: "R1", said: "BOX", why: "no-part" }] }) });
    press();
    await settle();
    expect(session.state).toBe("running");
    expect(errors).toEqual([]);
    expect(notes).toEqual(["R1 is on no heat wire: only a part of the simulation library has a thermal pin."]);
    expect(abouts).toEqual(["heat"]);
  });
});

describe("live session: a chip that runs firmware", () => {
  const LOADER = "export class WasmEmulator {}\nfunction initSync() {}\nexport { initSync };\n";
  const chip = (): PreparedRun => prepared({
    codeParts: [{ partId: "esp32-c3-wroom-02", kind: "emulator", name: "esp32-c3-wroom-02_1", ref: "U1", logic: null }],
    placed: [{
      ref: "U1", uuid: "u1", sheet: "/", partId: "esp32-c3-wroom-02", version: 1, rule: 3, name: "XU1", nodes: [], connected: ["IO4"], number: 1,
      settings: { firmware: { value: "firmware.bin", from: "default" } },
    }] as unknown as PreparedRun["placed"],
    parts: new Map([["esp32-c3-wroom-02", {
      id: "esp32-c3-wroom-02", analog: "", logic: null,
      manifest: { digital: { kind: "emulator", emulator: "esp-emu", chip: "esp32c3", orderParam: "IRR", pads: { IO4: 4 } } },
    }]]) as unknown as PreparedRun["parts"],
  });
  const library = async () => ({
    emulator: () => ({ id: "esp-emu", version: "1", program: "esp_emu_bg.wasm", loader: "esp_emu.js" }),
    emulatorFile: async (_id: string, name: string) => new TextEncoder().encode(name === "esp_emu.js" ? LOADER : "wasm"),
  });

  // the start of an ESP32-C3's merged image
  const IMAGE = new Uint8Array(40);
  IMAGE.set([0xe9, 3, 2, 0x2f]);
  IMAGE[12] = 0x05;

  function start(readFile?: (path: string) => Promise<Uint8Array | null>) {
    const mod: SimSymbolsModule & ToolbarButtonModule = { kicadSimSymbols: () => "{}", kicadSimNetlist: () => "{}", kicadSchToolbarButton: () => true };
    const engine = { start: vi.fn(async (_circuit: LiveCircuit) => {}), stop: vi.fn(async () => {}), frame: vi.fn(async () => frame()), dispose: vi.fn() };
    const errors: string[] = [];
    const session = createLiveSession({
      mod,
      reader: { prepare: async () => chip(), library } as unknown as SimPartsReader,
      readFile,
      onError: (text) => errors.push(text),
      createEngine: () => engine as unknown as LiveEngine,
    });
    return { mod, engine, errors, session };
  }

  it("hands the engine the chip's package: the emulator from the library, the firmware from the project", async () => {
    const readFile = vi.fn(async () => IMAGE);
    const { mod, engine, errors, session } = start(readFile);
    mod.onHostToolbarButton!(LIVE_BUTTON_ID);
    await vi.waitFor(() => expect(session.state).toBe("running"));
    expect(errors).toEqual([]);
    expect(readFile).toHaveBeenCalledWith("firmware.bin");
    const parts = engine.start.mock.calls[0]![0].parts;
    expect(parts.map((p) => p.name)).toEqual(["esp32-c3-wroom-02_1"]);
    expect(new TextDecoder().decode(parts[0]!.bytes.subarray(0, 4))).toBe("PJPK");
    session.dispose();
  });

  it("names the chip, not its code, in what the user reads", async () => {
    const mod: SimSymbolsModule & ToolbarButtonModule = { kicadSimSymbols: () => "{}", kicadSimNetlist: () => "{}", kicadSchToolbarButton: () => true };
    let onLog: (lines: [string, string][]) => void = () => {};
    const engine = {
      start: vi.fn(async (_circuit: LiveCircuit) => {
        onLog([
          ["part", "esp32-c3-wroom-02_1: > hello"],
          ["part", "counter: tick"],
          ["part", "esp32-c3-wroom-02_1: @stat {}"],
          ["part", "esp32-c3-wroom-02_1: load failed: Error: the emulator's loader is not there"],
        ]);
        throw new Error("code part 'esp32-c3-wroom-02_1' could not be started (its own lines say why)");
      }),
      stop: vi.fn(async () => {}), frame: vi.fn(async () => frame()), dispose: vi.fn(),
    };
    const errors: string[] = [];
    const logged: string[] = [];
    const session = createLiveSession({
      mod,
      reader: { prepare: async () => chip(), library } as unknown as SimPartsReader,
      readFile: async () => IMAGE,
      onError: (text) => errors.push(text),
      log: (text) => logged.push(text),
      createEngine: (opts) => {
        onLog = opts.onLog as typeof onLog;
        return engine as unknown as LiveEngine;
      },
    });
    mod.onHostToolbarButton!(LIVE_BUTTON_ID);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    // the part's own lines are in the sentence: what it printed and its numbers are not
    expect(errors[0]).toBe("Live simulation did not start: U1 could not be started: load failed: Error: the emulator's loader is not there");
    expect(logged).toContain("U1: > hello");
    expect(logged).toContain("counter: tick");
    session.dispose();
  });

  // A session whose engine is made up, with the two ways the engine talks back.
  function talking() {
    const mod: SimSymbolsModule & ToolbarButtonModule = { kicadSimSymbols: () => "{}", kicadSimNetlist: () => "{}", kicadSchToolbarButton: () => true };
    let options!: LiveEngineOptions;
    const engine = {
      start: vi.fn(async (_circuit: LiveCircuit) => {}), stop: vi.fn(async () => {}), frame: vi.fn(async () => frame()), dispose: vi.fn(),
      sendSerial: vi.fn(async (_name: string, _bytes: Uint8Array) => {}),
    };
    const logged: string[] = [];
    const notes: [text: string, about: string][] = [];
    const session = createLiveSession({
      mod,
      reader: { prepare: async () => chip(), library } as unknown as SimPartsReader,
      readFile: async () => IMAGE,
      onError: () => {},
      onNote: (text, about) => notes.push([text, about]),
      log: (text) => logged.push(text),
      createEngine: (opts) => {
        options = opts;
        return engine as unknown as LiveEngine;
      },
    });
    const play = async () => {
      mod.onHostToolbarButton!(LIVE_BUTTON_ID);
      await vi.waitFor(() => expect(session.state).toBe("running"));
    };
    return { engine, logged, notes, session, play, options: () => options };
  }
  const CHIP = "esp32-c3-wroom-02_1";

  it("gives the chip a console: what it prints, what the simulator says about it, what is typed to it", async () => {
    const { engine, logged, session, play, options } = talking();
    expect(session.console.chips).toEqual([]);
    expect(session.console.canSend).toBe(false);
    await play();
    expect(session.console.chips).toEqual([{ name: CHIP, ref: "U1" }]);
    expect(session.console.canSend).toBe(true);

    options().onSerial!([[CHIP, "ready\r\n> ", 0]]);
    options().onLog!([
      ["part", `${CHIP}: enable went low: the chip is in reset`],
      ["part", `${CHIP}: @stat {"t":1}`],
      ["part", `${CHIP}: power-up: pins held low by the circuit: 9; held high: none; the rest float`],
      ["part", "counter: tick"],
      ["problem", `code part '${CHIP}' said nothing`],
    ], 0);
    await session.console.send(CHIP, "on\n");
    options().onSerial!([[CHIP, "the LED is on\n", 0]]);

    expect(session.console.entries(CHIP)).toEqual([
      { kind: "out", text: "ready\n> \n" },
      { kind: "note", text: "enable went low: the chip is in reset\n" },
      { kind: "in", text: "on\n" },
      { kind: "out", text: "the LED is on\n" },
    ]);
    expect(engine.sendSerial).toHaveBeenCalledExactlyOnceWith(CHIP, new TextEncoder().encode("on\n"));
    // the app's log has the chip's whole lines, under the chip's reference, and the part's own words
    expect(logged).toContain("U1: > ready");
    expect(logged).toContain("U1: > > the LED is on");
    expect(logged).toContain('U1: @stat {"t":1}');
    session.dispose();
  });

  it("tells the user of a chip in trouble: a notice once, and a problem in the chip's console", async () => {
    const { logged, notes, session, play, options } = talking();
    await play();
    expect(session.console.troubled).toBe(false);
    options().onLog!([
      ["part", `${CHIP}: the firmware restarted the chip`],
      ["part", `${CHIP}: ! the firmware keeps restarting the chip: it does not get through its start-up`],
      // said again, and by a part that has no console: neither is a second notice
      ["part", `${CHIP}: ! the firmware keeps restarting the chip: it does not get through its start-up`],
      ["part", "counter: ! nothing to count"],
    ], 0);
    expect(notes).toEqual([["U1: the firmware keeps restarting the chip: it does not get through its start-up", "chip"]]);
    expect(session.console.entries(CHIP)).toEqual([
      { kind: "note", text: "the firmware restarted the chip\n" },
      { kind: "problem", text: "the firmware keeps restarting the chip: it does not get through its start-up\nthe firmware keeps restarting the chip: it does not get through its start-up\n" },
    ]);
    expect(session.console.troubled).toBe(true);
    expect(session.console.problems(CHIP)).toBe(2);
    // the app's log keeps the line as the adapter said it
    expect(logged).toContain("U1: ! the firmware keeps restarting the chip: it does not get through its start-up");

    // what the engine says of the chip's code is a problem in its console; the run's end is told by onError
    options().onLog!([["problem", `${CHIP}: its step failed`]], 0);
    expect(session.console.entries(CHIP).at(-1)).toEqual({
      kind: "problem",
      text: "the firmware keeps restarting the chip: it does not get through its start-up\nthe firmware keeps restarting the chip: it does not get through its start-up\nits step failed\n",
    });
    expect(notes).toHaveLength(1);

    // a run gives a few notices, not one for every line; the console has them all
    options().onLog!([1, 2, 3, 4, 5].map((n): ["part", string] => ["part", `${CHIP}: ! trouble ${n}`]), 0);
    expect(notes.map((n) => n[0])).toEqual([
      "U1: the firmware keeps restarting the chip: it does not get through its start-up",
      "U1: trouble 1",
      "U1: trouble 2",
      "U1: trouble 3",
    ]);
    expect(session.console.problems(CHIP)).toBe(8);

    // the next run tells again
    await session.stop();
    await play();
    expect(session.console.troubled).toBe(false);
    options().onLog!([["part", `${CHIP}: ! the enable pin is not high: the chip is held in reset and its firmware does not run`]], 0);
    expect(notes.at(-1)).toEqual(["U1: the enable pin is not high: the chip is held in reset and its firmware does not run", "chip"]);
    session.dispose();
  });

  it("keeps a run's text after Stop, takes no typed text then, and starts the next run empty", async () => {
    const { engine, session, play, options } = talking();
    const changes = vi.fn();
    session.console.onChange(changes);
    await play();
    options().onSerial!([[CHIP, "hello\n", 0]]);
    const before = changes.mock.calls.length;
    await session.stop();
    expect(changes.mock.calls.length).toBeGreaterThan(before); // who shows the console hears that it takes no text now
    expect(session.console.canSend).toBe(false);
    expect(session.console.entries(CHIP)).toEqual([{ kind: "out", text: "hello\n" }]);
    await expect(session.console.send(CHIP, "on\n")).rejects.toThrow("Nothing runs: press Play first.");
    expect(engine.sendSerial).not.toHaveBeenCalled();
    const run = session.console.run;
    await play();
    expect(session.console.run).toBe(run + 1);
    expect(session.console.entries(CHIP)).toEqual([]);
    expect(session.console.printed).toBe(false);
    session.dispose();
  });

  it("a simulator build without the serial line: the chip's lines still reach its console", async () => {
    const { session, play, options } = talking();
    await play();
    options().onLog!([["part", `${CHIP}: > hello`], ["part", `${CHIP}: > world`]], 0);
    expect(session.console.entries(CHIP)).toEqual([{ kind: "out", text: "hello\nworld\n" }]);
    expect(session.console.printed).toBe(true);
    session.dispose();
  });

  it("the app's log gets whole lines of what a chip prints, a few per batch", async () => {
    const { logged, session, play, options } = talking();
    await play();
    logged.length = 0;
    let text = "";
    for (let n = 1; n <= 30; n++) text += `line ${n}\r\n`;
    options().onSerial!([[CHIP, `${text}\n   \nhalf a `, 0]]);
    expect(logged.slice(0, 2)).toEqual(["U1: > line 1", "U1: > line 2"]);
    expect(logged).toHaveLength(21);
    expect(logged[20]).toBe("... and 10 more lines from the parts");
    // the line that was not whole yet comes with its end; an empty line is not a line of the log
    logged.length = 0;
    options().onSerial!([[CHIP, `line\n${"x".repeat(400)}\n`, 0]]);
    expect(logged).toEqual(["U1: > half a line", `U1: > ${"x".repeat(300)} ...`]);
    // the console has all of it
    expect(session.console.entries(CHIP)[0]!.text.split("\n")).toHaveLength(35);
    session.dispose();
  });

  it("does not start, and says why, when the project has no firmware file", async () => {
    const { mod, engine, errors, session } = start(async () => null);
    mod.onHostToolbarButton!(LIVE_BUTTON_ID);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe(
      'Live simulation did not start: U1 needs its firmware: the project has no file "firmware.bin". Choose the file on the chip\'s line in the Simulation parts list (Session menu)',
    );
    expect(engine.start).not.toHaveBeenCalled();
    expect(session.state).toBe("idle");
    session.dispose();
  });
});
