import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docToY, fileToDoc, parseSexpr } from "@pcbjam/shared";
import { thermalPins } from "@pcbjam/shared/sim-library";
import type { EditRequest } from "@/plugins/edits";
import { withSymbolField } from "./chip-firmware";
import { putOnWires, thermalPinLabel, thermalPinTip, wireNameProblem } from "./sim-thermal";

const TH1 = "11111111-1111-4111-8111-111111111111";
const M1 = "22222222-2222-4222-8222-222222222222";
const symbol = (uuid: string, ref: string, extra = ""): string => `(symbol (lib_id "Device:Thermistor_NTC") (at 81.28 63.5 0) (unit 1)
  (uuid "${uuid}")
  (property "Reference" "${ref}" (at 66.04 33.02 0) (effects (font (size 1.27 1.27))))
  (property "Value" "10k" (at 66.04 35.56 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27))))${extra}
  (pin "1" (uuid "${uuid.replace(/^.{8}/, "aaaaaaaa")}"))
  (instances (project "box" (path "/9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a" (reference "${ref}") (unit 1)))))`;
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0")
  (uuid "9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a") (paper "A4")
  (lib_symbols)
  ${symbol(TH1, "TH1")}
  ${symbol(M1, "M1", `\n  (property "PCBJam.SimThermal" "ATTIC ROOF" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27))))`)}
  (sheet_instances (path "/" (page "1")))
)`;
const sheetDoc = (): Y.Doc => {
  const doc = new Y.Doc();
  docToY(fileToDoc(SHEET), doc);
  return doc;
};
/** The value of a symbol's field, read back from its text. */
const field = (text: string, name: string): string | undefined => {
  const node = parseSexpr(text)[0] as unknown[];
  const hit = node.find((c) => Array.isArray(c) && c[0] === "property" && c[1] === `"${name}"`) as string[] | undefined;
  return hit?.[2]?.slice(1, -1);
};

describe("a wire's name", () => {
  it("is the text of a label, without a blank; none is no wire", () => {
    for (const ok of ["", "  ", "BOX", "Box-1", "oven_2", "7", "/Heat/BOX", "T(case)"]) expect(wireNameProblem(ok)).toBeNull();
    for (const bad of ["my box", "x".repeat(65)]) expect(wireNameProblem(bad)).toContain("cannot be a wire's name");
  });
});

describe("the line of a part's thermal pins", () => {
  it("says what the part does on each wire", () => {
    const fan = thermalPins(["air"]);
    expect([0, 1].map((i) => thermalPinLabel(fan, i))).toEqual(["Air between", "and"]);
    expect(thermalPinLabel(thermalPins(["heat"]), 0)).toBe("Heats the wire");
    expect(thermalPinLabel(thermalPins(["temperature"]), 0)).toBe("Feels the wire");
    expect(thermalPinLabel(thermalPins(["heat", "temperature"]), 0)).toBe("Heats and feels the wire");
    expect(thermalPinTip("R1", thermalPins(["heat"])[0]!)).toContain("R1 gives its heat to this wire");
    expect(thermalPinTip("TH1", thermalPins(["temperature"])[0]!)).toContain("Empty: a slider sets its temperature.");
    expect(thermalPinTip("M1", fan[0]!)).toContain("from the warmer to the cooler");
  });
});

describe("withSymbolField", () => {
  it("changes a field the symbol has, and gives a symbol without it one that is not drawn", () => {
    expect(field(withSymbolField(symbol(M1, "M1", `\n  (property "PCBJam.SimThermal" "ATTIC" (at 1 2 0) (hide yes))`), "PCBJam.SimThermal", (old) => `${old}-2`), "PCBJam.SimThermal")).toBe("ATTIC-2");
    const made = withSymbolField(symbol(TH1, "TH1"), "PCBJam.SimThermal", (old) => `BOX${old}`);
    expect(made).toContain(`(property "PCBJam.SimThermal" "BOX" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27)))) (pin "1"`);
    expect(field(made, "Value")).toBe("10k");
  });
});

describe("joining a part's thermal pins to wires", () => {
  const setup = (over: Partial<Parameters<typeof putOnWires>[0]> = {}) => {
    const edit = vi.fn(async (_request: EditRequest) => ({}));
    return { edit, args: { uuid: TH1, ref: "TH1", names: ["BOX"], doc: sheetDoc(), edit, ...over } };
  };
  const written = (edit: ReturnType<typeof setup>["edit"]): { label: string; value: string | undefined } => {
    const request = edit.mock.calls[0]![0];
    return { label: request.label ?? "", value: field(request.upsert[0]!.sexpr, "PCBJam.SimThermal") };
  };

  it("writes the names onto the symbol as one edit", async () => {
    const { edit, args } = setup({ names: [" BOX "] });
    expect(await putOnWires(args)).toEqual(["BOX"]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(written(edit)).toEqual({ label: "TH1 on the heat wire BOX", value: "BOX" });
    expect(edit.mock.calls[0]![0].remove).toEqual([]);
  });

  it("writes two names for a part with two thermal pins, and leaves an empty one out", async () => {
    const two = setup({ uuid: M1, ref: "M1", names: ["BOX", "OUTSIDE"] });
    expect(await putOnWires(two.args)).toEqual(["BOX", "OUTSIDE"]);
    expect(written(two.edit)).toEqual({ label: "M1 on the heat wires BOX and OUTSIDE", value: "BOX OUTSIDE" });
    const one = setup({ uuid: M1, ref: "M1", names: ["", "OUTSIDE"] });
    expect(await putOnWires(one.args)).toEqual(["OUTSIDE"]);
    expect(written(one.edit).value).toBe("OUTSIDE");
  });

  it("takes the part off its wires with no names", async () => {
    const { edit, args } = setup({ uuid: M1, ref: "M1", names: ["", " "] });
    expect(await putOnWires(args)).toEqual([]);
    expect(written(edit)).toEqual({ label: "M1 off its heat wires", value: "" });
  });

  it("changes nothing when a name cannot be one, or the symbol cannot be changed", async () => {
    const bad = setup({ names: ["my box"] });
    await expect(putOnWires(bad.args)).rejects.toThrow(`"my box" cannot be a wire's name`);
    expect(bad.edit).not.toHaveBeenCalled();
    const none = setup({ doc: null });
    await expect(putOnWires(none.args)).rejects.toThrow("This session cannot change the schematic from the list");
    const other = setup({ uuid: "33333333-3333-4333-8333-333333333333", ref: "R9" });
    await expect(putOnWires(other.args)).rejects.toThrow("R9 is not on the sheet that is shown");
    expect(other.edit).not.toHaveBeenCalled();
  });
});
