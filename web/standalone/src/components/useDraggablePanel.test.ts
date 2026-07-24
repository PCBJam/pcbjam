import { describe, expect, it } from "vitest";
import { restorePosition } from "./useDraggablePanel";

const VP = { w: 1200, h: 800 };

describe("restorePosition (comments-ux 0001 B always-onscreen guarantee)", () => {
  it("restores fraction entries scaled to the current viewport", () => {
    const p = restorePosition(JSON.stringify({ fx: 0.5, fy: 0.5 }), VP, 36, 36, 4);
    expect(p).toEqual({ x: 4 + 0.5 * (1200 - 36 - 8), y: 4 + 0.5 * (800 - 36 - 8) });
  });

  it("clamps out-of-range fractions onscreen instead of discarding", () => {
    const p = restorePosition(JSON.stringify({ fx: 7, fy: -3 }), VP, 36, 36, 4);
    expect(p).toEqual({ x: 4 + (1200 - 36 - 8), y: 4 });
  });

  it("keeps a legacy px entry that is still fully visible", () => {
    expect(restorePosition(JSON.stringify({ x: 100, y: 100 }), VP, 36, 36)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("discards a legacy px entry outside the current viewport (secondary display gone)", () => {
    expect(restorePosition(JSON.stringify({ x: 2500, y: 100 }), VP, 36, 36)).toBeNull();
    expect(restorePosition(JSON.stringify({ x: 100, y: -50 }), VP, 36, 36)).toBeNull();
    // Partially visible but the handle would stick out — also reset.
    expect(restorePosition(JSON.stringify({ x: 1190, y: 100 }), VP, 36, 36)).toBeNull();
  });

  it("ignores garbage", () => {
    expect(restorePosition(null, VP, 36, 36)).toBeNull();
    expect(restorePosition("not json", VP, 36, 36)).toBeNull();
    expect(restorePosition(JSON.stringify({ nope: 1 }), VP, 36, 36)).toBeNull();
  });
});
