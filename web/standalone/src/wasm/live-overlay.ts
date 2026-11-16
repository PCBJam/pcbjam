import type { DeckInput, DeckSignal, PreparedRun } from "@pcbjam/shared/sim-library";

/**
 * The live layer, the part without a screen: which widgets a running circuit
 * has on the open sheet, where they are and what they are bound to.
 *
 * A library part names its widgets (part.json "overlay"): "press-zone over
 * the symbol's box", "glow at its origin". The editor says where the symbols
 * of the open sheet are (Module.kicadSimPlaces, wasm/bindings/sim_places.h).
 * This module puts the two together. Drawing is components/LiveLayer.tsx.
 *
 * Numbers: the editor's are sheet units (KiCad's internal units, Y down); a
 * part's placement is in millimetres. A widget's box comes out in sheet units.
 */

/** Bridge surface: where the symbols of the open sheet are. */
export interface SimPlacesModule {
  kicadSimPlaces(): string;
}

/** True when the loaded wasm can say where the open sheet's symbols are. */
export function hasSimPlaces(mod: unknown): mod is SimPlacesModule {
  return typeof (mod as Partial<SimPlacesModule> | undefined)?.kicadSimPlaces === "function";
}

/** Left, top, right, bottom. */
export type Box4 = [number, number, number, number];

/** A symbol of the open sheet, in sheet units. */
export interface SymbolPlace {
  uuid: string;
  ref: string;
  /** Its origin. */
  x: number;
  y: number;
  /** A point of the symbol's own drawing (library file, Y up) -> sheet: x + a*px + b*py, y + c*px + d*py. */
  m: [number, number, number, number];
  /** The drawing and the pins, without text. */
  bbox: Box4;
  /** The drawing alone. */
  body: Box4;
}

export interface SheetPlaces {
  /** The open sheet instance in words ("/", "/Key 1/"). */
  sheet: string;
  iuPerMm: number;
  symbols: SymbolPlace[];
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBox = (v: unknown): v is Box4 => Array.isArray(v) && v.length === 4 && v.every(isNumber);

/** Reads the editor's answer. Throws a plain message when it is not one. */
export function readPlaces(answer: unknown): SheetPlaces {
  let data: unknown;
  try {
    data = typeof answer === "string" ? JSON.parse(answer) : answer;
  } catch {
    throw new Error("the editor's answer about the symbols' places is not JSON");
  }
  const obj = data as { error?: unknown; sheet?: unknown; iuPerMm?: unknown; symbols?: unknown } | null;
  if (!obj || typeof obj !== "object") throw new Error("the editor gave no answer about the symbols' places");
  if (typeof obj.error === "string") throw new Error(obj.error);
  if (typeof obj.sheet !== "string" || !isNumber(obj.iuPerMm) || obj.iuPerMm <= 0 || !Array.isArray(obj.symbols))
    throw new Error("the editor's answer about the symbols' places is not understood");
  const symbols: SymbolPlace[] = [];
  for (const raw of obj.symbols as Record<string, unknown>[]) {
    if (!raw || typeof raw.uuid !== "string" || !isNumber(raw.x) || !isNumber(raw.y) || !isBox(raw.m) || !isBox(raw.bbox))
      continue; // a symbol this page cannot place is left without widgets
    symbols.push({
      uuid: raw.uuid,
      ref: typeof raw.ref === "string" ? raw.ref : "",
      x: raw.x,
      y: raw.y,
      m: raw.m,
      bbox: raw.bbox,
      body: isBox(raw.body) ? raw.body : raw.bbox,
    });
  }
  return { sheet: obj.sheet, iuPerMm: obj.iuPerMm, symbols };
}

/**
 * Where a widget is on the sheet.
 *   corner      x, y is its top left corner; w and h are its size on the sheet
 *   center      x, y is its middle; w and h are its size on the sheet
 *   top-center  x, y is the middle of its top edge; it has its own size on screen
 */
export interface WidgetBox {
  x: number;
  y: number;
  w?: number;
  h?: number;
  anchor: "corner" | "center" | "top-center";
}

const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every(isNumber) ? (v as [number, number]) : null);

/** The named box of a symbol: "bbox" (drawing and pins) or "body" (drawing alone). */
function namedBox(sym: SymbolPlace, name: unknown): Box4 {
  return name === "body" ? sym.body : sym.bbox;
}

/** A point of the symbol's own drawing in mm, Y up. */
export type DrawingPoint = [number, number];

/**
 * A point of the symbol's own drawing (mm, Y up) -> the sheet. With `origin` the point is
 * measured from there: a part's "fits" line can say where on this symbol its overlay sits.
 */
