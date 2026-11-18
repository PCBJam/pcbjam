import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docToY, fileToDoc, parseSexpr } from "@pcbjam/shared";
import { settingAllows, type Match, type PartManifest, type SimLibrary } from "@pcbjam/shared/sim-library";
import type { EditRequest } from "@/plugins/edits";
import { chipFirmwares, firmwareName, firmwareProblem, giveFirmware, symbolText, withFirmware, type GiveFirmware } from "./chip-firmware";
import type { SaveOutcome } from "./save-flow";

// The header of a real ESP32-C3 image, and a file of words with a firmware's name.
const IMAGE = Uint8Array.from("e903022f10bf3c40ee0000000500000000ffff0000000001".match(/../g)!.map((h) => parseInt(h, 16)));
const WORDS = new TextEncoder().encode("just words, long enough to fill a header");

const FIRMWARE = { name: "firmware", label: "Firmware file", default: "firmware.bin", accept: "^[A-Za-z0-9_.+-]+\\.bin$" };

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const WIRE = "33333333-3333-4333-8333-333333333333";
const symbol = (uuid: string, ref: string, extra = ""): string => `(symbol (lib_id "RF_Module:ESP32-C3-WROOM-02") (at 81.28 63.5 0) (unit 1)
  (uuid "${uuid}")
  (property "Reference" "${ref}" (at 66.04 33.02 0) (effects (font (size 1.27 1.27))))
  (property "Value" "ESP32-C3-WROOM-02" (at 66.04 35.56 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "RF_Module:ESP32-C3-WROOM-02" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27))))${extra}
  (pin "1" (uuid "${uuid.replace(/^.{8}/, "aaaaaaaa")}"))
  (instances (project "two" (path "/9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a" (reference "${ref}") (unit 1)))))`;
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0")
  (uuid "9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a") (paper "A4")
  (lib_symbols)
  (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "${WIRE}"))
  ${symbol(U1, "U1")}
  ${symbol(U2, "U2", `\n  (property "PCBJam.SimSettings" "speed=2 firmware=old.bin" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27))))`)}
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

describe("firmwareName", () => {
  it("keeps a plain name and makes any other a plain token a setting can hold", () => {
    expect(firmwareName("blink.bin")).toBe("blink.bin");
    expect(firmwareName("sketch_nov18a.ino.merged.bin")).toBe("sketch_nov18a.ino.merged.bin");
    expect(firmwareName("My Sketch (final).ino.merged.BIN")).toBe("My-Sketch-final-.ino.merged.bin");
    expect(firmwareName("C:\\builds\\a.bin")).toBe("a.bin");
    expect(firmwareName("out/build/b.bin")).toBe("b.bin");
    expect(firmwareName("---.bin")).toBe("firmware.bin");
    // cut to what a setting holds, and not left ending in a dash
    expect(firmwareName("a-very-long-project-name-of-mine.ino.merged.bin")).toBe("a-very-long-project-name-of.bin");
  });

  it("gives a name the chip's setting takes", () => {
    for (const picked of ["blink.bin", "My Sketch (final).ino.merged.BIN", "---.bin", "ü.bin", `${"x".repeat(80)}.bin`, "a..b...bin"]) {
      const name = firmwareName(picked)!;
      expect(settingAllows(FIRMWARE, name), `${picked} -> ${name}`).toBe(true);
    }
  });

  it("is null for a file that is not named like a firmware image", () => {
    for (const picked of ["notes.txt", "firmware", ".bin", "", "firmware.bin.zip"]) expect(firmwareName(picked), picked).toBeNull();
  });
});

