import { describe, expect, it } from "vitest";
import { DOCK_BELOW_WIDTH, TARGET_GAP, VIEW_MARGIN, chooseSide, layoutCard, spotlightPath } from "./geometry";

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

  it("centres an unanchored card", () => {
    const l = layoutCard({ target: null, card, view });
    expect(l).toMatchObject({ x: 480, y: 330, side: null, docked: false, arrow: null });
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