function symbolPoint(sym: SymbolPlace, iuPerMm: number, origin: DrawingPoint = [0, 0]): (px: number, py: number) => [number, number] {
  const [a, b, c, d] = sym.m;
  return (px, py) => {
    const x = px + origin[0];
    const y = py + origin[1];
    return [sym.x + (a * x + b * y) * iuPerMm, sym.y + (c * x + d * y) * iuPerMm];
  };
}

/**
 * A part's placement on one symbol. Null: a placement this page does not know.
 *   { over: "bbox" | "body", margin?: [mx, my] }   a zone over the symbol
 *   { at: "origin", size: [w, h] }                 centred on the symbol's origin
 *   { below: "bbox" | "body", gap?: g }            under the symbol, centred
 *   { rect: [x0, y0, x1, y1] }                     in the symbol's own drawing (Y up); it turns with the symbol
 * `origin` moves "at" and "rect" to another point of the symbol's drawing (see PartFit.origin).
 */
export function placeBox(place: Record<string, unknown>, sym: SymbolPlace, iuPerMm: number, origin?: DrawingPoint): WidgetBox | null {
  const mm = (v: number) => v * iuPerMm;
  if (place.over !== undefined) {
    const [x0, y0, x1, y1] = namedBox(sym, place.over);
    const [mx, my] = pair(place.margin) ?? [0, 0];
    return { x: x0 - mm(mx), y: y0 - mm(my), w: x1 - x0 + 2 * mm(mx), h: y1 - y0 + 2 * mm(my), anchor: "corner" };
  }
  if (place.at === "origin") {
    const size = pair(place.size);
    if (!size) return null;
    const [x, y] = symbolPoint(sym, iuPerMm, origin)(0, 0);
    return { x, y, w: mm(size[0]), h: mm(size[1]), anchor: "center" };
  }
  if (place.below !== undefined) {
    const [x0, , x1, y1] = namedBox(sym, place.below);
    return { x: (x0 + x1) / 2, y: y1 + mm(isNumber(place.gap) ? place.gap : 0), anchor: "top-center" };
  }
  if (isBox(place.rect)) {
    const at = symbolPoint(sym, iuPerMm, origin);
    const [ax, ay] = at(place.rect[0], place.rect[1]);
    const [bx, by] = at(place.rect[2], place.rect[3]);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), anchor: "corner" };
  }
  return null;
}

/**
 * A contact that moves with a zone, as a line inside the zone's box: x0, y0, x1, y1, each a
 * fraction of the box (0, 0 is its top left corner; an end may lie outside it).
 */
export interface ZoneLine {
  off: Box4;
  on: Box4;
}

/**
 * A part's "lines" (the symbol's own drawing, mm) inside the zone they belong to. Nothing
 * when the zone has no size on the sheet or a line is not four numbers.
 */
function zoneLines(raw: unknown, sym: SymbolPlace, iuPerMm: number, box: WidgetBox, origin?: DrawingPoint): ZoneLine[] | undefined {
  if (!Array.isArray(raw) || !raw.length || box.anchor !== "corner" || !box.w || !box.h) return undefined;
  const { x, y, w, h } = box;
  const at = symbolPoint(sym, iuPerMm, origin);
  const inBox = (line: Box4): Box4 => {
    const [ax, ay] = at(line[0], line[1]);
    const [bx, by] = at(line[2], line[3]);
    return [(ax - x) / w, (ay - y) / h, (bx - x) / w, (by - y) / h];
  };
  const out: ZoneLine[] = [];
  for (const line of raw as { off?: unknown; on?: unknown }[]) {
    if (!line || !isBox(line.off) || !isBox(line.on)) return undefined;
    out.push({ off: inBox(line.off), on: inBox(line.on) });
  }
  return out;
}

/** One widget of one placed part on the open sheet. */
export interface LiveWidget {
  /** Stable while the symbol and its part stay: the sheet, the symbol's uuid and the widget's place in the part's list. */
  key: string;
  ref: string;
  uuid: string;
  partId: string;
  /** The widget's name, as the part gives it ("press-zone", "glow", ...). */
  widget: string;
  /** In sheet units. */
  box: WidgetBox;
  /** The widget's own options, with "$name" replaced by the setting of that name. */
  props: Record<string, unknown>;
  input?: DeckInput;
  signal?: DeckSignal;
  signals?: DeckSignal[];
  /** A zone's contacts that move, where the part draws them. */
  lines?: ZoneLine[];
}

const BINDING_KEYS = new Set(["widget", "place", "input", "signal", "signals", "lines"]);

