import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * kicadSimSymbols (wasm/bindings/sim_symbols.h): what live simulation asks the
 * schematic for. Against the real engine, on a hand-written project of two files:
 *
 *   root:  +5V - R1 - [~{CS}] - R2 - (no name) - R3 - open     U1 (two units), nothing wired
 *   cell:  [MID] - RK - GND                                     the sheet is used twice
 *
 *   - every sheet is read, not only the open one, and a sheet used twice gives
 *     two symbols (R11, R12) with their own nets;
 *   - the units of a multi-unit part are one symbol with all its pins;
 *   - power symbols are left out;
 *   - fields come by name, as shown (a variable in the Value is resolved);
 *   - a symbol excluded from simulation is listed and marked;
 *   - each pin's net comes under the name KiCad's SPICE netlist uses;
 *   - it is fresh after a commit.
 *
 * The node names below are what the desktop kicad-cli 10.0.6 writes for this
 * project (`sch export netlist --format spice`):
 *
 *   R1 +5V /_CS 10k
 *   R2 /_CS Net-_R2-Pad2_ 39
 *   R11 /Key_1/MID GND 330
 *   R12 /Key_2/MID GND 330
 *
 * kicadSimNetlist (wasm/bindings/sim_netlist.h): KiCad's SPICE netlist of the
 * schematic, one entry per statement, each marked with the symbol it belongs
 * to. On the same project with three diodes and three texts added (see "the
 * project of the netlist test" below):
 *
 *   - the text is the desktop's netlist of the same files, line for line,
 *     without the simulation command drawn on the sheet;
 *   - every symbol's line, and the .model KiCad writes for a symbol, carries
 *     that symbol's reference; the title, the include, the directive and
 *     ".end" carry none;
 *   - the item list says what KiCad has for each symbol: a real device, a
 *     placeholder (no model at all), or its guess for a symbol without one;
 *   - it is fresh after a commit;
 *   - a model file that is not there is reported in words, and no window
 *     opens over the editor.
 */

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabApplyItems(j: string): unknown;
  kicadSimSymbols(): string;
  kicadSimNetlist(): string;
  kicadSheetsGetTree(): string;
};
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Sym = {
  uuid: string;
  ref: string;
  libId: string;
  value: string;
  sheet: string;
  sheetPath: string;
  excluded?: boolean;
  fields: Record<string, string>;
  pins: Record<string, { name: string; node?: string }>;
};

const BOOT_TIMEOUT = 150000;
const DIR = "/home/kicad/documents/simprobe";
const ROOT = "11111111-1111-1111-1111-111111111111";
const CELL = "22222222-2222-2222-2222-222222222222";
const USE1 = "33333333-0000-0000-0000-000000000001";
const USE2 = "33333333-0000-0000-0000-000000000002";
const R1 = "aaaaaaaa-0000-0000-0000-000000000001";
const R2 = "aaaaaaaa-0000-0000-0000-000000000002";
const R3 = "aaaaaaaa-0000-0000-0000-000000000003";
const U1A = "aaaaaaaa-0000-0000-0000-000000000004";
const U1B = "aaaaaaaa-0000-0000-0000-000000000005";
const RK = "aaaaaaaa-0000-0000-0000-000000000006";

const font = `(effects (font (size 1.27 1.27)))`;
const hidden = `(effects (font (size 1.27 1.27)) (hide yes))`;

const LIB_R = `(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) ${font})
  (property "Value" "R" (at 0 0 90) ${font})
  (property "Footprint" "" (at -1.778 0 90) ${hidden})
  (property "Datasheet" "~" (at 0 0 0) ${hidden})
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${font}) (number "1" ${font}))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${font}) (number "2" ${font})))
  (embedded_fonts no))`;

