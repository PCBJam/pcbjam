import { describe, expect, it, vi } from "vitest";
import type { DeckInput, DeckSignal, LoadedPart, PlacedPart, PreparedRun } from "@pcbjam/shared/sim-library";
import {
  createInputSender,
  formatValue,
  hasSimPlaces,
  leftOutFor,
  mixColors,
  placeBox,
  readPlaces,
  screenBox,
  widgetsFor,
  type SheetPlaces,
  type SymbolPlace, sliderText, countValue, soundRings,
} from "./live-overlay";

const MM = 10000; // the editor's units per millimetre

/** A symbol at (50, 40) mm, 10 mm wide with its pins and 5 mm tall, not rotated. */
const symbol = (over: Partial<SymbolPlace> = {}): SymbolPlace => ({
  uuid: "u-sw1",
  ref: "SW1",
  x: 50 * MM,
  y: 40 * MM,
  m: [1, 0, 0, -1],
  bbox: [45 * MM, 37 * MM, 55 * MM, 42 * MM],
  body: [47 * MM, 38 * MM, 53 * MM, 42 * MM],
  ...over,
});

describe("readPlaces", () => {
  const answer = {
    sheet: "/Key 1/",
    sheetPath: "/abc/",
    iuPerMm: MM,
    symbols: [symbol(), { uuid: "u-bad", ref: "X1", x: 1, y: 2 }, { ...symbol({ uuid: "u-d1", ref: "D1" }), body: undefined }],
  };

  it("reads the editor's answer, as text or as an object", () => {
    const places = readPlaces(JSON.stringify(answer));
    expect(places.sheet).toBe("/Key 1/");
    expect(places.iuPerMm).toBe(MM);
    expect(places.symbols.map((s) => s.ref)).toEqual(["SW1", "D1"]); // the one without a box is left out
    expect(readPlaces(answer).symbols.length).toBe(2);
  });

  it("takes the drawing-and-pins box when the editor gives no body box", () => {
    const d1 = readPlaces(answer).symbols[1]!;
    expect(d1.body).toEqual(d1.bbox);
  });

  it("says in words what is wrong with an answer", () => {
    expect(() => readPlaces("{")).toThrow("not JSON");
    expect(() => readPlaces(null)).toThrow("no answer");
    expect(() => readPlaces('{"error":"no schematic frame"}')).toThrow("no schematic frame");
    expect(() => readPlaces({ sheet: "/", iuPerMm: 0, symbols: [] })).toThrow("not understood");
    expect(() => readPlaces({ sheet: "/", iuPerMm: MM })).toThrow("not understood");
  });

  it("hasSimPlaces is true only for an editor build with the read", () => {
    expect(hasSimPlaces({ kicadSimPlaces: () => "" })).toBe(true);
    expect(hasSimPlaces({ kicadSimSymbols: () => "" })).toBe(false);
    expect(hasSimPlaces(null)).toBe(false);
  });
});

