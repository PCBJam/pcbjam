// The chips of a circuit that run the user's firmware, made ready for the live engine.
//
// A microcontroller of the simulation library is a part whose digital half is a chip
// emulator: somebody else's program, kept by the library, that runs a firmware image. The
// engine takes such a part as a package of files ("PJPK", see pj_part_load in
// wasm/ngspice-service/ngspice_live.cpp) and hands it to an adapter of this app in the
// simulation thread: esp-emu-adapter.js for Espressif's emulator (the ESP32 modules),
// avr8js-adapter.js for avr8js (the Arduino boards with an AVR chip).
//
// This file builds the packages for a prepared run, one for every placed chip (the netlist
// step gives each its own model and its own name for its code):
//   - the emulator's files come from the library, checked against its checksums
//   - the firmware is a file of the project. Which one, says the chip's setting "firmware"
//     (the part gives the name a chip without the setting looks for). Two chips can name
//     the same file or two files. An ESP32's is its flash image and goes on as it is; an
//     AVR chip's is Intel HEX text, which is read here into the program's bytes
//   - what the adapter must know about the chip (its pads, which of them are wired) comes
//     from the part's description and the netlist step
//
// The emulator's own JavaScript (its loader, or all of it) is not part of this app. It is
// fetched with the emulator, wrapped so that it leaves what it defines in one place, and
// loaded in the simulation thread by its address.
import type { DigitalEmulator, IndexEmulator, PlacedPart, PreparedRun, SimLibrary } from "@pcbjam/shared/sim-library";
import { imageProblem } from "./esp-image";
import { programProblem, readIntelHex } from "./intel-hex";

/** The setting of a chip part that names its firmware file in the project. */
export const FIRMWARE_SETTING = "firmware";

/** How a kind of emulator is run here. */
interface EmulatorKind {
  /** The adapter it is run by (the names esp-emu-adapter.js and its like register). */
  adapter: string;
  /** The emulator's JavaScript as a script that leaves what it defines in `__pjGlue[key]`. */
  script: (text: string, key: string) => string;
  /** Whether the emulator is a WebAssembly program that its JavaScript loads. */
  program: boolean;
  /** The firmware file as the adapter takes it, for this chip. Throws with words for the user when the file is not one. */
  firmware: (file: Uint8Array, chip: string) => Uint8Array;
}

/** An AVR chip's program from its file: Intel HEX text, read into the bytes of the chip's program memory. */
function avrProgram(file: Uint8Array, chip: string): Uint8Array {
  const program = readIntelHex(new TextDecoder().decode(file));
  const problem = programProblem(program, chip);
  if (problem) throw new Error(problem);
  return program;
}

/**
 * An ESP32's flash from its file: the merged image as it is. A file the chip would not
 * start from is refused here too: it can come into the project past the chip's line of
 * the parts list (an upload on the project's page, an imported zip).
 */
function espImage(file: Uint8Array, chip: string): Uint8Array {
  const problem = imageProblem(file, chip);
  if (problem) throw new Error(problem);
  return file;
}

const KINDS: Record<string, EmulatorKind> = {
  "esp-emu": { adapter: "esp-emu", script: loaderScript, program: true, firmware: espImage },
  avr8js: { adapter: "avr8js", script: (text, key) => libraryScript(text, key, "avr8js"), program: false, firmware: avrProgram },
};

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

/**
 * An emulator that is one script defining `name` (avr8js, as the library packs it), as a
 * script that leaves it in `__pjGlue[key]` and nothing else in the thread.
 */
