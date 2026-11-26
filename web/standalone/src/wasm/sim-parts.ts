/**
 * Live simulation, the page's side of "which library part does each symbol of
 * the open schematic get", and of "which circuit runs".
 *
 * Two sources meet here:
 *   - the schematic editor says what is drawn: `Module.kicadSimSymbols()`
 *     (wasm/bindings/sim_symbols.h, eeschema builds only) returns every symbol
 *     of every sheet with its fields and the net of each pin, and
 *     `Module.kicadSimNetlist()` (wasm/bindings/sim_netlist.h) returns KiCad's
 *     own SPICE netlist of the same schematic;
 *   - the simulation library says what it has: a published snapshot of parts,
 *     read with the client in @pcbjam/shared (sim-library).
 * The matcher of the same package then gives one line per symbol: a part is
 * used, a part is suggested, simulation is switched off for it, KiCad's own
 * model runs it, or nothing fits. `prepare()` goes one step further and writes
 * the circuit a simulator runs: KiCad's netlist with the library parts in the
 * place of the matched symbols.
 *
 * Nothing is written into the schematic and nothing is kept between two reads
 * except the library itself: it is opened once per reader, so a page works
 * with one snapshot of the library from its first read until it is reloaded.
 *
 * Env-agnostic: the library's address comes in as an argument (lib/config.ts
 * builds the page's reader from VITE_SIM_LIBRARY_URL).
 */
import {
  kicadModels as kicadModelsOf,
  LEFT_OUT_ORDER,
  leftOutSentence,
  leftOutSymbols,
  leftOutWords,
  matchSymbols,
  openLibrary,
  prepareRun,
  readEditorNetlist,
  readEditorSymbols,
  thermalPins,
  unusableLines,
  valuesRead,
  wireProblemText,
  wiresOf,
  wiresSaid,
  type EditorNetlist,
  type EditorSymbol,
  type LeftOut,
  type LeftOutReason,
  type Match,
  type PreparedRun,
  type SimLibrary,
  type ThermalPin,
  type ValueRead,
} from "@pcbjam/shared/sim-library";

/** Bridge surface: the schematic editor's reads (eeschema builds). */
export interface SimSymbolsModule {
  kicadSimSymbols(): string;
  /** KiCad's SPICE netlist. Missing in an editor build older than the netlist step. */
  kicadSimNetlist?(): string;
  /** The sheets of the open schematic, as the sheet navigator lists them (wasm/bindings/eeschema_embind.cpp). */
  kicadSheetsGetTree?(): string;
}

/** True when the loaded wasm can list the schematic's symbols for simulation. */
export function hasSimSymbols(mod: unknown): mod is SimSymbolsModule {
  return (
    typeof (mod as Partial<SimSymbolsModule> | undefined)?.kicadSimSymbols ===
    "function"
  );
}

export interface SimPartsOptions {
  /** Symbol uuid -> part id or "off": a pick that is not written on the symbol (yet). */
  overrides?: Record<string, string>;
  /**
   * The references KiCad itself writes a real SPICE line for (a resistor, a
   * symbol with a built-in model). Left out, they are read from the editor's
   * netlist. An editor build without the netlist read cannot say: a symbol the
   * library has no part for then reads "none", which only means "no library
   * part": see `kicadModelsKnown`.
   */
  kicadModels?: Set<string>;
}

export interface SimRunOptions {
  /** Symbol uuid -> part id or "off": a pick that is not written on the symbol (yet). */
  overrides?: Record<string, string>;
  /**
   * true (the default): the parts' inputs can be set while it runs, and the
   * run never ends. false: a plain circuit that any ngspice takes.
   */
  live?: boolean;
}

/** A sheet of the schematic whose file the editor could not load: the sheet is there, and it is empty. */
export interface SheetNotLoaded {
  /** The sheet's name, as the sheet navigator shows it. */
  name: string;
  /** Its file's name, without the folder. */
  file: string;
}