describe("placeBox", () => {
  it("over: the symbol's box with a margin in millimetres", () => {
    expect(placeBox({ over: "bbox", margin: [1.5, 2.5] }, symbol(), MM)).toEqual({
      x: 43.5 * MM, y: 34.5 * MM, w: 13 * MM, h: 10 * MM, anchor: "corner",
    });
    expect(placeBox({ over: "body" }, symbol(), MM)).toEqual({ x: 47 * MM, y: 38 * MM, w: 6 * MM, h: 4 * MM, anchor: "corner" });
  });

  it("at origin: centred on the symbol's origin", () => {
    expect(placeBox({ at: "origin", size: [13, 13] }, symbol(), MM)).toEqual({ x: 50 * MM, y: 40 * MM, w: 13 * MM, h: 13 * MM, anchor: "center" });
    expect(placeBox({ at: "origin" }, symbol(), MM)).toBeNull(); // no size
  });

  it("below: under the box, centred, with a gap", () => {
    expect(placeBox({ below: "bbox", gap: 4 }, symbol(), MM)).toEqual({ x: 50 * MM, y: 46 * MM, anchor: "top-center" });
    expect(placeBox({ below: "body" }, symbol(), MM)).toEqual({ x: 50 * MM, y: 42 * MM, anchor: "top-center" });
  });

  it("rect: a rectangle of the symbol's own drawing (Y up) lands on the sheet (Y down)", () => {
    // x from 1 to 3 mm right of the origin, y from 1 to 2 mm ABOVE it
    expect(placeBox({ rect: [1, 1, 3, 2] }, symbol(), MM)).toEqual({ x: 51 * MM, y: 38 * MM, w: 2 * MM, h: 1 * MM, anchor: "corner" });
  });

  it("rect turns with a rotated symbol and flips with a mirrored one", () => {
    // rotated by 90 degrees, as the editor reports it
    expect(placeBox({ rect: [1, 1, 3, 2] }, symbol({ m: [0, -1, -1, 0] }), MM)).toEqual({ x: 48 * MM, y: 37 * MM, w: 1 * MM, h: 2 * MM, anchor: "corner" });
    // rotated by 180 degrees
    expect(placeBox({ rect: [1, 1, 3, 2] }, symbol({ m: [-1, 0, 0, 1] }), MM)).toEqual({ x: 47 * MM, y: 41 * MM, w: 2 * MM, h: 1 * MM, anchor: "corner" });
    // mirrored left to right
    expect(placeBox({ rect: [1, 1, 3, 2] }, symbol({ m: [-1, 0, 0, -1] }), MM)).toEqual({ x: 47 * MM, y: 38 * MM, w: 2 * MM, h: 1 * MM, anchor: "corner" });
  });

  it("a placement it does not know gives nothing", () => {
    expect(placeBox({ beside: "bbox" }, symbol(), MM)).toBeNull();
    expect(placeBox({}, symbol(), MM)).toBeNull();
  });
});

describe("screenBox", () => {
  // 0.001 px per unit, the sheet's (40, 30) mm in the corner
  const toPx = (p: { x: number; y: number }) => ({ x: (p.x - 40 * MM) * 0.001, y: (p.y - 30 * MM) * 0.001 });

  it("corner, centre and top-centre", () => {
    expect(screenBox({ x: 45 * MM, y: 35 * MM, w: 10 * MM, h: 5 * MM, anchor: "corner" }, toPx, 0.001)).toEqual({ left: 50, top: 50, width: 100, height: 50 });
    expect(screenBox({ x: 50 * MM, y: 40 * MM, w: 13 * MM, h: 13 * MM, anchor: "center" }, toPx, 0.001)).toEqual({ left: 35, top: 35, width: 130, height: 130 });
    expect(screenBox({ x: 50 * MM, y: 46 * MM, anchor: "top-center" }, toPx, 0.001)).toEqual({ left: 100, top: 160 });
  });
});

// --- a run with a button, an LED, a potentiometer, and a sheet used twice ----

const part = (id: string, overlay: unknown[]): LoadedPart => ({ id, manifest: { overlay } as unknown as LoadedPart["manifest"], analog: "", logic: null });
const placed = (over: Partial<PlacedPart>): PlacedPart => ({
  ref: "X1", uuid: "u", sheet: "/", partId: "p", version: "1", rule: "r", name: "x1", nodes: [], connected: [], settings: {}, number: 1,
  ...over,
} as PlacedPart);
const momentary = (ref: string): DeckInput => ({
  ref, partId: "push-button", vector: `v.x${ref.toLowerCase()}.vctl`, initial: 0,
  input: { name: "pressed", type: "momentary", source: "Vctl", released: 0, held: 1 },
});
const current = (ref: string): DeckSignal => ({ ref, partId: "led", name: "current", vector: `v.x${ref.toLowerCase()}.vsense#branch` });

