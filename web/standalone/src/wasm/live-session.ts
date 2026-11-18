import type { Power, PreparedRun } from "@pcbjam/shared/sim-library";
import { chipParts } from "./chip-parts";
import {
  circuitOf,
  createLiveEngine,
  type LiveEngine,
  type LiveEngineOptions,
  type LiveFrame,
  type LiveLogLine,
} from "./live-engine";
import type { SimPartsReader, SimSymbolsModule } from "./sim-parts";

/**
 * Play and Stop of live simulation.
 *
 * The button is KiCad's own: it sits on the schematic editor's top toolbar,
 * where KiCad puts the buttons of plugins (wasm/stubs/host_toolbar_buttons.h
 * says how it gets there). This module asks for the button, hears its clicks
 * and does what they mean. KiCad puts the button at the far end of its
 * toolbar, where a window of the usual size does not show it, so the Session
 * menu has a row that calls the same `click()`:
 *
 *   Play   read the schematic as it is now, put the library's parts into its
 *          netlist (sim-parts.ts), and hand the circuit to the engine
 *          (live-engine.ts). The button becomes Stop once the circuit runs.
 *   Stop   halt the run. The button becomes Play again.
 *
 * The circuit is the schematic at the moment of Play: an edit made while it
 * runs is in the next run.
 *
 * A symbol that nothing has a model for does not stop the circuit: it is left
 * out, the rest runs, and `onNote` gets one sentence that names it.
 *
 * A schematic that draws no source still runs: a supply wire whose name states
 * a voltage (+5V) is powered by that name, and `onNote` says which wires were,
 * which supply wires were not (VCC: no voltage in the name), and which battery
 * runs with a voltage its value does not say.
 *
 * When the simulation cannot start, or stops by itself, `onError` gets one
 * sentence for the user and the button is Play again. Nothing is restarted
 * without a click.
 */

/** Bridge surface: a button of the page on the schematic editor's toolbar. */
export interface ToolbarButtonModule {
  /**
   * Puts the button there or changes it. `icon` is one of KiCad's icon names
   * the build offers ("sim_run", "sim_stop"); "" takes the button away.
   * False: an icon name the build does not know.
   */
  kicadSchToolbarButton(id: string, tooltip: string, icon: string): boolean;
  /** Called with the button's id on a click. */
  onHostToolbarButton?: (id: string) => void;
}

/** True when the loaded wasm can put a button of the page on the toolbar. */
export function hasToolbarButton(mod: unknown): mod is ToolbarButtonModule {
  return typeof (mod as Partial<ToolbarButtonModule> | undefined)?.kicadSchToolbarButton === "function";
}

export const LIVE_BUTTON_ID = "com.pcbjam.live-simulation";
export const LIVE_BUTTON_PLAY = { tooltip: "Run live simulation", icon: "sim_run" } as const;
export const LIVE_BUTTON_STOP = { tooltip: "Stop live simulation", icon: "sim_stop" } as const;

/**
 * idle      nothing runs; the button says Play
 * starting  Play was clicked; the circuit is being read and loaded
 * running   it runs; the button says Stop
 * stopping  Stop was clicked; the run is being halted
 */
export type LiveSessionState = "idle" | "starting" | "running" | "stopping";

export interface LiveSessionOptions {
  /** The schematic editor: its two reads and the toolbar button. */
  mod: SimSymbolsModule & ToolbarButtonModule;
  /** The page's reader of the simulation library. */
  reader: SimPartsReader;
  /**
   * One file of the project by its path, or null when the project has none of that name.
   * A chip that runs firmware reads its image through this. Without it such a chip does
   * not run.
   */
  readFile?: (path: string) => Promise<Uint8Array | null>;
  /** One sentence for the user: why it did not start, or why it stopped. */
  onError: (text: string) => void;
  /**
   * A notice for the user about a run that started: what it runs without ("left-out"),
   * or where its power comes from ("power").
   */
  onNote?: (text: string, about: LiveNoteAbout) => void;
  onState?: (state: LiveSessionState) => void;
  /** A line for the app's own log. */
  log?: (msg: string) => void;
  /** How often the running circuit is looked at, in ms (default 250). */
  watchMs?: number;
  /** The same while somebody listens to the looks (onFrame), in ms (default 33). */
  frameMs?: number;
  /** For tests: makes the engine. */
  createEngine?: (options: LiveEngineOptions) => LiveEngine;
}