/**
 * The widgets of a run on the sheet that is open: every placed part whose
 * symbol is on it, with each of the part's overlay entries placed and bound.
 * `notes` says what was left out and why (a placement this page does not
 * know, an input the run does not have).
 */
export function widgetsFor(
  run: Pick<PreparedRun, "placed" | "parts" | "inputs" | "signals">,
  places: SheetPlaces,
): { widgets: LiveWidget[]; notes: string[] } {
  const widgets: LiveWidget[] = [];
  const notes: string[] = [];
  const byUuid = new Map(places.symbols.map((s) => [s.uuid, s]));

  for (const placed of run.placed) {
    if (placed.sheet !== places.sheet) continue;
    const sym = byUuid.get(placed.uuid);
    if (!sym) continue; // deleted since Play
    const overlay = run.parts.get(placed.partId)?.manifest.overlay ?? [];
    const input = (name: string) => run.inputs.find((i) => i.ref === placed.ref && i.input.name === name);
    const signal = (name: string) => run.signals.find((s) => s.ref === placed.ref && s.name === name);

    overlay.forEach((entry, index) => {
      const where = `${placed.ref}, widget "${entry.widget}"`;
      const box = placeBox(entry.place ?? {}, sym, places.iuPerMm, placed.origin);
      if (!box) {
        notes.push(`${where}: a placement this page does not know (${JSON.stringify(entry.place)})`);
        return;
      }
      // "$name" is the symbol's setting of that name, also inside a list (the colours of a mixed light)
      const setting = (v: unknown): unknown => (typeof v === "string" && v.startsWith("$") ? placed.settings[v.slice(1)]?.value : v);
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (BINDING_KEYS.has(k)) continue;
        props[k] = Array.isArray(v) ? v.map(setting) : setting(v);
      }
      const widget: LiveWidget = { key: `${placed.sheet}:${placed.uuid}:${index}`, ref: placed.ref, uuid: placed.uuid, partId: placed.partId, widget: entry.widget, box, props };
      const lines = zoneLines(entry.lines, sym, places.iuPerMm, box, placed.origin);
      if (lines) widget.lines = lines;
      if (entry.input) {
        widget.input = input(entry.input);
        if (!widget.input) return void notes.push(`${where}: the run has no input "${entry.input}"`);
      }
      if (entry.signal) {
        widget.signal = signal(entry.signal);
        if (!widget.signal) return void notes.push(`${where}: the run has no signal "${entry.signal}"`);
      }
      if (entry.signals) {
        const all = entry.signals.map(signal);
        if (all.some((s) => !s)) return void notes.push(`${where}: the run does not have all of its signals`);
        widget.signals = all as DeckSignal[];
      }
      widgets.push(widget);
    });
  }
  return { widgets, notes };
}

/** A widget's box on the screen, in CSS px relative to the canvas. */
/** A symbol on the open sheet that the run leaves out, and the box its mark is drawn on. */
export interface LeftOutMark {
  key: string;
  ref: string;
  uuid: string;
  box: WidgetBox;
}

/** How far the mark stands off the symbol's drawing, in mm. */
const LEFT_OUT_MARGIN_MM = 0.6;

/**
 * The symbols of the open sheet that the run leaves out because nothing has a
 * model for them. The references are those of this use of the sheet, so a sheet
 * that is used twice marks the right ones. A symbol of several units is marked
 * on each unit.
 */
export function leftOutFor(run: Pick<PreparedRun, "notSimulated">, places: SheetPlaces): LeftOutMark[] {
  if (!run.notSimulated.length) return [];
  const refs = new Set(run.notSimulated);
  const m = LEFT_OUT_MARGIN_MM * places.iuPerMm;
  return places.symbols
    .filter((sym) => refs.has(sym.ref))
    .map((sym) => {
      const [x0, y0, x1, y1] = sym.body;
      return {
        key: `${places.sheet}:${sym.uuid}:left-out`,
        ref: sym.ref,
        uuid: sym.uuid,
        box: { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m, anchor: "corner" as const },
      };
    });
}

export interface ScreenBox {
  left: number;
  top: number;
  /** Missing for a widget that has its own size on screen ("top-center"). */
  width?: number;
  height?: number;
}

/**
 * Sheet -> screen for one widget. `toPx` takes a sheet point to CSS px
 * relative to the canvas; `pxPerUnit` is the CSS px of one sheet unit.
 */
export function screenBox(box: WidgetBox, toPx: (p: { x: number; y: number }) => { x: number; y: number }, pxPerUnit: number): ScreenBox {
  const p = toPx({ x: box.x, y: box.y });
  if (box.anchor === "top-center" || box.w === undefined || box.h === undefined) return { left: p.x, top: p.y };
  const width = box.w * pxPerUnit;
  const height = box.h * pxPerUnit;
  if (box.anchor === "center") return { left: p.x - width / 2, top: p.y - height / 2, width, height };
  return { left: p.x, top: p.y, width, height };
}

