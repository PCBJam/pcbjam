/**
 * Pure layout for the overlay: where the card goes relative to its target,
 * where the arrow points, and the spotlight cut-out path. All page CSS px.
 */
import type { CssRect } from "@/wasm/canvas-coords";
import type { Placement } from "./types";

export const VIEW_MARGIN = 12;
export const TARGET_GAP = 12;
export const SPOT_PAD = 6;
export const SPOT_RADIUS = 8;
/** Unanchored card: distance from the viewport bottom (clears the status bar). */
export const UNANCHORED_BOTTOM = 72;
/** Below this viewport width the card docks to the bottom edge, arrowless. */
export const DOCK_BELOW_WIDTH = 480;

type Side = Exclude<Placement, "auto">;

export interface CardLayout {
  x: number;
  y: number;
  /** null when docked or unanchored. */
  side: Side | null;
  docked: boolean;
  /** Arrow tip on the card edge facing the target, page px. */
  arrow: { x: number; y: number } | null;
}

/** Clamp into [lo, hi]; when the range is empty (card wider than the view), lo wins. */
const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

function fits(side: Side, t: CssRect, card: { w: number; h: number }, view: { w: number; h: number }): boolean {
  const need = TARGET_GAP + VIEW_MARGIN;
  switch (side) {
    case "top":
      return t.y - card.h - need >= 0;
    case "bottom":
      return t.y + t.height + card.h + need <= view.h;
    case "left":
      return t.x - card.w - need >= 0;
    case "right":
      return t.x + t.width + card.w + need <= view.w;
  }
}

function room(side: Side, t: CssRect, view: { w: number; h: number }): number {
  switch (side) {
    case "top":
      return t.y;
    case "bottom":
      return view.h - (t.y + t.height);
    case "left":
      return t.x;
    case "right":
      return view.w - (t.x + t.width);
  }
}

/** Preferred side if it fits; else the side with the most room. */
export function chooseSide(
  placement: Placement,
  t: CssRect,
  card: { w: number; h: number },
  view: { w: number; h: number },
): Side {
  const sides: readonly Side[] = ["bottom", "right", "top", "left"];
  if (placement !== "auto" && fits(placement, t, card, view)) return placement;
  const fitting = sides.find((s) => fits(s, t, card, view));
  if (fitting) return fitting;
  return sides.reduce<Side>((best, s) => (room(s, t, view) > room(best, t, view) ? s : best), "bottom");
}

export function layoutCard(opts: {
  target: CssRect | null;
  card: { w: number; h: number };
  view: { w: number; h: number };
  placement?: Placement;
}): CardLayout {
  const { target, card, view } = opts;
  const maxX = view.w - card.w - VIEW_MARGIN;
  const maxY = view.h - card.h - VIEW_MARGIN;

  if (view.w < DOCK_BELOW_WIDTH) {
    return {
      x: clamp((view.w - card.w) / 2, VIEW_MARGIN, maxX),
      y: clamp(view.h - card.h - VIEW_MARGIN, VIEW_MARGIN, maxY),
      side: null,
      docked: true,
      arrow: null,
    };
  }
  if (!target) {
    // Unanchored cards sit bottom-centre, above the editor's status bar: the
    // middle of the canvas is where a step asks the user to click.
    return {
      x: clamp((view.w - card.w) / 2, VIEW_MARGIN, maxX),
      y: clamp(view.h - card.h - UNANCHORED_BOTTOM, VIEW_MARGIN, maxY),
      side: null,
      docked: false,
      arrow: null,
    };
  }

  const side = chooseSide(opts.placement ?? "auto", target, card, view);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  let x: number;
  let y: number;
  switch (side) {
    case "bottom":
      x = cx - card.w / 2;
      y = target.y + target.height + TARGET_GAP;
      break;
    case "top":
      x = cx - card.w / 2;
      y = target.y - TARGET_GAP - card.h;
      break;
    case "right":
      x = target.x + target.width + TARGET_GAP;
      y = cy - card.h / 2;
      break;
    case "left":
      x = target.x - TARGET_GAP - card.w;
      y = cy - card.h / 2;
      break;
  }
  x = clamp(x, VIEW_MARGIN, maxX);
  y = clamp(y, VIEW_MARGIN, maxY);

  // The arrow sits on the card edge facing the target, as close to the
  // target's centre as the card's rounded corners allow.
  const inset = 16;
  let arrow: { x: number; y: number };
  if (side === "bottom" || side === "top") {
    arrow = { x: clamp(cx, x + inset, x + card.w - inset), y: side === "bottom" ? y : y + card.h };
  } else {
    arrow = { x: side === "right" ? x : x + card.w, y: clamp(cy, y + inset, y + card.h - inset) };
  }
  return { x, y, side, docked: false, arrow };
}

/** Target rect grown by the spotlight padding. */
export function spotlightRect(t: CssRect, pad: number = SPOT_PAD): CssRect {
  return { x: t.x - pad, y: t.y - pad, width: t.width + 2 * pad, height: t.height + 2 * pad };
}

/**
 * Full-viewport rect with a rounded cut-out around `hole`, for an SVG path
 * with `fill-rule="evenodd"`.
 */
export function spotlightPath(view: { w: number; h: number }, hole: CssRect, radius: number = SPOT_RADIUS): string {
  const r = Math.max(0, Math.min(radius, hole.width / 2, hole.height / 2));
  const { x, y, width: w, height: h } = hole;
  const n = (v: number) => Number(v.toFixed(2));
  const outer = `M0 0H${n(view.w)}V${n(view.h)}H0Z`;
  const inner =
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
  return `${outer}${inner}`;
}
