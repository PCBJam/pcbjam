import { describe, expect, it } from "vitest";
import {
  compileTour,
  evalCond,
  hasEventLeaf,
  hasNextLeaf,
  parseSheetNets,
  parseSheetSymbols,
  parseTourDef,
  resolveStepTarget,
  sameValue,
  tourUsesBoard,
  tourUsesNets,
  type Cond,
  type DeclState,
  type SheetNet,
  type SheetSymbol,
  type TourDeps,
} from "./declarative";
import type { TourEvent } from "./runner";

const S = (libId: string, uuid: string, ref: string, footprint = ""): SheetSymbol => ({ uuid, libId, ref, value: "", footprint });
const P = (ref: string, uuid: string, libId: string, pin: string, noConnect = false) => ({ uuid, ref, libId, pin, name: "", noConnect });

// The USB-stick circuit: J1 (edge plug) VBUS → R1 → D1..D3 anodes; cathodes → GND.
const J1 = S("Tutorial:USB_A_PCB_Edge", "j1", "J1", "Tutorial:USB_A_PCB_Edge");
const R1 = S("Device:R", "r1", "R1", "Resistor_SMD:R_1206_3216Metric");
const D1 = S("Device:LED", "d1", "D1", "LED_SMD:LED_PLCC_2835");
const D2 = S("Device:LED", "d2", "D2");
const D3 = S("Device:LED", "d3", "D3", "LED_SMD:LED_PLCC_2835");
const PWR = S("power:+5V", "p1", "#PWR01");
const NETS: SheetNet[] = [
  { net: "+5V", pins: [P("J1", "j1", J1.libId, "1"), P("R1", "r1", "Device:R", "1")] },
  { net: "Net-(D1-A)", pins: [P("R1", "r1", "Device:R", "2"), P("D1", "d1", "Device:LED", "2"), P("D2", "d2", "Device:LED", "2")] },
  { net: "GND", pins: [P("J1", "j1", J1.libId, "4"), P("D1", "d1", "Device:LED", "1"), P("D2", "d2", "Device:LED", "1"), P("D3", "d3", "Device:LED", "1")] },
  { net: "unconnected-(D3-A)", pins: [P("D3", "d3", "Device:LED", "2")] },
  { net: "unconnected-(J1-D+)", pins: [P("J1", "j1", J1.libId, "3", true)] },
];

function state(over: Partial<DeclState> = {}): DeclState {
  return {
    symbols: [J1, R1, D1, D2, D3, PWR],
    nets: NETS,
    added: new Set(["r1", "d1", "d2", "d3"]),
    dialogOpen: (cls) => cls === "OPEN_ONE",
    ...over,
  };
}
const ev = (...e: TourEvent[]) => e;

const minimal = (steps: unknown[]) => ({ id: "t", editor: "eeschema", steps });
const last = { id: "end", text: "Done", until: { next: true } };

describe("parseTourDef", () => {
  it("accepts a well-formed tour", () => {
    const def = parseTourDef(
      minimal([
        { id: "a", target: "tool:eeschema.InteractiveDrawing.placeSymbol", text: "x", until: { dialogOpened: "DIALOG_SYMBOL_CHOOSER" } },
        { id: "b", target: "new:Device:R", text: "y", when: { not: { dialogOpen: "D" } }, until: { net: [{ power: "+5V" }, { libId: "Device:R", pin: "1" }] } },
        last,
      ]),
    );
    expect(def.steps).toHaveLength(3);
  });

  it.each([
    ["no steps", minimal([])],
    ["last step not Next", minimal([{ id: "a", text: "x", until: { action: "a.b" } }])],
    ["duplicate ids", minimal([{ id: "a", text: "x", until: { next: true } }, { id: "a", text: "y", until: { next: true } }])],
    ["unknown target", minimal([{ ...last, target: "html:<b>" }])],
    ["unknown condition", minimal([{ ...last, until: { eval: "1" } }])],
    ["extra key", minimal([{ ...last, onclick: "x" }])],
    ["pin selector with two keys", minimal([{ ...last, when: { noConnect: { libId: "A", ref: "B", pin: "1" } } }])],
    ["power selector with pin", minimal([{ ...last, when: { net: [{ power: "+5V", pin: "1" }, { ref: "R1", pin: "1" }] } }])],
    ["bad id", { id: "Bad Id", editor: "eeschema", steps: [last] }],
    ["bad editor", { id: "t", editor: "gerbview", steps: [last] }],
  ])("rejects %s", (_name, def) => {
    expect(() => parseTourDef(def)).toThrow(/invalid tour/);
  });

  it("caps the size", () => {
    expect(() => parseTourDef(minimal([{ ...last, text: "x".repeat(70000) }]))).toThrow(/too large/);
  });
});

