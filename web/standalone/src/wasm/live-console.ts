/**
 * The serial consoles of a live run.
 *
 * A microcontroller has no screen: its firmware prints text on its serial line
 * (`Serial.println` in an Arduino sketch), and on a real board that text shows
 * in the Arduino IDE's Serial Monitor. Here every chip of the running circuit
 * that runs firmware has a console of its own. It holds, in the order things
 * happened:
 *
 *   out      what the chip sent, as it sent it (a line need not be whole)
 *   in       what the user typed to the chip
 *   note     what the simulator says about the chip ("reset went low: ...")
 *   problem  the same, when the chip does not run or not as its firmware expects
 *            ("the firmware keeps restarting the chip: ...")
 *
 * The consoles belong to a run: a new run starts with empty ones, and what a
 * run printed stays readable after it was stopped. Text is kept while nobody
 * looks, so the panel (components/SimConsolePanel.tsx) can be opened late. A
 * console holds the newest CONSOLE_KEPT_CHARS characters; older lines go.
 *
 * live-session.ts fills the consoles from the engine's messages and sends what
 * is typed.
 */

/** A chip that has a console. */
export interface ConsoleChip {
  /** The name of the chip's code in the engine ("arduino-uno-r3_1"). */
  name: string;
  /** What the user calls the chip ("U1"). */
  ref: string;
}

export type ConsoleKind = "out" | "in" | "note" | "problem";

/** A stretch of a console's text of one kind. Stretches of one kind that follow each other are one. */
export interface ConsoleEntry {
  kind: ConsoleKind;
  text: string;
}

/** How many characters a console keeps. */
export const CONSOLE_KEPT_CHARS = 100_000;
/** What is left after the oldest lines were dropped: not every new line drops one. */
const CONSOLE_TRIM_TO = Math.floor(CONSOLE_KEPT_CHARS * 0.9);

/** What the panel reads and does. */
export interface LiveConsole {
  /** The chips of the circuit that runs, or ran last, in the circuit's order. */
  readonly chips: readonly ConsoleChip[];
  /** Counts up with every change: a chip's text, or the list of chips. */
  readonly stamp: number;
  /** Counts the runs: up when a new run starts with empty consoles. */
  readonly run: number;
  /** True when a chip of this run has sent something. */
  readonly printed: boolean;
  /** True when the simulator told of a problem with a chip of this run. */
  readonly troubled: boolean;
  /** Whether typed text can be sent now: a circuit runs. */
  readonly canSend: boolean;
  /** What a chip's console holds, oldest first. */
  entries(name: string): readonly ConsoleEntry[];
  /** True when the console's oldest lines were dropped. */
  cut(name: string): boolean;
  /** How many problems the simulator told of this chip, since the run started or its console was emptied. */
  problems(name: string): number;
  /** Hears every change. Returns the way to stop listening. */
  onChange(listener: () => void): () => void;
  /** Sends text to a chip's serial input. Rejects with a sentence when it was not sent. */
  send(name: string, text: string): Promise<void>;
  /** Empties a chip's console. */
  clear(name: string): void;
}

/** The same, with what fills it. */
export interface ConsoleStore extends LiveConsole {
  /** A new run: its chips, with empty consoles. */
  reset(chips: readonly ConsoleChip[]): void;
  /** What a chip sent on its serial line; `dropped` characters after it did not arrive. */
  out(name: string, text: string, dropped?: number): void;
  /** A word of the simulator about the chip. */
  note(name: string, text: string): void;
  /** The same, about a chip that does not run, or not as its firmware expects. */
  problem(name: string, text: string): void;
  /** Tells the listeners that `canSend` may have changed. */
  touch(): void;
}

export interface ConsoleStoreOptions {
  /** Hands typed text to the chip, as bytes. */
  send: (name: string, bytes: Uint8Array) => Promise<void>;
  /** Whether a circuit runs. */
  canSend: () => boolean;
}

const ESC = "\u001b";
// Colours and cursor moves (firmware built with ESP-IDF colours its log lines), and the
// other two-character escapes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\^_]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * A chip's text as a console shows it: line ends are "\n" (a board sends
 * "\r\n"; a lone "\r" is a line end too), terminal escape sequences and other
 * control characters are left out. The text arrives in pieces that cut where
 * they like: `carry` is the end of the last piece that could not be read yet
 * (a "\r" that may be followed by "\n", the start of an escape sequence), and
 * the result's `carry` goes into the next call.
 */
