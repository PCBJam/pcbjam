import { describe, expect, it } from "vitest";
import { cssRatio, cssToWorld, worldToCss } from "./canvas-coords";

// A 2x HiDPI panel: the GAL reports 800x600 device px, the element is 400x300
// CSS px at (100, 50) on the page.
const vp = { cx: 1000, cy: 2000, scale: 0.5, w: 800, h: 600 };
const rect = { x: 100, y: 50, width: 400, height: 300 };

describe("canvas-coords", () => {
  it("scales device px to CSS px", () => {
    expect(cssRatio(vp, rect)).toBe(0.5);
    expect(cssRatio({ ...vp, w: 0 }, rect)).toBe(1);
  });

  it("maps the viewport centre to the rect centre", () => {
    expect(worldToCss(vp, rect, { x: 1000, y: 2000 })).toEqual({ x: 300, y: 200 });
  });

  it("round-trips world ↔ css", () => {
    const world = { x: 1234, y: 1876 };
    const css = worldToCss(vp, rect, world)!;
    const back = cssToWorld(vp, rect, css);
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it("culls only when a margin is given", () => {
    const far = { x: 1000 + 2000, y: 2000 }; // 1000 device px → 500 CSS px right of centre
    expect(worldToCss(vp, rect, far)).toEqual({ x: 800, y: 200 });
    expect(worldToCss(vp, rect, far, 20)).toBeNull();
  });
});
