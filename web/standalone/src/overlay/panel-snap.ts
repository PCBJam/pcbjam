/**
 * Where a dragged floating panel snaps (overlay-system 0007): the window's edges, the other
 * panels' edges, and the editor's own parts (the drawing area, the toolbars, the status and
 * menu bars). Pure: page CSS pixels in, the snapped rect and the guide lines to draw out.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Something to snap to. A `panel` lines up with the dragged one (same edge) or sits beside it;
 * a `bar` (a toolbar, the status bar) only has panels beside it; an `area` (the drawing area)
 * holds them just inside its edges.
 */
export interface SnapTarget {
  rect: Rect;
  name: string;
  kind: "panel" | "bar" | "area";
  /** Names it across layout changes (an anchor's `key`); the name when not given. */
  key?: string;
}

/**
 * A panel edge held against the editor's layout (or the window): the panel's `edge` sits at
 * `offset` from the target's `ref` edge. Kept when a panel is dropped there, so the panel
 * follows when the layout moves (a toolbar hidden, a pane docked, the window resized).
 */
export interface Anchor {
  /** The target's key, or "window". */
  key: string;
  ref: "start" | "end";
  offset: number;
  edge: "start" | "end";
}

/** A guide line: vertical at x = `at` (axis "x") or horizontal at y = `at`, from..to. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface Snapped {
  x: number;
  y: number;
  w: number;
  h: number;
  guides: Guide[];
  /** What it snapped to, in words (for tests and the tooltip). */
  why: string[];
  /** Per axis, the editor part or window edge it snapped to (not a panel: stacks cover those). */
  anchors: { x?: Anchor; y?: Anchor };
}

/** The window's own anchor key. */
export const WINDOW = "window";

/** Gap kept from the window's edges. */
export const SNAP_MARGIN = 8;
/** Gap between a panel and what it sits beside. */
export const SNAP_GAP = 8;
/** How close an edge has to come to snap. */
export const SNAP_REACH = 12;
/** The grid a panel lands on when no edge is in reach (when the grid is on). */
export const SNAP_GRID = 16;

type Edge = "start" | "end";
interface Candidate {
  edge: Edge;
  /** Where that edge goes. */
  to: number;
  why: string;
  /** The guide's extent along the other axis. */
  span: [number, number];
  anchor?: Anchor;
}

/** Do [a0, a1] and [b0, b1] overlap, give or take the reach? */
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 + SNAP_REACH && b0 < a1 + SNAP_REACH;

/** Snap candidates along one axis; `along` picks x (with y as the other axis) or y. */
function candidates(r: Rect, targets: SnapTarget[], size: number, along: "x" | "y", edges: Edge[]): Candidate[] {
  const pos = (q: Rect) => (along === "x" ? q.x : q.y);
  const len = (q: Rect) => (along === "x" ? q.w : q.h);
  const cross = (q: Rect): [number, number] => (along === "x" ? [q.y, q.y + q.h] : [q.x, q.x + q.w]);
  const [lo, hi] = along === "x" ? ["left", "right"] : ["top", "bottom"];
  const out: Candidate[] = [];
  const add = (edge: Edge, to: number, why: string, span: [number, number], anchor?: Omit<Anchor, "edge">) => {
    if (edges.includes(edge)) out.push({ edge, to, why, span, ...(anchor ? { anchor: { ...anchor, edge } } : {}) });
  };
  const all: [number, number] = [0, Number.POSITIVE_INFINITY];
  add("start", SNAP_MARGIN, `the window's ${lo} edge`, all, { key: WINDOW, ref: "start", offset: SNAP_MARGIN });
  add("end", size - SNAP_MARGIN, `the window's ${hi} edge`, all, { key: WINDOW, ref: "end", offset: -SNAP_MARGIN });
  const [r0, r1] = cross(r);
  for (const t of targets) {
    const [o0, o1] = cross(t.rect);
    const near = overlaps(r0, r1, o0, o1);
    const span: [number, number] = [Math.min(r0, o0), Math.max(r1, o1)];
    const start = pos(t.rect);
    const end = start + len(t.rect);
    if (t.kind === "panel") {
      add("start", start, `${lo} edge of ${t.name}`, span);
      add("end", end, `${hi} edge of ${t.name}`, span);
    }
    const key = t.key ?? t.name;
    // Anchors only to the editor's parts: a panel beside another moves with it as a stack.
    const at = (ref: Edge, offset: number) => (t.kind === "panel" ? undefined : { key, ref, offset });
    if (t.kind === "area") {
      if (!near) continue;
      add("start", start + SNAP_GAP, `inside ${t.name}`, span, at("start", SNAP_GAP));
      add("end", end - SNAP_GAP, `inside ${t.name}`, span, at("end", -SNAP_GAP));
      continue;
    }
    if (!near) continue;
    add("start", end + SNAP_GAP, `beside ${t.name}`, span, at("end", SNAP_GAP));
    add("end", start - SNAP_GAP, `beside ${t.name}`, span, at("start", -SNAP_GAP));
  }
  return out;
}

/** The candidate whose edge is nearest, within reach; ties go to the first (the window, then panels). */
function nearest(r: Rect, along: "x" | "y", list: Candidate[]): (Candidate & { d: number }) | null {
  const start = along === "x" ? r.x : r.y;
  const end = start + (along === "x" ? r.w : r.h);
  let best: (Candidate & { d: number }) | null = null;
  for (const c of list) {
    const d = c.to - (c.edge === "start" ? start : end);
    if (Math.abs(d) <= SNAP_REACH && (!best || Math.abs(d) < Math.abs(best.d))) best = { ...c, d };
  }
  return best;
}

