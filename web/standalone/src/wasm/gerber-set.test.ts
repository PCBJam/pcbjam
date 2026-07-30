import { describe, expect, it } from "vitest";
import { gerberSiblings } from "./kicad-runner";

/**
 * Clicking one gerber on the project page opens the whole fabrication SET in
 * its folder (a single copper layer alone is a near-empty canvas). Drill files
 * come along — GerbView routes them to the Excellon loader itself.
 */
const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("gerberSiblings", () => {
  const SET = [
    "Production/gerbers/board-B_Cu.gbr",
    "Production/gerbers/board-Edge_Cuts.gbr",
    "Production/gerbers/board-F_Cu.gbr",
    "Production/gerbers/board-PTH.drl",
  ];

  it("collects every gerber and drill file in the clicked folder, sorted", () => {
    expect(
      gerberSiblings(files(...SET), "Production/gerbers/board-F_Cu.gbr"),
    ).toEqual(SET);
  });

  it("ignores other folders, nested subfolders, and non-gerber files", () => {
    const all = files(
      ...SET,
      "Production/gerbers/readme.md",
      "Production/gerbers/old/board-F_Cu.gbr",
      "Production/other/board-F_Cu.gbr",
      "KiCad Projects/board.kicad_pcb",
    );
    expect(gerberSiblings(all, "Production/gerbers/board-F_Cu.gbr")).toEqual(SET);
  });

  it("handles a gerber at the project root", () => {
    const all = files("a-F_Cu.gbr", "a-B_Cu.gbr", "sub/deep.gbr");
    expect(gerberSiblings(all, "a-F_Cu.gbr")).toEqual(["a-B_Cu.gbr", "a-F_Cu.gbr"]);
  });

  it("always includes the clicked file, even with an unrecognised extension", () => {
    const all = files("g/board-F_Cu.gbr", "g/weird.xyz");
    expect(gerberSiblings(all, "g/weird.xyz")).toEqual([
      "g/weird.xyz",
      "g/board-F_Cu.gbr",
    ]);
  });
});
