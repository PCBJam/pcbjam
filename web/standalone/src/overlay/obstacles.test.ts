import { describe, expect, it } from "vitest";
import { dialogRects } from "./obstacles";

const win = (over: Partial<WxElementInfo>): WxElementInfo => ({
  id: "1", typeName: "wxDialog", name: "", label: "", visible: true, enabled: true,
  screenX: 100, screenY: 50, centerX: 0, centerY: 0, width: 400, height: 300, ...over,
});

describe("dialogRects", () => {
  it("maps open dialogs to page px from their #canvas-relative registry rects", () => {
    const windows = new Map([["a", win({})], ["b", win({ screenX: 10, screenY: 20, width: 50, height: 60 })]]);
    expect(dialogRects(["a", "b"], windows, { x: 5, y: 7 })).toEqual([
      { x: 105, y: 57, width: 400, height: 300 },
      { x: 15, y: 27, width: 50, height: 60 },
    ]);
  });

  it("skips dialogs that are hidden, empty or not registered (yet)", () => {
    const windows = new Map([["hidden", win({ visible: false })], ["empty", win({ width: 0 })]]);
    expect(dialogRects(["hidden", "empty", "gone"], windows, { x: 0, y: 0 })).toEqual([]);
    expect(dialogRects(["a"], undefined, { x: 0, y: 0 })).toEqual([]);
  });
});
