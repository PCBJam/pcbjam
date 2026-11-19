import { describe, expect, it, vi } from "vitest";
import type { IndexEmulator, PartManifest, PlacedPart, PreparedRun } from "@pcbjam/shared/sim-library";
import { chipParts, FIRMWARE_SETTING, libraryScript, loaderScript, packPart, type ChipPartsOptions } from "./chip-parts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A package read back the way the engine's part loader reads it. */
function unpack(bytes: Uint8Array) {
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PJPK");
  const headLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen))) as {
    adapter: string; config: Record<string, unknown>; blobs: Record<string, [number, number]>;
  };
  const blobs = Object.fromEntries(Object.entries(head.blobs).map(([name, [at, len]]) => [name, bytes.subarray(8 + headLen + at, 8 + headLen + at + len)]));
  return { adapter: head.adapter, config: head.config, blobs };
}

// The shape of a loader as wasm-bindgen writes one for the web.
const LOADER = `let wasm;
export class WasmEmulator {
    constructor(chip) { this.chip = chip; }
}
function initSync(module) { return module; }
async function __wbg_init(module_or_path) {
    if (typeof module_or_path === 'undefined') module_or_path = new URL('esp_emu_bg.wasm', import.meta.url);
    return wasm;
}
export { initSync, __wbg_init as default };
`;

const EMULATOR: IndexEmulator = {
  id: "esp-emu", version: "1.0.0-rc2", title: "Espressif's ESP32 emulator", licence: "Apache-2.0", origin: "https://example.test/esp-emu",
  program: "esp_emu_bg.wasm", loader: "esp_emu.js", files: [],
};

const CHIP: PartManifest = {
  schema: 1, id: "esp32-c3-wroom-02", version: 1, title: "ESP32-C3-WROOM-02",
  fits: [{ symbol: "RF_Module:ESP32-C3-WROOM-02" }],
  pins: ["3V3", "VSS", "EN", "IO4", "IO5", "IO9"],
  analog: { file: "model.lib", subckt: "PJ_ESP32C3_WROOM02" },
  settings: [{ name: FIRMWARE_SETTING, default: "firmware.bin", accept: "^[A-Za-z0-9_.+-]+\\.bin$" }],
  digital: {
    kind: "emulator", emulator: "esp-emu", chip: "esp32c3", cores: 1, orderParam: "IRR",
    pads: { IO4: 4, IO5: 5, IO9: 9 }, enable: "EN",
    padRegisters: { base: 1610649604, count: 22, pullUpBit: 8, pullDownBit: 7 },
  },
};

const placed = (ref: string, connected: string[], firmware = "firmware.bin", from: "default" | "symbol" = "default"): PlacedPart => ({
  ref, uuid: `uuid-${ref}`, sheet: "/", partId: CHIP.id, version: 1, rule: 3, name: `X${ref}`,
  nodes: [], connected, number: 1,
  settings: { [FIRMWARE_SETTING]: { value: firmware, from } } as PlacedPart["settings"],
});

// The start of an ESP32-C3 image as a merged file has it (the bootloader's header), with a
// byte of its own at the end.
const esp = (tag: number, chip = 0x05): Uint8Array => {
  const bytes = new Uint8Array(40);
  bytes.set([0xe9, 3, 2, 0x2f]);
  bytes[12] = chip;
  bytes[39] = tag;
  return bytes;
};

// as the netlist step lists them: every placed chip with code of its own, numbered in order
const run = (chips: PlacedPart[], manifest: PartManifest = CHIP): Pick<PreparedRun, "codeParts" | "placed" | "parts"> => ({
  codeParts: chips.map((chip, i) => ({ partId: manifest.id, kind: "emulator" as const, name: `${manifest.id}_${i + 1}`, ref: chip.ref, logic: null })),
  placed: chips,
  parts: new Map([[manifest.id, { id: manifest.id, manifest, analog: "", logic: null }]]),
});

// avr8js as the library packs it: one script that defines one name. It has no program.
const AVR8JS = "// avr8js, packed for a test\nvar avr8js = (function () { return { CPU: function () {} }; })();\n";
const AVR: IndexEmulator = {
  id: "avr8js", version: "0.21.1", title: "avr8js", licence: "MIT", origin: "https://example.test/avr8js", loader: "avr8js.js", files: [],
};