/**
 * The sheets whose file is not in the editor's file system. KiCad opens a schematic whose
 * sheet has no file with that sheet empty: nothing says which symbols are missing, so they
 * can be neither simulated nor counted. A sheet the user adds has its file from the moment
 * it is made (the editor writes it at once), so a missing file means a sheet that did not
 * load, not a new one.
 *
 * `fileExists` looks into the editor's file system. Without it, or with an editor build
 * that cannot list its sheets, nothing can be said: the answer is empty.
 */
export function sheetsNotLoaded(mod: SimSymbolsModule, fileExists?: (path: string) => boolean): SheetNotLoaded[] {
  if (!fileExists || typeof mod.kicadSheetsGetTree !== "function") return [];
  let tree: unknown;
  try {
    tree = JSON.parse(mod.kicadSheetsGetTree() || "null");
  } catch {
    return [];
  }
  const sheets: unknown[] = typeof tree === "object" && tree !== null && Array.isArray((tree as { sheets?: unknown }).sheets) ? (tree as { sheets: unknown[] }).sheets : [];
  const out: SheetNotLoaded[] = [];
  for (const raw of sheets) {
    const sheet = raw as { name?: unknown; file?: unknown; depth?: unknown } | null;
    // the root sheet is the schematic that is open
    if (!sheet || typeof sheet.file !== "string" || !sheet.file || sheet.depth === 0) continue;
    let exists = true;
    try {
      exists = fileExists(sheet.file);
    } catch {
      // cannot say
    }
    const file = sheet.file.slice(sheet.file.lastIndexOf("/") + 1);
    // a file that is used twice is two sheets, and one file to add
    if (!exists && !out.some((o) => o.file === file)) out.push({ name: typeof sheet.name === "string" && sheet.name ? sheet.name : file, file });
  }
  return out;
}

/** Why a schematic with a sheet that did not load is not simulated: a sentence without its first capital. */
export function notLoadedSentence(lost: readonly SheetNotLoaded[]): string {
  if (lost.length === 1) {
    const [sheet] = lost as [SheetNotLoaded];
    return `the sheet "${sheet.name}" is not loaded: its file ${sheet.file} is not in the project. Its symbols cannot be simulated, or even counted. Add the file to the project, or delete the sheet.`;
  }
  const named = lost.map((s) => `"${s.name}" (${s.file})`).join(", ");
  return `${lost.length} sheets are not loaded, their files are not in the project: ${named}. Their symbols cannot be simulated, or even counted. Add the files to the project, or delete the sheets.`;
}

export interface SimParts {
  /** The library the symbols were matched against (`library.version` names its snapshot). */
  library: SimLibrary;
  /** One line per symbol, in the editor's order: `matches[i]` is about `symbols[i]`. */
  matches: Match[];
  /** The symbols that take part in a simulation, as the editor reported them. */
  symbols: EditorSymbol[];
  /** Symbols excluded from simulation in KiCad (the symbol or its sheet). Not matched. */
  excluded: EditorSymbol[];
  /** False when nothing said which symbols KiCad simulates itself: "none" then does not say that KiCad cannot simulate the symbol. */
  kicadModelsKnown: boolean;
  /** KiCad's netlist of the same moment. Null when the editor build cannot write it. */
  netlist: EditorNetlist | null;
  /** What KiCad's netlist export complained about (a model file that was not found, ...), in its words. */
  problems: string[];
  /**
   * The symbols a run of this schematic leaves out, each with its reason: the same rules a
   * run uses (@pcbjam/shared, sim-library/left-out.ts). Empty when the editor build cannot
   * write the netlist: then nothing says what KiCad simulates.
   */
  leftOut: LeftOut[];
  /**
   * The resistors, capacitors and coils whose Value says their ratings too ("22uF/25V"): a
   * run takes the value alone, by the same rules (@pcbjam/shared, sim-library/values.ts).
   * By reference.
   */
  valuesRead: ReadonlyMap<string, ValueRead>;
  /** The sheets whose file the editor could not load: their symbols are not in the list. */
  notLoaded: SheetNotLoaded[];
}