// Two units in one package: unit 1 has the pins A (1) and B (2), unit 2 has C (3) and D (4).
const LIB_DUAL = `(symbol "Test:DUAL" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${font})
  (property "Value" "DUAL" (at 0 -5.08 0) ${font})
  (property "Footprint" "" (at 0 0 0) ${hidden})
  (property "Datasheet" "" (at 0 0 0) ${hidden})
  (symbol "DUAL_1_1"
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0.254) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 2.54) (name "A" ${font}) (number "1" ${font}))
    (pin passive line (at 5.08 0 180) (length 2.54) (name "B" ${font}) (number "2" ${font})))
  (symbol "DUAL_2_1"
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0.254) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 2.54) (name "C" ${font}) (number "3" ${font}))
    (pin passive line (at 5.08 0 180) (length 2.54) (name "D" ${font}) (number "4" ${font})))
  (embedded_fonts no))`;

const power = (name: string) => `(symbol "power:${name}" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -3.81 0) ${hidden})
  (property "Value" "${name}" (at 0 3.556 0) ${font})
  (property "Footprint" "" (at 0 0 0) ${hidden})
  (property "Datasheet" "" (at 0 0 0) ${hidden})
  (symbol "${name}_0_1" (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "${name}_1_1" (pin power_in line (at 0 0 90) (length 0) (hide yes) (name "${name}" ${font}) (number "1" ${font})))
  (embedded_fonts no))`;

type InstOpts = { unit?: number; excluded?: boolean; fields?: Record<string, string> };

/** One placed symbol. `paths` is [[sheet path, reference], ...]: one line per use of its sheet. */
const inst = (
  lib: string,
  uuid: string,
  x: number,
  y: number,
  value: string,
  pins: string[],
  paths: [string, string][],
  opts: InstOpts = {},
) =>
  `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit ${opts.unit ?? 1}) (exclude_from_sim ${opts.excluded ? "yes" : "no"}) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
    (property "Reference" "${paths[0]![1]}" (at ${x + 2} ${y} 90) ${font})
    (property "Value" "${value}" (at ${x} ${y} 90) ${font})
    (property "Footprint" "" (at ${x} ${y} 0) ${hidden})
    (property "Datasheet" "" (at ${x} ${y} 0) ${hidden})
    ${Object.entries(opts.fields ?? {})
      .map(([k, v]) => `(property "${k}" "${v}" (at ${x} ${y} 0) ${hidden})`)
      .join(" ")}
    ${pins.map((p, i) => `(pin "${p}" (uuid "${uuid.slice(0, -2)}${i}f"))`).join(" ")}
    (instances (project "simprobe" ${paths.map(([path, ref]) => `(path "${path}" (reference "${ref}") (unit ${opts.unit ?? 1}))`).join(" ")})))`;

const wire = (x1: number, y1: number, x2: number, y2: number, uuid: string) =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "${uuid}"))`;
const label = (text: string, x: number, y: number, uuid: string) =>
  `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uuid}"))`;
const sheet = (name: string, uuid: string, x: number, y: number, page: number) =>
  `(sheet (at ${x} ${y}) (size 20.32 10.16) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "${uuid}")
    (property "Sheetname" "${name}" (at ${x} ${y - 0.6} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "cell.kicad_sch" (at ${x} ${y + 10.8} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (instances (project "simprobe" (path "/${ROOT}" (page "${page}")))))`;