// An Arduino board: the part is the board, its chip's pads are on the headers.
const UNO: PartManifest = {
  schema: 1, id: "arduino-uno-r3", version: 1, title: "Arduino Uno R3",
  fits: [{ symbol: "MCU_Module:Arduino_UNO_R3" }],
  pins: ["RESET", "P5V", "VSS", "VSS2", "D2", "D13", "A4", "SDA"],
  supplies: ["P5V"], powered: ["VSS"], joined: [["VSS", "VSS2"], ["A4", "SDA"]],
  analog: { file: "model.lib", subckt: "PJ_ARDUINO_UNO_R3" },
  settings: [{ name: FIRMWARE_SETTING, default: "firmware.hex", accept: "^[A-Za-z0-9_.+-]+\\.hex$" }],
  digital: { kind: "emulator", emulator: "avr8js", chip: "atmega328p", clock: 16000000, orderParam: "IRR", pads: { D2: 26, D13: 13, A4: 20 }, enable: "RESET", taps: ["A4", "AVCC"] },
};
// two bytes at address 0 and two at address 4
const HEX = ":020000000C945E\r\n:020004005C009E\r\n:00000001FF\r\n";

function library(emulators: IndexEmulator[] = [EMULATOR, AVR]) {
  const emulatorFile = vi.fn(async (_id: string, name: string) => (name === "esp_emu.js" ? utf8(LOADER) : name === "avr8js.js" ? utf8(AVR8JS) : new Uint8Array([0, 97, 115, 109])));
  return { emulator: (id: string) => emulators.find((e) => e.id === id), emulatorFile } satisfies ChipPartsOptions["library"];
}

describe("packPart", () => {
  it("writes the header and the files one after the other", () => {
    const got = unpack(packPart({ adapter: "esp-emu", config: { chip: "esp32c3" }, blobs: { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([9]) } }));
    expect(got.adapter).toBe("esp-emu");
    expect(got.config).toEqual({ chip: "esp32c3" });
    expect([...got.blobs.a!]).toEqual([1, 2, 3]);
    expect([...got.blobs.b!]).toEqual([9]);
  });
});

describe("loaderScript", () => {
  it("turns the emulator's module into a script that leaves its two names in one place", () => {
    const script = loaderScript(LOADER, "esp-emu@1.0.0-rc2");
    expect(script).not.toMatch(/^\s*(import|export)\s/m);
    expect(script).not.toContain("import.meta");
    const scope: { __pjGlue?: Record<string, { WasmEmulator: new (chip: string) => { chip: string }; initSync: (m: unknown) => unknown }> } = {};
    // run it the way a Worker would, with a global object of its own
    new Function("globalThis", script)(scope);
    const glue = scope.__pjGlue?.["esp-emu@1.0.0-rc2"];
    expect(new glue!.WasmEmulator("esp32c3").chip).toBe("esp32c3");
    expect(glue!.initSync(7)).toBe(7);
  });

  it("refuses a loader it does not know", () => {
    expect(() => loaderScript(`import x from "./y.js";\n${LOADER}`, "k")).toThrow("an import or an export that is not known");
    expect(() => loaderScript(`export function extra() {}\n${LOADER}`, "k")).toThrow("an import or an export that is not known");
    expect(() => loaderScript("function initSync() {}\n", "k")).toThrow("the emulator's loader has no WasmEmulator");
  });
});

describe("libraryScript", () => {
  it("leaves the one name an emulator's script defines in one place, and nothing else", () => {
    const script = libraryScript(AVR8JS, "avr8js@0.21.1", "avr8js");
    const scope: { __pjGlue?: Record<string, { CPU: unknown }>; avr8js?: unknown } = {};
    new Function("globalThis", script)(scope);
    expect(typeof scope.__pjGlue?.["avr8js@0.21.1"]?.CPU).toBe("function");
    expect(scope.avr8js).toBeUndefined();
  });

  it("refuses a script that does not define the name", () => {
    expect(() => libraryScript("var other = 1;\n", "k", "avr8js")).toThrow("the emulator's script does not define avr8js");
  });
});

