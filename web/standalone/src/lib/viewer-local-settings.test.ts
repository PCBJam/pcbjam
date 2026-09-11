import { describe, expect, it } from "vitest";
import { isLocalSettingsPath, viewerLocalSettings } from "./viewer-local-settings";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

describe("viewerLocalSettings", () => {
  it("drops the board and schematic selection filters, keeps everything else", () => {
    const prl = enc({
      board: { selection_filter: { footprints: false, tracks: false }, visible_layers: "ff" },
      schematic: { selection_filter: { wires: false } },
      project: { files: [] },
    });
    const out = dec(viewerLocalSettings(prl));
    expect(out.board.selection_filter).toBeUndefined();
    expect(out.schematic.selection_filter).toBeUndefined();
    expect(out.board.visible_layers).toBe("ff");
    expect(out.project.files).toEqual([]);
  });

  it("returns the same bytes when there is nothing to strip or the file is not JSON", () => {
    const plain = enc({ board: { visible_layers: "ff" } });
    expect(viewerLocalSettings(plain)).toBe(plain);
    const junk = new TextEncoder().encode("(kicad_prl");
    expect(viewerLocalSettings(junk)).toBe(junk);
  });

  it("recognizes the local settings extension", () => {
    expect(isLocalSettingsPath("PCB/Board.kicad_prl")).toBe(true);
    expect(isLocalSettingsPath("Board.kicad_pro")).toBe(false);
  });
});
