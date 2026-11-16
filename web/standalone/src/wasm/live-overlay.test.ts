import { describe, expect, it, vi } from "vitest";
import type { DeckInput, DeckSignal, LoadedPart, PlacedPart, PreparedRun } from "@pcbjam/shared/sim-library";
import {
  createInputSender,
  formatValue,
  hasSimPlaces,
  placeBox,
  readPlaces,
  screenBox,
  widgetsFor,
  type SheetPlaces,
  type SymbolPlace,
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