export interface SimPartsReader {
  /** The library's address, as given. */
  base: string;
  /** The library, opened at the first call. A failed open is not kept: the next call tries again. */
  library(): Promise<SimLibrary>;
  /**
   * Reads the schematic as it is now and matches it. Rejects with a plain
   * message when the library cannot be reached or the editor's answer is not
   * understood (no schematic open, or an editor build older than this page).
   */
  read(mod: SimSymbolsModule, options?: SimPartsOptions): Promise<SimParts>;
  /**
   * The circuit of the schematic as it is now: KiCad's netlist with the
   * library parts in the place of the matched symbols, the model files it
   * includes, and what can be set and shown while it runs. The parts that are
   * used are downloaded. `errors` of the answer says what stops a run.
   * Rejects like read(), and when the editor build cannot write the netlist.
   */
  prepare(mod: SimSymbolsModule, options?: SimRunOptions): Promise<PreparedRun>;
}

export function simPartsReader(
  base: string,
  { fetch: fetchImpl, fileExists }: {
    fetch?: typeof fetch;
    /** Whether the editor's file system has this file (see sheetsNotLoaded). Left out: nothing is said about sheets. */
    fileExists?: (path: string) => boolean;
  } = {},
): SimPartsReader {
  let opened: Promise<SimLibrary> | null = null;

  const library = (): Promise<SimLibrary> => {
    if (!opened) {
      const attempt = openLibrary(base, { fetch: fetchImpl });
      opened = attempt;
      attempt.catch(() => {
        if (opened === attempt) opened = null;
      });
    }
    return opened;
  };

  return {
    base,
    library,
    async read(mod, { overrides, kicadModels } = {}) {
      const lib = await library();
      // After the wait, and in one go with the matching: the answer is the
      // schematic at one moment, not a mix of two.
      const { symbols, excluded } = readEditorSymbols(mod.kicadSimSymbols());
      const netlist = mod.kicadSimNetlist ? readEditorNetlist(mod.kicadSimNetlist()) : null;
      // With the symbols: a line of KiCad that names a model nothing defines is no model.
      const models = kicadModels ?? (netlist ? kicadModelsOf(netlist, symbols) : undefined);
      const matches = matchSymbols(lib.index, symbols, { overrides, kicadModels: models });
      return {
        library: lib,
        matches,
        symbols,
        excluded,
        kicadModelsKnown: models !== undefined,
        netlist,
        problems: netlist ? netlist.messages.filter((m) => m.severity !== "info").map((m) => m.text) : [],
        // a matched symbol is taken to run: its part is only downloaded for a run
        leftOut: netlist
          ? leftOutSymbols({
              symbols, plan: matches, excluded, items: netlist.items, unusable: unusableLines(netlist, symbols),
              placed: new Set(matches.flatMap((m) => (m.status === "matched" ? [m.ref] : []))),
            })
          : [],
        valuesRead: netlist ? valuesRead(netlist, symbols) : new Map(),
        notLoaded: sheetsNotLoaded(mod, fileExists),
      };
    },
    async prepare(mod, { overrides, live } = {}) {
      if (!mod.kicadSimNetlist) throw new Error("this editor build cannot write the netlist");
      const lib = await library();
      // A sheet that did not load is empty in the editor: the circuit is not the one that is drawn.
      const lost = sheetsNotLoaded(mod, fileExists);
      if (lost.length) throw new Error(notLoadedSentence(lost));
      // Both reads after the wait and back to back: one moment of the schematic.
      const { symbols, excluded } = readEditorSymbols(mod.kicadSimSymbols());
      const netlist = readEditorNetlist(mod.kicadSimNetlist());
      return prepareRun({ library: lib, symbols, excluded, netlist, overrides, live });
    },
  };
}

