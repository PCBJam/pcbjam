import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Schematic connectivity must not join points that merely lie at the same
 * distance from the sheet origin (overlay-system 0004 finding).
 *
 * VECTOR2::operator< compares squared lengths; KiCad keys its connection maps
 * (`std::map<VECTOR2I, …>`) on the lexicographic `std::less<VECTOR2I>`
 * specialization instead. libc++ 22's map bypasses a program's `std::less`
 * specialization (it "desugars" `std::less<T>` to `operator<`), so every
 * mirrored pair of points — (a, b) and (b, a) — became one connection point:
 * two pins nothing joins were reported (and netlisted) as one net.
 *
 *   R1 at (50.8, 72.39): pin 2 at (50.8, 76.2)
 *   R2 at (76.2, 54.61): pin 1 at (76.2, 50.8)   ← same distance from (0, 0)
 */
type Mod = { kicadOpenFile(p: string): unknown; kicadSheetNets(): string };
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Net = { net: string; pins: { ref: string; pin: string }[] };

const BOOT_TIMEOUT = 150000;
const DIR = "/home/kicad/documents/probe";
const ROOT = "22222222-2222-2222-2222-222222222222";
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
const inst = (uuid: string, x: number, y: number, ref: string) =>
  `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
    (property "Reference" "${ref}" (at ${x + 2} ${y} 90) ${font})
    (property "Value" "1k" (at ${x} ${y} 90) ${font})
    (property "Footprint" "" (at ${x} ${y} 0) ${hidden})
    (property "Datasheet" "" (at ${x} ${y} 0) ${hidden})
    (pin "1" (uuid "${uuid.slice(0, -2)}1f")) (pin "2" (uuid "${uuid.slice(0, -2)}2f"))
    (instances (project "probe" (path "/${ROOT}" (reference "${ref}") (unit 1)))))`;

const FIXTURE = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "9.0")
  (uuid "${ROOT}")
  (paper "A4")
  (lib_symbols ${LIB_R})
  ${inst("aaaaaaaa-0000-0000-0000-000000000011", 50.8, 72.39, "R1")}
  ${inst("aaaaaaaa-0000-0000-0000-000000000012", 76.2, 54.61, "R2")}
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

/** Nets as sorted "REF.PIN" groups. */
const groups = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse((window as unknown as { Module: Mod }).Module.kicadSheetNets()) as Net[])
      .map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(","))
      .sort(),
  );

test.describe("schematic connectivity: points at equal distance from the origin", () => {
  test.describe.configure({ timeout: 420000 });

  test("mirrored pin positions stay separate nets", async ({ page, testLogger }) => {
    await bootAndOpen(page);
    // Four unconnected pins: four nets. The bug reported "R1.2,R2.1" as one net.
    await expect.poll(() => groups(page), { timeout: 60000, intervals: [500] }).toEqual(["R1.1", "R1.2", "R2.1", "R2.2"]);
    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });
});
