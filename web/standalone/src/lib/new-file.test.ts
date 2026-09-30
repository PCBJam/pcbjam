import { describe, expect, it } from "vitest";
import { newFileTemplate } from "./new-file";

describe("newFileTemplate", () => {
  const board = newFileTemplate("pcbnew", "00000000-0000-0000-0000-000000000000");
  const layers = [...board.matchAll(/\((\d+) "([^"]+)" (signal|user)/g)].map((m) => ({ id: Number(m[1]), name: m[2]! }));

  it("a new board enables KiCad's default layer set", () => {
    // Without F.Mask / F.Paste a board has no mask openings (fab outputs and the 3D view
    // cover every pad) and hides what footprints draw on Fab, courtyard and User layers.
    for (const name of ["F.Cu", "B.Cu", "F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Adhes",
      "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User",
      "Edge.Cuts", "Margin"]) {
      expect(layers.map((l) => l.name), name).toContain(name);
    }
  });

  it("uses KiCad 9 layer ids (the file's version is 20241229)", () => {
    const id = (name: string) => layers.find((l) => l.name === name)?.id;
    expect([id("F.Cu"), id("F.Mask"), id("B.Cu"), id("F.SilkS"), id("Edge.Cuts"), id("F.Fab")]).toEqual([0, 1, 2, 5, 25, 35]);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  it("is one balanced s-expression", () => {
    let depth = 0;
    for (const ch of board) {
      depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