describe("chipParts", () => {
  it("packs an Arduino board: the sketch as the program's bytes, no emulator program, the chip's clock", async () => {
    const lib = library();
    const readFile = vi.fn(async () => utf8(HEX));
    const scriptUrl = vi.fn((_text: string) => "blob:avr-1");
    // the sketch's wires: D13, and the pad A4 by its second pin (SDA); D2 has nothing on it
    const board: PlacedPart = { ...placed("A1", ["P5V", "VSS", "VSS2", "D13", "A4", "SDA"], "firmware.hex"), partId: UNO.id };
    const parts = await chipParts(run([board], UNO), { library: lib, readFile, scriptUrl });
    expect(parts.map((p) => p.name)).toEqual(["arduino-uno-r3_1"]);
    expect(readFile).toHaveBeenCalledWith("firmware.hex");
    const got = unpack(parts[0]!.bytes);
    expect(got.adapter).toBe("avr8js");
    expect(got.config).toEqual({
      chip: "atmega328p", cores: 1, clock: 16000000, pads: [26, 13, 20], enable: true,
      // what the sketch can measure, in the order of the model's voltage tap
      taps: ["A4", "AVCC"],
      wired: [13, 20], emulatorKey: "avr8js@0.21.1", glueUrl: "blob:avr-1",
    });
    // the program as it sits in the chip's memory, not the text of the file
    expect([...got.blobs["firmware.bin"]!]).toEqual([0x0c, 0x94, 0xff, 0xff, 0x5c, 0x00]);
    expect(Object.keys(got.blobs)).toEqual(["firmware.bin"]);
    expect(lib.emulatorFile.mock.calls.map((c) => c[1])).toEqual(["avr8js.js"]);
    expect(scriptUrl.mock.calls[0]?.[0]).toContain('["avr8js@0.21.1"] = avr8js;');
  });

  it("says why a sketch's file cannot run", async () => {
    const board: PlacedPart = { ...placed("A1", [], "firmware.hex"), partId: UNO.id };
    const opts = { library: library(), scriptUrl: () => "blob:x" };
    await expect(chipParts(run([board], UNO), { ...opts, readFile: async () => utf8("just words") }))
      .rejects.toThrow('A1: the firmware file "firmware.hex" cannot run: it is not an Intel HEX file (.hex)');
    await expect(chipParts(run([board], UNO), { ...opts, readFile: async () => utf8(HEX.replace("5E", "5F")) }))
      .rejects.toThrow('A1: the firmware file "firmware.hex" cannot run: a line of the HEX file is damaged (its checksum is wrong)');
    await expect(chipParts(run([board], UNO), { ...opts, readFile: async () => null }))
      .rejects.toThrow('A1 needs its firmware: the project has no file "firmware.hex"');
    // an emulator that should have a program and does not say which file it is
    const { program: _none, ...bare } = EMULATOR;
    await expect(chipParts(run([placed("U1", [])]), { ...opts, library: library([bare]), readFile: async () => esp(1) }))
      .rejects.toThrow('the emulator "esp-emu" of the library has no program');
  });

  it("packs the emulator, the firmware of the project and what the adapter must know", async () => {
    const lib = library();
    const readFile = vi.fn(async () => esp(2));
    const scriptUrl = vi.fn((_text: string) => "blob:loader-1");
    const parts = await chipParts(run([placed("U1", ["3V3", "VSS", "EN", "IO4", "IO9"])]), { library: lib, readFile, scriptUrl });
    expect(parts.map((p) => p.name)).toEqual(["esp32-c3-wroom-02_1"]);
    expect(readFile).toHaveBeenCalledWith("firmware.bin");
    const got = unpack(parts[0]!.bytes);
    expect(got.adapter).toBe("esp-emu");
    expect(got.config).toEqual({
      chip: "esp32c3", cores: 1, pads: [4, 5, 9], enable: true,
      iomux: { base: 1610649604, count: 22, pullUpBit: 8, pullDownBit: 7 },
      wired: [4, 9], emulatorKey: "esp-emu@1.0.0-rc2", glueUrl: "blob:loader-1",
    });
    expect([...got.blobs["firmware.bin"]!]).toEqual([...esp(2)]);
    expect([...got.blobs["emulator.wasm"]!]).toEqual([0, 97, 115, 109]);
    expect(lib.emulatorFile.mock.calls.map((c) => c[1]).sort()).toEqual(["esp_emu.js", "esp_emu_bg.wasm"]);
    expect(scriptUrl.mock.calls[0]?.[0]).toContain('["esp-emu@1.0.0-rc2"]');

    // the loader gets one address for the page's life
    const again = await chipParts(run([placed("U1", [])]), { library: lib, readFile, scriptUrl });
    expect(unpack(again[0]!.bytes).config.glueUrl).toBe("blob:loader-1");
    expect(scriptUrl).toHaveBeenCalledTimes(1);
  });

  it("gives every placed chip a package of its own, with the firmware its own setting names", async () => {
    const images: Record<string, Uint8Array> = { "blink.bin": esp(1), "motor.bin": esp(2) };
    const readFile = vi.fn(async (name: string) => images[name] ?? null);
    const lib = library();
    const parts = await chipParts(
      run([placed("U1", ["IO4"], "blink.bin", "symbol"), placed("U2", ["IO5"], "motor.bin", "symbol"), placed("U3", ["IO9"], "blink.bin", "symbol")]),
      { library: lib, readFile, scriptUrl: () => "blob:x" },
    );
    expect(parts.map((p) => p.name)).toEqual(["esp32-c3-wroom-02_1", "esp32-c3-wroom-02_2", "esp32-c3-wroom-02_3"]);
    const got = parts.map((p) => unpack(p.bytes));
    expect(got.map((g) => [...g.blobs["firmware.bin"]!])).toEqual([[...esp(1)], [...esp(2)], [...esp(1)]]);
    // a pad is wired when that chip has something on its pin
    expect(got.map((g) => g.config.wired)).toEqual([[4], [5], [9]]);
    // a file two chips name is read once, and so are the emulator's files
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(["blink.bin", "motor.bin"]);
    expect(lib.emulatorFile.mock.calls.map((c) => c[1]).sort()).toEqual(["esp_emu.js", "esp_emu_bg.wasm"]);
  });

  it("does not start a chip with a file it would not start from, and says which kind the file is", async () => {
    const one = run([placed("U1", [])]);
    const opts = { library: library(), scriptUrl: () => "blob:x" };
    // the program alone, as a build writes it next to the merged image: a chip crashes on it without end
    const alone = esp(1);
    alone.set([0x32, 0x54, 0xcd, 0xab], 32);
    await expect(chipParts(one, { ...opts, readFile: async () => alone })).rejects.toThrow(
      'U1: the firmware file "firmware.bin" cannot run: it holds the program alone, without the bootloader. The merged image is needed',
    );
    // built for another chip
    await expect(chipParts(one, { ...opts, readFile: async () => esp(1, 0x09) })).rejects.toThrow(
      'U1: the firmware file "firmware.bin" cannot run: it was built for the ESP32-S3, and this chip is an ESP32-C3. Choose the file on the chip\'s line',
    );
    // no image at all
    await expect(chipParts(one, { ...opts, readFile: async () => new Uint8Array(64) })).rejects.toThrow(
      'U1: the firmware file "firmware.bin" cannot run: it does not start like an ESP32 firmware image',
    );
  });

  it("does nothing for a run without chips", async () => {
    const readFile = vi.fn(async () => null);
    expect(await chipParts({ codeParts: [{ partId: "counter", kind: "part-wasm", name: "counter", logic: new Uint8Array(1) }], placed: [], parts: new Map() }, { library: library(), readFile })).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("says in a sentence why a chip cannot run", async () => {
    const lib = library();
    const one = run([placed("U1", [])]);
    const opts = { library: lib, scriptUrl: () => "blob:x" };
    // where a file is chosen is said once, at the end
    await expect(chipParts(one, { ...opts, readFile: async () => null }))
      .rejects.toThrow('U1 needs its firmware: the project has no file "firmware.bin". Choose the file on the chip\'s line in the Simulation parts list (Session menu)');
    await expect(chipParts(run([placed("U1", [], "")]), { ...opts, readFile: async () => null }))
      .rejects.toThrow("U1 needs its firmware: no file is chosen for it. Choose the file on the chip's line in the Simulation parts list (Session menu)");
    await expect(chipParts(one, { ...opts, readFile: async () => new Uint8Array(0) }))
      .rejects.toThrow('U1: the firmware file "firmware.bin" is empty');
    await expect(chipParts(one, opts)).rejects.toThrow("U1: a chip with firmware can only run in a project");
    // every chip that cannot run is named, not only the first
    await expect(chipParts(run([placed("U1", [], "a.bin"), placed("U2", [], "b.bin"), placed("U3", [], "c.bin")]), { ...opts, readFile: async (name) => (name === "b.bin" ? esp(1) : null) }))
      .rejects.toThrow('U1 needs its firmware: the project has no file "a.bin"; U3 needs its firmware: the project has no file "c.bin". Choose the file');
    await expect(chipParts(one, { ...opts, library: library([]), readFile: async () => new Uint8Array(1) }))
      .rejects.toThrow('U1: this page cannot run the chip (its emulator "esp-emu" is not known here)');
    const other: PartManifest = { ...CHIP, digital: { ...(CHIP.digital as object), emulator: "other-emu" } as PartManifest["digital"] };
    await expect(chipParts(run([placed("U1", [])], other), { ...opts, library: library([{ ...EMULATOR, id: "other-emu" }]), readFile: async () => new Uint8Array(1) }))
      .rejects.toThrow('its emulator "other-emu" is not known here');
  });
});
