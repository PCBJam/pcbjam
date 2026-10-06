import { describe, expect, it } from "vitest";
import { parseCrop, prepareSvg } from "../src/shot.ts";
import { classifyRef, modelRefs } from "../src/step.ts";

const PLOT =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<g/></svg>';

describe("shots", () => {
  it("crops to an area in page mm and keeps the mm sizing", () => {
    const out = prepareSvg(PLOT, { crop: { cx: 100, cy: 80, halfW: 20, halfH: 10 } });
    expect(out).toContain('viewBox="80 70 40 20"');
    expect(out).toContain('width="40mm"');
    expect(out).toContain('height="20mm"');
  });

  it("puts the background first, covering the (cropped) view", () => {
    const out = prepareSvg(PLOT, { crop: { cx: 10, cy: 10, halfW: 5, halfH: 5 }, background: "#001023" });
    const rect = out.indexOf('<rect x="5" y="5" width="10" height="10" fill="#001023"/>');
    expect(rect).toBeGreaterThan(out.indexOf("<svg"));
    expect(rect).toBeLessThan(out.indexOf("<g/>"));
  });

  it("parses --crop", () => {
    expect(parseCrop("1,2,3,4")).toEqual({ cx: 1, cy: 2, halfW: 3, halfH: 4 });
    expect(parseCrop(undefined)).toBeNull();
    expect(() => parseCrop("1,2,0,4")).toThrow(/--crop/);
  });
});

describe("STEP models", () => {
  it("finds every referenced model once", () => {
    const board = '(footprint "a" (model "${KICAD9_3DMODEL_DIR}/R.3dshapes/R.wrl")) (footprint "b" (model "${KICAD9_3DMODEL_DIR}/R.3dshapes/R.wrl") (model "${KIPRJMOD}/3d/x.step"))';
    expect(modelRefs(board)).toEqual(["${KICAD9_3DMODEL_DIR}/R.3dshapes/R.wrl", "${KIPRJMOD}/3d/x.step"]);
  });

  it("classifies library and project refs of any vintage", () => {
    expect(classifyRef("${KICAD6_3DMODEL_DIR}/C.3dshapes/C.wrl")).toEqual({ kind: "lib", rel: "C.3dshapes/C.wrl" });
    expect(classifyRef("$(KISYS3DMOD)/C.3dshapes/C.wrl")).toEqual({ kind: "lib", rel: "C.3dshapes/C.wrl" });
    expect(classifyRef("${KIPRJMOD}/3d_shapes/ecc83.wrl")).toEqual({ kind: "project", rel: "3d_shapes/ecc83.wrl" });
    expect(classifyRef("/abs/path.wrl")).toBeNull();
  });
});