describe("firmwareProblem", () => {
  it("takes an ESP32 image and says why another file is not one", () => {
    expect(firmwareProblem(IMAGE.length, IMAGE)).toBeNull();
    expect(firmwareProblem(WORDS.length, WORDS)).toMatch(/does not start like an ESP32 firmware image/);
    expect(firmwareProblem(3, IMAGE.subarray(0, 3))).toMatch(/does not start like/);
    expect(firmwareProblem(16 * 1024 * 1024, IMAGE)).toBeNull();
    expect(firmwareProblem(16 * 1024 * 1024 + 1, IMAGE)).toMatch(/larger than 16 MB/);
  });

  it("takes an image built for the chip and says which chip another one was built for", () => {
    // IMAGE is an ESP32-C3's; the number of the chip is in bytes 12 and 13
    const builtFor = (low: number, high = 0) => Uint8Array.from(IMAGE, (b, i) => (i === 12 ? low : i === 13 ? high : b));
    expect(firmwareProblem(IMAGE.length, IMAGE, "esp32c3")).toBeNull();
    expect(firmwareProblem(IMAGE.length, IMAGE, "esp32s3")).toBe("it was built for the ESP32-C3, and this chip is an ESP32-S3");
    expect(firmwareProblem(IMAGE.length, builtFor(0x09), "esp32c3")).toBe("it was built for the ESP32-S3, and this chip is an ESP32-C3");
    expect(firmwareProblem(IMAGE.length, builtFor(0x09), "esp32s3")).toBeNull();
    expect(firmwareProblem(IMAGE.length, builtFor(0x34, 0x12), "esp32c3")).toBe("it was built for another chip (number 0x1234), and this chip is an ESP32-C3");
    // a part that does not say which chip it is, or names one this list does not have: its emulator decides
    expect(firmwareProblem(IMAGE.length, builtFor(0x09))).toBeNull();
    expect(firmwareProblem(IMAGE.length, builtFor(0x09), "some-other-chip")).toBeNull();
    // a file that is no image is said to be that, whatever the chip
    expect(firmwareProblem(WORDS.length, WORDS, "esp32c3")).toMatch(/does not start like/);
  });
});

describe("withFirmware", () => {
  it("sets the firmware in the settings field and keeps the other settings", () => {
    const before = symbol(U2, "U2", `\n  (property "PCBJam.SimSettings" "speed=2 firmware=old.bin" (at 1 2 0) (hide yes))`);
    const after = withFirmware(before, "blink.bin");
    expect(field(after, "PCBJam.SimSettings")).toBe("speed=2 firmware=blink.bin");
    // nothing else of the symbol changed
    expect(after.replace("firmware=blink.bin", "firmware=old.bin")).toBe(withFirmware(before, "old.bin"));
    expect(parseSexpr(after)).toHaveLength(1);
  });

  it("adds the field to a symbol that has none, after its fields and not drawn", () => {
    const after = withFirmware(symbol(U1, "U1"), "blink.bin");
    expect(field(after, "PCBJam.SimSettings")).toBe("firmware=blink.bin");
    // placed like the symbol's hidden field, right after the last field
    expect(after).toContain(`(property "PCBJam.SimSettings" "firmware=blink.bin" (at 81.28 63.5 0) (hide yes) (effects (font (size 1.27 1.27)))) (pin "1"`);
    expect(field(after, "Reference")).toBe("U1");
  });

  it("hides the new field when the symbol draws all of its own, and takes no number from them", () => {
    const shown = `(symbol (lib_id "X:Y") (at 1 2 0) (uuid "${U1}") (property "Reference" "U1" (id 0) (at 1 2 0)) (property "Value" "Y" (id 1) (at 3 4 0)))`;
    expect(withFirmware(shown, "a.bin")).toContain(`(property "PCBJam.SimSettings" "firmware=a.bin" (at 3 4 0) (hide yes)))`);
    const old = `(symbol (lib_id "X:Y") (uuid "${U1}") (property "Reference" "U1" (id 0) (at 1 2 0) (effects (font (size 1 1)) hide)))`;
    expect(withFirmware(old, "a.bin")).toContain(`(property "PCBJam.SimSettings" "firmware=a.bin" (at 1 2 0) (effects (font (size 1 1)) hide)))`);
  });

  it("keeps a field text with a quote or a backslash in it whole", () => {
    const odd = symbol(U1, "U1", `\n  (property "Note" "say \\"hi\\" \\\\ ok" (at 1 2 0) (hide yes))`);
    expect(withFirmware(odd, "a.bin")).toContain(`(property "Note" "say \\"hi\\" \\\\ ok" (at 1 2 0) (hide yes))`);
  });

  it("refuses what is not one symbol", () => {
    expect(() => withFirmware(`(wire (pts (xy 1 1) (xy 2 2)) (uuid "${WIRE}"))`, "a.bin")).toThrow("the item is not a symbol");
    expect(() => withFirmware(`(symbol (lib_id "X:Y") (uuid "${U1}"))`, "a.bin")).toThrow("the symbol has no fields");
  });
});

