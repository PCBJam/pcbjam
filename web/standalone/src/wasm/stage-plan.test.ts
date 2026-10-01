import { describe, expect, it } from "vitest";
import {
  expandRefs,
  initialStageSet,
  placeholderDirs,
  projectDirFor,
  referencesIn,
  resolveProjectRef,
  wantsScopedStaging,
} from "./stage-plan";

// A repository-shaped project: three designs under hw/, shared libraries,
// firmware and documents beside them.
const TREE = [
  "README.md",
  "firmware/main.c",
  "firmware/main.h",
  "docs/spec.pdf",
  "hw/b/b.kicad_pro",
  "hw/b/b.kicad_sch",
  "hw/c/c.kicad_pro",
  "hw/c/c.kicad_pcb",
  "hw/d/d.kicad_pro",
  "hw/d/d.kicad_prl",
  "hw/d/d.kicad_sch",
  "hw/d/d.kicad_pcb",
  "hw/d/d.kicad_dru",
  "hw/d/notes.txt",
  "hw/d/logo.png",
  "hw/d/sym-lib-table",
  "hw/d/fp-lib-table",
  "hw/d/sheets/power.kicad_sch",
  "hw/d/sheets/deep/adc.kicad_sch",
  "hw/d/scratch/old.kicad_sch",
  "hw/libs/shared.kicad_sym",
  "hw/libs/unused.kicad_sym",
  "hw/libs/shared.pretty/R_0603.kicad_mod",
  "hw/libs/shared.pretty/C_0603.kicad_mod",
  "hw/libs/3d/R_0603.step",
  "hw/libs/3d/R_0603.wrl",
  "hw/common/frame.kicad_wks",
  "hw/common/opamp.lib",
];

describe("projectDirFor", () => {
  it("is the folder of the design's project file", () => {
    expect(projectDirFor(TREE, "hw/d/d.kicad_sch")).toBe("hw/d");
  });
  it("walks up from a sub-sheet to the nearest project file", () => {
    expect(projectDirFor(TREE, "hw/d/sheets/deep/adc.kicad_sch")).toBe("hw/d");
  });
  it("is the target's own folder without any project file, the root without a target", () => {
    expect(projectDirFor(["gerbers/a.gbr", "x.txt"], "gerbers/a.gbr")).toBe("gerbers");
    expect(projectDirFor(TREE)).toBe("");
  });
});

describe("initialStageSet", () => {
  it("an editor gets every file of the project folder, whatever its type — and nothing else", () => {
    const { projectDir, paths } = initialStageSet({ paths: TREE, targetPath: "hw/d/d.kicad_sch", viewer: false });
    expect(projectDir).toBe("hw/d");
    expect([...paths].sort()).toEqual([
      "hw/d/d.kicad_dru",
      "hw/d/d.kicad_pcb",
      "hw/d/d.kicad_prl",
      "hw/d/d.kicad_pro",
      "hw/d/d.kicad_sch",
      "hw/d/fp-lib-table",
      "hw/d/logo.png",
      "hw/d/notes.txt",
      "hw/d/sym-lib-table",
    ]);
  });

  it("a viewer gets the project file, the target and its same-stem companions only", () => {
    const { paths } = initialStageSet({ paths: TREE, targetPath: "hw/d/d.kicad_sch", viewer: true });
    expect([...paths].sort()).toEqual([
      "hw/d/d.kicad_dru",
      "hw/d/d.kicad_pcb",
      "hw/d/d.kicad_prl",
      "hw/d/d.kicad_pro",
      "hw/d/d.kicad_sch",
    ]);
  });

  it("a sub-sheet opened directly still brings its project's folder", () => {
    const { paths } = initialStageSet({ paths: TREE, targetPath: "hw/d/sheets/power.kicad_sch", viewer: false });
    expect(paths.has("hw/d/sheets/power.kicad_sch")).toBe(true);
    expect(paths.has("hw/d/d.kicad_pro")).toBe(true);
    expect(paths.has("hw/d/sheets/deep/adc.kicad_sch")).toBe(false);
  });

  it("gerbview gets the folder beside the clicked layer", () => {
    const { paths } = initialStageSet({
      paths: ["fab/a.gtl", "fab/a.gbl", "fab/a.drl", "hw/x.kicad_pcb"],
      targetPath: "fab/a.gtl",
      viewer: true,
      gerbview: true,
    });
    expect([...paths].sort()).toEqual(["fab/a.drl", "fab/a.gbl", "fab/a.gtl"]);
  });
});

describe("resolveProjectRef", () => {
  it("resolves ${KIPRJMOD} and plain relative paths against the project folder", () => {
    expect(resolveProjectRef("hw/d", "${KIPRJMOD}/../libs/shared.kicad_sym")).toBe("hw/libs/shared.kicad_sym");
    expect(resolveProjectRef("hw/d", "local.kicad_sym")).toBe("hw/d/local.kicad_sym");
    expect(resolveProjectRef("", "${KIPRJMOD}/libs/a.pretty")).toBe("libs/a.pretty");
  });
  it("is null for absolute paths, other variables, URLs and escapes above the root", () => {
    expect(resolveProjectRef("hw/d", "/usr/share/kicad/x.kicad_sym")).toBeNull();
    expect(resolveProjectRef("hw/d", "${KICAD9_SYMBOL_DIR}/Device.kicad_sym")).toBeNull();
    expect(resolveProjectRef("hw/d", "https://example.test/x.step")).toBeNull();
    expect(resolveProjectRef("hw", "${KIPRJMOD}/../../x")).toBeNull();
  });
});

