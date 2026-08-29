import { describe, expect, it } from "vitest";
import { hasSheetsBridge, parseSheetsState } from "./SheetPanel";

/** Sheet navigator bridge parsing (sheet-panel) — the wire shape emitted by
 *  eeschema_embind.cpp's sheetsStateJson / kicadSheetsGetTree. */
describe("parseSheetsState", () => {
  it("parses the C++ wire shape, keeping row order (page-number sorted)", () => {
    const s = parseSheetsState(
      JSON.stringify({
        current: "/root",
        sheets: [
          { path: "/root", parent: "", name: "Arduino Leonardo", file: "/p/root.kicad_sch", page: "1", depth: 0 },
          { path: "/root/aaa", parent: "/root", name: "Headers", file: "/p/Headers.kicad_sch", page: "2", depth: 1 },
          { path: "/root/bbb", parent: "/root", name: "Power", file: "/p/Power.kicad_sch", page: "3", depth: 1 },
        ],
      }),
    );
    expect(s?.current).toBe("/root");
    expect(s?.sheets.map((r) => r.name)).toEqual(["Arduino Leonardo", "Headers", "Power"]);
    expect(s?.sheets[1]).toMatchObject({ parent: "/root", depth: 1, page: "2" });
  });

  it("tolerates missing optional fields and drops rows without a path", () => {
    const s = parseSheetsState(
      JSON.stringify({ current: "/r", sheets: [{ path: "/r" }, { name: "no path" }, null] }),
    );
    expect(s?.sheets).toEqual([{ path: "/r", parent: "", name: "", file: "", page: "", depth: 0 }]);
  });

  it("returns null for garbage / an empty bridge answer", () => {
    expect(parseSheetsState("")).toBeNull();
    expect(parseSheetsState("null")).toBeNull();
    expect(parseSheetsState('{"sheets":[]}')).toBeNull();
    expect(parseSheetsState("{not json")).toBeNull();
  });
});

describe("hasSheetsBridge", () => {
  it("needs both exports (older bundles / non-eeschema frames have neither)", () => {
    expect(hasSheetsBridge({ kicadSheetsGetTree: () => "", kicadSheetsEnter: () => true })).toBe(true);
    expect(hasSheetsBridge({ kicadSheetsGetTree: () => "" })).toBe(false);
    expect(hasSheetsBridge(undefined)).toBe(false);
  });
});