// Pin ends (library Y is up, sheet Y is down): a resistor at (x, y) has pin 1 at
// (x, y - 3.81) and pin 2 at (x, y + 3.81); a DUAL unit at (x, y) has its pins at
// (x - 5.08, y) and (x + 5.08, y).
const HERE = `/${ROOT}`;
const ROOT_SCH = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${ROOT}")
  (paper "A4")
  (lib_symbols ${LIB_R} ${LIB_DUAL} ${power("+5V")})
  ${inst("Device:R", R1, 101.6, 101.6, "10k", ["1", "2"], [[HERE, "R1"]], { fields: { "PCBJam.SimPart": "off" } })}
  ${inst("Device:R", R2, 127, 101.6, "\${Rating}", ["1", "2"], [[HERE, "R2"]], { fields: { Rating: "39" } })}
  ${inst("Device:R", R3, 152.4, 101.6, "1k", ["1", "2"], [[HERE, "R3"]], { excluded: true })}
  ${inst("Test:DUAL", U1A, 101.6, 127, "DUAL", ["1", "2"], [[HERE, "U1"]], { unit: 1 })}
  ${inst("Test:DUAL", U1B, 127, 127, "DUAL", ["3", "4"], [[HERE, "U1"]], { unit: 2 })}
  ${inst("power:+5V", "aaaaaaaa-0000-0000-0000-000000000007", 101.6, 97.79, "+5V", ["1"], [[HERE, "#PWR01"]])}
  ${wire(101.6, 105.41, 114.3, 105.41, "bbbbbbbb-0000-0000-0000-000000000001")}
  ${wire(114.3, 105.41, 114.3, 97.79, "bbbbbbbb-0000-0000-0000-000000000002")}
  ${wire(114.3, 97.79, 127, 97.79, "bbbbbbbb-0000-0000-0000-000000000003")}
  ${label("~{CS}", 114.3, 105.41, "dddddddd-0000-0000-0000-000000000001")}
  ${wire(127, 105.41, 139.7, 105.41, "bbbbbbbb-0000-0000-0000-000000000004")}
  ${wire(139.7, 105.41, 139.7, 97.79, "bbbbbbbb-0000-0000-0000-000000000005")}
  ${wire(139.7, 97.79, 152.4, 97.79, "bbbbbbbb-0000-0000-0000-000000000006")}
  ${sheet("Key 1", USE1, 50.8, 50.8, 2)}
  ${sheet("Key 2", USE2, 50.8, 76.2, 3)}
  (sheet_instances (path "/" (page "1")))
)
`;

const CELL_SCH = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${CELL}")
  (paper "A4")
  (lib_symbols ${LIB_R} ${power("GND")})
  ${inst("Device:R", RK, 101.6, 101.6, "330", ["1", "2"], [
    [`${HERE}/${USE1}`, "R11"],
    [`${HERE}/${USE2}`, "R12"],
  ])}
  ${inst("power:GND", "aaaaaaaa-0000-0000-0000-000000000008", 101.6, 105.41, "GND", ["1"], [
    [`${HERE}/${USE1}`, "#PWR011"],
    [`${HERE}/${USE2}`, "#PWR012"],
  ])}
  ${wire(101.6, 97.79, 101.6, 88.9, "bbbbbbbb-0000-0000-0000-000000000007")}
  ${label("MID", 101.6, 88.9, "dddddddd-0000-0000-0000-000000000002")}
)
`;

// ── the project of the netlist test ─────────────────────────────────────────
// The root sheet of above, plus what makes KiCad write every kind of netlist statement:
//
//   D1  a diode with its own parameters           -> a .model statement and an item line
//   D2  a diode like a stock LED: no model at all  -> a line that names its Value as the model
//   D3  a diode with a model from a file           -> an .include and an item line
//   three texts: a directive (.param), a simulation command (.tran), a plain note
//
// The diodes' anodes are on the net behind R2, their cathodes on GND.
// (Their uuids start differently from the others': KiCad renumbers a uuid it has seen
// before in a file, and the pins' uuids that inst() makes up count upwards from ...0f.)
const D1 = "cccccccc-0000-0000-0000-000000000001";
const D2 = "cccccccc-0000-0000-0000-000000000002";
const D3 = "cccccccc-0000-0000-0000-000000000003";

// A diode at (x, y) has pin 1 (K) at (x - 3.81, y) and pin 2 (A) at (x + 3.81, y).
const LIB_D = `(symbol "Device:D" (pin_numbers (hide yes)) (pin_names (offset 1.016) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "D" (at 0 2.54 0) ${font})
  (property "Value" "D" (at 0 -2.54 0) ${font})
  (property "Footprint" "" (at 0 0 0) ${hidden})
  (property "Datasheet" "~" (at 0 0 0) ${hidden})
  (symbol "D_0_1" (polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "D_1_1"
    (pin passive line (at -3.81 0 0) (length 2.54) (name "K" ${font}) (number "1" ${font}))
    (pin passive line (at 3.81 0 180) (length 2.54) (name "A" ${font}) (number "2" ${font})))
  (embedded_fonts no))`;