describe("referencesIn + expandRefs", () => {
  const ctx = { projectDir: "hw/d", viewer: false };
  const expand = (path: string, text: string, c = ctx) => expandRefs(referencesIn(path, text, c), TREE).sort();

  it("a schematic names its sub-sheets (relative to itself) and its simulation models", () => {
    const text =
      '(sheet (property "Sheetfile" "sheets/power.kicad_sch"))' +
      '(symbol (property "Sim.Library" "${KIPRJMOD}/../common/opamp.lib"))';
    expect(expand("hw/d/d.kicad_sch", text)).toEqual(["hw/common/opamp.lib", "hw/d/sheets/power.kicad_sch"]);
    expect(expand("hw/d/sheets/power.kicad_sch", '(property "Sheetfile" "deep/adc.kicad_sch")')).toEqual([
      "hw/d/sheets/deep/adc.kicad_sch",
    ]);
  });

  it("a project file names its drawing sheet", () => {
    const text = '{"schematic": {"page_layout_descr_file": "${KIPRJMOD}/../common/frame.kicad_wks"}}';
    expect(expand("hw/d/d.kicad_pro", text)).toEqual(["hw/common/frame.kicad_wks"]);
  });

  it("a lib table names a library file, or a whole library folder", () => {
    const sym = '(sym_lib_table (lib (name "shared")(type "KiCad")(uri "${KIPRJMOD}/../libs/shared.kicad_sym")(options "")))';
    expect(expand("hw/d/sym-lib-table", sym)).toEqual(["hw/libs/shared.kicad_sym"]);
    const fp = "(fp_lib_table (lib (name shared)(type KiCad)(uri ${KIPRJMOD}/../libs/shared.pretty)(options \"\")))";
    expect(expand("hw/d/fp-lib-table", fp)).toEqual([
      "hw/libs/shared.pretty/C_0603.kicad_mod",
      "hw/libs/shared.pretty/R_0603.kicad_mod",
    ]);
    // A registry library (another variable) is not a project file.
    expect(expand("hw/d/sym-lib-table", '(lib (name "Device")(uri "${KICAD9_SYMBOL_DIR}/Device.kicad_sym"))')).toEqual([]);
  });

  it("a board names the folder of each project-local 3D model", () => {
    const text = '(footprint "shared:R_0603" (model "${KIPRJMOD}/../libs/3d/R_0603.step"))';
    expect(expand("hw/d/d.kicad_pcb", text)).toEqual(["hw/libs/3d/R_0603.step", "hw/libs/3d/R_0603.wrl"]);
  });

  it("a viewer follows sub-sheets and the drawing sheet, nothing else", () => {
    const viewer = { projectDir: "hw/d", viewer: true };
    const sch = '(property "Sheetfile" "sheets/power.kicad_sch")(property "Sim.Library" "${KIPRJMOD}/../common/opamp.lib")';
    expect(expand("hw/d/d.kicad_sch", sch, viewer)).toEqual(["hw/d/sheets/power.kicad_sch"]);
    expect(expand("hw/d/d.kicad_pcb", '(model "${KIPRJMOD}/../libs/3d/R_0603.step")', viewer)).toEqual([]);
  });
});

describe("placeholderDirs", () => {
  it("creates every folder and owes each one its unstaged files", () => {
    const staged = new Set(["hw/d/d.kicad_sch", "hw/libs/shared.kicad_sym"]);
    const { dirs, missing } = placeholderDirs(TREE, staged);
    expect(dirs).toContain("hw/d/sheets/deep");
    expect(dirs).toContain("firmware");
    // A folder with one referenced file staged still owes the rest.
    expect([...missing.get("hw/libs")!]).toEqual(["hw/libs/unused.kicad_sym"]);
    expect([...missing.get("")!]).toEqual(["README.md"]);
    expect(missing.get("hw/d")!.has("hw/d/d.kicad_sch")).toBe(false);
  });
});

describe("wantsScopedStaging", () => {
  it("is on for big projects, with a flag either way", () => {
    expect(wantsScopedStaging("", 10)).toBe(false);
    expect(wantsScopedStaging("", 500)).toBe(true);
    expect(wantsScopedStaging("?stage=all", 500)).toBe(false);
    expect(wantsScopedStaging("?stage=scoped", 10)).toBe(true);
    // The deployment-wide switch, which a URL flag still overrides.
    expect(wantsScopedStaging("", 500, true)).toBe(false);
    expect(wantsScopedStaging("?stage=scoped", 500, true)).toBe(true);
  });
});