export function readable(carry: string, piece: string): { text: string; carry: string } {
  let s = carry + piece;
  let rest = "";
  const at = s.lastIndexOf(ESC);
  // eslint-disable-next-line no-control-regex
  if (at >= 0 && s.length - at < 32 && /^\u001b(\[[0-9;?]*[ -/]*)?$/.test(s.slice(at))) {
    rest = s.slice(at);
    s = s.slice(0, at);
  } else if (s.endsWith("\r")) {
    rest = "\r";
    s = s.slice(0, -1);
  }
  return { text: s.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, ""), carry: rest };
}

interface Log {
  entries: ConsoleEntry[];
  chars: number;
  cut: boolean;
  carry: string;
  problems: number;
}

export function createConsoleStore(options: ConsoleStoreOptions): ConsoleStore {
  let chips: ConsoleChip[] = [];
  let logs = new Map<string, Log>();
  let stamp = 0;
  let run = 0;
  let printed = false;
  let troubled = false;
  const listeners = new Set<() => void>();

  const changed = (): void => {
    stamp++;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a listener that fails must not stop the others */
      }
    }
  };

  /** Drops the oldest lines of a console that grew too long. */
  const trim = (log: Log): void => {
    if (log.chars <= CONSOLE_KEPT_CHARS) return;
    log.cut = true;
    let over = log.chars - CONSOLE_TRIM_TO;
    while (over > 0 && log.entries.length > 1 && (log.entries[0]?.text.length ?? 0) <= over) {
      const gone = log.entries.shift()?.text.length ?? 0;
      log.chars -= gone;
      over -= gone;
    }
    const first = log.entries[0];
    if (over <= 0 || !first) return;
    // the rest goes from the oldest stretch, up to the end of a line where there is one
    const lineEnd = first.text.indexOf("\n", over - 1);
    const drop = lineEnd < 0 ? Math.min(over, first.text.length) : lineEnd + 1;
    first.text = first.text.slice(drop);
    log.chars -= drop;
    if (!first.text && log.entries.length > 1) log.entries.shift();
  };

  const add = (log: Log, kind: ConsoleKind, text: string): void => {
    if (!text) return;
    const last = log.entries[log.entries.length - 1];
    if (last && last.kind === kind) last.text += text;
    else log.entries.push({ kind, text });
    log.chars += text.length;
    trim(log);
  };

  /** A note stands on a line of its own, whatever was being printed. */
  const ownLine = (log: Log): void => {
    const last = log.entries[log.entries.length - 1];
    if (last && !last.text.endsWith("\n")) {
      last.text += "\n";
      log.chars++;
    }
  };

  return {
    get chips() {
      return chips;
    },
    get stamp() {
      return stamp;
    },
    get run() {
      return run;
    },
    get printed() {
      return printed;
    },
    get troubled() {
      return troubled;
    },
    get canSend() {
      return options.canSend();
    },
    entries: (name) => logs.get(name)?.entries ?? [],
    cut: (name) => logs.get(name)?.cut ?? false,
    problems: (name) => logs.get(name)?.problems ?? 0,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async send(name, text) {
      const log = logs.get(name);
      if (!log) throw new Error("This chip is not in the running circuit.");
      if (!options.canSend()) throw new Error("Nothing runs: press Play first.");
      if (!text) return;
      await options.send(name, new TextEncoder().encode(text));
      // shown where it was typed: after a prompt the chip left without a line end, too
      add(log, "in", text);
      changed();
    },

    clear(name) {
      const log = logs.get(name);
      if (!log || (!log.entries.length && !log.problems)) return;
      log.entries = [];
      log.chars = 0;
      log.cut = false;
      log.problems = 0;
      changed();
    },

    reset(next) {
      chips = next.map((c) => ({ name: c.name, ref: c.ref }));
      logs = new Map(chips.map((c) => [c.name, { entries: [], chars: 0, cut: false, carry: "", problems: 0 }]));
      printed = false;
      troubled = false;
      run++;
      changed();
    },

    out(name, piece, dropped = 0) {
      const log = logs.get(name);
      if (!log) return;
      const { text, carry } = readable(log.carry, piece);
      log.carry = carry;
      if (text) {
        add(log, "out", text);
        printed = true;
      }
      if (dropped > 0) {
        ownLine(log);
        add(log, "note", `... ${dropped} characters were left out: the chip prints faster than they can be shown\n`);
      }
      if (text || dropped > 0) changed();
    },

    note(name, text) {
      const log = logs.get(name);
      if (!log || !text) return;
      ownLine(log);
      add(log, "note", text.endsWith("\n") ? text : `${text}\n`);
      changed();
    },

    problem(name, text) {
      const log = logs.get(name);
      if (!log || !text) return;
      ownLine(log);
      add(log, "problem", text.endsWith("\n") ? text : `${text}\n`);
      log.problems++;
      troubled = true;
      changed();
    },

    touch: changed,
  };
}
