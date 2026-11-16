/**
 * The live layer's tags (a meter's number, a slider) hang under their symbols
 * and can cover what is drawn there. The user drags a tag off it. This file
 * holds where each tag was put, and how large the tags are drawn:
 *
 *   - a tag's place is a shift from its own place under its symbol, in
 *     millimetres of the sheet: it follows pan, zoom and the symbol;
 *   - the shifts are kept in the browser, one entry for a project. Moving a
 *     tag changes nothing in the schematic, and nobody else sees it moved;
 *   - a tag has one size on the screen at the zooms a schematic is mostly
 *     read at. Zoomed out, the tags shrink with the sheet, down to a size
 *     whose words can still be read. Zoomed in close, they grow with it, so
 *     a tag stays about as large as the schematic's own text beside it.
 */
import type { WidgetBox } from "./live-overlay";

/** How far a tag is from its own place: to the right and down, in mm of the sheet. */
export type TagShift = readonly [dx: number, dy: number];
/** By the widget's key (the sheet, the symbol, which of the part's widgets). */
export type TagShifts = Readonly<Record<string, TagShift>>;

/** A project remembers this many moved tags. The ones moved longest ago go first. */
export const MOST_TAGS = 500;
/** No tag is farther from its own place than this, in mm: no sheet is larger. */
const FARTHEST_MM = 2000;

const storageKey = (project: string): string => `pcbjam:live-tags:${project}`;
const round = (mm: number): number => Math.round(mm * 100) / 100 || 0; // never -0
const within = (mm: number): number => Math.max(-FARTHEST_MM, Math.min(FARTHEST_MM, mm));

/** A shift as it is kept: in hundredths of a millimetre. A tag at its own place has none. */
function asShift(v: unknown): TagShift | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [dx, dy] = v as unknown[];
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const shift: TagShift = [round(within(dx)), round(within(dy))];
  return shift[0] === 0 && shift[1] === 0 ? null : shift;
}

/** What the browser stored, as shifts. Anything in it that is not a shift is dropped. */
export function parseTagShifts(raw: string | null | undefined): TagShifts {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, TagShift> = {};
  for (const [key, value] of Object.entries(data).slice(-MOST_TAGS)) {
    const shift = asShift(value);
    if (shift) out[key] = shift;
  }
  return out;
}

/** The shifts with one tag moved, or put back at its own place (`null`). */
export function withTagShift(shifts: TagShifts, key: string, shift: TagShift | null): TagShifts {
  const next = shift ? asShift(shift) : null;
  const was = shifts[key];
  if (!next && !was) return shifts;
  if (next && was && next[0] === was[0] && next[1] === was[1]) return shifts;
  const rest = Object.entries(shifts).filter(([k]) => k !== key);
  if (!next) return Object.fromEntries(rest);
  // the tag that was moved last is the newest
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - MOST_TAGS + 1)), [key, next]]);
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // blocked storage: the tags are where they are until the page is left
  }
}

/** The moved tags of a project, as this browser remembers them. */
export function loadTagShifts(project: string | undefined, store: Store | null = browserStore()): TagShifts {
  if (!project) return {};
  try {
    return parseTagShifts(store?.getItem(storageKey(project)));
  } catch {
    return {};
  }
}

/** Remembers them. With blocked or full storage nothing is remembered, and nothing else happens. */
export function saveTagShifts(project: string | undefined, shifts: TagShifts, store: Store | null = browserStore()): void {
  if (!project) return;
  try {
    if (Object.keys(shifts).length === 0) store?.removeItem(storageKey(project));
    else store?.setItem(storageKey(project), JSON.stringify(shifts));
  } catch {
    /* not remembered */
  }
}

/** A tag's box, moved by its shift. `iuPerMm`: the sheet's units in a millimetre. */
export function shiftBox(box: WidgetBox, shift: TagShift | undefined, iuPerMm: number): WidgetBox {
  return shift ? { ...box, x: box.x + shift[0] * iuPerMm, y: box.y + shift[1] * iuPerMm } : box;
}

/** From this many CSS px in a millimetre of the sheet, a tag has its full size. */
export const TAG_FULL_PX_PER_MM = 5;
/** A tag is never smaller than this share of its full size: its words could not be read. */
export const TAG_LEAST = 0.7;
/**
 * From this many CSS px in a millimetre on, a tag grows with the sheet. It is where the
 * schematic's own text (1.27 mm high) gets larger than the tag's words.
 */
export const TAG_GROWS_PX_PER_MM = 8;
/** And it stops growing at this many times its full size: closer than that, a detail is looked at. */
export const TAG_MOST = 8;

/**
 * How many times its full size a tag is drawn at. Its full size between the two zooms above;
 * smaller with the sheet when that is zoomed out, larger with it when it is zoomed in close.
 */
export function tagScale(pxPerMm: number): number {
  if (!(pxPerMm > 0)) return 1;
  if (pxPerMm < TAG_FULL_PX_PER_MM) return Math.max(TAG_LEAST, pxPerMm / TAG_FULL_PX_PER_MM);
  return Math.min(TAG_MOST, Math.max(1, pxPerMm / TAG_GROWS_PX_PER_MM));
}