/**
 * Sends what the user sets to the engine, one value per input at a time and
 * in order. While a send is on its way, only the newest value waits: a slider
 * that is dragged does not queue up a hundred values, and the last one always
 * arrives. A send that fails is told to `onProblem`; the next one is tried.
 */
export function createInputSender(
  send: (vector: string, value: number) => Promise<void>,
  onProblem: (text: string) => void = () => {},
): (vector: string, value: number) => void {
  const waiting = new Map<string, number>();
  const busy = new Set<string>();

  async function pump(vector: string): Promise<void> {
    if (busy.has(vector)) return;
    busy.add(vector);
    try {
      while (waiting.has(vector)) {
        const value = waiting.get(vector)!;
        waiting.delete(vector);
        try {
          await send(vector, value);
        } catch (e) {
          onProblem(`${vector} = ${value}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      busy.delete(vector);
    }
  }

  return (vector, value) => {
    waiting.set(vector, value);
    void pump(vector);
  };
}

const PICO: [number, string] = [1e-12, "p"];
const PREFIXES: [number, string][] = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], PICO];

/** A value for a meter: three digits and the unit with its prefix ("4.98 V", "12.3 mV"). */
export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `? ${unit}`;
  const abs = Math.abs(value);
  if (abs < 0.5e-12) return `0.00 ${unit}`;
  // The first prefix whose number, rounded to three digits, is at least 1.
  const [step, prefix] = PREFIXES.find(([s]) => Number((abs / s).toPrecision(3)) >= 1) ?? PICO;
  return `${Number((value / step).toPrecision(3)).toPrecision(3)} ${prefix}${unit}`;
}

/**
 * A number that counts something (turns a minute), for a meter that wants no prefix: whole,
 * with three digits that count. "5450 rpm", never "5.45 krpm".
 */
export function countValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `? ${unit}`;
  // Number(): no "-0"
  return `${Number(Number(Math.round(value).toPrecision(3)))} ${unit}`;
}

/** From this much of a part's full loudness on, one more ring spreads from it. */
export const SOUND_STEPS: readonly number[] = [0.01, 0.1, 0.5];

/** How many rings a part that sounds this loud has: none when it is silent, up to three. */
export function soundRings(level: number): number {
  return SOUND_STEPS.filter((step) => level >= step).length;
}

/**
 * What a slider says beside its knob. Without a unit: where it stands in its range ("50 %").
 * With a unit: the input's own value ("25 °C"), with as many decimals as one step of the
 * slider can tell. With the scale "log" the input's value is the base-10 logarithm of what
 * is shown ("100 lx", "1.3 klx"): two digits, which is what a step of such a slider can tell.
 */
export function sliderText(value: number, min: number, max: number, unit?: string, log = false): string {
  if (!unit) return `${Math.round(((value - min) / (max - min)) * 100)} %`;
  if (log) {
    const shown = Number((10 ** value).toPrecision(2));
    return shown >= 1000 ? `${Number((shown / 1000).toPrecision(2))} k${unit}` : `${shown} ${unit}`;
  }
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(Math.abs(max - min) / 100))));
  // Number(): no "-0", and no zeros at the end
  return `${Number(value.toFixed(decimals))} ${unit}`;
}

// --- the colour of a light with several LEDs ----------------------------------

export type Rgb = readonly [r: number, g: number, b: number];

/**
 * The colour of several lights behind one lens. `levels` are 0 to 1, one per colour. The hue
 * is the sum of the colours, each weighted with its level and scaled so that the brightest
 * channel is full: red and green give yellow. What three colours have in common is white:
 * an RGB LED with all three on is white, with one of them stronger it is white with a tint.
 */
export function mixColors(colors: readonly Rgb[], levels: readonly number[]): Rgb {
  const sum = [0, 0, 0];
  colors.forEach((color, i) => color.forEach((part, k) => (sum[k]! += part * (levels[i] ?? 0))));
  const peak = Math.max(...sum);
  if (!(peak > 0)) return colors[0] ?? [0, 0, 0];   // dark: no colour to tell
  const most = Math.max(...colors.map((_, i) => levels[i] ?? 0));
  const white = colors.length >= 3 ? Math.min(...colors.map((_, i) => levels[i] ?? 0)) / most : 0;
  const [r, g, b] = sum.map((v) => {
    const hue = (v / peak) * 255;
    return Math.round(hue + (255 - hue) * white);
  });
  return [r!, g!, b!];
}
