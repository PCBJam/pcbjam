import { FIELD_SETTINGS, clockSentence, leftOutNotice, symbolsNamed, wireProblemText, type LeftOut, type NotOnWire, type Power, type PreparedRun } from "@pcbjam/shared/sim-library";
import { chipParts } from "./chip-parts";
import {
  circuitOf,
  createLiveEngine,
  type LiveEngine,
  type LiveEngineOptions,
  type LiveFrame,
  type LiveLogLine,
  type LiveSerialChunk,
} from "./live-engine";
import { createConsoleStore, type ConsoleStore, type LiveConsole } from "./live-console";
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
 *
 * Heat is part of the circuit the user draws: a heater, a fan and a temperature
 * sensor have thermal pins, and their symbols name the wires those are on.
 * `onNote` says when a symbol names heat wires and is on none.
 *
 * A chip that runs firmware can be in trouble while the circuit runs on: its
 * firmware restarts it without end, its reset pin is low from the start, the
 * sketch reads an input the board does not have. The chip's adapter says so
 * in a line it marks with "! " (esp32sim-adapter.js, avr8js-adapter.js). Such
 * a line goes to `onNote` once per run, with the chip's name in front, and
 * into the chip's console as a problem.
 *
 * A schematic can carry commands for the simulator in a text of its sheet (a
 * block from ".control" to ".endc", a line that begins with "*#"). They come
 * with the schematic, whoever drew it, and a live run needs none of them: the
 * netlist step takes them out, the circuit runs, and `onNote` says so.
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
 * starting  Play was clicked; the circuit is being read and loaded. The button says Stop:
 *           a click gives the start up
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
   * where its power comes from ("power"), a chip that does not run as its firmware
   * expects ("chip"), a symbol that names heat wires and is on none ("heat"), the speed
   * a chip without a board runs at when no crystal says it ("clock"), or simulator commands
   * the schematic carries, which are not run ("commands").
   */
  onNote?: (text: string, about: LiveNoteAbout) => void;
  onState?: (state: LiveSessionState) => void;
  /** The report of the run that was tried, at every change of it (see LiveReport). */
  onReport?: (report: LiveReport) => void;
  /** A line for the app's own log. */
  log?: (msg: string) => void;
  /** How long a file of the project (a chip's firmware) is waited for, in ms (default LIVE_FILE_TIMEOUT_MS). */
  fileTimeoutMs?: number;
  /** How often the running circuit is looked at, in ms (default 250). */
  watchMs?: number;
  /** The same while somebody listens to the looks (onFrame), in ms (default 33). */
  frameMs?: number;
  /** For tests: makes the engine. */
  createEngine?: (options: LiveEngineOptions) => LiveEngine;
}

/**
 * What became of the run that was tried, and what it left out. It is made when the circuit
 * is written, before the engine starts, and it is kept: after a start that failed, after a
 * run that ended by itself and after Stop it still says what that run was. The next Play
 * makes a new one. A list that reads the schematic anew can say something else, because the
 * schematic can have changed since.
 */
export interface LiveReport {
  /**
   * "starting": the circuit is written and the engine is being started. "running". "stopped":
   * by a click on Stop. "not-started": the run did not start, `problem` says why. "ended":
   * it ran and ended by itself, `problem` says why.
   */
  outcome: "starting" | "running" | "stopped" | "not-started" | "ended";
  /**
   * The symbols the run left out, each with its reason (@pcbjam/shared, left-out.ts). Empty
   * for a run whose circuit could not be written at all.
   */
  leftOut: LeftOut[];
  /** Why it did not start, or why it ended: the sentence the user was told. */
  problem?: string;
  /** The symbols that sentence is about, by reference: the ones the simulator's own words name. */
  about: string[];
}

export interface LiveSession {
  readonly state: LiveSessionState;
  /** The report of the run that was tried last. Null before the first Play. */
  readonly report: LiveReport | null;
  /** The circuit that runs: its inputs and the values it shows. Null when nothing runs. */
  readonly run: PreparedRun | null;
  /** The engine of this session, for the layer that shows the values. */
  readonly engine: LiveEngine;
  /** The last look at the running circuit. Null when nothing runs. */
  readonly lastFrame: LiveFrame | null;
  /**
   * The serial consoles of the chips that run firmware: what each printed in this run (or
   * the last one), and the way to type to it. See live-console.ts.
   */
  readonly console: LiveConsole;
  /**
   * Hears every look at the running circuit: the values the widgets on the
   * sheet show. While somebody listens, the looks come faster. Returns the
   * way to stop listening.
   */
  onFrame(listener: (frame: LiveFrame) => void): () => void;
  /**
   * What a click on the button does: Play when idle, Stop when it runs or is starting. A
   * second click right behind the one that began the start is the same click (a
   * double-click), not a Stop.
   */
  click(): Promise<void>;
  play(): Promise<void>;
  /** Halts the run, or gives up a start that is not through yet. */
  stop(): Promise<void>;
  /** Stops, throws the engine away and takes the button off the toolbar. */
  dispose(): void;
}