/** What the parts list says about one symbol. */
export type SimPartState =
  /** A library part is used. */
  | "live"
  /** The library offers a part; it is not used until the user says yes. */
  | "suggested"
  /** Two library parts fit equally well; the user has to pick. */
  | "choice"
  /** A library part was found and cannot be used. */
  | "error"
  /** Simulation is switched off on the symbol. */
  | "off"
  /** The symbol carries its own SPICE model. */
  | "own-model"
  /** KiCad's own model runs it. */
  | "kicad"
  /** The library has no part for it. */
  | "none"
  /** Excluded from simulation in KiCad. */
  | "excluded";

export interface SimPartRow {
  /** Unique per placed symbol: a sheet used twice gives two rows. */
  key: string;
  /** The symbol's uuid: the same for the rows of a sheet that is used twice. */
  uuid: string;
  ref: string;
  value: string;
  /** The sheet instance in words ("/", "/Key 1/"). */
  sheet: string;
  state: SimPartState;
  /** The library part's title, or the offered parts' titles; "" when there is none. */
  part: string;
  /** A few words for the row's right side. */
  label: string;
  /** One plain sentence: why the row says what it says. */
  note: string;
  /** Only for a symbol a run leaves out, or runs with KiCad's model because ours is switched off: why. */
  reason?: LeftOutReason;
  /**
   * Only for a part with thermal pins (a heater, a fan, a temperature sensor): the pins,
   * the names of the wires its symbol says they are on (none when it says none), and why
   * the part is on no wires with those names, as a sentence.
   */
  thermal?: { pins: ThermalPin[]; wires: string[]; problem?: string };
}

/**
 * The rows and the left-out list of a read, with every crystal that clocks a chip said as
 * what it is: it has no part and no model, and the run still uses it. `clocking` is the
 * crystal's reference -> the chip's.
 */
export function withClocking<L extends { ref: string }>(rows: SimPartRow[], leftOut: L[], clocking: ReadonlyMap<string, string>): { rows: SimPartRow[]; leftOut: L[] } {
  if (!clocking.size) return { rows, leftOut };
  return {
    rows: rows.map((r) => {
      const chip = clocking.get(r.ref);
      if (chip === undefined || r.state !== "none") return r;
      const { reason: _reason, ...rest } = r;
      return { ...rest, label: `clocks ${chip}`, note: `${r.ref} sets the clock of ${chip}: the chip runs at the speed its Value says. It is not simulated as a part of its own.` };
    }),
    leftOut: leftOut.filter((s) => !clocking.has(s.ref)),
  };
}

/** Which value a symbol runs with, when its Value says more than the value: a sentence. */
export function valueReadSentence(read: Pick<ValueRead, "shown" | "ratings">): string {
  const ratings = read.ratings.join(", ");
  return `Runs with KiCad's own model, as ${read.shown}. Its Value says ${read.ratings.length === 1 ? "a rating" : "ratings"} too (${ratings}), which ${read.ratings.length === 1 ? "is" : "are"} no part of the circuit.`;
}

