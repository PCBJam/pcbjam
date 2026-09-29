import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Guide-tour engine reads (docs/features/overlay-system/0003 phase 1), against
 * the real engine on a hand-written schematic with known connectivity:
 *
 *   +5V ── R1.1   R1.2 ──wire── R2.1   R2.2 ✕ (no-connect)
 *
 *   - kicadSheetSymbols: uuid, libId, ref, value, footprint per placed symbol;
 *   - kicadSheetNets: every net with a pin on the shown sheet, power-symbol
 *     pins (#PWR…) left out, the power symbol naming its net, no-connect
 *     flags per pin, and fresh after a commit (a collab apply adds a wire).
 */

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabApplyItems(j: string): unknown;
  kicadSheetSymbols(): string;
  kicadSheetNets(): string;
};
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Sym = { uuid: string; libId: string; ref: string; value: string; footprint: string };
type Net = { net: string; pins: { uuid: string; ref: string; libId: string; pin: string; name: string; noConnect: boolean }[] };

const BOOT_TIMEOUT = 150000;
const DIR = "/home/kicad/documents/probe";
const ROOT = "11111111-1111-1111-1111-111111111111";
const R1 = "aaaaaaaa-0000-0000-0000-000000000001";
const R2 = "aaaaaaaa-0000-0000-0000-000000000002";
const PWR = "aaaaaaaa-0000-0000-0000-000000000003";

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

const LIB_5V = `(symbol "power:+5V" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -3.81 0) ${hidden})
  (property "Value" "+5V" (at 0 3.556 0) ${font})
  (property "Footprint" "" (at 0 0 0) ${hidden})
  (property "Datasheet" "" (at 0 0 0) ${hidden})
  (symbol "+5V_0_1" (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "+5V_1_1" (pin power_in line (at 0 0 90) (length 0) (hide yes) (name "+5V" ${font}) (number "1" ${font})))
  (embedded_fonts no))`;

const inst = (lib: string, uuid: string, x: number, y: number, ref: string, value: string, fp: string, pins: string[]) =>
  `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
    (property "Reference" "${ref}" (at ${x + 2} ${y} 90) ${font})
    (property "Value" "${value}" (at ${x} ${y} 90) ${font})
    (property "Footprint" "${fp}" (at ${x} ${y} 0) ${hidden})
    (property "Datasheet" "" (at ${x} ${y} 0) ${hidden})
    ${pins.map((p, i) => `(pin "${p}" (uuid "${uuid.slice(0, -2)}${i}f"))`).join(" ")}
    (instances (project "probe" (path "/${ROOT}" (reference "${ref}") (unit 1)))))`;

const wire = (x1: number, y1: number, x2: number, y2: number, uuid: string) =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "${uuid}"))`;

// Pin connection points (lib Y is up, sheet Y is down): R at (x, 101.6) has
// pin 1 at (x, 97.79) and pin 2 at (x, 105.41).
const FIXTURE = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${ROOT}")
  (paper "A4")
  (lib_symbols ${LIB_R} ${LIB_5V})
  ${inst("Device:R", R1, 101.6, 101.6, "R1", "10k", "Resistor_SMD:R_0603_1608Metric", ["1", "2"])}
  ${inst("Device:R", R2, 127, 101.6, "R2", "39", "Resistor_SMD:R_1206_3216Metric", ["1", "2"])}
  ${inst("power:+5V", PWR, 101.6, 97.79, "#PWR01", "+5V", "", ["1"])}
  ${wire(101.6, 105.41, 114.3, 105.41, "bbbbbbbb-0000-0000-0000-000000000001")}
  ${wire(114.3, 105.41, 114.3, 97.79, "bbbbbbbb-0000-0000-0000-000000000002")}
  ${wire(114.3, 97.79, 127, 97.79, "bbbbbbbb-0000-0000-0000-000000000003")}
  (no_connect (at 127 105.41) (uuid "cccccccc-0000-0000-0000-000000000001"))
  (sheet_instances (path "/" (page "1")))
)
`;

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadSheetNets === "function";
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
    ({ dir, content }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      w.FS.mkdirTree(dir);
      w.FS.writeFile(`${dir}/probe.kicad_sch`, content);
      w.Module.kicadOpenFile(`${dir}/probe.kicad_sch`);
    },
    { dir: DIR, content: FIXTURE },
  );
}

const symbols = (page: Page) =>
  page.evaluate(() => JSON.parse((window as unknown as { Module: Mod }).Module.kicadSheetSymbols()) as Sym[]);
const nets = (page: Page) =>
  page.evaluate(() => JSON.parse((window as unknown as { Module: Mod }).Module.kicadSheetNets()) as Net[]);

/** Nets as sorted "REF.PIN" lists, plus the named ones by name. */
function shape(list: Net[]) {
  const groups = list.map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(",")).sort();
  const byName = Object.fromEntries(list.map((n) => [n.net, n.pins.map((p) => `${p.ref}.${p.pin}`).sort()]));
  return { groups, byName };
}

test.describe("guide-tour engine reads (eeschema)", () => {
  test.describe.configure({ timeout: 420000 });

  test("kicadSheetSymbols and kicadSheetNets report the shown sheet exactly", async ({ page, testLogger }) => {
    await bootAndOpen(page);
    await expect.poll(async () => (await symbols(page)).length, { timeout: 60000, intervals: [500] }).toBe(3);

    const syms = (await symbols(page)).sort((a, b) => a.ref.localeCompare(b.ref));
    expect(syms).toEqual([
      { uuid: PWR, libId: "power:+5V", ref: "#PWR01", value: "+5V", footprint: "" },
      { uuid: R1, libId: "Device:R", ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" },
      { uuid: R2, libId: "Device:R", ref: "R2", value: "39", footprint: "Resistor_SMD:R_1206_3216Metric" },
    ]);

    const list = await nets(page);
    const { groups, byName } = shape(list);
    // Three nets with pins on this sheet; the power symbol's own pin is not listed.
    expect(groups).toEqual(["R1.1", "R1.2,R2.1", "R2.2"]);
    expect(byName["+5V"], "the power symbol names its net").toEqual(["R1.1"]);
    const all = list.flatMap((n) => n.pins);
    expect(all.some((p) => p.ref.startsWith("#")), "no #PWR pins").toBe(false);
    expect(all.find((p) => p.ref === "R2" && p.pin === "2")?.noConnect, "R2.2 carries the no-connect").toBe(true);
    expect(all.filter((p) => p.noConnect)).toHaveLength(1);
    expect(all.find((p) => p.ref === "R1" && p.pin === "1")).toMatchObject({ uuid: R1, libId: "Device:R" });

    // A committed edit (collab apply → SCH_COMMIT → RecalculateConnections):
    // tie R2.1 to +5V — the R1.2/R2.1 net merges into +5V.
    // Routed above the parts so it overlaps no existing segment.
    await page.evaluate(
      (ws) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabApplyItems(
          JSON.stringify({ added: ws.map((sexpr) => ({ sexpr })) }),
        ),
      [
        wire(101.6, 97.79, 101.6, 91.44, "bbbbbbbb-0000-0000-0000-000000000004"),
        wire(101.6, 91.44, 127, 91.44, "bbbbbbbb-0000-0000-0000-000000000005"),
        wire(127, 91.44, 127, 97.79, "bbbbbbbb-0000-0000-0000-000000000006"),
      ],
    );
    await expect
      .poll(async () => shape(await nets(page)).byName["+5V"] ?? [], { timeout: 25000, intervals: [400] })
      .toEqual(["R1.1", "R1.2", "R2.1"]);

    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });
});
