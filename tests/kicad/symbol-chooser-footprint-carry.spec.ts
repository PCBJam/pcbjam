/**
 * Add Symbol: a symbol is placed with ITS footprint, not the previous
 * selection's.
 *
 * PANEL_SYMBOL_CHOOSER writes the selected symbol's default footprint into its
 * field edits (onFootprintSelected), and PickSymbolFromLibrary copies those
 * edits onto the placed symbol. Without clearing them on the next selection, a
 * symbol with no default footprint inherited the previous one's: select an MCU,
 * then a mounting hole, place, and the hole carried the MCU's 16-pin footprint
 * while the selector said "No default footprint". Upstream fixed it (KiCad
 * issue 25538, c3f0e1723f "Clear field edits when symbol changes", in 10.0.7);
 * production still ran the earlier fork. This spec guards it.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { settledShot } from "../e2e/utils/element-tracker";

const DIR = "/home/kicad/documents/fpcarry";
const STEM = "fpcarry";

const SYMBOL = (name: string, footprint: string) => `\t(symbol "${name}"
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t(property "Reference" "U" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "${name}" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
\t\t(property "Footprint" "${footprint}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(symbol "${name}_0_1"
\t\t\t(rectangle (start -2.54 1.27) (end 2.54 -1.27) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t)
\t\t(symbol "${name}_1_1"
\t\t\t(pin passive line (at -5.08 0 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t)
\t)`;

const LIB = `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
${SYMBOL("CarryMcu", "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm")}
${SYMBOL("CarryHole", "")}
)`;

const SYM_LIB_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "CarryLib") (type "KiCad") (uri "\${KIPRJMOD}/CarryLib.kicad_sym") (options "") (descr ""))
)`;

const SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000031")
\t(paper "A4")
\t(lib_symbols)
)`;

const PRO = JSON.stringify({ meta: { filename: `${STEM}.kicad_pro`, version: 3 } });

type Sym = { libId: string; footprint: string };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadTestRunAction(n: string): boolean;
  kicadSheetSymbols(): string;
};

async function boot(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 120000 });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadOpenFile === "function" &&
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 120000 },
  );
  await page.evaluate(
    ({ dir, stem, files }) => {
      const w = window as unknown as { FS: any; Module: Mod };
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      for (const [name, body] of Object.entries(files)) w.FS.writeFile(`${dir}/${name}`, body);
      w.Module.kicadOpenFile(`${dir}/${stem}.kicad_sch`);
    },
    {
      dir: DIR,
      stem: STEM,
      files: {
        [`${STEM}.kicad_pro`]: PRO,
        [`${STEM}.kicad_sch`]: SCH,
        "sym-lib-table": SYM_LIB_TABLE,
        "CarryLib.kicad_sym": LIB,
      } as Record<string, string>,
    },
  );
  await expect
    .poll(() => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()), {
      timeout: 120000,
      intervals: [250],
    })
    .toBe(false);
}

const chooserUp = (page: Page) =>
  page.evaluate(() =>
    window.wxElementRegistry.findAll({ visible: true }).some((e) => /^&?Cancel$/i.test(e.label ?? "")),
  );

/** Filter the chooser's tree to `query` and select the first hit. */
async function selectSymbol(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(query, { delay: 40 });
  await settledShot(page, expect);
  await page.keyboard.press("ArrowDown");
  await settledShot(page, expect);
}

const sheetSymbols = (page: Page): Promise<Sym[]> =>
  page.evaluate(() => JSON.parse((window.Module as unknown as Mod).kicadSheetSymbols()));

test("Add Symbol: a symbol without a default footprint does not inherit the previous selection's", async ({
  page,
}) => {
  test.setTimeout(300000);
  await boot(page);

  const box = (await page.locator("#canvas").boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);

  await page.evaluate(() =>
    (window.Module as unknown as Mod).kicadTestRunAction("eeschema.InteractiveDrawing.placeSymbol"),
  );
  await expect.poll(() => chooserUp(page), { message: "the symbol chooser opens", timeout: 60000 }).toBe(true);

  // The MCU first: its default footprint goes into the chooser's field edits.
  await selectSymbol(page, "CarryMcu");
  // Then the hole, which has none, and place it.
  await selectSymbol(page, "CarryHole");
  await page.keyboard.press("Enter");
  await expect.poll(() => chooserUp(page), { message: "the chooser closes", timeout: 30000 }).toBe(false);

  await page.mouse.move(at.x + 20, at.y + 20);
  await page.mouse.click(at.x + 20, at.y + 20);
  await expect
    .poll(async () => (await sheetSymbols(page)).filter((s) => s.libId.endsWith(":CarryHole")).length, {
      message: "the hole is placed",
      timeout: 30000,
    })
    .toBe(1);
  await page.keyboard.press("Escape");

  const hole = (await sheetSymbols(page)).find((s) => s.libId.endsWith(":CarryHole"))!;
  expect(hole.footprint, "the hole keeps its (empty) footprint").toBe("");
});
