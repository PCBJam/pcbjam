import { describe, expect, it } from "vitest";
import {
  applyEnvelope,
  buildFootprintImport,
  buildInteractiveImport,
  buildSymbolImport,
  hasInteractivePlacement,
  kindForFile,
  placementAtCssPx,
  placementMm,
} from "./import-item";

const SYM_LIB = `(kicad_symbol_lib
  (version 20250925)
  (generator "kicad_symbol_editor")
  (symbol "R"
    (pin_numbers (hide yes))
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at -1.778 0 90) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "~" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "") (number "2"))
    )
  )
  (symbol "R_Small" (extends "R") (property "Value" "R_Small" (at 0 0 0)))
)`;

const FP = `(footprint "R_0603_1608Metric"
	(version 20251028)
	(generator "kicad-footprint-generator")
	(layer "F.Cu")
	(descr "0603")
	(property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (effects (font (size 1 1))))
	(attr smd)
	(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask"))
)`;

describe("kindForFile", () => {
  it("maps extensions", () => {
    expect(kindForFile("Device.kicad_sym")).toBe("symbol");
    expect(kindForFile("R_0603.KICAD_MOD")).toBe("footprint");
    expect(kindForFile("board.kicad_pcb")).toBeNull();
  });
});

describe("buildSymbolImport", () => {
  it("emits a lib_symbols prelude keyed by the full lib id and an unannotated instance", () => {
    const r = buildSymbolImport(SYM_LIB, "R", "MyLib", 50.8, 63.5, "11111111-2222-3333-4444-555555555555");
    expect(r.libId).toBe("MyLib:R");
    expect(r.reference).toBe("R?");
    expect(r.sexpr).toMatch(/^\(lib_symbols \(symbol "MyLib:R"/);
    // Sub-units keep their short names.
    expect(r.sexpr).toContain('(symbol "R_1_1"');
    expect(r.sexpr).toContain('(lib_id "MyLib:R") (at 50.8 63.5 0) (unit 1)');
    expect(r.sexpr).toContain('(uuid "11111111-2222-3333-4444-555555555555")');
    expect(r.sexpr).toContain('(property "Reference" "R?"');
    expect(r.sexpr).toContain('(property "Value" "R"');
    expect(r.sexpr).toContain('(property "Datasheet" "~"');
    // No lib-file header leaks into the schematic blob.
    expect(r.sexpr).not.toContain("kicad_symbol_lib");
  });

  it("defaults to the first symbol and resolves extends", () => {
    const r = buildSymbolImport(SYM_LIB, undefined, "MyLib", 0, 0);
    expect(r.libId).toBe("MyLib:R");
    const d = buildSymbolImport(SYM_LIB, "R_Small", "MyLib", 0, 0);
    expect(d.libId).toBe("MyLib:R_Small");
    expect(d.sexpr).toContain('(symbol "R_1_1"'); // inherited units flattened in
    expect(d.sexpr).not.toContain("(extends");
  });

  it("rejects unknown symbols", () => {
    expect(() => buildSymbolImport(SYM_LIB, "Nope", "L", 0, 0)).toThrow(/not found/);
  });
});

describe("buildFootprintImport", () => {
  it("adds the position after the layer header and keeps the body", () => {
    const r = buildFootprintImport(FP, 120.5, 80);
    expect(r.name).toBe("R_0603_1608Metric");
    expect(r.sexpr).toMatch(/\(layer "F\.Cu"\)\n\t\(at 120\.5 80\)/);
    expect(r.sexpr).toContain('(pad "1" smd roundrect (at -0.825 0)'); // nested at untouched
    expect(r.sexpr.match(/\(at 120\.5 80\)/g)).toHaveLength(1);
  });

  it("replaces an existing top-level at and caps the version", () => {
    const withAt = FP.replace('(layer "F.Cu")', '(layer "F.Cu")\n\t(at 1 2 90)').replace(
      "20251028",
      "20991231",
    );
    const r = buildFootprintImport(withAt, 3, 4);
    expect(r.sexpr).not.toContain("(at 1 2 90)");
    expect(r.sexpr).toContain("(at 3 4)");
    expect(r.sexpr).toContain("(version 20251028)");
  });

  it("rejects non-footprint text", () => {
    expect(() => buildFootprintImport("(kicad_pcb)", 0, 0)).toThrow(/footprint/);
  });
});

describe("placementMm", () => {
  it("converts the viewport centre from IU and snaps to the grid", () => {
    const mod = {
      kicadCollabApplyItems: () => undefined,
      kicadCollabGetViewport: () => JSON.stringify({ cx: 1001000, cy: 500000, scale: 1, w: 1, h: 1 }),
    };
    expect(placementMm(mod, "symbol")).toEqual({ x: 100.33, y: 49.53 });
    expect(placementMm(mod, "footprint")).toEqual({ x: 1, y: 0.5 });
  });
  it("falls back without a viewport probe", () => {
    expect(placementMm({ kicadCollabApplyItems: () => undefined }, "symbol")).toEqual({ x: 100, y: 100 });
  });
});

describe("placementAtCssPx", () => {
  // 1000×800 canvas px shown at 500×400 CSS px (HiDPI 2×), centred on world
  // (1e6, 5e5) IU at 0.001 px/IU — 100 mm, 50 mm on a schematic (IU = 0.1 µm).
  const vp = { cx: 1_000_000, cy: 500_000, scale: 0.001, w: 1000, h: 800 };
  const rect = { x: 200, y: 100, width: 500, height: 400 };

  it("maps the rect centre to the viewport centre", () => {
    expect(placementAtCssPx(vp, rect, { x: 450, y: 300 }, "symbol")).toEqual({ x: 100.33, y: 49.53 });
  });

  it("scales CSS px by the HiDPI ratio before the viewport transform", () => {
    // +50 CSS px right = +100 canvas px = +100000 IU = +10 mm → 110 mm, snapped to 1.27 grid.
    const p = placementAtCssPx(vp, rect, { x: 500, y: 300 }, "symbol");
    expect(p.x).toBeCloseTo(110.49, 2);
    // On a board the IU is nm, so the same world point is 1.1 mm, 0.5 mm (0.5 mm grid).
    const f = placementAtCssPx(vp, rect, { x: 500, y: 300 }, "footprint");
    expect(f).toEqual({ x: 1, y: 0.5 });
  });
});

describe("applyEnvelope", () => {
  it("wraps one added blob", () => {
    expect(JSON.parse(applyEnvelope("(x)"))).toEqual({ added: [{ sexpr: "(x)" }], changed: [], removed: [] });
  });
});

describe("hasInteractivePlacement", () => {
  it("is true only when the editor exports kicadPlaceImportedItem", () => {
    expect(hasInteractivePlacement({ kicadCollabApplyItems: () => 0 })).toBe(false);
    expect(hasInteractivePlacement({ kicadCollabApplyItems: () => 0, kicadPlaceImportedItem: () => "{}" })).toBe(true);
    expect(hasInteractivePlacement(undefined)).toBe(false);
  });
});

describe("buildInteractiveImport", () => {
  it("builds the symbol blob with a placeholder position and labels it by lib id", () => {
    const r = buildInteractiveImport({ kind: "symbol", fileName: "MyLib.kicad_sym", text: SYM_LIB }, "R");
    expect(r.label).toBe("MyLib:R");
    expect(r.sexpr).toMatch(/^\(lib_symbols \(symbol "MyLib:R"/);
    expect(r.sexpr).toContain('(lib_id "MyLib:R") (at 0 0 0) (unit 1)');
    expect(r.sexpr).toContain('(property "Reference" "R?"');
  });

  it("builds the footprint blob with a placeholder position and labels it by name", () => {
    const r = buildInteractiveImport({ kind: "footprint", fileName: "R_0603_1608Metric.kicad_mod", text: FP }, undefined);
    expect(r.label).toBe("R_0603_1608Metric");
    expect(r.sexpr).toMatch(/^\s*\(footprint /);
    expect(r.sexpr).toContain("(at 0 0)");
  });
});