describe("engine payloads", () => {
  it("parse symbols and nets, dropping malformed rows", () => {
    expect(parseSheetSymbols(JSON.stringify([{ uuid: "AB", libId: "Device:R", ref: "R1" }, { uuid: 1 }, null]))).toEqual([
      { uuid: "ab", libId: "Device:R", ref: "R1", value: "", footprint: "" },
    ]);
    expect(parseSheetSymbols("{")).toBeNull();
    expect(parseSheetSymbols(undefined)).toBeNull();
    expect(parseSheetNets(JSON.stringify([{ net: "+5V", pins: [{ uuid: "A", pin: "1", ref: "R1", noConnect: 1 }, { pin: "2" }] }, { pins: [] }]))).toEqual([
      { net: "+5V", pins: [{ uuid: "a", ref: "R1", libId: "", pin: "1", name: "", noConnect: false }] },
    ]);
  });
});

describe("evalCond", () => {
  const s = state();

  it("event leaves need a matching event", () => {
    expect(evalCond({ next: true }, s, [])).toBe(false);
    expect(evalCond({ next: true }, s, ev({ type: "button", button: "next" }))).toBe(true);
    expect(evalCond({ next: true }, s, ev({ type: "button", button: "skip" }))).toBe(false);
    expect(evalCond({ action: "a.b" }, s, ev({ type: "action", name: "a.b", depth: 0 }))).toBe(true);
    expect(evalCond({ dialogOpened: "D" }, s, ev({ type: "dialogShown", cls: "D", ptr: "1", title: "" }))).toBe(true);
    expect(evalCond({ dialogClosed: "D" }, s, ev({ type: "dialogShown", cls: "D", ptr: "1", title: "" }))).toBe(false);
  });

  it("symbols counts by lib id, optionally only new ones", () => {
    expect(evalCond({ symbols: { libId: "Device:LED", min: 3 } }, s, [])).toBe(true);
    expect(evalCond({ symbols: { libId: "Device:LED", min: 4 } }, s, [])).toBe(false);
    expect(evalCond({ symbols: { libId: "Tutorial:USB_A_PCB_Edge", min: 1, new: true } }, s, [])).toBe(false);
  });

  it("footprint needs every placed matching symbol set", () => {
    expect(evalCond({ footprint: { libId: "Device:LED", set: true } }, s, [])).toBe(false); // D2 has none
    expect(evalCond({ footprint: { ref: "R1", set: "Resistor_SMD:R_1206_3216Metric" } }, s, [])).toBe(true);
    expect(evalCond({ footprint: { ref: "R9", set: true } }, s, [])).toBe(false);
  });

  it("value: every placed matching symbol, compared as a component value", () => {
    const v = state({ symbols: [{ ...R1, value: "39R" }, { ...D1, value: "white" }, { ...D2, value: "White" }, { ...PWR, value: "+5V" }] });
    expect(evalCond({ value: { ref: "R1", is: "39" } }, v, [])).toBe(true);
    expect(evalCond({ value: { libId: "Device:R", is: "39Ω" } }, v, [])).toBe(true);
    expect(evalCond({ value: { ref: "R1", is: "390" } }, v, [])).toBe(false);
    expect(evalCond({ value: { libId: "Device:LED", is: "white" } }, v, [])).toBe(true);
    expect(evalCond({ value: { ref: "R9", is: "39" } }, v, [])).toBe(false); // nothing placed
    expect(evalCond({ value: { libId: "power:+5V", is: "+5V" } }, v, [])).toBe(false); // #PWR is not placed
    expect(() => parseTourDef({ id: "t", editor: "eeschema", steps: [{ id: "a", text: "x", until: { value: { is: "39" } } }, { id: "b", text: "y", until: { next: true } }] })).toThrow(/exactly one of libId, ref/);
  });

  it("sameValue reads units, SI prefixes and RKM notation", () => {
    for (const [a, b] of [["39", "39R"], ["39", "39 Ω"], ["39", "39ohm"], ["39", "0.039k"], ["4k7", "4.7k"], ["4k7", "4700"], ["4R7", "4.7"], ["2M2", "2.2M"], ["100n", "0.1u"], ["10m", "0.01"]]) {
      expect(sameValue(a!, b!), `${a} = ${b}`).toBe(true);
    }
    for (const [a, b] of [["39", "390"], ["1M", "1m"], ["39", "39k"], ["white", "red"], ["", "0"]]) {
      expect(sameValue(a!, b!), `${a} != ${b}`).toBe(false);
    }
  });

  it("net: one net holds every selector; power names the net", () => {
    expect(evalCond({ net: [{ power: "+5V" }, { ref: "R1", pin: "1" }] }, s, [])).toBe(true);
    expect(evalCond({ net: [{ power: "+5V" }, { ref: "R1", pin: "2" }] }, s, [])).toBe(false);
    expect(evalCond({ net: [{ ref: "R1", pin: "2" }, { libId: "Device:LED", pin: "2" }] }, s, [])).toBe(true);
    // `all`: every LED's anode — D3's is unconnected.
    expect(evalCond({ net: [{ ref: "R1", pin: "2" }, { libId: "Device:LED", pin: "2", all: true }] }, s, [])).toBe(false);
    expect(evalCond({ net: [{ power: "GND" }, { libId: "Device:LED", pin: "1", all: true }] }, s, [])).toBe(true);
    expect(evalCond({ net: [{ power: "+5V" }, { ref: "R1", pin: "1" }] }, state({ nets: null }), [])).toBe(false);
  });

  it("noConnect per pin, or on all matching", () => {
    expect(evalCond({ noConnect: { ref: "J1", pin: "3" } }, s, [])).toBe(true);
    expect(evalCond({ noConnect: { ref: "J1", pin: "2" } }, s, [])).toBe(false);
    expect(evalCond({ noConnect: { libId: "Tutorial:USB_A_PCB_Edge", pin: "3", all: true } }, s, [])).toBe(true);
  });

  it("combinators and dialogOpen", () => {
    const c: Cond = { all: [{ dialogOpen: "OPEN_ONE" }, { not: { dialogOpen: "OTHER" } }, { any: [{ next: true }, { symbols: { libId: "Device:R", min: 1 } }] }] };
    expect(evalCond(c, s, [])).toBe(true);
    expect(hasEventLeaf(c)).toBe(true);
    expect(hasNextLeaf(c)).toBe(true);
    expect(hasNextLeaf({ not: { next: true } })).toBe(false);
    expect(hasEventLeaf({ symbols: { libId: "x", min: 1 } })).toBe(false);
  });
});

