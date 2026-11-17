import { describe, expect, it } from "vitest";
import { nameToolbar, snapMove, snapResize, SNAP_GAP, SNAP_MARGIN, type SnapTarget } from "./panel-snap";

const view = { w: 1200, h: 800 };
const sheets: SnapTarget = { rect: { x: 900, y: 100, w: 256, h: 200 }, name: "Sheets", kind: "panel" };
const canvas: SnapTarget = { rect: { x: 40, y: 60, w: 1100, h: 700 }, name: "the drawing area", kind: "area" };
const leftBar: SnapTarget = { rect: { x: 0, y: 60, w: 36, h: 700 }, name: "the left toolbar", kind: "bar" };

describe("snapMove", () => {
  it("leaves a panel out of reach where it was", () => {
    const s = snapMove({ x: 400, y: 300, w: 200, h: 150 }, [sheets], view);
    expect(s).toMatchObject({ x: 400, y: 300, guides: [], why: [] });
  });

  it("puts a panel flush against the window's edge, keeping the margin", () => {
    const s = snapMove({ x: 1200 - 200 - 15, y: 3, w: 200, h: 150 }, [], view);
    expect(s.x).toBe(1200 - SNAP_MARGIN - 200);
    expect(s.y).toBe(SNAP_MARGIN);
    expect(s.why).toEqual(["the window's right edge", "the window's top edge"]);
  });

  it("stacks a panel under another and lines up their edges", () => {
    // 5 px right of Sheets' left edge, 6 px below its bottom (+ the gap).
    const s = snapMove({ x: 905, y: 100 + 200 + SNAP_GAP + 6, w: 256, h: 120 }, [sheets], view);
    expect(s.x).toBe(900);
    expect(s.y).toBe(100 + 200 + SNAP_GAP);
    expect(s.why).toEqual(["left edge of Sheets", "beside Sheets"]);
    expect(s.guides).toHaveLength(2);
  });

  it("doesn't put a panel beside one it is nowhere near on the other axis", () => {
    const s = snapMove({ x: 900 - SNAP_GAP - 200 + 4, y: 600, w: 200, h: 100 }, [sheets], view);
    expect(s.why).not.toContain("beside Sheets");
  });

  it("keeps a panel just inside the drawing area and beside a toolbar", () => {
    const inside = snapMove({ x: 300, y: 60 + SNAP_GAP + 5, w: 200, h: 150 }, [canvas], view);
    expect(inside.y).toBe(60 + SNAP_GAP);
    expect(inside.why).toEqual(["inside the drawing area"]);
    const beside = snapMove({ x: 36 + SNAP_GAP + 7, y: 300, w: 200, h: 150 }, [leftBar], view);
    expect(beside.x).toBe(36 + SNAP_GAP);
    expect(beside.why).toEqual(["beside the left toolbar"]);
  });

  it("lands on the grid when nothing is in reach and the grid is on", () => {
    expect(snapMove({ x: 403, y: 309, w: 200, h: 150 }, [], view, { grid: true })).toMatchObject({ x: 400, y: 304 });
  });
});

describe("snapResize", () => {
  it("snaps the edges that move: the right one to a panel, the bottom to the window", () => {
    const s = snapResize({ x: 600, y: 100, w: 900 - SNAP_GAP - 600 - 5, h: 800 - SNAP_MARGIN - 100 - 9 }, "right", [sheets], view);
    expect(s.x).toBe(600);
    expect(s.x + s.w).toBe(900 - SNAP_GAP);
    expect(s.y + s.h).toBe(800 - SNAP_MARGIN);
  });

  it("from the left corner, moves the left edge and keeps the right one", () => {
    const s = snapResize({ x: 36 + SNAP_GAP + 6, y: 100, w: 300, h: 200 }, "left", [leftBar], view);
    expect(s.x).toBe(36 + SNAP_GAP);
    expect(s.x + s.w).toBe(36 + SNAP_GAP + 6 + 300);
  });
});

describe("nameToolbar", () => {
  const area = canvas.rect;
  it("names toolbars by where they sit against the drawing area", () => {
    expect(nameToolbar({ x: 0, y: 60, w: 36, h: 700 }, area)).toBe("the left toolbar");
    expect(nameToolbar({ x: 1150, y: 60, w: 36, h: 700 }, area)).toBe("the right toolbar");
    expect(nameToolbar({ x: 0, y: 20, w: 1200, h: 36 }, area)).toBe("the top toolbar");
  });
});
