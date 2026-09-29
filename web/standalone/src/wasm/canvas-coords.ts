/**
 * World (KiCad IU) ↔ page CSS px for DOM layers drawn over the GAL canvas.
 *
 * Two steps: the viewport transform maps world → the GAL panel's own pixel
 * space (`worldToScreen`), then the panel's bounding rect maps that to CSS px.
 * The panel reports device px, which differ from CSS px on HiDPI — hence
 * `cssRatio`. Shared by the comment layer, the import-item placement and the
 * overlay system (overlay-system 0002 M0).
 */
import { screenToWorld, worldToScreen, type ViewportState } from "./collab/comments";

/** A CSS-pixel rect (getBoundingClientRect shape, page coordinates). */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
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

/** CSS px per GAL panel px. */
export function cssRatio(vp: ViewportState, rect: CssRect): number {
  return rect.width > 0 && vp.w > 0 ? rect.width / vp.w : 1;
}

/**
 * World → page CSS px. With `cullMargin`, points further than that many CSS px
 * outside the canvas return null (the comment layer hides such pins).
 */
export function worldToCss(
  vp: ViewportState,
  rect: CssRect,
  world: { x: number; y: number },
  cullMargin?: number,
): { x: number; y: number } | null {
  const ratio = cssRatio(vp, rect);
  const px = worldToScreen(vp, world);
  const x = rect.x + px.x * ratio;
  const y = rect.y + px.y * ratio;
  if (cullMargin !== undefined) {
    if (x < rect.x - cullMargin || x > rect.x + rect.width + cullMargin) return null;
    if (y < rect.y - cullMargin || y > rect.y + rect.height + cullMargin) return null;
  }
  return { x, y };
}

/** Page CSS px → world. */
export function cssToWorld(
  vp: ViewportState,
  rect: CssRect,
  css: { x: number; y: number },
): { x: number; y: number } {
  const ratio = cssRatio(vp, rect);
  return screenToWorld(vp, { x: (css.x - rect.x) / ratio, y: (css.y - rect.y) / ratio });
}