describe("targets and net reads", () => {
  it("new:<libId> points at the newest added symbol", () => {
    expect(resolveStepTarget("new:Device:LED", state())).toBe("item:d3");
    expect(resolveStepTarget("new:Tutorial:USB_A_PCB_Edge", state())).toBeUndefined();
    expect(resolveStepTarget("tool:x.y", state())).toBe("tool:x.y");
  });

  it("nets are read only when a step needs them", () => {
    expect(tourUsesNets(parseTourDef(minimal([last])))).toBe(false);
    expect(tourUsesNets(parseTourDef(minimal([{ ...last, when: { any: [{ noConnect: { ref: "J1", pin: "3" } }] } }])))).toBe(true);
  });
});

describe("compileTour", () => {
  function deps(sheet: { syms: SheetSymbol[]; busy?: boolean; dialog?: boolean; board?: string }, reads: string[]): TourDeps {
    return {
      symbols: () => (reads.push("symbols"), JSON.stringify(sheet.syms)),
      nets: () => (reads.push("nets"), "[]"),
      board: () => (reads.push("board"), sheet.board ?? "{}"),
      openBusy: () => !!sheet.busy,
      dialogOpen: () => !!sheet.dialog,
      anyDialogOpen: () => !!sheet.dialog,
    };
  }
  const def = parseTourDef(
    minimal([
      { id: "open", text: "Open the chooser", until: { dialogOpened: "C" } },
      { id: "place", text: "Place an R", until: { symbols: { libId: "Device:R", min: 1, new: true } } },
      last,
    ]),
  );
  const pick = (t: ReturnType<typeof compileTour>, s: DeclState) => t.steps.find((st) => st.when(s))?.id;

  it("latches event steps only while they are on screen", () => {
    const reads: string[] = [];
    const t = compileTour(def, deps({ syms: [] }, reads));
    let s = t.sample([]);
    expect(pick(t, s)).toBe("open");
    // Not yet shown → an event does not latch it.
    s = t.sample(ev({ type: "dialogShown", cls: "C", ptr: "1", title: "" }));
    expect(pick(t, s)).toBe("open");
    t.steps[0]!.content(s); // the runner shows it
    s = t.sample(ev({ type: "dialogShown", cls: "C", ptr: "1", title: "" }));
    expect(pick(t, s)).toBe("place");
    expect(reads).not.toContain("nets");
  });

  it("baselines symbols once, skips reads while busy or in a dialog, and adds Next to the last step", () => {
    const reads: string[] = [];
    const sheet = { syms: [S("Device:R", "old", "R1")], busy: true, dialog: false };
    const t = compileTour(def, deps(sheet, reads));
    t.sample([]);
    expect(reads).toEqual([]); // busy → no read, no baseline yet
    sheet.busy = false;
    t.sample([]); // baseline {old}
    sheet.dialog = true;
    sheet.syms = [S("Device:R", "old", "R1"), S("Device:R", "new", "R2")];
    const inDialog = t.sample([]);
    expect(reads).toEqual(["symbols"]);
    expect(inDialog.added.size).toBe(0);
    sheet.dialog = false;
    const s = t.sample([]);
    expect([...s.added]).toEqual(["new"]);
    const lastStep = t.steps[2]!;
    expect(lastStep.final).toBe(true);
    expect(lastStep.content(s).buttons).toEqual(["next"]);
    expect(t.steps[1]!.content(s).buttons).toBeUndefined();
  });
});