export interface LiveSession {
  readonly state: LiveSessionState;
  /** The circuit that runs: its inputs and the values it shows. Null when nothing runs. */
  readonly run: PreparedRun | null;
  /** The engine of this session, for the layer that shows the values. */
  readonly engine: LiveEngine;
  /** The last look at the running circuit. Null when nothing runs. */
  readonly lastFrame: LiveFrame | null;
  /**
   * Hears every look at the running circuit: the values the widgets on the
   * sheet show. While somebody listens, the looks come faster. Returns the
   * way to stop listening.
   */
  onFrame(listener: (frame: LiveFrame) => void): () => void;
  /** What a click on the button does: Play when idle, Stop when it runs. */
  click(): Promise<void>;
  play(): Promise<void>;
  stop(): Promise<void>;
  /** Stops, throws the engine away and takes the button off the toolbar. */
  dispose(): void;
}

export type LiveNoteAbout = "left-out" | "power";

/** How many symbols or wires a note names before it counts the rest. */
const NAMED_IN_NOTE = 6;

/** "a, b, c and 2 more": the first few of a list. */
const firstFew = (items: readonly string[]): string => {
  const more = items.length - NAMED_IN_NOTE;
  return `${items.slice(0, NAMED_IN_NOTE).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

/** The sentence about the symbols a run leaves out. Null when there are none. */
export function leftOutNote(refs: readonly string[]): string | null {
  if (!refs.length) return null;
  if (refs.length === 1) return `${refs[0]} is not simulated: nothing has a model for it. The rest of the circuit runs.`;
  return `Not simulated, nothing has a model for them: ${firstFew(refs)}. The rest of the circuit runs.`;
}

/** "pin 8" or "pins 4 and 8". */
const pinsOf = (pins: readonly string[]): string =>
  pins.length === 1 ? `pin ${pins[0]}` : `pins ${pins.slice(0, -1).join(", ")} and ${pins[pins.length - 1]}`;

/**
 * The notice about where a run's power comes from, when the schematic does not draw all of
 * it: the supply wires powered by their names, the supply wires that stay without power, the
 * regulators that no source reaches, the chips with nothing on a supply pin, and the
 * batteries whose voltage is the part's own. Null when there is nothing to say.
 */
export function powerNote(power: Power): string | null {
  const out: string[] = [];
  const { byName, noVolts, assumed, noPower, unfed } = power;
  if (byName.length === 1) out.push(`${byName[0]?.net} is powered with ${byName[0]?.volts} V, by its name.`);
  else if (byName.length) out.push(`Powered by their names: ${firstFew(byName.map((s) => `${s.net} with ${s.volts} V`))}.`);
  if (noVolts.length === 1) out.push(`${noVolts[0]} is not powered: its name does not say a voltage. A battery or a voltage source on the wire powers it.`);
  else if (noVolts.length) out.push(`Not powered, their names do not say a voltage: ${firstFew(noVolts)}. A battery or a voltage source on a wire powers it.`);
  // a regulator with nothing to regulate: the wire on its output keeps the power of its name, if it states one
  if (unfed.length === 1) out.push(`${unfed[0]?.ref} gives no power: no source reaches its input (${pinsOf(unfed[0]?.pins ?? [])}).`);
  else if (unfed.length) out.push(`Give no power, no source reaches their inputs: ${firstFew(unfed.map((c) => `${c.ref} (${c.pins.join(", ")})`))}.`);
  // a chip with a supply pin left open (or the unit with its supply pins not placed) does nothing
  if (noPower.length === 1) out.push(`${noPower[0]?.ref} has no power: nothing is connected to its supply ${pinsOf(noPower[0]?.pins ?? [])}.`);
  else if (noPower.length) out.push(`No power, nothing is connected to their supply pins: ${firstFew(noPower.map((c) => `${c.ref} (${c.pins.join(", ")})`))}.`);
  const runs = assumed.map((a) => `${a.ref} runs with ${a.value}${a.unit ? ` ${a.unit}` : ""}`);
  if (assumed.length === 1) out.push(`${runs[0]}: its value does not say the ${(assumed[0]?.label ?? "").toLowerCase()}.`);
  else if (assumed.length) out.push(`${firstFew(runs)}: their values do not say it.`);
  return out.length ? out.join(" ") : null;
}

const WATCH_MS = 250;
const FRAME_MS = 33;
const KEPT_LOG_LINES = 40;
/** How many lines of the parts with code one batch of the engine's log puts into the app's log. */
const PART_LINES_PER_BATCH = 20;

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createLiveSession(options: LiveSessionOptions): LiveSession {
  const { mod, reader, onError, onState } = options;
  const log = options.log ?? (() => {});
  const watchMs = options.watchMs ?? WATCH_MS;
  const frameMs = options.frameMs ?? FRAME_MS;
  const listeners = new Set<(frame: LiveFrame) => void>();

  let state: LiveSessionState = "idle";
  let run: PreparedRun | null = null;
  let lastFrame: LiveFrame | null = null;
  let disposed = false;
  // Counts up at every Play and at dispose: what an older Play still has to
  // do after one of its waits is no longer wanted.
  let epoch = 0;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let watching = false;
  // ngspice's last lines: when a run ends by itself, the reason is in there.
  let recent: string[] = [];
  // A chip that runs firmware has code under a name of its own ("esp32-c3-wroom-02_1"). What
  // the user reads names the chip ("U1"). The longest name first: "_1" starts "_10".
  let chipNames: [name: string, ref: string][] = [];
  const byRef = (text: string): string => chipNames.reduce((t, [name, ref]) => t.split(name).join(ref), text);

  const engine = (options.createEngine ?? createLiveEngine)({
    log,
    onLog: (lines: LiveLogLine[]) => {
      for (const [kind, text] of lines) if (kind === "spice" || kind === "problem") recent.push(byRef(text));
      if (recent.length > KEPT_LOG_LINES) recent = recent.slice(-KEPT_LOG_LINES);
      // What a part with code says (a chip: what its firmware prints, "> ..."), into the
      // app's own log. A firmware can print without end, so one batch gives a few lines.
      const said = lines.flatMap(([kind, text]) => (kind === "part" ? [text] : []));
      for (const text of said.slice(0, PART_LINES_PER_BATCH)) log(byRef(text));
      if (said.length > PART_LINES_PER_BATCH) log(`... and ${said.length - PART_LINES_PER_BATCH} more lines from the parts`);
    },
    onCrash: (reason) => {
      // While it starts or stops, the call that waits is told the same thing.
      if (state === "running") ended(`Live simulation stopped: ${reason}`);
    },
  });

  // --- the button -----------------------------------------------------------
  // Every change makes KiCad rebuild its toolbars: only say what is new.
  let shown: { tooltip: string; icon: string } | null = null;
  function showButton(want: { tooltip: string; icon: string } | null): void {
    if (shown?.tooltip === want?.tooltip && shown?.icon === want?.icon) return;
    try {
      const ok = mod.kicadSchToolbarButton(LIVE_BUTTON_ID, want?.tooltip ?? "", want?.icon ?? "");
      if (!ok) log(`live simulation: the editor has no icon "${want?.icon}"`);
      shown = want;
    } catch (e) {
      // the editor is gone (the page is being left)
      log(`live simulation: the toolbar button could not be set: ${words(e)}`);
    }
  }

  function set(next: LiveSessionState): void {
    if (state === next) return;
    state = next;
    showButton(next === "running" || next === "stopping" ? LIVE_BUTTON_STOP : LIVE_BUTTON_PLAY);
    onState?.(next);
  }

  // --- looking at the running circuit ---------------------------------------
  function stopWatch(): void {
    if (watchTimer !== null) clearInterval(watchTimer);
    watchTimer = null;
  }

  /** One look per tick; faster while the widgets on the sheet listen. */
  function startWatch(mine: number): void {
    stopWatch();
    watchTimer = setInterval(() => void watch(mine), listeners.size ? frameMs : watchMs);
  }

  /** The run is over without a click on Stop. */
  function ended(text: string): void {
    stopWatch();
    run = null;
    lastFrame = null;
    set("idle");
    onError(byRef(text));
  }

  async function watch(mine: number): Promise<void> {
    if (watching) return; // the last look has not come back yet
    watching = true;
    try {
      const frame = await engine.frame();
      if (mine !== epoch || state !== "running") return;
      lastFrame = frame;
      if (frame?.problem) {
        ended(`Live simulation stopped: ${frame.problem}`);
      } else if (!frame || !frame.running) {
        const why = [...recent].reverse().find((line) => /error|too small|singular/i.test(line));
        ended(why ? `Live simulation stopped by itself: ${why}` : "Live simulation stopped by itself.");
      } else {
        for (const listener of [...listeners]) {
          try {
            listener(frame);
          } catch (e) {
            log(`live simulation: a listener of the values failed: ${words(e)}`);
          }
        }
      }
    } catch (e) {
      // a crash: onCrash has told the user already
      log(`live simulation: no answer from the engine: ${words(e)}`);
    } finally {
      watching = false;
    }
  }

  // --- Play and Stop --------------------------------------------------------
  async function play(): Promise<void> {
    if (disposed || state !== "idle") return;
    const mine = ++epoch;
    set("starting");
    recent = [];
    try {
      const prepared = await reader.prepare(mod);
      if (mine !== epoch) return;
      chipNames = prepared.codeParts
        .flatMap((c): [string, string][] => (c.ref && c.name !== c.ref ? [[c.name, c.ref]] : []))
        .sort((a, b) => b[0].length - a[0].length);
      // the chips that run firmware: the emulator from the library, the image from the project
      const chips = prepared.codeParts.some((p) => p.kind === "emulator")
        ? await chipParts(prepared, { library: await reader.library(), readFile: options.readFile })
        : [];
      if (mine !== epoch) return;
      await engine.start(circuitOf(prepared, chips));
      if (mine !== epoch) return;
      run = prepared;
      set("running");
      startWatch(mine);
      const note = leftOutNote(prepared.notSimulated);
      if (note) options.onNote?.(note, "left-out");
      const power = powerNote(prepared.power);
      if (power) options.onNote?.(power, "power");
    } catch (e) {
      if (mine !== epoch) return;
      set("idle");
      onError(`Live simulation did not start: ${byRef(words(e))}`);
    }
  }

  async function stop(): Promise<void> {
    if (disposed || state !== "running") return;
    const mine = epoch;
    stopWatch();
    set("stopping");
    try {
      await engine.stop();
    } catch (e) {
      // A run that does not stop: the engine threw its Worker away. Nothing runs.
      log(`live simulation: stop: ${words(e)}`);
    }
    if (mine !== epoch) return;
    run = null;
    lastFrame = null;
    set("idle");
  }

  async function click(): Promise<void> {
    if (state === "idle") await play();
    else if (state === "running") await stop();
    // starting, stopping: the click that began it is still being served
  }

  // --- the editor's side ----------------------------------------------------
  const before = mod.onHostToolbarButton;
  const onButton = (id: string): void => {
    if (id === LIVE_BUTTON_ID) void click();
    else before?.(id);
  };
  mod.onHostToolbarButton = onButton;
  showButton(LIVE_BUTTON_PLAY);

  return {
    get state() {
      return state;
    },
    get run() {
      return run;
    },
    engine,
    get lastFrame() {
      return lastFrame;
    },
    onFrame(listener) {
      const retime = () => {
        if (state === "running" && watchTimer !== null) startWatch(epoch);
      };
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) retime();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) retime();
      };
    },
    click,
    play,
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      stopWatch();
      listeners.clear();
      run = null;
      lastFrame = null;
      state = "idle";
      engine.dispose();
      showButton(null);
      if (mod.onHostToolbarButton === onButton) mod.onHostToolbarButton = before;
    },
  };
}