const guide = (axis: "x" | "y", c: Candidate, size: number): Guide => ({
  axis,
  at: c.to,
  from: Number.isFinite(c.span[1]) ? c.span[0] - SNAP_REACH : 0,
  to: Number.isFinite(c.span[1]) ? c.span[1] + SNAP_REACH : size,
});

const onGrid = (v: number) => Math.round(v / SNAP_GRID) * SNAP_GRID;

/** A panel moved to `r`: snapped on each axis to the nearest edge in reach, else (with `grid`) to the grid. */
export function snapMove(r: Rect, targets: SnapTarget[], viewport: { w: number; h: number }, opts: { grid?: boolean } = {}): Snapped {
  const out: Snapped = { ...r, guides: [], why: [], anchors: {} };
  const bx = nearest(r, "x", candidates(r, targets, viewport.w, "x", ["start", "end"]));
  const by = nearest(r, "y", candidates(r, targets, viewport.h, "y", ["start", "end"]));
  if (bx) {
    out.x += bx.d;
    out.why.push(bx.why);
    out.guides.push(guide("x", bx, viewport.h));
    if (bx.anchor) out.anchors.x = bx.anchor;
  } else if (opts.grid) out.x = onGrid(r.x);
  if (by) {
    out.y += by.d;
    out.why.push(by.why);
    out.guides.push(guide("y", by, viewport.w));
    if (by.anchor) out.anchors.y = by.anchor;
  } else if (opts.grid) out.y = onGrid(r.y);
  return out;
}

/**
 * Where an anchored panel's start edge goes on `axis` now: null when its target is gone (a
 * hidden toolbar), so the panel stays put.
 */
export function anchoredAt(
  anchor: Anchor,
  axis: "x" | "y",
  panelLength: number,
  targets: SnapTarget[],
  viewport: { w: number; h: number },
): number | null {
  let base: number;
  if (anchor.key === WINDOW) base = anchor.ref === "start" ? 0 : axis === "x" ? viewport.w : viewport.h;
  else {
    const t = targets.find((q) => (q.key ?? q.name) === anchor.key);
    if (!t) return null;
    const start = axis === "x" ? t.rect.x : t.rect.y;
    base = anchor.ref === "start" ? start : start + (axis === "x" ? t.rect.w : t.rect.h);
  }
  const to = base + anchor.offset;
  return anchor.edge === "start" ? to : to - panelLength;
}

/**
 * Columns of panels from the right edge of `region`, top to bottom in the order given, each
 * column as wide as its widest panel; a panel that would overflow the bottom starts the next
 * column to the left. Answers each panel's new top-left.
 */
export function arrangeColumns(sizes: Array<{ w: number; h: number }>, region: Rect): Array<{ x: number; y: number }> {
  const top = region.y + SNAP_GAP;
  const bottom = region.y + region.h - SNAP_GAP;
  let right = region.x + region.w - SNAP_GAP;
  let y = top;
  let width = 0;
  return sizes.map((p) => {
    if (y > top && y + p.h > bottom) {
      right -= width + SNAP_GAP;
      y = top;
      width = 0;
    }
    const at = { x: right - p.w, y };
    y += p.h + SNAP_GAP;
    width = Math.max(width, p.w);
    return at;
  });
}

/** A panel resized from its bottom-left or bottom-right corner: the edges that move snap. */
export function snapResize(
  r: Rect,
  side: "left" | "right",
  targets: SnapTarget[],
  viewport: { w: number; h: number },
  opts: { grid?: boolean } = {},
): Snapped {
  const out: Snapped = { ...r, guides: [], why: [], anchors: {} };
  const bx = nearest(r, "x", candidates(r, targets, viewport.w, "x", [side === "left" ? "start" : "end"]));
  const by = nearest(r, "y", candidates(r, targets, viewport.h, "y", ["end"]));
  if (bx) {
    if (side === "right") out.w += bx.d;
    else {
      out.x += bx.d;
      out.w -= bx.d;
    }
    out.why.push(bx.why);
    out.guides.push(guide("x", bx, viewport.h));
    if (bx.anchor) out.anchors.x = bx.anchor;
  } else if (opts.grid) {
    if (side === "right") out.w = onGrid(r.x + r.w) - r.x;
    else {
      out.x = onGrid(r.x);
      out.w = r.w + (r.x - out.x);
    }
  }
  if (by) {
    out.h += by.d;
    out.why.push(by.why);
    out.guides.push(guide("y", by, viewport.w));
  } else if (opts.grid) out.h = onGrid(r.y + r.h) - r.y;
  return out;
}

/**
 * Names the editor's toolbars by where they sit against the drawing area: a tall one left or
 * right of it, a wide one above it (wx does not tell JS which AUI pane is which).
 */
export function nameToolbar(bar: Rect, canvas: Rect | null): string {
  const tall = bar.h > bar.w * 2;
  if (!tall) return canvas && bar.y >= canvas.y + canvas.h - 1 ? "the bottom toolbar" : "the top toolbar";
  const mid = canvas ? canvas.x + canvas.w / 2 : Number.POSITIVE_INFINITY;
  return bar.x + bar.w / 2 < mid ? "the left toolbar" : "the right toolbar";
}