describe("symbolText", () => {
  it("gives a symbol of the shown sheet as text the edit path takes, and null for anything else", () => {
    const doc = sheetDoc();
    const text = symbolText(doc, U1)!;
    expect(text.startsWith("(symbol ")).toBe(true);
    expect(text).toContain(`(uuid "${U1}")`);
    expect(field(text, "Reference")).toBe("U1");
    expect(field(symbolText(doc, U2)!, "PCBJam.SimSettings")).toBe("speed=2 firmware=old.bin");
    expect(symbolText(doc, WIRE)).toBeNull();
    expect(symbolText(doc, "44444444-4444-4444-8444-444444444444")).toBeNull();
    expect(symbolText(new Y.Doc(), U1)).toBeNull();
  });
});

describe("giveFirmware", () => {
  const file = (name: string, bytes: Uint8Array = IMAGE): GiveFirmware["file"] => ({ name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
  const setup = (over: Partial<GiveFirmware> = {}) => {
    const save = vi.fn(async (_path: string, _bytes: Uint8Array): Promise<SaveOutcome> => ({ kind: "committed" }));
    const edit = vi.fn(async (_request: EditRequest): Promise<unknown> => ({ status: "applied" }));
    const options: GiveFirmware = { chip: { uuid: U1, ref: "U1", name: "firmware.bin" }, file: file("blink.bin"), doc: sheetDoc(), save, edit, ...over };
    return { save, edit, options };
  };

  it("stores the file under its own name and writes the name onto the chip", async () => {
    const { save, edit, options } = setup();
    await expect(giveFirmware(options)).resolves.toBe("blink.bin");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe("blink.bin");
    expect([...save.mock.calls[0]![1]]).toEqual([...IMAGE]);
    expect(edit).toHaveBeenCalledTimes(1);
    const request = edit.mock.calls[0]![0];
    expect(request.label).toBe("Firmware of U1");
    expect(request.remove).toEqual([]);
    expect(request.upsert).toHaveLength(1);
    expect(request.upsert[0]!.sexpr).toContain(`(uuid "${U1}")`);
    expect(field(request.upsert[0]!.sexpr, "PCBJam.SimSettings")).toBe("firmware=blink.bin");
  });

  it("keeps the chip's other settings", async () => {
    const { edit, options } = setup({ chip: { uuid: U2, ref: "U2", name: "old.bin" } });
    await giveFirmware(options);
    expect(field(edit.mock.calls[0]![0].upsert[0]!.sexpr, "PCBJam.SimSettings")).toBe("speed=2 firmware=blink.bin");
  });

  it("replaces the file and leaves the schematic alone when the chip already asks for that name", async () => {
    // a new build of the same firmware; no shared document is needed for it
    const { save, edit, options } = setup({ file: file("firmware.bin"), doc: null });
    await expect(giveFirmware(options)).resolves.toBe("firmware.bin");
    expect(save).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });

  it("stores nothing when the file is no firmware image", async () => {
    for (const [picked, said] of [
      [file("notes.txt"), `"notes.txt" is not a firmware image: its name has to end in .bin`],
      [file("words.bin", WORDS), /^"words\.bin" is not taken: it does not start like an ESP32 firmware image/],
      [{ ...file("huge.bin"), size: 16 * 1024 * 1024 + 1 }, /^"huge\.bin" is not taken: it is larger than 16 MB/],
    ] as const) {
      const { save, edit, options } = setup({ file: picked });
      await expect(giveFirmware(options)).rejects.toThrow(said);
      expect(save).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
    }
  });

  it("stores nothing when the image was built for another chip than the part is", async () => {
    const s3 = { uuid: U1, ref: "U1", name: "firmware.bin", chip: "esp32s3" };
    const refused = setup({ chip: s3 });
    await expect(giveFirmware(refused.options)).rejects.toThrow(`"blink.bin" is not taken: it was built for the ESP32-C3, and this chip is an ESP32-S3`);
    expect(refused.save).not.toHaveBeenCalled();
    expect(refused.edit).not.toHaveBeenCalled();

    const taken = setup({ chip: { ...s3, chip: "esp32c3" } });
    await expect(giveFirmware(taken.options)).resolves.toBe("blink.bin");
    expect(taken.save).toHaveBeenCalledTimes(1);
  });

  it("stores nothing when the chip is not on the shown sheet, or the session has no shared document", async () => {
    for (const [doc, said] of [
      [new Y.Doc(), "U1 is not on the sheet that is shown. Open its sheet, then choose the file"],
      [null, `Here U1 only takes a file named "firmware.bin": this session cannot change the schematic from the list`],
    ] as const) {
      const { save, edit, options } = setup({ doc });
      await expect(giveFirmware(options)).rejects.toThrow(said);
      expect(save).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
    }
  });

  it("says so when the project does not take the file, and leaves the chip alone", async () => {
    const { edit, options } = setup({ save: async () => ({ kind: "not-committed", message: "blink.bin stays in this tab: the project is read-only" }) });
    await expect(giveFirmware(options)).rejects.toThrow(`"blink.bin" was not stored in the project: blink.bin stays in this tab: the project is read-only`);
    expect(edit).not.toHaveBeenCalled();
    await expect(giveFirmware({ ...options, save: async () => ({ kind: "unknown" }) })).rejects.toThrow(/^"blink\.bin" was not stored in the project$/);
  });

  it("says that the file is stored when only the chip could not be changed", async () => {
    const { save, options } = setup({ edit: async () => { throw new Error("The editor is busy: finish the current tool first"); } });
    await expect(giveFirmware(options)).rejects.toThrow(
      `"blink.bin" is in the project, but U1 could not be changed: The editor is busy: finish the current tool first. Choose the file again to try once more`,
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("chipFirmwares", () => {
  const manifest = { settings: [FIRMWARE] } as unknown as PartManifest;
  const library = {
    part: (id: string) => (id === "chip" ? { emulator: "esp-emu" } : id === "led" ? {} : undefined),
    text: vi.fn(async (_id: string, _file: string) => JSON.stringify(manifest)),
  } as unknown as SimLibrary;
  const sym = (uuid: string, ref: string, fields: Record<string, string> = {}) =>
    ({ uuid, ref, value: "X", sheet: "/", sheetPath: "/", libId: "L:X", fields, pins: {} }) as never;
  const matched = (uuid: string, ref: string, partId: string): Match => ({ status: "matched", uuid, ref, partId } as unknown as Match);

  it("says which chip a part is when its description does", async () => {
    const esp = { settings: [FIRMWARE], digital: { kind: "emulator", emulator: "esp-emu", chip: "esp32c3" } };
    const wasm = { settings: [FIRMWARE], digital: { kind: "part-wasm", file: "part.wasm" } };
    for (const [described, chip] of [[esp, "esp32c3"], [wasm, undefined]] as const) {
      const chips = await chipFirmwares({
        library: { ...library, text: async () => JSON.stringify(described) } as unknown as SimLibrary,
        symbols: [sym(U1, "U1")],
        matches: [matched(U1, "U1", "chip")],
      });
      expect(chips.get(U1)?.chip).toBe(chip);
    }
  });

  it("lists the chips with the file each asks for", async () => {
    const chips = await chipFirmwares({
      library,
      symbols: [sym(U1, "U1"), sym(U2, "U2", { "PCBJam.SimSettings": "firmware=blink.bin" }), sym(WIRE, "D1"), sym("x", "R1")],
      matches: [matched(U1, "U1", "chip"), matched(U2, "U2", "chip"), matched(WIRE, "D1", "led"), { status: "none", uuid: "x", ref: "R1" } as unknown as Match],
    });
    expect([...chips.values()]).toEqual([
      { uuid: U1, ref: "U1", name: "firmware.bin" },
      { uuid: U2, ref: "U2", name: "blink.bin" },
    ]);
    // the part's description is asked for the chips only
    expect(library.text).toHaveBeenCalledTimes(2);
    expect(library.text).toHaveBeenCalledWith("chip", "part.json");
  });
});
