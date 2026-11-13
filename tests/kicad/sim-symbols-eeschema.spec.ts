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
 */

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabApplyItems(j: string): unknown;
  kicadSimSymbols(): string;
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

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadSimSymbols === "function";
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
    ({ dir, root, cell }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      w.FS.mkdirTree(dir);
      w.FS.writeFile(`${dir}/cell.kicad_sch`, cell);
      w.FS.writeFile(`${dir}/simprobe.kicad_sch`, root);
      w.Module.kicadOpenFile(`${dir}/simprobe.kicad_sch`);
    },
    { dir: DIR, root: ROOT_SCH, cell: CELL_SCH },
  );
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