const run = (): Pick<PreparedRun, "placed" | "parts" | "inputs" | "signals"> => ({
  parts: new Map([
    ["push-button", part("push-button", [{ widget: "press-zone", place: { over: "bbox", margin: [1.5, 2.5] }, input: "pressed" }])],
    ["led", part("led", [{ widget: "glow", place: { at: "origin", size: [13, 13] }, signal: "current", full: 0.008, color: "$color" }])],
    ["odd", part("odd", [{ widget: "glow", place: { beside: "bbox" }, signal: "current" }, { widget: "press-zone", place: { over: "bbox" }, input: "nope" }])],
  ]),
  placed: [
    // one sheet file used twice: the same uuids under other references
    placed({ ref: "SW1", uuid: "u-sw", sheet: "/Key 1/", partId: "push-button" }),
    placed({ ref: "D1", uuid: "u-led", sheet: "/Key 1/", partId: "led", settings: { color: { value: "green", from: "value" } } }),
    placed({ ref: "SW2", uuid: "u-sw", sheet: "/Key 2/", partId: "push-button" }),
    placed({ ref: "D2", uuid: "u-led", sheet: "/Key 2/", partId: "led", settings: { color: { value: "red", from: "default" } } }),
    placed({ ref: "U9", uuid: "u-odd", sheet: "/Key 1/", partId: "odd" }),
    placed({ ref: "R1", uuid: "u-r1", sheet: "/Key 1/", partId: "gone" }),
  ],
  inputs: [momentary("SW1"), momentary("SW2")],
  signals: [current("D1"), current("D2"), current("U9")],
});

const sheet = (name: string, refs: [string, string]): SheetPlaces => ({
  sheet: name,
  iuPerMm: MM,
  symbols: [symbol({ uuid: "u-sw", ref: refs[0] }), symbol({ uuid: "u-led", ref: refs[1], x: 80 * MM }), symbol({ uuid: "u-odd", ref: "U9" }), symbol({ uuid: "u-other", ref: "R7" })],
});

