// The chips of a circuit that run the user's firmware, made ready for the live engine.
//
// A microcontroller of the simulation library is a part whose digital half is a chip
// emulator: somebody else's program, kept by the library, that runs a firmware image. The
// engine takes such a part as a package of files ("PJPK", see pj_part_load in
// wasm/ngspice-service/ngspice_live.cpp) and hands it to an adapter of this app
// (esp-emu-adapter.js) in the simulation thread.
//
// This file builds the packages for a prepared run, one for every placed chip (the netlist
// step gives each its own model and its own name for its code):
//   - the emulator's files come from the library, checked against its checksums
//   - the firmware is a file of the project. Which one, says the chip's setting "firmware"
//     (the part gives the name a chip without the setting looks for). Two chips can name
//     the same file or two files
//   - what the adapter must know about the chip (its pads, which of them are wired) comes
//     from the part's description and the netlist step
//
// The emulator's own JavaScript (its loader) is not part of this app. It is fetched with
// the emulator, wrapped so that it leaves what it defines in one place, and loaded in the
// simulation thread by its address.
import type { DigitalEmulator, IndexEmulator, PlacedPart, PreparedRun, SimLibrary } from "@pcbjam/shared/sim-library";

/** The setting of a chip part that names its firmware file in the project. */
export const FIRMWARE_SETTING = "firmware";

/** The adapter each kind of emulator is run by (the names esp-emu-adapter.js and its like register). */
const ADAPTERS: Record<string, string> = { "esp-emu": "esp-emu" };

export interface PartPackage {
  /** The name of the adapter in the simulation thread's `__pjAdapters`. */
  adapter: string;
  /** Plain data for the adapter. */
  config: Record<string, unknown>;
  /** The files, by the names the adapter asks for. */
  blobs: Record<string, Uint8Array>;
}

/** "PJPK" | u32 header length | header JSON | the files, one after the other. */
export function packPart({ adapter, config, blobs }: PartPackage): Uint8Array {
  const table: Record<string, [number, number]> = {};
  let at = 0;
  for (const [name, bytes] of Object.entries(blobs)) {
    table[name] = [at, bytes.length];
    at += bytes.length;
  }
  const head = new TextEncoder().encode(JSON.stringify({ adapter, config, blobs: table }));
  const out = new Uint8Array(8 + head.length + at);
  out.set([80, 74, 80, 75]);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let pos = 8 + head.length;
  for (const bytes of Object.values(blobs)) {
    out.set(bytes, pos);
    pos += bytes.length;
  }
  return out;
}

/**
 * An emulator's loader, which is written as a module, as a script a Worker can load by its
 * address: what it defines is left in `__pjGlue[key]`, and nothing else gets out. A loader
 * with an import or an export this does not know is refused: a new release of an emulator
 * is looked at before it is used.
 */
export function loaderScript(text: string, key: string): string {
  const body = text
    .replace(/^export class /gm, "class ")
    .replace(/^export \{[^}]*\};?[ \t]*$/gm, "")
    .replace(/import\.meta\.url/g, "undefined");
  if (/^\s*(import|export)\s/m.test(body)) throw new Error("the emulator's loader has an import or an export that is not known");
  for (const name of ["WasmEmulator", "initSync"]) {
    if (!new RegExp(`^(class|function) ${name}\\b`, "m").test(body)) throw new Error(`the emulator's loader has no ${name}`);
  }
  return `(function () {\n${body}\n(globalThis.__pjGlue = globalThis.__pjGlue || {})[${JSON.stringify(key)}] = { WasmEmulator: WasmEmulator, initSync: initSync };\n})();\n`;
}

export interface ChipPartsOptions {
  library: Pick<SimLibrary, "emulator" | "emulatorFile">;
  /** One file of the project by its path, or null when the project has no such file. */
  readFile?: (path: string) => Promise<Uint8Array | null>;
  /** For tests: gives a script's text an address a Worker can load it from. */
  scriptUrl?: (text: string) => string;
}

// One address per emulator and page: the loader does not change while the page lives.
const loaderUrls = new Map<string, string>();

const defaultScriptUrl = (text: string): string => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));

type Run = Pick<PreparedRun, "codeParts" | "placed" | "parts">;

/** A sentence for each chip that cannot run, in one error. */
function cannotRun(problems: string[]): Error {
  return new Error(problems.join("; "));
}

