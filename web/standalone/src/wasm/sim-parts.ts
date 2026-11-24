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
  matchSymbols,
  openLibrary,
  prepareRun,
  readEditorNetlist,
  readEditorSymbols,
  thermalPins,
  wireProblemText,
  wiresOf,
  wiresSaid,
  type EditorNetlist,
  type EditorSymbol,
  type Match,
  type PreparedRun,
  type SimLibrary,
  type ThermalPin,
} from "@pcbjam/shared/sim-library";

/** Bridge surface: the schematic editor's reads (eeschema builds). */
export interface SimSymbolsModule {
  kicadSimSymbols(): string;
  /** KiCad's SPICE netlist. Missing in an editor build older than the netlist step. */
  kicadSimNetlist?(): string;
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
  { fetch: fetchImpl }: { fetch?: typeof fetch } = {},
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
      return {
        library: lib,
        matches: matchSymbols(lib.index, symbols, { overrides, kicadModels: models }),
        symbols,
        excluded,
        kicadModelsKnown: models !== undefined,
        netlist,
        problems: netlist ? netlist.messages.filter((m) => m.severity !== "info").map((m) => m.text) : [],
      };
    },
    async prepare(mod, { overrides, live } = {}) {
      if (!mod.kicadSimNetlist) throw new Error("this editor build cannot write the netlist");
      const lib = await library();
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
  /**
   * Only for a part with thermal pins (a heater, a fan, a temperature sensor): the pins,
   * the names of the wires its symbol says they are on (none when it says none), and why
   * the part is on no wires with those names, as a sentence.
   */
  thermal?: { pins: ThermalPin[]; wires: string[]; problem?: string };
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
  /** The nets of the schematic: a symbol names the wires of its part's thermal pins among them. */
  const nets = [...new Set([...parts.symbols, ...parts.excluded].flatMap((s) => Object.values(s.pins).flatMap((p) => (p.node ? [p.node] : []))))];
  const rows: SimPartRow[] = parts.matches.map((m, i) => {
    const sym = parts.symbols[i];
    const base = { key: `${sym?.sheetPath ?? m.sheet}${m.uuid}`, uuid: m.uuid, ref: m.ref, value: m.value, sheet: m.sheet };
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
        return { ...base, state: "off", part: "", label: "switched off", note: "Simulation is switched off on this symbol." };
      case "kicad":
        return m.own
          ? { ...base, state: "own-model", part: "", label: "own SPICE model", note: "The symbol carries its own SPICE model. It runs as a plain analog part." }
          : { ...base, state: "kicad", part: "", label: "KiCad's model", note: "Runs with KiCad's own model." };
      case "none":
        return parts.kicadModelsKnown
          ? { ...base, state: "none", part: "", label: "not simulated", note: "Neither the library nor KiCad has a model for this symbol. A live run leaves it out." }
          : { ...base, state: "none", part: "", label: "no library part", note: "The library has no part for this symbol. KiCad's own model is used when the symbol has one." };
    }
  });
  for (const sym of parts.excluded) {
    rows.push({
      key: `${sym.sheetPath}${sym.uuid}`, uuid: sym.uuid, ref: sym.ref, value: sym.value, sheet: sym.sheet,
      state: "excluded", part: "", label: "excluded", note: "Excluded from simulation in KiCad.",
    });
  }
  return rows.sort((a, b) => GROUP[a.state] - GROUP[b.state] || byRef.compare(a.ref, b.ref));
}