const note = (text: string, x: number, y: number, uuid: string) =>
  `(text "${text}" (exclude_from_sim no) (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uuid}"))`;

const DIODE_PINS = { "Sim.Device": "D", "Sim.Pins": "1=K 2=A" };

const NET_ROOT_SCH = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${ROOT}")
  (paper "A4")
  (lib_symbols ${LIB_R} ${LIB_DUAL} ${LIB_D} ${power("+5V")} ${power("GND")})
  ${inst("Device:R", R1, 101.6, 101.6, "10k", ["1", "2"], [[HERE, "R1"]])}
  ${inst("Device:R", R2, 127, 101.6, "39", ["1", "2"], [[HERE, "R2"]])}
  ${inst("Device:R", R3, 152.4, 101.6, "1k", ["1", "2"], [[HERE, "R3"]], { excluded: true })}
  ${inst("Test:DUAL", U1A, 101.6, 127, "DUAL", ["1", "2"], [[HERE, "U1"]], { unit: 1 })}
  ${inst("Test:DUAL", U1B, 127, 127, "DUAL", ["3", "4"], [[HERE, "U1"]], { unit: 2 })}
  ${inst("Device:D", D1, 165.1, 127, "D", ["1", "2"], [[HERE, "D1"]], { fields: { ...DIODE_PINS, "Sim.Params": "is=2e-14 n=1.9" } })}
  ${inst("Device:D", D2, 165.1, 139.7, "red", ["1", "2"], [[HERE, "D2"]], { fields: { "Sim.Pins": "1=K 2=A" } })}
  ${inst("Device:D", D3, 165.1, 152.4, "MYD", ["1", "2"], [[HERE, "D3"]], { fields: { ...DIODE_PINS, "Sim.Library": "models.lib", "Sim.Name": "MYD" } })}
  ${inst("power:+5V", "aaaaaaaa-0000-0000-0000-000000000007", 101.6, 97.79, "+5V", ["1"], [[HERE, "#PWR01"]])}
  ${inst("power:GND", "ffffffff-0000-0000-0000-000000000001", 161.29, 127, "GND", ["1"], [[HERE, "#PWR02"]])}
  ${inst("power:GND", "ffffffff-0000-0000-0000-000000000002", 161.29, 139.7, "GND", ["1"], [[HERE, "#PWR03"]])}
  ${inst("power:GND", "ffffffff-0000-0000-0000-000000000003", 161.29, 152.4, "GND", ["1"], [[HERE, "#PWR04"]])}
  ${wire(101.6, 105.41, 114.3, 105.41, "bbbbbbbb-0000-0000-0000-000000000001")}
  ${wire(114.3, 105.41, 114.3, 97.79, "bbbbbbbb-0000-0000-0000-000000000002")}
  ${wire(114.3, 97.79, 127, 97.79, "bbbbbbbb-0000-0000-0000-000000000003")}
  ${label("~{CS}", 114.3, 105.41, "dddddddd-0000-0000-0000-000000000001")}
  ${wire(127, 105.41, 139.7, 105.41, "bbbbbbbb-0000-0000-0000-000000000004")}
  ${wire(139.7, 105.41, 139.7, 97.79, "bbbbbbbb-0000-0000-0000-000000000005")}
  ${wire(139.7, 97.79, 152.4, 97.79, "bbbbbbbb-0000-0000-0000-000000000006")}
  ${wire(139.7, 105.41, 139.7, 114.3, "bbbbbbbb-0000-0000-0000-000000000011")}
  ${wire(139.7, 114.3, 176.53, 114.3, "bbbbbbbb-0000-0000-0000-000000000012")}
  ${wire(176.53, 114.3, 176.53, 127, "bbbbbbbb-0000-0000-0000-000000000013")}
  ${wire(176.53, 127, 168.91, 127, "bbbbbbbb-0000-0000-0000-000000000014")}
  ${wire(176.53, 127, 176.53, 139.7, "bbbbbbbb-0000-0000-0000-000000000015")}
  ${wire(176.53, 139.7, 168.91, 139.7, "bbbbbbbb-0000-0000-0000-000000000016")}
  ${wire(176.53, 139.7, 176.53, 152.4, "bbbbbbbb-0000-0000-0000-000000000017")}
  ${wire(176.53, 152.4, 168.91, 152.4, "bbbbbbbb-0000-0000-0000-000000000018")}
  ${note(".param gain=2", 50.8, 127, "eeeeeeee-0000-0000-0000-000000000001")}
  ${note(".tran 1m 10m", 50.8, 132.08, "eeeeeeee-0000-0000-0000-000000000002")}
  ${note("only a note", 50.8, 137.16, "eeeeeeee-0000-0000-0000-000000000003")}
  ${sheet("Key 1", USE1, 50.8, 50.8, 2)}
  ${sheet("Key 2", USE2, 50.8, 76.2, 3)}
  (sheet_instances (path "/" (page "1")))
)
`;

const MODELS_LIB = `* the model file D3 names
.model MYD D(is=1e-14 n=1.5)
`;

const NET_FILES = { "cell.kicad_sch": CELL_SCH, "models.lib": MODELS_LIB, "simprobe.kicad_sch": NET_ROOT_SCH };

// What the desktop kicad-cli 10.0.6 writes for these files
// (`sch export netlist --format spice`), with <dir> for the project's folder.
const DESKTOP_NETLIST = `.title KiCad schematic
.include "<dir>/models.lib"
.model __D1 D
+           is=20f
+           n=1.9
.param gain=2
.tran 1m 10m
R1 +5V /_CS 10k
R2 /_CS Net-_D1-A_ 39
U1 __U1
D1 Net-_D1-A_ GND __D1
D3 Net-_D1-A_ GND MYD
D2 GND Net-_D1-A_ red
R11 /Key_1/MID GND 330
R12 /Key_2/MID GND 330
.end
`;

// Two diodes whose model files do not exist: D3 names a library the way KiCad's own model
// dialog does, D4 as a raw SPICE model (the include KiCad writes for it is looked up when
// the netlist is written, and a miss goes to wx's log).
const D4 = "cccccccc-0000-0000-0000-000000000004";
const LOST_ROOT_SCH = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${ROOT}")
  (paper "A4")
  (lib_symbols ${LIB_R} ${LIB_D})
  ${inst("Device:R", R1, 101.6, 101.6, "10k", ["1", "2"], [[HERE, "R1"]])}
  ${inst("Device:D", D3, 165.1, 152.4, "MYD", ["1", "2"], [[HERE, "D3"]], { fields: { ...DIODE_PINS, "Sim.Library": "lost.lib", "Sim.Name": "MYD" } })}
  ${inst("Device:D", D4, 165.1, 165.1, "MYD", ["1", "2"], [[HERE, "D4"]], { fields: { "Sim.Device": "SPICE", "Sim.Pins": "1=K 2=A", "Sim.Params": 'type=\\"D\\" model=\\"MYD\\" lib=\\"lost2.lib\\"' } })}
  (sheet_instances (path "/" (page "1")))
)
`;

