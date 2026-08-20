import { describe, expect, it } from "vitest";
import { fileToDoc, type KicadItem } from "@pcbjam/shared";
import { netNameResolver, summarizeItem, unq } from "./item-summary";

/** Build a doc from board text and summarize the item of the given type. */
function summarizeFromBoard(text: string, type: string) {
  const doc = fileToDoc(text);
  const entry = Object.entries(doc.items).find(([, it]) => it.type === type);
  if (!entry) throw new Error(`no ${type} item in fixture`);
  const [uuid, item] = entry;
  return summarizeItem({
    uuid,
    item,
    itemOf: (u) => doc.items[u],
    netName: netNameResolver(doc.layout),
  });
}

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.6))
  (net 0 "")
  (net 1 "GND")
  (net 2 "/CLK")
  (footprint "Resistor_SMD:R_0402"
    (layer "F.Cu")
    (uuid "aaaaaaaa-0000-0000-0000-000000000001")
    (at 149.5 105.25 90)
    (property "Reference" "R5" (at 0 -1.17 90) (layer "F.SilkS")
      (uuid "aaaaaaaa-0000-0000-0000-000000000002"))
    (property "Value" "10k" (at 0 1.17 90) (layer "F.Fab")
      (uuid "aaaaaaaa-0000-0000-0000-000000000003"))
    (property "Datasheet" "https://example.com/r.pdf" (at 0 0 0) (layer "F.Fab") hide
      (uuid "aaaaaaaa-0000-0000-0000-000000000004"))
    (property "ki_description" "internal" (at 0 0 0) (layer "F.Fab") hide
      (uuid "aaaaaaaa-0000-0000-0000-000000000007"))
    (attr smd)
    (pad "1" smd roundrect (at -0.51 0 90) (size 0.54 0.64) (layers "F.Cu" "F.Paste" "F.Mask")
      (net 1 "GND") (uuid "aaaaaaaa-0000-0000-0000-000000000005"))
    (pad "2" smd roundrect (at 0.51 0 90) (size 0.54 0.64) (layers "F.Cu" "F.Paste" "F.Mask")
      (net 2 "/CLK") (uuid "aaaaaaaa-0000-0000-0000-000000000006")))
  (segment (start 100 50) (end 103 54) (width 0.250000) (layer "F.Cu") (net 2)
    (uuid "bbbbbbbb-0000-0000-0000-000000000001"))
  (via (at 103 54) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1)
    (uuid "bbbbbbbb-0000-0000-0000-000000000002"))
)`;

const SCHEMATIC = `(kicad_sch (version 20231120) (generator "eeschema")
  (symbol (lib_id "Device:C") (at 120.65 73.66 0) (unit 1)
    (uuid "cccccccc-0000-0000-0000-000000000001")
    (property "Reference" "C3" (at 124 72 0))
    (property "Value" "100n" (at 124 75 0))
    (property "Footprint" "Capacitor_SMD:C_0402" (at 120 73 0))
    (pin "1" (uuid "cccccccc-0000-0000-0000-000000000002"))
    (pin "2" (uuid "cccccccc-0000-0000-0000-000000000003")))
  (label "CLK" (at 100 50 0) (uuid "dddddddd-0000-0000-0000-000000000001"))
)`;

describe("unq", () => {
  it("strips kept quotes and unescapes", () => {
    expect(unq('"GND"')).toBe("GND");
    expect(unq('"a \\"b\\" \\\\c"')).toBe('a "b" \\c');
    expect(unq("bare")).toBe("bare");
    expect(unq(undefined)).toBe("");
  });
});

describe("summarizeItem (viewer-panels inspector rows)", () => {
  it("footprint: title from Reference/Value, lib id, position, pads + nets", () => {
    const s = summarizeFromBoard(BOARD, "footprint");
    expect(s.title).toBe("R5 · 10k");
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r.value]));
    expect(byLabel["Footprint"]).toBe("Resistor_SMD:R_0402");
    expect(byLabel["Position"]).toBe("149.5, 105.25 mm");
    expect(byLabel["Rotation"]).toBe("90°");
    expect(byLabel["Layer"]).toBe("F.Cu");
    expect(byLabel["Datasheet"]).toBe("https://example.com/r.pdf");
    expect(byLabel["Pads"]).toBe("2");
    expect(byLabel["Nets"]).toBe("GND, /CLK");
    // Internal ki_* properties never render.
    expect(s.rows.some((r) => r.label === "ki_description")).toBe(false);
  });

  it("segment: endpoints, computed length, width, layer, net name via layout", () => {
    const s = summarizeFromBoard(BOARD, "segment");
    expect(s.title).toBe("Track");
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r.value]));
    expect(byLabel["Start"]).toBe("100, 50 mm");
    expect(byLabel["End"]).toBe("103, 54 mm");
    expect(byLabel["Length"]).toBe("5 mm"); // 3-4-5
    expect(byLabel["Width"]).toBe("0.25 mm");
    expect(byLabel["Net"]).toBe("/CLK"); // resolved from (net 2 "/CLK")
  });

  it("via: size/drill/layers and net resolved by number", () => {
    const s = summarizeFromBoard(BOARD, "via");
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r.value]));
    expect(s.title).toBe("Via");
    expect(byLabel["Size"]).toBe("0.8 mm");
    expect(byLabel["Drill"]).toBe("0.4 mm");
    expect(byLabel["Layers"]).toBe("F.Cu, B.Cu");
    expect(byLabel["Net"]).toBe("GND");
  });

  it("symbol: title from Reference/Value, lib id and Footprint property", () => {
    const s = summarizeFromBoard(SCHEMATIC, "symbol");
    expect(s.title).toBe("C3 · 100n");
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r.value]));
    expect(byLabel["Symbol"]).toBe("Device:C");
    expect(byLabel["Footprint"]).toBe("Capacitor_SMD:C_0402");
    expect(byLabel["Position"]).toBe("120.65, 73.66 mm");
  });

  it("label: quoted text in the title", () => {
    const s = summarizeFromBoard(SCHEMATIC, "label");
    expect(s.title).toBe('Label "CLK"');
  });

  it("unknown types fall back to a generic summary without throwing", () => {
    const item: KicadItem = {
      type: "mystery_thing",
      parent: null,
      body: [{ k: "at", v: [{ atom: "1" }, { atom: "2" }] }],
    };
    const s = summarizeItem({
      uuid: "u",
      item,
      itemOf: () => undefined,
      netName: () => undefined,
    });
    expect(s.title).toBe("Mystery thing");
    expect(s.rows[0]).toEqual({ label: "Position", value: "1, 2 mm" });
  });
});
