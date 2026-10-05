import { describe, expect, it } from "vitest";
import { DOCK_BELOW_WIDTH, TARGET_GAP, UNANCHORED_BOTTOM, VIEW_MARGIN, chooseSide, layoutCard, overlapArea, placeMoved, spotlightPath } from "./geometry";

const view = { w: 1280, h: 800 };
const card = { w: 320, h: 140 };

describe("chooseSide", () => {
  it("honours the requested side when it fits", () => {
    expect(chooseSide("right", { x: 100, y: 300, width: 24, height: 24 }, card, view)).toBe("right");
  });

  it("falls back when the requested side does not fit", () => {
    // Top toolbar button: no room above.
    expect(chooseSide("top", { x: 600, y: 4, width: 24, height: 24 }, card, view)).toBe("bottom");
  });

  it("auto prefers bottom, then right", () => {
    expect(chooseSide("auto", { x: 600, y: 100, width: 24, height: 24 }, card, view)).toBe("bottom");
    // Right-hand toolbar near the bottom: no room below or right → top.
    expect(chooseSide("auto", { x: 1250, y: 700, width: 24, height: 24 }, card, view)).toBe("top");
  });

  it("picks the roomiest side when nothing fits", () => {
    const tiny = { w: 400, h: 300 };
    expect(chooseSide("auto", { x: 20, y: 20, width: 300, height: 200 }, card, tiny)).toBe("bottom");
  });
});

describe("layoutCard", () => {
  it("centres below a top-toolbar button with the arrow at the target", () => {
    const t = { x: 600, y: 4, width: 24, height: 24 };
    const l = layoutCard({ target: t, card, view });
    expect(l.side).toBe("bottom");
    expect(l.y).toBe(t.y + t.height + TARGET_GAP);
    expect(l.x).toBe(612 - 160);
    expect(l.arrow).toEqual({ x: 612, y: l.y });
  });

  it("clamps into the viewport and keeps the arrow on the target", () => {
    // Left-edge button: the centred card would stick out on the left.
    const t = { x: 2, y: 200, width: 24, height: 24 };
    const l = layoutCard({ target: t, card, view, placement: "bottom" });
    expect(l.x).toBe(VIEW_MARGIN);
    expect(l.arrow!.x).toBe(16 + VIEW_MARGIN); // clamped to the rounded-corner inset
  });

  it("puts the arrow on the facing edge for side placements", () => {
    const t = { x: 1240, y: 300, width: 24, height: 24 };
    const l = layoutCard({ target: t, card, view, placement: "left" });
    expect(l.side).toBe("left");
    expect(l.x + card.w).toBe(t.x - TARGET_GAP);
    expect(l.arrow).toEqual({ x: l.x + card.w, y: 312 });
  });

  it("puts an unanchored card bottom-centre, off the canvas middle", () => {
    const l = layoutCard({ target: null, card, view });
    expect(l).toMatchObject({ x: 480, y: 800 - 140 - UNANCHORED_BOTTOM, side: null, docked: false, arrow: null });
  });

  it("docks to the bottom on phone widths", () => {
    const phone = { w: DOCK_BELOW_WIDTH - 90, h: 800 };
    const l = layoutCard({ target: { x: 10, y: 10, width: 24, height: 24 }, card, view: phone });
    expect(l).toMatchObject({ docked: true, side: null, arrow: null });
    expect(l.y).toBe(800 - card.h - VIEW_MARGIN);
  });

  it("pins to the margin when the card is wider than the view", () => {
    const l = layoutCard({ target: null, card: { w: 900, h: 100 }, view: { w: 500, h: 400 } });
    expect(l.x).toBe(VIEW_MARGIN);
  });
});

describe("spotlightPath", () => {
  it("draws the viewport plus a rounded hole", () => {
    const d = spotlightPath({ w: 100, h: 50 }, { x: 10, y: 10, width: 20, height: 10 }, 4);
    expect(d.startsWith("M0 0H100V50H0Z")).toBe(true);
    expect(d).toContain("M14 10H26A4 4 0 0 1 30 14");
  });

  it("caps the radius at half the hole", () => {
    const d = spotlightPath({ w: 100, h: 50 }, { x: 0, y: 0, width: 6, height: 4 }, 8);
    expect(d).toContain("A2 2");
  });
});

describe("layoutCard with obstacles", () => {
  // A plugin panel docked top-right, under the right-hand toolbar's tool.
  const panel = { x: 900, y: 70, width: 360, height: 560 };
  const tool = { x: 1250, y: 130, width: 24, height: 24 };

  it("moves off the panel when another side is clear", () => {
    const plain = layoutCard({ target: tool, card, view });
    expect(overlapArea({ x: plain.x, y: plain.y, width: card.w, height: card.h }, panel)).toBeGreaterThan(0);
    const l = layoutCard({ target: tool, card, view, obstacles: [panel] });
    expect(overlapArea({ x: l.x, y: l.y, width: card.w, height: card.h }, panel)).toBe(0);
    // Pushed past the panel on the left, arrow on its right edge, aimed at the tool's row.
    expect(l).toMatchObject({ side: "left", x: panel.x - TARGET_GAP - card.w });
    expect(l.arrow).toEqual({ x: panel.x - TARGET_GAP, y: 142 });
  });

  it("a collapsed panel (header only) no longer pushes the card away", () => {
    const header = { x: 900, y: 70, width: 360, height: 40 };
    const l = layoutCard({ target: tool, card, view, obstacles: [header] });
    expect(l.side).toBe("bottom");
    expect(overlapArea({ x: l.x, y: l.y, width: card.w, height: card.h }, header)).toBe(0);
  });

  it("keeps the preferred side when it is already clear", () => {
    const t = { x: 300, y: 300, width: 24, height: 24 };
    expect(layoutCard({ target: t, card, view, obstacles: [panel] })).toEqual(layoutCard({ target: t, card, view }));
  });

  it("covers as little as possible when nothing is clear", () => {
    const everywhere = [{ x: 0, y: 0, width: 1280, height: 800 }];
    const l = layoutCard({ target: tool, card, view, obstacles: everywhere });
    expect(l.side).not.toBeNull(); // still anchored, just unavoidable
  });

  it("slides an unanchored card along the bottom away from a panel", () => {
    const bottomPanel = { x: 400, y: 500, width: 500, height: 300 };
    const l = layoutCard({ target: null, card, view, obstacles: [bottomPanel] });
    expect(overlapArea({ x: l.x, y: l.y, width: card.w, height: card.h }, bottomPanel)).toBe(0);
  });
});

describe("placeMoved", () => {
  it("keeps a dragged card where it was dropped, without an arrow", () => {
    expect(placeMoved({ x: 200, y: 150 }, card, view)).toEqual({ x: 200, y: 150, side: null, docked: false, arrow: null });
  });

  it("keeps the whole card on screen", () => {
    expect(placeMoved({ x: -40, y: 900 }, card, view)).toMatchObject({ x: VIEW_MARGIN, y: view.h - card.h - VIEW_MARGIN });
    expect(placeMoved({ x: 5000, y: -5 }, card, view)).toMatchObject({ x: view.w - card.w - VIEW_MARGIN, y: VIEW_MARGIN });
  });

  it("re-clamps after the view shrank", () => {
    const small = { w: 600, h: 400 };
    expect(placeMoved({ x: 900, y: 600 }, card, small)).toMatchObject({ x: small.w - card.w - VIEW_MARGIN, y: small.h - card.h - VIEW_MARGIN });
  });
});
