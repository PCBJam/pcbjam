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
}

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
  const add = (edge: Edge, to: number, why: string, span: [number, number]) => {
    if (edges.includes(edge)) out.push({ edge, to, why, span });
  };
  add("start", SNAP_MARGIN, `the window's ${lo} edge`, [0, Number.POSITIVE_INFINITY]);
  add("end", size - SNAP_MARGIN, `the window's ${hi} edge`, [0, Number.POSITIVE_INFINITY]);
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
    if (t.kind === "area") {
      if (!near) continue;
      add("start", start + SNAP_GAP, `inside ${t.name}`, span);
      add("end", end - SNAP_GAP, `inside ${t.name}`, span);
      continue;
    }
    if (!near) continue;
    add("start", end + SNAP_GAP, `beside ${t.name}`, span);
    add("end", start - SNAP_GAP, `beside ${t.name}`, span);
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
  const out: Snapped = { ...r, guides: [], why: [] };
  const bx = nearest(r, "x", candidates(r, targets, viewport.w, "x", ["start", "end"]));
  const by = nearest(r, "y", candidates(r, targets, viewport.h, "y", ["start", "end"]));
  if (bx) {
    out.x += bx.d;
    out.why.push(bx.why);
    out.guides.push(guide("x", bx, viewport.h));
  } else if (opts.grid) out.x = onGrid(r.x);
  if (by) {
    out.y += by.d;
    out.why.push(by.why);
    out.guides.push(guide("y", by, viewport.w));
  } else if (opts.grid) out.y = onGrid(r.y);
  return out;
}

/** A panel resized from its bottom-left or bottom-right corner: the edges that move snap. */
export function snapResize(
  r: Rect,
  side: "left" | "right",
  targets: SnapTarget[],
  viewport: { w: number; h: number },
  opts: { grid?: boolean } = {},
): Snapped {
  const out: Snapped = { ...r, guides: [], why: [] };
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