/** Boots the schematic editor, writes the project's files and opens its root sheet. */
async function bootAndOpen(page: Page, files: Record<string, string> = { "cell.kicad_sch": CELL_SCH, "simprobe.kicad_sch": ROOT_SCH }): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadSimSymbols === "function" && typeof m?.kicadSimNetlist === "function";
    },
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate(
    ({ dir, files }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      w.FS.mkdirTree(dir);
      for (const [name, text] of Object.entries(files)) w.FS.writeFile(`${dir}/${name}`, text);
      w.Module.kicadOpenFile(`${dir}/simprobe.kicad_sch`);
    },
    { dir: DIR, files },
  );
}

type Line = { text: string; ref?: string; kind?: string };
type Netlist = {
  lines?: Line[];
  items?: { ref: string; name: string; device: string; type: string; off?: boolean }[];
  messages?: { severity: string; text: string }[];
  ok?: boolean;
  error?: string;
};

const simNetlist = (page: Page) =>
  page.evaluate(() => JSON.parse((window as unknown as { Module: Mod }).Module.kicadSimNetlist()) as Netlist);

/** Visible dialogs and log windows of the editor. */
const dialogCount = (page: Page) =>
  page.evaluate(
    () => window.wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog|LogFrame|LogWindow/i.test(e.typeName)).length,
  );