describe("widgetsFor", () => {
  it("gives the open sheet's parts their widgets, placed and bound", () => {
    const { widgets } = widgetsFor(run(), sheet("/Key 1/", ["SW1", "D1"]));
    expect(widgets.map((w) => `${w.ref}:${w.widget}`)).toEqual(["SW1:press-zone", "D1:glow"]);
    const [press, glow] = widgets;
    expect(press!.input?.vector).toBe("v.xsw1.vctl");
    expect(press!.box).toEqual({ x: 43.5 * MM, y: 34.5 * MM, w: 13 * MM, h: 10 * MM, anchor: "corner" });
    expect(glow!.signal?.vector).toBe("v.xd1.vsense#branch");
    expect(glow!.box).toEqual({ x: 80 * MM, y: 40 * MM, w: 13 * MM, h: 13 * MM, anchor: "center" });
    // the widget's own options, a "$name" replaced by the symbol's setting
    expect(glow!.props).toEqual({ full: 0.008, color: "green" });
    expect(press!.props).toEqual({});
  });

  it("the same drawing on the sheet's other use is bound to the other references", () => {
    const one = widgetsFor(run(), sheet("/Key 1/", ["SW1", "D1"])).widgets;
    const two = widgetsFor(run(), sheet("/Key 2/", ["SW2", "D2"])).widgets;
    expect(two.map((w) => `${w.ref}:${w.widget}`)).toEqual(["SW2:press-zone", "D2:glow"]);
    expect(two[0]!.input?.vector).toBe("v.xsw2.vctl");
    expect(two[1]!.props.color).toBe("red");
    // and they are other widgets: what one holds is not the other's
    expect(two[0]!.key).not.toBe(one[0]!.key);
  });

  it("a sheet without parts of the run has no widgets", () => {
    expect(widgetsFor(run(), { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-v1", ref: "V1" })] })).toEqual({ widgets: [], notes: [] });
  });

  it("a symbol deleted since Play has no widget; one that moved has it at the new place", () => {
    const places = sheet("/Key 1/", ["SW1", "D1"]);
    places.symbols = places.symbols.filter((s) => s.uuid !== "u-sw");
    places.symbols.find((s) => s.uuid === "u-led")!.x = 90 * MM;
    const { widgets } = widgetsFor(run(), places);
    expect(widgets.map((w) => w.ref)).toEqual(["D1"]);
    expect(widgets[0]!.box.x).toBe(90 * MM);
  });

  it("a symbol with several switches has a zone for each, with its contact drawn in it", () => {
    // two rows of one symbol: each its own input, its own rectangle and the line that moves
    const toggle = (name: string): DeckInput => ({
      ref: "SW1", partId: "dip", vector: `v.xsw1.v${name}`, initial: 0,
      input: { name, type: "toggle", source: `V${name}`, off: 0, on: 1, default: "off" },
    });
    const dip = {
      parts: new Map([["dip", part("dip", [
        { widget: "toggle-zone", place: { rect: [-4, 1, 4, 3] }, input: "sw1", label: "1", lines: [{ off: [-2, 2, 2, 3], on: [-2, 2, 2, 2] }] },
        { widget: "toggle-zone", place: { rect: [-4, -1, 4, 1] }, input: "sw2", label: "2", lines: [{ off: [-2, 0, 2, 1], on: [-2, 0, 2, 0] }] },
      ])]]),
      placed: [placed({ ref: "SW1", uuid: "u-sw", sheet: "/", partId: "dip" })],
      inputs: [toggle("sw1"), toggle("sw2")],
      signals: [],
    };
    const places = (m: SymbolPlace["m"]): SheetPlaces => ({ sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-sw", m })] });
    const { widgets, notes } = widgetsFor(dip, places([1, 0, 0, -1]));
    expect(notes).toEqual([]);
    expect(widgets.map((w) => [w.input?.vector, w.props])).toEqual([["v.xsw1.vsw1", { label: "1" }], ["v.xsw1.vsw2", { label: "2" }]]);
    // the symbol is at (50, 40) mm: the upper row is the box from (46, 37), 8 by 2 mm
    expect(widgets[0]!.box).toEqual({ x: 46 * MM, y: 37 * MM, w: 8 * MM, h: 2 * MM, anchor: "corner" });
    expect(widgets[1]!.box).toEqual({ x: 46 * MM, y: 39 * MM, w: 8 * MM, h: 2 * MM, anchor: "corner" });
    // the line in fractions of its box: open it rises to the box's top edge, closed it lies level
    expect(widgets[0]!.lines).toEqual([{ off: [0.25, 0.5, 0.75, 0], on: [0.25, 0.5, 0.75, 0.5] }]);
    expect(widgets[1]!.lines).toEqual(widgets[0]!.lines);

    // turned a quarter: the row stands upright, and the line turns with it
    const turned = widgetsFor(dip, places([0, -1, -1, 0])).widgets[0]!;
    expect(turned.box).toEqual({ x: 47 * MM, y: 36 * MM, w: 2 * MM, h: 8 * MM, anchor: "corner" });
    expect(turned.lines).toEqual([{ off: [0.5, 0.75, 0, 0.25], on: [0.5, 0.75, 0.5, 0.25] }]);
  });

  it("a zone over the whole symbol draws its contact too; a widget without a size on the sheet has none", () => {
    const lines = [{ off: [-2, 0, 2, 1], on: [-2, 0, 2, 0] }];
    const one = {
      parts: new Map([["sw", part("sw", [
        { widget: "press-zone", place: { over: "bbox", margin: [1, 1] }, input: "pressed", lines },
        { widget: "press-zone", place: { below: "bbox" }, input: "pressed", lines },
        { widget: "press-zone", place: { over: "bbox" }, input: "pressed", lines: [{ off: [0, 0, 1], on: [0, 0, 1, 1] }] },
      ])]]),
      placed: [placed({ ref: "SW1", uuid: "u-sw", sheet: "/", partId: "sw" })],
      inputs: [momentary("SW1")],
      signals: [],
    };
    const { widgets } = widgetsFor(one, { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-sw" })] });
    // the box is (44, 36) to (56, 43) mm: 12 by 7
    expect(widgets[0]!.lines![0]!.off.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.333, 0.571, 0.667, 0.429]);
    expect(widgets[0]!.props).toEqual({});
    expect(widgets[1]!.lines).toBeUndefined();
    // a line that is not four numbers: the zone is there, without a drawing
    expect(widgets[2]!.lines).toBeUndefined();
  });

  it("a part's overlay sits where its line for this symbol says, and turns with the symbol", () => {
    // a digit: its face is measured from the place where this symbol draws its small digit
    const bars = ["a", "b", "c", "d", "e", "f", "g"];
    const digit = (origin?: [number, number]) => ({
      parts: new Map([["digit", part("digit", [
        { widget: "seven-segment", place: { rect: [-2, -1, 3, 7] }, signals: bars, color: "$color" },
        { widget: "glow", place: { at: "origin", size: [4, 4] }, signal: "a" },
      ])]]),
      placed: [placed({ ref: "U1", uuid: "u-sw", sheet: "/", partId: "digit", settings: { color: { value: "green", from: "field" } }, ...(origin ? { origin } : {}) })],
      inputs: [],
      signals: bars.map((name): DeckSignal => ({ ref: "U1", partId: "digit", name, vector: `v.xu1.v${name}#branch` })),
    });
    const places = (m: SymbolPlace["m"]): SheetPlaces => ({ sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-sw", m })] });
    // without a place of its own it is measured from the symbol's origin, (50, 40) mm; Y is up in the drawing
    const plain = widgetsFor(digit(), places([1, 0, 0, -1])).widgets;
    expect(plain[0]!.box).toEqual({ x: 48 * MM, y: 33 * MM, w: 5 * MM, h: 8 * MM, anchor: "corner" });
    expect(plain[0]!.signals?.map((s) => s.vector)).toEqual(bars.map((b) => `v.xu1.v${b}#branch`));
    expect(plain[0]!.props).toEqual({ color: "green" });
    // 1 mm to the right and 3 mm up: both widgets move with it
    const [face, glow] = widgetsFor(digit([1, 3]), places([1, 0, 0, -1])).widgets;
    expect(face!.box).toEqual({ x: 49 * MM, y: 30 * MM, w: 5 * MM, h: 8 * MM, anchor: "corner" });
    expect(glow!.box).toEqual({ x: 51 * MM, y: 37 * MM, w: 4 * MM, h: 4 * MM, anchor: "center" });
    // the symbol turned a quarter: the place turns with it
    expect(widgetsFor(digit([1, 3]), places([0, -1, -1, 0])).widgets[0]!.box).toEqual({ x: 40 * MM, y: 36 * MM, w: 8 * MM, h: 5 * MM, anchor: "corner" });
  });

  it("a relay's contacts are drawn by a widget that is no zone: bound to its signal, measured from the first arm", () => {
    const relay = (origin: [number, number]) => ({
      parts: new Map([["relay", part("relay", [
        { widget: "contact", place: { rect: [-3, -3, 3, 5] }, signal: "pulled", lines: [{ off: [0, -2, -2, 4], on: [0, -2, 2, 4] }] },
      ])]]),
      placed: [placed({ ref: "K1", uuid: "u-sw", sheet: "/", partId: "relay", settings: {}, origin })],
      inputs: [],
      signals: [{ ref: "K1", partId: "relay", name: "pulled", vector: "v.xk1.vstate#branch" }] satisfies DeckSignal[],
    });
    const places: SheetPlaces = { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-sw", m: [1, 0, 0, -1] })] };
    // the symbol is at (50, 40) mm; the arm's foot 5 mm to the right of it
    const { widgets, notes } = widgetsFor(relay([5, 0]), places);
    expect(notes).toEqual([]);
    expect(widgets).toHaveLength(1);
    const [contact] = widgets;
    expect(contact).toMatchObject({ widget: "contact", ref: "K1", box: { x: 52 * MM, y: 35 * MM, w: 6 * MM, h: 8 * MM, anchor: "corner" } });
    expect(contact!.signal?.vector).toBe("v.xk1.vstate#branch");
    expect(contact!.input).toBeUndefined();
    // the arm in fractions of the box: from its foot up to the left at rest, up to the right when pulled in
    const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
    close(contact!.lines![0]!.off, [3 / 6, 7 / 8, 1 / 6, 1 / 8]);
    close(contact!.lines![0]!.on, [3 / 6, 7 / 8, 5 / 6, 1 / 8]);
  });

  it("a light for several currents has them all, and reads its colours out of the settings", () => {
    const two = {
      parts: new Map([["dual", part("dual", [{ widget: "glow-mix", place: { at: "origin", size: [13, 13] }, signals: ["led1", "led2"], colors: ["$color1", "$color2", "blue"], full: 0.008 }])]]),
      placed: [placed({ ref: "D1", uuid: "u-led", sheet: "/", partId: "dual", settings: { color1: { value: "red", from: "default" }, color2: { value: "yellow", from: "field" } } })],
      inputs: [],
      signals: ["led1", "led2"].map((name, i): DeckSignal => ({ ref: "D1", partId: "dual", name, vector: `v.xd1.v${i + 1}#branch` })),
    };
    const { widgets, notes } = widgetsFor(two, { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-led" })] });
    expect(notes).toEqual([]);
    expect(widgets[0]!.signals?.map((s) => s.vector)).toEqual(["v.xd1.v1#branch", "v.xd1.v2#branch"]);
    expect(widgets[0]!.props).toEqual({ colors: ["red", "yellow", "blue"], full: 0.008 });
    // a signal the run does not have: the widget is left out, with a note
    two.signals.pop();
    expect(widgetsFor(two, { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-led" })] })).toEqual({ widgets: [], notes: ['D1, widget "glow-mix": the run does not have all of its signals'] });
  });

  it("says what it left out: a placement it does not know, an input the run does not have", () => {
    const { notes } = widgetsFor(run(), sheet("/Key 1/", ["SW1", "D1"]));
    expect(notes).toEqual([
      'U9, widget "glow": a placement this page does not know ({"beside":"bbox"})',
      'U9, widget "press-zone": the run has no input "nope"',
    ]);
  });
});

describe("createInputSender", () => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("sends a press and its release in order", async () => {
    const sent: [string, number][] = [];
    const send = createInputSender(async (vector, value) => void sent.push([vector, value]));
    send("v.xsw1.vctl", 1);
    send("v.xsw1.vctl", 0);
    await tick();
    expect(sent).toEqual([["v.xsw1.vctl", 1], ["v.xsw1.vctl", 0]]);
  });

  it("while one value is on its way only the newest waits, and it always arrives", async () => {
    const sent: number[] = [];
    const first = gate();
    const send = createInputSender(async (_vector, value) => {
      sent.push(value);
      if (sent.length === 1) await first.promise;
    });
    send("v.xrv1.vpos", 0.1);
    for (const v of [0.2, 0.3, 0.4, 0.5]) send("v.xrv1.vpos", v);
    await tick();
    expect(sent).toEqual([0.1]);
    first.open();
    await tick();
    expect(sent).toEqual([0.1, 0.5]);
  });

  it("one input that waits does not hold up another", async () => {
    const sent: string[] = [];
    const slow = gate();
    const send = createInputSender(async (vector) => {
      sent.push(vector);
      if (vector === "a") await slow.promise;
    });
    send("a", 1);
    send("b", 1);
    await tick();
    expect(sent).toEqual(["a", "b"]);
    slow.open();
  });

  it("a send that fails is told, and the next one is tried", async () => {
    const problems: string[] = [];
    const engine = vi.fn(async (_vector: string, value: number) => {
      if (value === 1) throw new Error("no answer from the engine");
    });
    const send = createInputSender(engine, (text) => problems.push(text));
    send("v.x.vctl", 1);
    await tick();
    send("v.x.vctl", 0);
    await tick();
    expect(problems).toEqual(["v.x.vctl = 1: no answer from the engine"]);
    expect(engine).toHaveBeenCalledTimes(2);
  });
});

describe("formatValue", () => {
  it("three digits and the unit with its prefix", () => {
    expect(formatValue(4.9812, "V")).toBe("4.98 V");
    expect(formatValue(12.34, "V")).toBe("12.3 V");
    expect(formatValue(123.4, "V")).toBe("123 V");
    expect(formatValue(0.01234, "V")).toBe("12.3 mV");
    expect(formatValue(0.0000152, "A")).toBe("15.2 µA");
    expect(formatValue(4700, "ohm")).toBe("4.70 kohm");
    expect(formatValue(-3.3, "V")).toBe("-3.30 V");
  });

  it("does not jump a prefix at a rounding edge", () => {
    expect(formatValue(999.96, "V")).toBe("1.00 kV");
    expect(formatValue(0.99996, "V")).toBe("1.00 V");
  });

  it("nothing is zero, and a value that is not a number says so", () => {
    expect(formatValue(0, "V")).toBe("0.00 V");
    expect(formatValue(1e-15, "V")).toBe("0.00 V");
    expect(formatValue(Number.NaN, "V")).toBe("? V");
  });
});

describe("countValue", () => {
  it("a count is whole and has no prefix: three digits that count", () => {
    expect([0, 0.4, 87.6, 1200, 5454.4, 12345, -5939.2].map((v) => countValue(v, "rpm"))).toEqual(["0 rpm", "0 rpm", "88 rpm", "1200 rpm", "5450 rpm", "12300 rpm", "-5940 rpm"]);
    // what is left of a motor that has stopped is no number to show
    expect([1e-9, -0.2].map((v) => countValue(v, "rpm"))).toEqual(["0 rpm", "0 rpm"]);
    expect(countValue(Number.NaN, "rpm")).toBe("? rpm");
  });
});

describe("soundRings", () => {
  it("none while a part is silent, one more with every step of its loudness", () => {
    expect([0, 0.005, 0.01, 0.09, 0.1, 0.42, 0.5, 1, 1.4].map(soundRings)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 3]);
    // the other way round a signal is no sound
    expect(soundRings(-1)).toBe(0);
  });
});

describe("sliderText", () => {
  it("without a unit: where the slider stands in its range", () => {
    expect([0, 0.5, 1].map((v) => sliderText(v, 0, 1))).toEqual(["0 %", "50 %", "100 %"]);
    expect(sliderText(25, -40, 125)).toBe("39 %");
  });

  it("with a unit: the value itself, as fine as one step of the slider", () => {
    // a thermistor: 165 degrees in a hundred steps
    expect([-40, -0.4, 24.7, 125].map((v) => sliderText(v, -40, 125, "°C"))).toEqual(["-40 °C", "0 °C", "25 °C", "125 °C"]);
    // a range of 5: a twentieth per step
    expect(sliderText(1.25, 0, 5, "V")).toBe("1.25 V");
    expect(sliderText(2, 0, 5, "V")).toBe("2 V");
  });

  it("on a log scale: ten to the power of the value, in two digits", () => {
    const lux = (v: number) => sliderText(v, -1, 5, "lx", true);
    expect([-1, 0, 1, 2, 2.06, 3, 3.12, 5].map(lux)).toEqual(["0.1 lx", "1 lx", "10 lx", "100 lx", "110 lx", "1 klx", "1.3 klx", "100 klx"]);
  });
});

describe("leftOutFor", () => {
  it("marks the open sheet's symbols that the run leaves out, around their drawing", () => {
    const marks = leftOutFor({ notSimulated: ["Q1", "R7", "U9"] }, sheet("/Key 1/", ["SW1", "D1"]));
    expect(marks.map((m) => [m.ref, m.uuid, m.key])).toEqual([
      ["U9", "u-odd", "/Key 1/:u-odd:left-out"],
      ["R7", "u-other", "/Key 1/:u-other:left-out"],
    ]);
    // the drawing (47..53 x 38..42 mm) and 0.6 mm around it
    expect(marks[0]!.box).toEqual({ x: 46.4 * MM, y: 37.4 * MM, w: 7.2 * MM, h: 5.2 * MM, anchor: "corner" });
  });

  it("goes by the references of this use of the sheet", () => {
    // the same drawing is SW1 on one use of the sheet and SW2 on the other
    expect(leftOutFor({ notSimulated: ["SW2"] }, sheet("/Key 1/", ["SW1", "D1"]))).toEqual([]);
    expect(leftOutFor({ notSimulated: ["SW2"] }, sheet("/Key 2/", ["SW2", "D2"])).map((m) => m.ref)).toEqual(["SW2"]);
  });

  it("marks every unit of a symbol that has several, and nothing when the run leaves nothing out", () => {
    const two: SheetPlaces = { sheet: "/", iuPerMm: MM, symbols: [symbol({ uuid: "u-a", ref: "U1" }), symbol({ uuid: "u-b", ref: "U1", x: 90 * MM })] };
    expect(leftOutFor({ notSimulated: ["U1"] }, two).map((m) => m.uuid)).toEqual(["u-a", "u-b"]);
    expect(leftOutFor({ notSimulated: [] }, two)).toEqual([]);
  });
});

describe("mixColors", () => {
  const red = [255, 58, 40] as const;
  const green = [50, 215, 90] as const;
  const blue = [64, 140, 255] as const;

  it("one colour alone is that colour, however weak", () => {
    expect(mixColors([red, green, blue], [1, 0, 0])).toEqual([255, 58, 40]);
    expect(mixColors([red, green, blue], [0, 0.1, 0])).toEqual([59, 255, 107]);
    expect(mixColors([red, green], [0, 1])).toEqual([59, 255, 107]);
  });

  it("two colours give the colour between them", () => {
    // red and green: yellow; green and blue: cyan
    expect(mixColors([red, green], [1, 1])).toEqual([255, 228, 109]);
    expect(mixColors([red, green, blue], [1, 1, 0])).toEqual([255, 228, 109]);
    expect(mixColors([red, green, blue], [0, 1, 1])).toEqual([82, 255, 248]);
    // the weaker one only tints
    expect(mixColors([red, green], [1, 0.2])).toEqual([255, 97, 56]);
  });

  it("what three colours have in common is white", () => {
    expect(mixColors([red, green, blue], [1, 1, 1])).toEqual([255, 255, 255]);
    expect(mixColors([red, green, blue], [0.3, 0.3, 0.3])).toEqual([255, 255, 255]);
    // red stronger than the other two: white with a warm tint
    const [r, g, b] = mixColors([red, green, blue], [1, 0.68, 0.68]);
    expect([r, g > b, b > 230]).toEqual([255, true, true]);
  });

  it("nothing lit: the first colour, the light is dark anyway", () => {
    expect(mixColors([red, green], [0, 0])).toEqual([255, 58, 40]);
    expect(mixColors([], [])).toEqual([0, 0, 0]);
  });
});
