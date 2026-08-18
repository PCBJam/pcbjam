import { describe, expect, it } from "vitest";
import { resolveSheetHierarchy } from "./sheet-hierarchy";

const sheetRef = (file: string) =>
  `(sheet (at 10 10) (property "Sheetfile" "${file}") (property "Sheetname" "x"))`;

function reader(files: Record<string, string>) {
  return (p: string): string | null => files[p] ?? null;
}

describe("resolveSheetHierarchy", () => {
  it("returns the root plus its transitive Sheetfile closure only", () => {
    // A repo-as-project: two boards' schematics side by side. Opening
    // Leonardo must warm ITS hierarchy, never the Mega's.
    const files = {
      "boards/leonardo/root.kicad_sch":
        sheetRef("cpu.kicad_sch") + sheetRef("power.kicad_sch"),
      "boards/leonardo/cpu.kicad_sch": "(kicad_sch)",
      "boards/leonardo/power.kicad_sch": sheetRef("regulator.kicad_sch"),
      "boards/leonardo/regulator.kicad_sch": "(kicad_sch)",
      "boards/mega/root.kicad_sch": sheetRef("cpu.kicad_sch"),
      "boards/mega/cpu.kicad_sch": "(kicad_sch)",
    };
    const all = Object.keys(files);
    expect(
      resolveSheetHierarchy("boards/leonardo/root.kicad_sch", reader(files), all),
    ).toEqual([
      "boards/leonardo/root.kicad_sch",
      "boards/leonardo/cpu.kicad_sch",
      "boards/leonardo/power.kicad_sch",
      "boards/leonardo/regulator.kicad_sch",
    ]);
  });

  it("resolves ../ and ${KIPRJMOD}/ references and ignores non-project ones", () => {
    const files = {
      "a/root.kicad_sch":
        sheetRef("../shared/common.kicad_sch") +
        sheetRef("${KIPRJMOD}/b/top.kicad_sch") +
        sheetRef("missing.kicad_sch"),
      "shared/common.kicad_sch": "(kicad_sch)",
      "b/top.kicad_sch": "(kicad_sch)",
    };
    const all = Object.keys(files);
    expect(resolveSheetHierarchy("a/root.kicad_sch", reader(files), all)).toEqual([
      "a/root.kicad_sch",
      "shared/common.kicad_sch",
      "b/top.kicad_sch",
    ]);
  });

  it("survives reference cycles and duplicate references", () => {
    const files = {
      "root.kicad_sch": sheetRef("child.kicad_sch") + sheetRef("child.kicad_sch"),
      "child.kicad_sch": sheetRef("root.kicad_sch"),
    };
    const all = Object.keys(files);
    expect(resolveSheetHierarchy("root.kicad_sch", reader(files), all)).toEqual([
      "root.kicad_sch",
      "child.kicad_sch",
    ]);
  });

  it("keeps an unreadable sheet warmed without expanding it", () => {
    // Staging failed for the child: still give it a room (erring toward
    // inclusion), but its own references are unknowable.
    const files = {
      "root.kicad_sch": sheetRef("child.kicad_sch"),
    };
    const all = ["root.kicad_sch", "child.kicad_sch", "orphan.kicad_sch"];
    expect(resolveSheetHierarchy("root.kicad_sch", reader(files), all)).toEqual([
      "root.kicad_sch",
      "child.kicad_sch",
    ]);
  });

  it("handles escaped quotes in the Sheetfile value", () => {
    const files = {
      'root.kicad_sch': '(property "Sheetfile" "my \\"quoted\\" sheet.kicad_sch")',
      'my "quoted" sheet.kicad_sch': "(kicad_sch)",
    };
    const all = Object.keys(files);
    expect(resolveSheetHierarchy("root.kicad_sch", reader(files), all)).toEqual([
      "root.kicad_sch",
      'my "quoted" sheet.kicad_sch',
    ]);
  });
});