export function libraryScript(text: string, key: string, name: string): string {
  if (!new RegExp(`^var ${name} = `, "m").test(text)) throw new Error(`the emulator's script does not define ${name}`);
  return `(function () {\n${text}\n(globalThis.__pjGlue = globalThis.__pjGlue || {})[${JSON.stringify(key)}] = ${name};\n})();\n`;
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

/** Where the user gives a chip its firmware. */
const WHERE_TO_CHOOSE = "Choose the file on the chip's line in the Simulation parts list (Session menu)";

/** A sentence for each chip that cannot run, in one error; with `choose`, where a firmware file is chosen. */
function cannotRun(problems: string[], choose: boolean): Error {
  return new Error(`${problems.join("; ")}${choose ? `. ${WHERE_TO_CHOOSE}` : ""}`);
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
  const programs = new Map<string, Promise<EmulatorFiles>>();
  const program = (emulator: IndexEmulator, kind: EmulatorKind): Promise<EmulatorFiles> => {
    const key = emulatorKey(emulator);
    let got = programs.get(key);
    if (!got) programs.set(key, (got = emulatorFiles(library, emulator, kind, scriptUrl)));
    return got;
  };

  const out: { name: string; bytes: Uint8Array }[] = [];
  const problems: string[] = [];
  // a chip without a file that runs: the sentence ends with where one is chosen
  let choose = false;
  for (const code of run.codeParts) {
    if (code.kind !== "emulator") continue;
    const digital = run.parts.get(code.partId)?.manifest.digital;
    const chip = run.placed.find((p) => p.ref === code.ref);
    if (!digital || digital.kind !== "emulator" || !chip) throw new Error(`${code.ref ?? code.partId}: the part's description is not loaded`);
    const emulator = library.emulator(digital.emulator);
    const kind = KINDS[digital.emulator];
    if (!emulator || !kind) {
      problems.push(`${chip.ref}: this page cannot run the chip (its emulator "${digital.emulator}" is not known here)`);
      continue;
    }
    const name = chip.settings[FIRMWARE_SETTING]?.value ?? "";
    if (!name) problems.push(`${chip.ref} needs its firmware: no file is chosen for it`);
    else if (!readFile) problems.push(`${chip.ref}: a chip with firmware can only run in a project`);
    if (!name) choose = true;
    if (!name || !readFile) continue;
    const file = await image(name);
    if (!file) problems.push(`${chip.ref} needs its firmware: the project has no file "${name}"`);
    else if (!file.length) problems.push(`${chip.ref}: the firmware file "${name}" is empty`);
    let firmware: Uint8Array | null = null;
    if (file?.length) {
      try { firmware = kind.firmware(file, digital.chip); } catch (e) { problems.push(`${chip.ref}: the firmware file "${name}" cannot run: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (!firmware) choose = true;
    if (!firmware || problems.length) continue;

    out.push({ name: code.name, bytes: packPart(emulatorPackage(emulator, kind, digital, chip, firmware, await program(emulator, kind))) });
  }
  if (problems.length) throw cannotRun(problems, choose);
  return out;
}

const emulatorKey = (emulator: IndexEmulator): string => `${emulator.id}@${emulator.version}`;

/** An emulator's program (when it has one), and the address its JavaScript is loaded from in the simulation thread. */
interface EmulatorFiles {
  program: Uint8Array | null;
  glueUrl: string;
}

async function emulatorFiles(
  library: ChipPartsOptions["library"], emulator: IndexEmulator, kind: EmulatorKind, scriptUrl: (text: string) => string,
): Promise<EmulatorFiles> {
  const key = emulatorKey(emulator);
  if (kind.program && !emulator.program) throw new Error(`the emulator "${emulator.id}" of the library has no program`);
  const [program, loader] = await Promise.all([
    kind.program && emulator.program ? library.emulatorFile(emulator.id, emulator.program) : null,
    library.emulatorFile(emulator.id, emulator.loader),
  ]);
  let glueUrl = loaderUrls.get(key);
  if (!glueUrl) {
    glueUrl = scriptUrl(kind.script(new TextDecoder().decode(loader), key));
    loaderUrls.set(key, glueUrl);
  }
  return { program, glueUrl };
}

function emulatorPackage(
  emulator: IndexEmulator, kind: EmulatorKind, digital: DigitalEmulator, chip: PlacedPart, firmware: Uint8Array,
  { program, glueUrl }: EmulatorFiles,
): PartPackage {
  const key = emulatorKey(emulator);
  // A pad is wired when the chip has something on its pin (or on a pin the part joins it with).
  const wired = Object.entries(digital.pads).filter(([pin]) => chip.connected.includes(pin)).map(([, gpio]) => gpio);
  return {
    adapter: kind.adapter,
    config: {
      chip: digital.chip,
      cores: digital.cores ?? 1,
      ...(digital.clock ? { clock: digital.clock } : {}),
      // the model's emulator line takes the pads in the order the part lists them
      pads: Object.values(digital.pads),
      enable: !!digital.enable,
      ...(digital.padRegisters ? { iomux: digital.padRegisters } : {}),
      // the voltages the chip's program may ask the engine for, in the order of the model's voltage tap
      ...(digital.taps ? { taps: digital.taps } : {}),
      wired,
      emulatorKey: key,
      glueUrl,
    },
    blobs: { ...(program ? { "emulator.wasm": program } : {}), "firmware.bin": firmware },
  };
}
