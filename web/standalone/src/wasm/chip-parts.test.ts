import { describe, expect, it, vi } from "vitest";
import type { IndexEmulator, PartManifest, PlacedPart, PreparedRun } from "@pcbjam/shared/sim-library";
import { chipParts, FIRMWARE_SETTING, loaderScript, packPart, type ChipPartsOptions } from "./chip-parts";

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

// as the netlist step lists them: every placed chip with code of its own, numbered in order
const run = (chips: PlacedPart[], manifest: PartManifest = CHIP): Pick<PreparedRun, "codeParts" | "placed" | "parts"> => ({
  codeParts: chips.map((chip, i) => ({ partId: manifest.id, kind: "emulator" as const, name: `${manifest.id}_${i + 1}`, ref: chip.ref, logic: null })),
  placed: chips,
  parts: new Map([[manifest.id, { id: manifest.id, manifest, analog: "", logic: null }]]),
});

function library(emulators: IndexEmulator[] = [EMULATOR]) {
  const emulatorFile = vi.fn(async (_id: string, name: string) => (name === "esp_emu.js" ? utf8(LOADER) : new Uint8Array([0, 97, 115, 109])));
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

describe("chipParts", () => {
  it("packs the emulator, the firmware of the project and what the adapter must know", async () => {
    const lib = library();
    const readFile = vi.fn(async () => new Uint8Array([0xe9, 1, 2]));
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
    expect([...got.blobs["firmware.bin"]!]).toEqual([0xe9, 1, 2]);
    expect([...got.blobs["emulator.wasm"]!]).toEqual([0, 97, 115, 109]);
    expect(lib.emulatorFile.mock.calls.map((c) => c[1]).sort()).toEqual(["esp_emu.js", "esp_emu_bg.wasm"]);
    expect(scriptUrl.mock.calls[0]?.[0]).toContain('["esp-emu@1.0.0-rc2"]');

    // the loader gets one address for the page's life
    const again = await chipParts(run([placed("U1", [])]), { library: lib, readFile, scriptUrl });
    expect(unpack(again[0]!.bytes).config.glueUrl).toBe("blob:loader-1");
    expect(scriptUrl).toHaveBeenCalledTimes(1);
  });

  it("gives every placed chip a package of its own, with the firmware its own setting names", async () => {
    const images: Record<string, number[]> = { "blink.bin": [0xe9, 1], "motor.bin": [0xe9, 2] };
    const readFile = vi.fn(async (name: string) => (images[name] ? new Uint8Array(images[name]) : null));
    const lib = library();
    const parts = await chipParts(
      run([placed("U1", ["IO4"], "blink.bin", "symbol"), placed("U2", ["IO5"], "motor.bin", "symbol"), placed("U3", ["IO9"], "blink.bin", "symbol")]),
      { library: lib, readFile, scriptUrl: () => "blob:x" },
    );
    expect(parts.map((p) => p.name)).toEqual(["esp32-c3-wroom-02_1", "esp32-c3-wroom-02_2", "esp32-c3-wroom-02_3"]);
    const got = parts.map((p) => unpack(p.bytes));
    expect(got.map((g) => [...g.blobs["firmware.bin"]!])).toEqual([[0xe9, 1], [0xe9, 2], [0xe9, 1]]);
    // a pad is wired when that chip has something on its pin
    expect(got.map((g) => g.config.wired)).toEqual([[4], [5], [9]]);
    // a file two chips name is read once, and so are the emulator's files
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(["blink.bin", "motor.bin"]);
    expect(lib.emulatorFile.mock.calls.map((c) => c[1]).sort()).toEqual(["esp_emu.js", "esp_emu_bg.wasm"]);
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
    await expect(chipParts(one, { ...opts, readFile: async () => null }))
      .rejects.toThrow('U1 needs its firmware: the project has no file "firmware.bin"');
    await expect(chipParts(one, { ...opts, readFile: async () => new Uint8Array(0) }))
      .rejects.toThrow('U1: the firmware file "firmware.bin" is empty');
    await expect(chipParts(one, opts)).rejects.toThrow("U1: a chip with firmware can only run in a project");
    // every chip that cannot run is named, not only the first
    await expect(chipParts(run([placed("U1", [], "a.bin"), placed("U2", [], "b.bin"), placed("U3", [], "c.bin")]), { ...opts, readFile: async (name) => (name === "b.bin" ? new Uint8Array(1) : null) }))
      .rejects.toThrow('U1 needs its firmware: the project has no file "a.bin"; U3 needs its firmware: the project has no file "c.bin"');
    await expect(chipParts(one, { ...opts, library: library([]), readFile: async () => new Uint8Array(1) }))
      .rejects.toThrow('U1: this page cannot run the chip (its emulator "esp-emu" is not known here)');
    const other: PartManifest = { ...CHIP, digital: { ...(CHIP.digital as object), emulator: "other-emu" } as PartManifest["digital"] };
    await expect(chipParts(run([placed("U1", [])], other), { ...opts, library: library([{ ...EMULATOR, id: "other-emu" }]), readFile: async () => new Uint8Array(1) }))
      .rejects.toThrow('its emulator "other-emu" is not known here');
  });
});