export type LiveNoteAbout = "left-out" | "power" | "chip" | "heat" | "clock" | "commands";

/** How many symbols or wires a note names before it counts the rest. */
const NAMED_IN_NOTE = 6;

/** "a, b, c and 2 more": the first few of a list. */
const firstFew = (items: readonly string[]): string => {
  const more = items.length - NAMED_IN_NOTE;
  return `${items.slice(0, NAMED_IN_NOTE).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

/** "U1", "U1 and R2", "U1, R2 and D3". */
const allOf = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** What the engine's answers start with when the words after it are the simulator's own. */
const SIMULATORS_WORDS = /^(ngspice did not (take|run) the circuit|the run did not start)\b/;

/**
 * The symbols the simulator's own words are about. Only its own words are searched: the
 * other reasons (a chip without its firmware, a part that is not loaded) name their symbol
 * already.
 */
export function namedBySimulator(text: string, marks: ReadonlyMap<string, string> | undefined, own = SIMULATORS_WORDS.test(text)): string[] {
  return own && marks ? symbolsNamed(text, marks).slice(0, NAMED_IN_NOTE) : [];
}

/** "The simulator names Q1: " before the simulator's words, when they name a line of a symbol. */
const naming = (about: readonly string[]): string => (about.length ? `The simulator names ${allOf(about)}: ` : "");

/** "pin 8" or "pins 4 and 8". */
const pinsOf = (pins: readonly string[]): string =>
  pins.length === 1 ? `pin ${pins[0]}` : `pins ${pins.slice(0, -1).join(", ")} and ${pins[pins.length - 1]}`;

/**
 * The notice about where a run's power comes from, when the schematic does not draw all of
 * it: the supply wires powered by their names, the supply wires that stay without power, the
 * regulators that no source reaches, the chips with nothing on a supply pin, the batteries
 * whose voltage is the part's own, and the sockets (a USB socket, a barrel jack): which feed
 * the board and with what, and which give nothing. Null when there is nothing to say.
 */
/** How many sockets the power notice names one by one. */
const NAMED_SOCKETS = 3;

export function powerNote(power: Power): string | null {
  const out: string[] = [];
  const { byName, noVolts, assumed, noPower, unfed, sockets } = power;
  // the sockets the board is fed through, and the ones that give nothing
  for (const s of sockets.slice(0, NAMED_SOCKETS)) {
    const what = `${s.ref} (${/^[A-Z][a-z]/.test(s.title) ? s.title.charAt(0).toLowerCase() + s.title.slice(1) : s.title})`;
    const where = s.label.replace(/^Voltage\s*/i, "");
    if (s.feeds) out.push(`${what} feeds the board${s.volts ? ` with ${s.volts} V${where ? ` ${where}` : ""}` : ""}${s.fromWire ? ", as the name of its wire says" : ""}${s.assumed ? "; its value does not say a voltage" : ""}.`);
    else out.push(`${what} gives no power: it does not count as plugged in (${s.setting}=${s.on} in the symbol's field ${FIELD_SETTINGS} changes that).`);
  }
  if (sockets.length > NAMED_SOCKETS) out.push(`And ${sockets.length - NAMED_SOCKETS} more ${sockets.length - NAMED_SOCKETS === 1 ? "socket" : "sockets"}.`);
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

/**
 * The notice about heat, when a symbol names heat wires and is on none. Null when there
 * is nothing to say.
 */
/**
 * What a run says about simulator commands the schematic carries (a text of the sheet
 * from ".control" to ".endc", a line that begins with "*#"): they are not run.
 */
export function commandsNote(count: number): string | null {
  if (count <= 0) return null;
  return "A text of this schematic holds commands for the simulator (\".control\" or \"*#\"). Live simulation does not run them: the circuit runs without them.";
}

export function heatNote(notOnWire: readonly NotOnWire[]): string | null {
  const out = notOnWire.map((n) => {
    if (n.why === "wires" && n.problem) return wireProblemText(n.ref, n.title ?? "its part", n.problem);
    if (n.why === "part") return `${n.ref} is on no heat wire: ${n.title ?? "its part"} has no thermal pin.`;
    return `${n.ref} is on no heat wire: only a part of the simulation library has a thermal pin.`;
  });
  return out.length ? out.slice(0, NAMED_IN_NOTE).join(" ") : null;
}

const WATCH_MS = 250;
/** How long a file of the project (a chip's firmware) is waited for. */
export const LIVE_FILE_TIMEOUT_MS = 60_000;
/**
 * A click this soon after the click on Play is the same click: people double-click a
 * button, and a start must not be given up by its own second click.
 */
export const SAME_CLICK_MS = 700;
const FRAME_MS = 33;
const KEPT_LOG_LINES = 40;
/** How many lines of the parts with code one batch of the engine's log puts into the app's log. */
const PART_LINES_PER_BATCH = 20;
/** A line a chip printed, as the app's log shows it. */
const PRINTED_LINE_CHARS = 300;
/** What a part says for the log and the tests, not for the reader of its chip's console. */
const NOT_FOR_THE_CONSOLE = /^(@stat |power-up: )/;
/** How a chip's adapter starts a line the user has to be told. */
const TROUBLE_MARK = "! ";
/** How many such lines one run gives the user as notices; the rest is in the chip's console. */
const CHIP_NOTICES_PER_RUN = 4;
/** How many of a part's last lines are kept, to say why it could not be started. */
const KEPT_PART_LINES = 3;

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createLiveSession(options: LiveSessionOptions): LiveSession {
  const { mod, reader, onError, onState } = options;
  const log = options.log ?? (() => {});
  const fileTimeoutMs = options.fileTimeoutMs ?? LIVE_FILE_TIMEOUT_MS;
  // A file of the project that never arrives must not keep a start waiting for ever.
  const readFile = options.readFile
    ? (path: string): Promise<Uint8Array | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the project's file "${path}" did not arrive within ${Math.round(fileTimeoutMs / 1000)} seconds`)), fileTimeoutMs);
        });
        return Promise.race([options.readFile!(path), late]).finally(() => clearTimeout(timer));
      }
    : undefined;
  const watchMs = options.watchMs ?? WATCH_MS;
  const frameMs = options.frameMs ?? FRAME_MS;
  const listeners = new Set<(frame: LiveFrame) => void>();

  let state: LiveSessionState = "idle";
  let run: PreparedRun | null = null;
  // What became of the run that was tried last; kept until the next Play.
  let report: LiveReport | null = null;
  const tell = (next: LiveReport): void => {
    report = next;
    try {
      options.onReport?.(next);
    } catch (e) {
      log(`live simulation: a listener of the report failed: ${words(e)}`);
    }
  };
  let lastFrame: LiveFrame | null = null;
  let disposed = false;
  // Counts up at every Play and at dispose: what an older Play still has to
  // do after one of its waits is no longer wanted.
  let epoch = 0;
  /** When the Play that is starting was clicked (see SAME_CLICK_MS). */
  let startedAt = 0;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let watching = false;
  // ngspice's last lines: when a run ends by itself, the reason is in there.
  let recent: string[] = [];
  // A chip that runs firmware has code under a name of its own ("esp32-c3-wroom-02_1"). What
  // the user reads names the chip ("U1"). The longest name first: "_1" starts "_10".
  let chipNames: [name: string, ref: string][] = [];
  const byRef = (text: string): string => chipNames.reduce((t, [name, ref]) => t.split(name).join(ref), text);

  // The serial consoles of the run's chips. `store` is filled here; the panel reads it.
  const store: ConsoleStore = createConsoleStore({
    send: (name, bytes) => engine.sendSerial(name, bytes),
    canSend: () => state === "running",
  });
  // The longest name first, as in chipNames.
  let consoleNames: string[] = [];
  // What each chip printed since its last line end: the app's log gets whole lines.
  let printing = new Map<string, string>();

  /** A part's line "name: words", when the part is a chip with a console. */
  const chipLine = (text: string): [name: string, words: string] | null => {
    const name = consoleNames.find((n) => text.startsWith(`${n}: `));
    return name ? [name, text.slice(name.length + 2)] : null;
  };

  // The names of the run's parts with code, the longest first, and what each said last: a
  // part that could not be started has said why in its own lines.
  let codeNames: string[] = [];
  let saidBy = new Map<string, string[]>();
  const remember = (text: string): void => {
    const name = codeNames.find((n) => text.startsWith(`${n}: `));
    if (!name) return;
    const said = text.slice(name.length + 2);
    if (NOT_FOR_THE_CONSOLE.test(said) || said.startsWith("> ")) return;
    const kept = saidBy.get(name) ?? [];
    kept.push(said.startsWith(TROUBLE_MARK) ? said.slice(TROUBLE_MARK.length) : said);
    saidBy.set(name, kept.slice(-KEPT_PART_LINES));
  };

  // The chip troubles this run has told the user of: each once, and not without end.
  let told = new Set<string>();
  /** A chip's adapter says the chip does not run, or not as its firmware expects. */
  const chipTrouble = (name: string, said: string): void => {
    const text = byRef(said);
    store.problem(name, text);
    const key = `${name}\n${said}`;
    if (told.has(key) || told.size >= CHIP_NOTICES_PER_RUN) return;
    told.add(key);
    options.onNote?.(`${byRef(name)}: ${text}`, "chip");
  };

  const engine: LiveEngine = (options.createEngine ?? createLiveEngine)({
    log,
    onLog: (lines: LiveLogLine[]) => {
      for (const [kind, text] of lines) if (kind === "spice" || kind === "problem") recent.push(byRef(text));
      if (recent.length > KEPT_LOG_LINES) recent = recent.slice(-KEPT_LOG_LINES);
      // What a part with code says about itself, into the app's own log, and into its
      // chip's console. One batch gives the log a few lines.
      const said = lines.flatMap(([kind, text]) => (kind === "part" ? [text] : []));
      for (const text of said.slice(0, PART_LINES_PER_BATCH)) log(byRef(text));
      if (said.length > PART_LINES_PER_BATCH) log(`... and ${said.length - PART_LINES_PER_BATCH} more lines from the parts`);
      for (const [kind, text] of lines) {
        if (kind !== "part" && kind !== "problem") continue;
        remember(text);
        const line = chipLine(text);
        if (!line) continue;
        const [name, said] = line;
        // a simulator build without the serial line hands a chip's text over as lines, marked "> "
        if (kind === "part" && said.startsWith("> ")) store.out(name, `${said.slice(2)}\n`);
        else if (kind === "part" && said.startsWith(TROUBLE_MARK)) chipTrouble(name, said.slice(TROUBLE_MARK.length));
        // what the engine says of a chip's code that failed: the run ends, and `onError` says so
        else if (kind === "problem") store.problem(name, byRef(said));
        else if (!NOT_FOR_THE_CONSOLE.test(said)) store.note(name, byRef(said));
      }
    },
    onSerial: (chunks: LiveSerialChunk[]) => {
      // A firmware can print without end, so one batch gives the app's log a few lines.
      let logged = 0;
      let more = 0;
      for (const [name, text, dropped] of chunks) {
        store.out(name, text, dropped);
        const lines = ((printing.get(name) ?? "") + text).split("\n");
        const rest = lines.pop() ?? "";
        printing.set(name, rest.length > 2000 ? rest.slice(-PRINTED_LINE_CHARS) : rest);
        for (const raw of lines) {
          const line = raw.split("\r").join("");
          if (!line.trim()) continue;
          if (logged++ < PART_LINES_PER_BATCH) {
            log(byRef(`${name}: > ${line.length > PRINTED_LINE_CHARS ? `${line.slice(0, PRINTED_LINE_CHARS)} ...` : line}`));
          } else more++;
        }
      }
      if (more) log(`... and ${more} more lines from the parts`);
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
    // Stop also while it starts: a start that waits for a download can be given up
    showButton(next === "idle" ? LIVE_BUTTON_PLAY : LIVE_BUTTON_STOP);
    store.touch(); // whether a chip can be typed to
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

  /** The run is over without a click on Stop. `about`: the symbols the reason names. */
  function ended(text: string, about: string[] = []): void {
    stopWatch();
    run = null;
    lastFrame = null;
    set("idle");
    const problem = byRef(text);
    tell({ outcome: "ended", leftOut: report?.leftOut ?? [], problem, about });
    onError(problem);
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
        // the simulator's own line: it names an element or a node of the circuit, never a symbol
        const about = why ? namedBySimulator(why, run?.marks, true) : [];
        ended(!why ? "Live simulation stopped by itself." : about.length ? `Live simulation stopped by itself. ${naming(about)}${why}` : `Live simulation stopped by itself: ${why}`, about);
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
    startedAt = Date.now();
    set("starting");
    recent = [];
    // the circuit of this Play, once it is written: a start that fails after that still says what it left out
    let written: PreparedRun | null = null;
    try {
      const prepared = await reader.prepare(mod);
      if (mine !== epoch) return;
      written = prepared;
      tell({ outcome: "starting", leftOut: prepared.leftOut, about: [] });
      chipNames = prepared.codeParts
        .flatMap((c): [string, string][] => (c.ref && c.name !== c.ref ? [[c.name, c.ref]] : []))
        .sort((a, b) => b[0].length - a[0].length);
      // the chips that run firmware: the emulator from the library, the image from the project
      const chips = prepared.codeParts.some((p) => p.kind === "emulator")
        ? await chipParts(prepared, { library: await reader.library(), readFile })
        : [];
      if (mine !== epoch) return;
      // each of them has a console, empty for this run
      const withConsole = prepared.codeParts.filter((p) => p.kind === "emulator");
      consoleNames = withConsole.map((p) => p.name).sort((a, b) => b.length - a.length);
      codeNames = prepared.codeParts.map((p) => p.name).sort((a, b) => b.length - a.length);
      saidBy = new Map();
      told = new Set();
      printing = new Map();
      store.reset(withConsole.map((p) => ({ name: p.name, ref: p.ref || p.name })));
      await engine.start(circuitOf(prepared, chips));
      if (mine !== epoch) return;
      run = prepared;
      set("running");
      startWatch(mine);
      tell({ outcome: "running", leftOut: prepared.leftOut, about: [] });
      const note = leftOutNotice(prepared.leftOut);
      if (note) options.onNote?.(note, "left-out");
      const power = powerNote(prepared.power);
      if (power) options.onNote?.(power, "power");
      const heat = heatNote(prepared.notOnWire);
      if (heat) options.onNote?.(heat, "heat");
      // a chip without a board: the speed it runs at, when the schematic does not say it with a crystal
      const clocks = prepared.placed.flatMap((p) => { const said = p.clock ? clockSentence(p.ref, p.clock) : null; return said ? [said] : []; });
      if (clocks.length) options.onNote?.(clocks.slice(0, NAMED_IN_NOTE).join(" "), "clock");
      const commands = commandsNote(prepared.commandsLeftOut);
      if (commands) options.onNote?.(commands, "commands");
    } catch (e) {
      if (mine !== epoch) return;
      set("idle");
      const why = byRef(whyNotStarted(words(e)));
      const about = namedBySimulator(why, written?.marks);
      const problem = about.length ? `Live simulation did not start. ${naming(about)}${why}` : `Live simulation did not start: ${why}`;
      tell({ outcome: "not-started", leftOut: written?.leftOut ?? [], problem, about });
      onError(problem);
    }
  }

  /**
   * The engine's sentence about a start that failed. Of a part whose code could not be
   * started it only says that the part's own lines say why: here they are put in.
   */
  function whyNotStarted(text: string): string {
    const part = /code part '([^']+)' could not be started/.exec(text)?.[1];
    if (part === undefined) return text;
    const said = saidBy.get(part) ?? [];
    return said.length ? `${part} could not be started: ${said.join("; ")}` : `${part} could not be started`;
  }

  async function stop(): Promise<void> {
    if (disposed || (state !== "running" && state !== "starting")) return;
    // A start that is not through is given up: whatever it waits for (the library, a
    // firmware file, the engine) is not waited for any more, and its answer is dropped.
    const givenUp = state === "starting";
    const mine = givenUp ? ++epoch : epoch;
    stopWatch();
    set("stopping");
    try {
      // also for a start: the engine may be loading the circuit, or run it already
      await engine.stop();
    } catch (e) {
      // A run that does not stop: the engine threw its Worker away. Nothing runs.
      log(`live simulation: stop: ${words(e)}`);
    }
    if (mine !== epoch) return;
    run = null;
    lastFrame = null;
    set("idle");
    // the report of this Play: a start given up before its circuit was written has none
    if (report && (!givenUp || report.outcome === "starting")) tell({ ...report, outcome: "stopped" });
  }

  async function click(): Promise<void> {
    if (state === "idle") await play();
    else if (state === "running") await stop();
    else if (state === "starting" && Date.now() - startedAt >= SAME_CLICK_MS) await stop();
    // stopping: the click that began it is still being served
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
    get report() {
      return report;
    },
    engine,
    get lastFrame() {
      return lastFrame;
    },
    console: store,
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
