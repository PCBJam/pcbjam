import { describe, expect, it } from "vitest";
import { pickToolByText, worldRectToPage, wxRectToPage } from "./resolve";

const tool = (over: Partial<WxRenderedElementInfo>): WxRenderedElementInfo => ({
  id: "1:tool:0",
  parentId: "1",
  elementType: "tool",
  subType: "button",
  label: "",
  tooltip: "",
  screenX: 0,
  screenY: 0,
  width: 24,
  height: 24,
  centerX: 12,
  centerY: 12,
  enabled: true,
  index: 0,
  ...over,
});

const win = (visible: boolean) => ({ visible }) as WxElementInfo;

describe("wxRectToPage", () => {
  it("adds the #canvas origin", () => {
    expect(wxRectToPage({ screenX: 10, screenY: 20, width: 5, height: 6 }, { x: 100, y: 50 })).toEqual({
      x: 110,
      y: 70,
      width: 5,
      height: 6,
    });
  });
});

describe("pickToolByText", () => {
  const symbols = tool({ id: "1:tool:3", tooltip: "Place Symbols\t(A)\nAdd a symbol" });
  const power = tool({ id: "1:tool:4", tooltip: "Place Power Symbols\t(P)" });

  it("matches the first tooltip line, hotkey stripped, case-insensitive", () => {
    expect(pickToolByText([power, symbols], undefined, "place symbols")).toBe(symbols);
  });

  it("does not prefix-match a longer name", () => {
    expect(pickToolByText([power], undefined, "Place Symbols")).toBeNull();
  });

  it("falls back to the label, ignoring the [checked] marker", () => {
    const t = tool({ label: "Highlight [checked]" });
    expect(pickToolByText([t], undefined, "Highlight")).toBe(t);
  });

  it("skips tools on hidden toolbars and zero-size tools", () => {
    const hidden = tool({ id: "2:tool:0", parentId: "2", tooltip: "Place Symbols" });
    const empty = tool({ id: "1:tool:9", tooltip: "Place Symbols", width: 0 });
    const shown = tool({ id: "3:tool:0", parentId: "3", tooltip: "Place Symbols" });
    const windows = new Map([
      ["2", win(false)],
      ["3", win(true)],
    ]);
    expect(pickToolByText([hidden, empty, shown], windows, "Place Symbols")).toBe(shown);
  });
});

describe("worldRectToPage", () => {
  const vp = { cx: 0, cy: 0, scale: 1, w: 400, h: 300 };
  const canvas = { x: 0, y: 0, width: 400, height: 300 };

  it("maps a world rect and normalizes flipped corners", () => {
    expect(worldRectToPage(vp, canvas, { x: 10, y: 10, w: 20, h: 30 })).toEqual({
      x: 210,
      y: 160,
      width: 20,
      height: 30,
    });
  });

  it("is null when entirely off the canvas", () => {
    expect(worldRectToPage(vp, canvas, { x: 1000, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it("keeps partially visible rects", () => {
    expect(worldRectToPage(vp, canvas, { x: 190, y: 0, w: 50, h: 10 })).not.toBeNull();
  });
});