describe("board conditions (PCB editor)", () => {
  const FP = (ref: string, fpid: string, inside: boolean) => ({ uuid: ref.toLowerCase(), ref, fpid, x: 0, y: 0, side: "front" as const, inside });
  const board = {
    outlineClosed: true,
    activeLayer: "Edge.Cuts",
    tracks: 3,
    vias: 0,
    unrouted: 2,
    footprints: [FP("J1", "plugin_usb:USB_A_PCB_Edge", true), FP("R1", "Resistor_SMD:R_0805_2012Metric", true), FP("D1", "LED_SMD:LED_0603_1608Metric", false)],
  };
  const on = (over: Partial<typeof board> = {}) => state({ board: { ...board, ...over } });

  it("boardFootprints: count by ref, fpid or all; `inside` needs every match inside the outline", () => {
    expect(evalCond({ boardFootprints: { min: 3 } }, on(), [])).toBe(true);
    expect(evalCond({ boardFootprints: { min: 4 } }, on(), [])).toBe(false);
    expect(evalCond({ boardFootprints: { ref: "J1", inside: true } }, on(), [])).toBe(true);
    expect(evalCond({ boardFootprints: { fpid: "LED_SMD:LED_0603_1608Metric", inside: true } }, on(), [])).toBe(false);
    expect(evalCond({ boardFootprints: { min: 3, inside: true } }, on(), [])).toBe(false);
    expect(evalCond({ boardFootprints: { ref: "J9" } }, on(), [])).toBe(false);
  });

  it("outline, unrouted, tracks and the active layer", () => {
    expect(evalCond({ boardOutline: { closed: true } }, on(), [])).toBe(true);
    expect(evalCond({ boardOutline: { closed: true } }, on({ outlineClosed: false }), [])).toBe(false);
    expect(evalCond({ unrouted: { max: 0 } }, on(), [])).toBe(false);
    expect(evalCond({ unrouted: { max: 0 } }, on({ unrouted: 0 }), [])).toBe(true);
    expect(evalCond({ tracks: { min: 3 } }, on(), [])).toBe(true);
    expect(evalCond({ activeLayer: "Edge.Cuts" }, on(), [])).toBe(true);
    expect(evalCond({ activeLayer: "F.Cu" }, on(), [])).toBe(false);
  });

  it("without a board (schematic page, not read yet) nothing on it holds — not even `unrouted: 0`", () => {
    const none = state({ board: null });
    for (const c of [{ boardFootprints: { min: 1 } }, { boardOutline: { closed: true } }, { unrouted: { max: 0 } }, { tracks: { min: 1 } }, { activeLayer: "F.Cu" }] as Cond[]) {
      expect(evalCond(c, none, []), JSON.stringify(c)).toBe(false);
    }
  });

  it("validates the board vocabulary", () => {
    const bad = (until: unknown) => () => parseTourDef({ id: "t", editor: "pcbnew", steps: [{ id: "a", text: "x", until }, { id: "b", text: "y", until: { next: true } }] });
    expect(bad({ boardFootprints: { ref: "J1", fpid: "A:B" } })).toThrow(/at most one of ref, fpid/);
    expect(bad({ boardOutline: { closed: false } })).toThrow();
    expect(bad({ unrouted: { max: -1 } })).toThrow();
    expect(bad({ activeLayer: "Edge Cuts" })).toThrow();
    expect(() => parseTourDef({ id: "t", editor: "pcbnew", steps: [{ id: "a", target: "footprint:J1", text: "x", until: { next: true } }] })).not.toThrow();
  });

  it("reads the board only for tours that ask about it", () => {
    const sch = parseTourDef(minimal([{ id: "a", text: "x", until: { symbols: { libId: "Device:R", min: 1 } } }, last]));
    const pcb = parseTourDef({ id: "p", editor: "pcbnew", steps: [{ id: "o", text: "Draw the outline", until: { boardOutline: { closed: true } } }, last] });
    expect(tourUsesBoard(sch)).toBe(false);
    expect(tourUsesBoard(pcb)).toBe(true);
    const reads: string[] = [];
    const raw = JSON.stringify({ ...board, outlineClosed: false });
    const deps: TourDeps = {
      symbols: () => "[]", nets: () => "[]", board: () => (reads.push("board"), raw),
      openBusy: () => false, dialogOpen: () => false, anyDialogOpen: () => false,
    };
    compileTour(sch, deps).sample([]);
    expect(reads).toEqual([]);
    const t = compileTour(pcb, deps);
    const s = t.sample([]);
    expect(reads).toEqual(["board"]);
    expect(t.steps.find((st) => st.when(s))?.id).toBe("o");
  });
});