// Rows about a library part first (they are what the list is for), then the
// rest, then what KiCad leaves out. Inside a group: by reference, R2 before R10.
const GROUP: Record<SimPartState, number> = {
  live: 0, suggested: 0, choice: 0, error: 0, off: 0,
  "own-model": 1, kicad: 1, none: 1,
  excluded: 2,
};
const byRef = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The parts list: one row per placed symbol, in the order it is shown. */
export function simPartRows(parts: SimParts): SimPartRow[] {
  const title = (id: string): string => parts.library.part(id)?.title ?? id;
  const leftOut = new Map(parts.leftOut.map((s) => [s.ref, s]));
  /** The nets of the schematic: a symbol names the wires of its part's thermal pins among them. */
  const nets = [...new Set([...parts.symbols, ...parts.excluded].flatMap((s) => Object.values(s.pins).flatMap((p) => (p.node ? [p.node] : []))))];
  const rows: SimPartRow[] = parts.matches.map((m, i) => {
    const sym = parts.symbols[i];
    const out = leftOut.get(m.ref);
    const base = { key: `${sym?.sheetPath ?? m.sheet}${m.uuid}`, uuid: m.uuid, ref: m.ref, value: m.value, sheet: m.sheet, ...(out ? { reason: out.reason } : {}) };
    // the symbol's model is switched off in KiCad: whatever the library says, it does not run
    if (out?.off === "model") return { ...base, state: "off", part: "", label: "switched off", note: leftOutSentence(out) };
    switch (m.status) {
      case "matched": {
        const part = parts.library.part(m.partId);
        const pins = part?.thermal ? thermalPins(part.thermal) : [];
        const on = sym && pins.length ? wiresOf(sym, pins.length, nets) : null;
        const thermal = pins.length
          ? { thermal: { pins, wires: sym ? wiresSaid(sym) : [], ...(on && "problem" in on ? { problem: wireProblemText(m.ref, part?.title ?? m.partId, on.problem) } : {}) } }
          : {};
        return m.rule === 1
          ? { ...base, ...thermal, state: "live", part: title(m.partId), label: "live, set by hand", note: `Runs as the library part "${title(m.partId)}", named on the symbol by hand.` }
          : { ...base, ...thermal, state: "live", part: title(m.partId), label: "live", note: `Runs as the library part "${title(m.partId)}".` };
      }
      case "suggested": {
        const names = m.candidates.map((c) => c.title).join(", ");
        return { ...base, state: "suggested", part: names, label: "suggestion", note: `The library offers ${names} for this value. Not used until it is confirmed.` };
      }
      case "choice": {
        const names = m.candidates.map((c) => c.title).join(", ");
        return { ...base, state: "choice", part: names, label: "pick one", note: `Several library parts fit: ${names}. One has to be picked.` };
      }
      case "error":
        return { ...base, state: "error", part: m.partId ? title(m.partId) : "", label: "cannot be used", note: `${m.reason.charAt(0).toUpperCase()}${m.reason.slice(1)}.` };
      case "off":
        return { ...base, state: "off", part: "", label: "switched off", note: out ? leftOutSentence(out) : "Simulation is switched off on this symbol." };
      case "kicad": {
        if (m.own) return { ...base, state: "own-model", part: "", label: "own SPICE model", note: "The symbol carries its own SPICE model. It runs as a plain analog part." };
        // a Value that says its ratings too: the row says which value runs
        const read = parts.valuesRead.get(m.ref);
        return read
          ? { ...base, state: "kicad", part: "", label: `KiCad's model, as ${read.shown}`, note: valueReadSentence(read) }
          : { ...base, state: "kicad", part: "", label: "KiCad's model", note: "Runs with KiCad's own model." };
      }
      case "none":
        if (out) return { ...base, state: "none", part: "", label: leftOutWords(out.reason), note: leftOutSentence(out) };
        return parts.kicadModelsKnown
          ? { ...base, state: "none", part: "", label: "not simulated", note: "Neither the library nor KiCad has a model for this symbol. A live run leaves it out." }
          : { ...base, state: "none", part: "", label: "no library part", note: "The library has no part for this symbol. KiCad's own model is used when the symbol has one." };
    }
  });
  for (const sym of parts.excluded) {
    rows.push({
      key: `${sym.sheetPath}${sym.uuid}`, uuid: sym.uuid, ref: sym.ref, value: sym.value, sheet: sym.sheet,
      state: "excluded", part: "", label: "excluded", note: "Excluded from simulation in KiCad.", reason: "off",
    });
  }
  // inside "not simulated": what the user can mend first (a value), what has nothing to simulate last
  const order = (r: SimPartRow): number => (r.state === "none" && r.reason ? LEFT_OUT_ORDER.indexOf(r.reason) : -1);
  return rows.sort((a, b) => GROUP[a.state] - GROUP[b.state] || order(a) - order(b) || byRef.compare(a.ref, b.ref));
}
