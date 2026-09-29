import { describe, expect, it } from "vitest";
import { normalizeUiLabel, parseTarget } from "./parse";

describe("parseTarget", () => {
  it("parses every namespace", () => {
    expect(parseTarget("tool:eeschema.InteractiveDrawing.placeSymbol")).toEqual({
      ns: "tool",
      action: "eeschema.InteractiveDrawing.placeSymbol",
    });
    expect(parseTarget("tooltip:Place Symbols")).toEqual({ ns: "tooltip", text: "Place Symbols" });
    expect(parseTarget("menu:Place")).toEqual({ ns: "menu", title: "Place" });
    expect(parseTarget("menu:Place/Add Symbol")).toEqual({ ns: "menu", title: "Place", item: "Add Symbol" });
    expect(parseTarget("panel:layers")).toEqual({ ns: "panel", id: "layers" });
    expect(parseTarget("area:1, -2.5, 30, 40")).toEqual({ ns: "area", x: 1, y: -2.5, w: 30, h: 40 });
    expect(parseTarget("point:10,20")).toEqual({ ns: "point", x: 10, y: 20 });
  });

  it("rejects malformed ids", () => {
    for (const bad of [
      "",
      "tool",
      "tool:",
      ":x",
      "nope:x",
      "menu:/Item",
      "menu:Place/",
      "area:1,2,3",
      "area:1,2,-3,4",
      "area:1,2,x,4",
      "point:1",
      "point:1,,",
    ]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
  });
});

describe("normalizeUiLabel", () => {
  it("reduces KiCad tooltips to the friendly name", () => {
    expect(normalizeUiLabel("Place Symbols\t(A)\nAdd a symbol")).toBe("place symbols");
    expect(normalizeUiLabel("Run ERC")).toBe("run erc");
  });

  it("strips menu decorations", () => {
    expect(normalizeUiLabel("&Place")).toBe("place");
    expect(normalizeUiLabel("   Add Symbol...\tA")).toBe("add symbol");
    expect(normalizeUiLabel("✓ Show Grid")).toBe("show grid");
    expect(normalizeUiLabel("   Export  ▸")).toBe("export");
    expect(normalizeUiLabel("Save &As…")).toBe("save as");
    expect(normalizeUiLabel("Fish && Chips")).toBe("fish & chips");
  });
});