/**
 * The package of every placed chip of the run that runs an emulator, under the name its
 * model asks for. Rejects with a sentence for the user about every chip that cannot run:
 * no firmware file, an emulator this app does not run.
 */
export async function chipParts(run: Run, { library, readFile, scriptUrl = defaultScriptUrl }: ChipPartsOptions): Promise<{ name: string; bytes: Uint8Array }[]> {
  // Two chips with the same firmware read the file once; the same for an emulator's files.
  const images = new Map<string, Promise<Uint8Array | null>>();
  const image = (name: string): Promise<Uint8Array | null> => {
    let got = images.get(name);
    if (!got) images.set(name, (got = readFile ? readFile(name) : Promise.resolve(null)));
    return got;
  };
  const programs = new Map<string, Promise<{ program: Uint8Array; glueUrl: string }>>();
  const program = (emulator: IndexEmulator): Promise<{ program: Uint8Array; glueUrl: string }> => {
    const key = emulatorKey(emulator);
    let got = programs.get(key);
    if (!got) programs.set(key, (got = emulatorFiles(library, emulator, scriptUrl)));
    return got;
  };

  const out: { name: string; bytes: Uint8Array }[] = [];
  const problems: string[] = [];
  for (const code of run.codeParts) {
    if (code.kind !== "emulator") continue;
    const digital = run.parts.get(code.partId)?.manifest.digital;
    const chip = run.placed.find((p) => p.ref === code.ref);
    if (!digital || digital.kind !== "emulator" || !chip) throw new Error(`${code.ref ?? code.partId}: the part's description is not loaded`);
    const emulator = library.emulator(digital.emulator);
    const adapter = ADAPTERS[digital.emulator];
    if (!emulator || !adapter) {
      problems.push(`${chip.ref}: this page cannot run the chip (its emulator "${digital.emulator}" is not known here)`);
      continue;
    }
    const name = chip.settings[FIRMWARE_SETTING]?.value ?? "";
    if (!name) problems.push(`${chip.ref}: the part does not say which file its firmware is`);
    else if (!readFile) problems.push(`${chip.ref}: a chip with firmware can only run in a project`);
    if (!name || !readFile) continue;
    const firmware = await image(name);
    if (!firmware) problems.push(`${chip.ref} needs its firmware: the project has no file "${name}"`);
    else if (!firmware.length) problems.push(`${chip.ref}: the firmware file "${name}" is empty`);
    if (!firmware?.length || problems.length) continue;

    out.push({ name: code.name, bytes: packPart(emulatorPackage(emulator, adapter, digital, chip, firmware, await program(emulator))) });
  }
  if (problems.length) throw cannotRun(problems);
  return out;
}

const emulatorKey = (emulator: IndexEmulator): string => `${emulator.id}@${emulator.version}`;

/** An emulator's program, and the address its loader is loaded from in the simulation thread. */
async function emulatorFiles(
  library: ChipPartsOptions["library"], emulator: IndexEmulator, scriptUrl: (text: string) => string,
): Promise<{ program: Uint8Array; glueUrl: string }> {
  const key = emulatorKey(emulator);
  const [program, loader] = await Promise.all([library.emulatorFile(emulator.id, emulator.program), library.emulatorFile(emulator.id, emulator.loader)]);
  let glueUrl = loaderUrls.get(key);
  if (!glueUrl) {
    glueUrl = scriptUrl(loaderScript(new TextDecoder().decode(loader), key));
    loaderUrls.set(key, glueUrl);
  }
  return { program, glueUrl };
}

function emulatorPackage(
  emulator: IndexEmulator, adapter: string, digital: DigitalEmulator, chip: PlacedPart, firmware: Uint8Array,
  { program, glueUrl }: { program: Uint8Array; glueUrl: string },
): PartPackage {
  const key = emulatorKey(emulator);
  // A pad is wired when the chip has something on its pin.
  const wired = Object.entries(digital.pads).filter(([pin]) => chip.connected.includes(pin)).map(([, gpio]) => gpio);
  return {
    adapter,
    config: {
      chip: digital.chip,
      cores: digital.cores ?? 1,
      // the model's emulator line takes the pads in the order the part lists them
      pads: Object.values(digital.pads),
      enable: !!digital.enable,
      ...(digital.padRegisters ? { iomux: digital.padRegisters } : {}),
      wired,
      emulatorKey: key,
      glueUrl,
    },
    blobs: { "emulator.wasm": program, "firmware.bin": firmware },
  };
}
