import { describe, expect, it } from "vitest";
import { parseCrop, parseMarks, pickSheetSvg, prepareSvg, rasterize } from "../src/shot.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRef, modelRefs, prepareBoard } from "../src/step.ts";

const PLOT =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072">\n<g/></svg>';

describe("a schematic shot's sheet", () => {
  const svgs = ["board.svg", "board-CH1.svg", "board-CH10.svg", "board-IO-Sub.svg", "board-Power.svg"];
  it("picks the sheet named whole, by name or path, and the root without one", () => {
    expect(pickSheetSvg(svgs, "board").pick).toBe("board.svg");
    expect(pickSheetSvg(svgs, "board", "CH1").pick).toBe("board-CH1.svg");
    expect(pickSheetSvg(svgs, "board", "ch10").pick).toBe("board-CH10.svg");
    expect(pickSheetSvg(svgs, "board", "/IO/Sub").pick).toBe("board-IO-Sub.svg");
    expect(pickSheetSvg(svgs, "board", "board").pick).toBe("board.svg");
  });
  it("takes part of a name only when one sheet has it, and says which ones when more do", () => {
    expect(pickSheetSvg(svgs, "board", "Pow").pick).toBe("board-Power.svg");
    expect(pickSheetSvg(svgs, "board", "CH")).toEqual({ ambiguous: ["board-CH1.svg", "board-CH10.svg"] });
    expect(pickSheetSvg(svgs, "board", "Audio")).toEqual({});
  });
});

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

  it("draws marks on top of the plot, and takes only numbers and short words as labels", () => {
    const marks = parseMarks('[{"x":10,"y":20,"w":7.62,"h":7.62,"label":"1"},{"x":30,"y":40,"w":5,"h":5,"label":"helper"}]');
    expect(marks).toEqual([
      { x: 10, y: 20, w: 7.62, h: 7.62, label: "1" },
      { x: 30, y: 40, w: 5, h: 5, label: "helper" },
    ]);
    const out = prepareSvg(PLOT, { background: "#F5F4EF", marks });
    expect(out.indexOf('<g id="pcbjam-marks">')).toBeGreaterThan(out.indexOf("<g/>"));
    expect(out.trimEnd().endsWith("</g>\n</svg>")).toBe(true);
    expect(out).toContain('<rect x="10" y="20" width="7.62" height="7.62" fill="none"');
    expect(out).toContain(">helper</text>");
    expect(parseMarks(undefined)).toEqual([]);
    expect(() => parseMarks('[{"x":1,"y":1,"w":1,"h":1,"label":"<script>"}]')).toThrow(/letters or digits/);
    expect(() => parseMarks('[{"x":1,"y":1,"w":0,"h":1,"label":"1"}]')).toThrow(/w, h above 0/);
    expect(() => parseMarks("not json")).toThrow(/JSON array/);
    expect(() => parseMarks(JSON.stringify(Array.from({ length: 51 }, () => ({ x: 1, y: 1, w: 1, h: 1, label: "1" }))))).toThrow(/at most 50/);
  });

  it("parses --crop", () => {
    expect(parseCrop("1,2,3,4")).toEqual({ cx: 1, cy: 2, halfW: 3, halfH: 4 });
    expect(parseCrop(undefined)).toBeNull();
    expect(() => parseCrop("1,2,0,4")).toThrow(/--crop/);
  });

  it("renders a small crop at the asked width without overshooting sharp's pixel limit", async () => {
    // 10 mm at 1600 px: a density linear in the width asked ~700 Mpx of
    // librsvg (the size grows with density²) and sharp refused it.
    const svg = prepareSvg(PLOT.replace("<g/>", '<circle cx="50" cy="50" r="2"/>'), { crop: { cx: 50, cy: 50, halfW: 5, halfH: 3.5 } });
    const png = await rasterize(svg, 1600);
    const sharp = (await import("sharp")).default;
    expect((await sharp(Buffer.from(png)).metadata()).width).toBe(1600);
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
    // A team library's path variable (PCBJam libs 0020).
    expect(classifyRef("${MYPARTS_DIR}/MyParts.3dshapes/a.step")).toEqual({ kind: "team", pathVar: "MYPARTS_DIR", rel: "MyParts.3dshapes/a.step" });
    expect(classifyRef("${MYPARTS_DIR}/../etc/passwd")).toBeNull();
  });

  it("stages team-library models from --models-dir/<PATHVAR>/ and rewrites their refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "kt-team-"));
    const models = join(root, "models");
    mkdirSync(join(models, "MYPARTS_DIR", "MyParts.3dshapes"), { recursive: true });
    writeFileSync(join(models, "MYPARTS_DIR", "MyParts.3dshapes", "a.step"), "ISO-10303-21;");
    const pcb = join(root, "board.kicad_pcb");
    writeFileSync(pcb, '(kicad_pcb (footprint "x" (model "${MYPARTS_DIR}/MyParts.3dshapes/a.wrl") (model "${MYPARTS_DIR}/MyParts.3dshapes/gone.step")))');
    const prepared = await prepareBoard(pcb, { "models-dir": models } as never);
    expect(prepared.models.map((m) => m.path)).toEqual(["teamlib/MYPARTS_DIR/MyParts.3dshapes/a.step"]);
    expect(prepared.board).toContain('(model "teamlib/MYPARTS_DIR/MyParts.3dshapes/a.wrl")');
    expect(prepared.missing).toEqual(["${MYPARTS_DIR}/MyParts.3dshapes/gone.step"]);
  });
});
