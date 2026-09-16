/**
 * POC: drop a symbol (`.kicad_sym`) or footprint (`.kicad_mod`) picked from the
 * user's machine straight onto the open eeschema / pcbnew canvas.
 *
 * No new C++: both editors already expose the collab "items" apply bridge
 * (`Module.kicadCollabApplyItems`, wasm/bindings/{eeschema,pcbnew}_embind.cpp),
 * whose blobs go through the editors' own clipboard-paste parsers:
 *   - pcbnew accepts a BARE `(footprint …)` s-expr (makeFromBlob wraps it in a
 *     board envelope, remaps nets, commits it);
 *   - eeschema parses `(lib_symbols …) (symbol …)` clipboard dialect (LoadContent
 *     into a throwaway sheet) and re-links the instance to the blob's own
 *     lib_symbols entry — so a symbol from a library the editor has never seen
 *     can still be placed.
 * This file builds those blobs. Pure string work, unit-tested.
 */
import { parseKicadSymLib } from "./libs/kicad-sym-parse";

/** Bridge surface the panel needs; every export is in the merged bundle. */
export interface ImportModule {
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabGetViewport?: () => string;
  kicadOpenFileBusy?: () => boolean;
  /** Interactive placement (editor builds since 2026-09-15): the item hangs
   *  off the pointer like a chooser pick, the click commits it through the
   *  editor's own undo + collab path. Absent on older builds. */
  kicadPlaceImportedItem?: (sexpr: string) => string;
}

export function hasInteractivePlacement(
  mod: unknown,
): mod is ImportModule & { kicadPlaceImportedItem: (sexpr: string) => string } {
  return typeof (mod as Partial<ImportModule> | undefined)?.kicadPlaceImportedItem === "function";
}

export function hasImportBridge(mod: unknown): mod is ImportModule {
  return typeof (mod as Partial<ImportModule> | undefined)?.kicadCollabApplyItems === "function";
}

export type ImportKind = "symbol" | "footprint";

export function kindForFile(name: string): ImportKind | null {
  if (/\.kicad_sym$/i.test(name)) return "symbol";
  if (/\.kicad_mod$/i.test(name)) return "footprint";
  return null;
}

/** Max board/footprint format version the WASM fork parses (mirror local-file-source). */
const FORK_MAX_BOARD_VERSION = 20251028;

// Internal units per mm: pcbnew is nm, eeschema is 1/10000 mm (schIUScale).
const IU_PER_MM = { footprint: 1e6, symbol: 1e4 } as const;

/** The GAL viewport transform as `kicadCollabGetViewport` reports it. */
export interface Viewport {
  cx: number;
  cy: number;
  scale: number; // px per IU (canvas device px)
  w: number;
  h: number;
}

export function readViewport(mod: ImportModule): Viewport | null {
  try {
    const raw = mod.kicadCollabGetViewport?.();
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Viewport>;
    if (typeof v.cx !== "number" || typeof v.cy !== "number") return null;
    if (typeof v.scale !== "number" || typeof v.w !== "number" || typeof v.h !== "number") return null;
    return { cx: v.cx, cy: v.cy, scale: v.scale, w: v.w, h: v.h };
  } catch {
    return null;
  }
}

/** Snap a world position (IU) to the editor's default grid, in mm. */
export function worldToPlacementMm(
  world: { x: number; y: number },
  kind: ImportKind,
): { x: number; y: number } {
  const grid = kind === "symbol" ? 1.27 : 0.5;
  const snap = (mm: number) => Math.round(mm / grid) * grid;
  return { x: snap(world.x / IU_PER_MM[kind]), y: snap(world.y / IU_PER_MM[kind]) };
}

/** A CSS-pixel rect of the GAL canvas element (getBoundingClientRect). */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the user clicked, in mm: CSS px → canvas px (the GAL panel reports its
 * own pixel size, which differs from the CSS size on HiDPI) → world IU via the
 * viewport transform (same mapping the comment layer uses for its pins).
 */
export function placementAtCssPx(
  vp: Viewport,
  rect: CssRect,
  css: { x: number; y: number },
  kind: ImportKind,
): { x: number; y: number } {
  const cssRatio = rect.width > 0 && vp.w > 0 ? rect.width / vp.w : 1;
  const px = { x: (css.x - rect.x) / cssRatio, y: (css.y - rect.y) / cssRatio };
  const world = {
    x: (px.x - vp.w / 2) / vp.scale + vp.cx,
    y: (px.y - vp.h / 2) / vp.scale + vp.cy,
  };
  return worldToPlacementMm(world, kind);
}