/** Completed wx idle passes (wxWasmIdlePassCount, a plain wasm export). */
const idlePasses = (page: Page) =>
  page.evaluate(() => (window.Module as unknown as { _wxWasmIdlePassCount(): number })._wxWasmIdlePassCount());

/** Resolves once two full idle passes have run from now on: wx shows what it logged when it is idle. */
async function waitForIdle(page: Page): Promise<void> {
  const before = await idlePasses(page);
  await expect.poll(() => idlePasses(page), { timeout: 20000, intervals: [50] }).toBeGreaterThan(before + 1);
}

const simSymbols = (page: Page) =>
  page.evaluate(() => {
    const out = JSON.parse((window as unknown as { Module: Mod }).Module.kicadSimSymbols()) as {
      symbols?: Sym[];
      error?: string;
    };
    return out.symbols ?? [];
  });

test.describe("live simulation reads (eeschema)", () => {
  test.describe.configure({ timeout: 420000 });

  test("kicadSimSymbols reports every sheet's symbols with fields and SPICE node names", async ({ page, testLogger }) => {
    await bootAndOpen(page);
    await expect.poll(async () => (await simSymbols(page)).length, { timeout: 60000, intervals: [500] }).toBe(6);

    const list = await simSymbols(page);
    const by = Object.fromEntries(list.map((s) => [s.ref, s]));
    // One entry per reference: no power symbols, U1 once, the cell's resistor twice.
    expect(Object.keys(by).sort()).toEqual(["R1", "R11", "R12", "R2", "R3", "U1"]);

    // The root sheet. Fields by name, without the reference and without empty ones.
    expect(by.R1).toEqual({
      uuid: R1,
      ref: "R1",
      libId: "Device:R",
      value: "10k",
      sheet: "/",
      sheetPath: by.R1!.sheetPath,
      fields: { Value: "10k", "PCBJam.SimPart": "off" },
      pins: { "1": { name: "", node: "+5V" }, "2": { name: "", node: "/_CS" } },
    });
    // The Value is "${Rating}": it comes as shown.
    expect(by.R2).toMatchObject({
      uuid: R2,
      value: "39",
      fields: { Value: "39", Rating: "39" },
      pins: { "1": { name: "", node: "/_CS" }, "2": { name: "", node: "Net-_R2-Pad2_" } },
    });
    expect(by.R2!.excluded, "only an excluded symbol carries the mark").toBeUndefined();

    // Excluded from simulation: listed, marked, and its pins still have their nets.
    expect(by.R3).toMatchObject({
      uuid: R3,
      excluded: true,
      pins: { "1": { name: "", node: "Net-_R2-Pad2_" }, "2": { name: "", node: "unconnected-_R3-Pad2_" } },
    });

    // Two units, one part: all four pins, with their names.
    expect([U1A, U1B]).toContain(by.U1!.uuid);
    expect(by.U1).toMatchObject({ libId: "Test:DUAL", value: "DUAL", sheet: "/" });
    expect(by.U1!.pins).toEqual({
      "1": { name: "A", node: "unconnected-_U1A-A-Pad1_" },
      "2": { name: "B", node: "unconnected-_U1A-B-Pad2_" },
      "3": { name: "C", node: "unconnected-_U1B-C-Pad3_" },
      "4": { name: "D", node: "unconnected-_U1B-D-Pad4_" },
    });

    // The sheet that is used twice: one drawn resistor, two symbols, each with its own
    // net for the local label and the shared GND.
    expect(by.R11).toMatchObject({
      uuid: RK,
      value: "330",
      sheet: "/Key 1/",
      pins: { "1": { name: "", node: "/Key_1/MID" }, "2": { name: "", node: "GND" } },
    });
    expect(by.R12).toMatchObject({
      uuid: RK,
      value: "330",
      sheet: "/Key 2/",
      pins: { "1": { name: "", node: "/Key_2/MID" }, "2": { name: "", node: "GND" } },
    });

    // sheetPath names a sheet instance the way the sheet navigator does.
    const tree = await page.evaluate(() => (window as unknown as { Module: Mod }).Module.kicadSheetsGetTree());
    for (const s of list) expect(tree, `${s.ref}: ${s.sheetPath} is a path of the sheet tree`).toContain(JSON.stringify(s.sheetPath).slice(1, -1));
    expect(by.R11!.sheetPath).toContain(USE1);
    expect(by.R12!.sheetPath).toContain(USE2);
    expect(new Set([by.R1!.sheetPath, by.R11!.sheetPath, by.R12!.sheetPath]).size).toBe(3);

    // A committed edit (collab apply -> SCH_COMMIT -> RecalculateConnections): wire R3.2 to
    // U1's pin D. Both pins leave their "unconnected" nets and share one.
    await page.evaluate(
      (ws) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabApplyItems(
          JSON.stringify({ added: ws.map((sexpr) => ({ sexpr })) }),
        ),
      [
        wire(152.4, 105.41, 152.4, 127, "bbbbbbbb-0000-0000-0000-000000000008"),
        wire(152.4, 127, 132.08, 127, "bbbbbbbb-0000-0000-0000-000000000009"),
      ],
    );
    const node = async (ref: string, pin: string) => (await simSymbols(page)).find((s) => s.ref === ref)?.pins[pin]?.node ?? "";
    await expect.poll(() => node("R3", "2"), { timeout: 25000, intervals: [400] }).not.toContain("unconnected");
    expect(await node("U1", "4")).toBe(await node("R3", "2"));
    expect(await node("U1", "3"), "the other pins are untouched").toBe("unconnected-_U1B-C-Pad3_");

    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });

  test("kicadSimNetlist gives KiCad's netlist with every statement marked", async ({ page, testLogger }) => {
    await bootAndOpen(page, NET_FILES);
    await expect.poll(async () => (await simSymbols(page)).length, { timeout: 60000, intervals: [500] }).toBe(9);

    const answer = await simNetlist(page);
    expect(answer.error).toBeUndefined();
    expect(answer.ok).toBe(true);
    expect(answer.messages).toEqual([]);
    const lines = answer.lines ?? [];

    // The desktop's netlist of the same files, without the simulation command.
    const desktop = DESKTOP_NETLIST.replace("<dir>", DIR).replace(".tran 1m 10m\n", "");
    expect(lines.map((l) => l.text).join("\n") + "\n").toBe(desktop);
    expect(desktop, "the note is no directive").not.toContain("only a note");

    // Every statement of a symbol carries its reference; the rest carries none.
    expect(lines.map((l) => [l.text.split(/\s+/).slice(0, 2).join(" "), l.ref ?? "", l.kind ?? ""])).toEqual([
      [".title KiCad", "", ""],
      [`.include "${DIR}/models.lib"`, "", ""],
      [".model __D1", "D1", "model"],
      [".param gain=2", "", ""],
      ["R1 +5V", "R1", "item"],
      ["R2 /_CS", "R2", "item"],
      ["U1 __U1", "U1", "item"],
      ["D1 Net-_D1-A_", "D1", "item"],
      ["D3 Net-_D1-A_", "D3", "item"],
      ["D2 GND", "D2", "item"],
      ["R11 /Key_1/MID", "R11", "item"],
      ["R12 /Key_2/MID", "R12", "item"],
      [".end", "", ""],
    ]);
    // A statement is whole: the .model comes with its parameter lines.
    expect(lines[2]!.text).toBe(".model __D1 D\n+           is=20f\n+           n=1.9");

    // What KiCad has for each symbol. U1 has no model at all (its line is a placeholder).
    // D2 has no model either, but pins that say "diode": KiCad then writes a raw SPICE line
    // that names the symbol's Value as the model. R3 is excluded from simulation: not here.
    expect(answer.items).toEqual([
      { ref: "R1", name: "R1", device: "R", type: "" },
      { ref: "R2", name: "R2", device: "R", type: "" },
      { ref: "U1", name: "U1", device: "", type: "" },
      { ref: "D1", name: "D1", device: "D", type: "" },
      { ref: "D3", name: "D3", device: "D", type: "" },
      { ref: "D2", name: "D2", device: "SPICE", type: "" },
      { ref: "R11", name: "R11", device: "R", type: "" },
      { ref: "R12", name: "R12", device: "R", type: "" },
    ]);

    // The nodes are the ones kicadSimSymbols reports for the same pins.
    const d2 = (await simSymbols(page)).find((s) => s.ref === "D2")!;
    expect(d2.uuid).toBe(D2);
    expect(lines.find((l) => l.ref === "D2")!.text).toBe(`D2 ${d2.pins["1"]!.node} ${d2.pins["2"]!.node} red`);

    // A committed edit (collab apply -> SCH_COMMIT): one more directive on the sheet.
    await page.evaluate(
      (sexpr) => (window as unknown as { Module: Mod }).Module.kicadCollabApplyItems(JSON.stringify({ added: [{ sexpr }] })),
      note(".param extra=1", 50.8, 142.24, "eeeeeeee-0000-0000-0000-000000000004"),
    );
    await expect
      .poll(async () => ((await simNetlist(page)).lines ?? []).map((l) => l.text), { timeout: 25000, intervals: [400] })
      .toContain(".param extra=1");
    const again = (await simNetlist(page)).lines ?? [];
    expect(again.filter((l) => l.ref).map((l) => l.text), "the symbols' lines are untouched").toEqual(lines.filter((l) => l.ref).map((l) => l.text));

    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });

  test("kicadSimNetlist reports a model file that is not there, without a window", async ({ page, testLogger }) => {
    await bootAndOpen(page, { "simprobe.kicad_sch": LOST_ROOT_SCH });
    await expect.poll(async () => (await simSymbols(page)).length, { timeout: 60000, intervals: [500] }).toBe(3);
    await waitForIdle(page);
    const before = await dialogCount(page);

    const answer = await simNetlist(page);
    expect(answer.error).toBeUndefined();
    expect(answer.ok).toBe(false);
    const errors = answer.messages!.filter((m) => m.severity === "error").map((m) => m.text);
    // D3's library: KiCad's exporter reports it.
    expect(errors).toContain(`Simulation model library not found at '${DIR}/lost.lib'`);
    // D4's file: KiCad only writes it to wx's log. It has to come back all the same.
    expect(errors.some((t) => t.includes("lost2.lib")), `the log's finding is among: ${errors.join(" | ")}`).toBe(true);
    // The rest of the schematic is still there.
    expect((answer.lines ?? []).map((l) => l.text)).toContain("R1 unconnected-_R1-Pad1_ unconnected-_R1-Pad2_ 10k");

    // wx shows what it logged when it is idle: nothing may have reached its log.
    await waitForIdle(page);
    expect(await dialogCount(page), "no window opened over the editor").toBe(before);

    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });

  // One image serves all four editors, so the function also exists while a board is open.
  test("kicadSimSymbols says so when no schematic is open", async ({ page }) => {
    await page.goto("/kicad/pcbnew.html");
    await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.waitForFunction(
      () => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadSimSymbols === "function",
      null,
      { timeout: BOOT_TIMEOUT },
    );
    await page.waitForFunction(
      () =>
        !!window.wxElementRegistry &&
        window.wxElementRegistry
          .findAll({ visible: true })
          .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
      null,
      { timeout: BOOT_TIMEOUT },
    );
    const answer = await page.evaluate(() => JSON.parse((window as unknown as { Module: Mod }).Module.kicadSimSymbols()));
    expect(answer).toEqual({ error: "no schematic frame" });
  });
});