/** Fallback drop point: the viewport centre, or a fixed spot if the viewport
 *  probe is missing (older bundle) or empty (no canvas yet). */
export function placementMm(mod: ImportModule, kind: ImportKind): { x: number; y: number } {
  const vp = readViewport(mod);
  return vp ? worldToPlacementMm({ x: vp.cx, y: vp.cy }, kind) : { x: 100, y: 100 };
}

/** The visible GAL canvas element's CSS rect, or null before the tool has one. */
export function glCanvasRect(): CssRect | null {
  const el = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
    const r = (c as HTMLElement).getBoundingClientRect();
    return getComputedStyle(c as HTMLElement).display !== "none" && r.width > 0;
  }) as HTMLElement | undefined;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

const fmt = (n: number): string => String(Number(n.toFixed(4)));
const esc = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`);
const unesc = (s: string): string => s.replace(/\\(.)/g, "$1");

/** Skip from `i` (just after an opening quote) to the index past the close. */
function endOfString(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return i;
}

/** [start, end) of the balanced form starting at `open` (a `(`), quote-aware. */
function matchParen(src: string, open: number): [number, number] {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i + 1);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
    i += 1;
  }
  throw new Error("unbalanced parentheses in s-expr");
}

/** Direct children of the outermost form. */
function* children(src: string): Generator<string> {
  const open = src.indexOf("(");
  if (open < 0) return;
  const [, outerEnd] = matchParen(src, open);
  let i = src.indexOf("(", open + 1);
  while (i >= 0 && i < outerEnd) {
    const [s, e] = matchParen(src, i);
    yield src.slice(s, e);
    i = src.indexOf("(", e);
  }
}

/** `(property "Name" "Value" …)` direct children → name → value. */
function properties(form: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of children(form)) {
    const m = c.match(/^\(\s*property\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/);
    if (m) out.set(unesc(m[1]!), unesc(m[2]!));
  }
  return out;
}

export interface SymbolImport {
  /** The blob for `kicadCollabApplyItems`. */
  sexpr: string;
  uuid: string;
  libId: string;
  reference: string;
}

/** Names of the symbols in a `.kicad_sym` file (file order; empty if not a lib). */
export function symbolNames(libText: string): string[] {
  try {
    return parseKicadSymLib(libText).names;
  } catch {
    return [];
  }
}

/**
 * Build the eeschema clipboard-dialect blob that places `symbolName` from the
 * `.kicad_sym` text at (x, y) mm on the shown sheet. `libNick` is the nickname
 * the placed instance will reference (`Nick:Name`) — the file's basename by
 * default; it only has to be stable, the definition travels in the blob.
 */
export function buildSymbolImport(
  libText: string,
  symbolName: string | undefined,
  libNick: string,
  x: number,
  y: number,
  uuid: string = crypto.randomUUID(),
): SymbolImport {
  const parsed = parseKicadSymLib(libText);
  const name = symbolName ?? parsed.names[0];
  if (!name) throw new Error("no symbol found in the library file");
  const body = parsed.bodyFor(name); // self-contained `(kicad_symbol_lib … (symbol "Name" …))`
  if (!body) throw new Error(`symbol "${name}" not found in the library file`);

  let block: string | null = null;
  for (const c of children(body)) {
    if (/^\(\s*symbol\b/.test(c)) {
      block = c;
      break;
    }
  }
  if (!block) throw new Error(`symbol "${name}" has no body`);

  const libId = `${libNick}:${name}`;
  // Schematic lib_symbols entries are keyed by the FULL lib id; sub-units keep
  // their short "Name_0_1" names (that is what a saved .kicad_sch looks like).
  const libEntry = block.replace(/^\(\s*symbol\s+"(?:[^"\\]|\\.)*"/, `(symbol "${esc(libId)}"`);

  const props = properties(block);
  const refPrefix = props.get("Reference") || "U";
  const reference = `${refPrefix}?`;
  const value = props.get("Value") || name;
  const footprint = props.get("Footprint") ?? "";
  const datasheet = props.get("Datasheet") ?? "";

  const font = "(effects (font (size 1.27 1.27)) (justify left))";
  const hidden = "(hide yes) (effects (font (size 1.27 1.27)))";
  const sexpr = [
    `(lib_symbols ${libEntry})`,
    `(symbol (lib_id "${esc(libId)}") (at ${fmt(x)} ${fmt(y)} 0) (unit 1)`,
    `  (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)`,
    `  (uuid "${uuid}")`,
    `  (property "Reference" "${esc(reference)}" (at ${fmt(x + 2.54)} ${fmt(y - 1.27)} 0) ${font})`,
    `  (property "Value" "${esc(value)}" (at ${fmt(x + 2.54)} ${fmt(y + 1.27)} 0) ${font})`,
    `  (property "Footprint" "${esc(footprint)}" (at ${fmt(x)} ${fmt(y)} 0) ${hidden})`,
    `  (property "Datasheet" "${esc(datasheet)}" (at ${fmt(x)} ${fmt(y)} 0) ${hidden})`,
    `)`,
  ].join("\n");

  return { sexpr, uuid, libId, reference };
}

export interface FootprintImport {
  sexpr: string;
  name: string;
}

/**
 * Build the pcbnew blob that drops the `.kicad_mod` footprint at (x, y) mm on
 * the board: the library body itself with `(at x y)` added (a library
 * footprint has no position) and the format version capped to the fork's.
 */
export function buildFootprintImport(modText: string, x: number, y: number): FootprintImport {
  const head = modText.match(/^\s*\(\s*footprint\s+"((?:[^"\\]|\\.)*)"/);
  if (!head) throw new Error("not a KiCad footprint file (expected `(footprint \"…\"`)");
  const name = unesc(head[1]!);

  let body = modText.replace(/\(\s*version\s+(\d+)\s*\)/, (m, v: string) =>
    Number(v) > FORK_MAX_BOARD_VERSION ? `(version ${FORK_MAX_BOARD_VERSION})` : m,
  );

  // Position goes right after the `(layer "…")` header form every .kicad_mod has;
  // the parser's footprint loop is token-order independent, this just keeps
  // the header shape a human expects. Replace an existing top-level `(at …)`.
  const at = `(at ${fmt(x)} ${fmt(y)})`;
  let placed = false;
  const parts: string[] = [];
  let cursor = 0;
  const open = body.indexOf("(");
  const [, outerEnd] = matchParen(body, open);
  let i = body.indexOf("(", open + 1);
  while (i >= 0 && i < outerEnd) {
    const [s, e] = matchParen(body, i);
    const form = body.slice(s, e);
    if (/^\(\s*at\b/.test(form)) {
      parts.push(body.slice(cursor, s), at);
      cursor = e;
      placed = true;
    } else if (!placed && /^\(\s*layer\b/.test(form)) {
      parts.push(body.slice(cursor, e), `\n\t${at}`);
      cursor = e;
      placed = true;
    }
    i = body.indexOf("(", e);
  }
  parts.push(body.slice(cursor));
  body = parts.join("");
  if (!placed) body = body.replace(/^(\s*\(\s*footprint\s+"(?:[^"\\]|\\.)*")/, `$1\n\t${at}`);

  return { sexpr: body, name };
}

/** The `kicadCollabApplyItems` envelope for one added blob (untagged: applies
 *  to the shown sheet / the board). */
export function applyEnvelope(sexpr: string): string {
  return JSON.stringify({ added: [{ sexpr }], changed: [], removed: [] });
}

/** The picked file as the panel holds it. */
export interface PickedFile {
  kind: ImportKind;
  fileName: string;
  text: string;
}

/**
 * Build the blob for `kicadPlaceImportedItem`: the same clipboard-dialect
 * text as the click-to-place path, but the position is a placeholder — the
 * editor's placement tool puts the item under the pointer and the click
 * decides where it lands. Returns the blob and a human label for the status.
 */
export function buildInteractiveImport(
  picked: PickedFile,
  symbolName?: string,
): { sexpr: string; label: string } {
  if (picked.kind === "symbol") {
    const nick = picked.fileName.replace(/\.kicad_sym$/i, "");
    const r = buildSymbolImport(picked.text, symbolName || undefined, nick, 0, 0);
    return { sexpr: r.sexpr, label: r.libId };
  }
  const r = buildFootprintImport(picked.text, 0, 0);
  return { sexpr: r.sexpr, label: r.name };
}
