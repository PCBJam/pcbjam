/**
 * Add Symbol many times in a row: the schematic keeps its WebGL canvas.
 *
 * Every opening of the symbol chooser makes WebGL canvases for its previews.
 * Closing them only dropped the references (emscripten_webgl_destroy_context),
 * so the browser kept those contexts alive until its next garbage collection,
 * and Chromium gives a page 16 live ones. At the fifth opening it took the
 * OLDEST away, which is the schematic's own ("Too many active WebGL contexts.
 * Oldest context will be lost."). The sheet then fell back to software drawing
 * with no `#glcanvas-*` element on the page, so everything that is placed over
 * that element (live simulation widgets, comment pins, overlays) had nothing to
 * hold on to.
 *
 * The fix (wx.js `destroyGLCanvas`) hands a closed canvas's context back to the
 * browser at once. This spec guards it.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { settledShot } from "../e2e/utils/element-tracker";

const DIR = "/home/kicad/documents/glctx";
const STEM = "glctx";
/** The sheet's context went at the fifth opening; a few more for good measure. */
const OPENINGS = 7;

const LIB = `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
\t(symbol "CtxPart"
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t(property "Reference" "U" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "CtxPart" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
\t\t(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(symbol "CtxPart_0_1"
\t\t\t(rectangle (start -2.54 1.27) (end 2.54 -1.27) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t)
\t\t(symbol "CtxPart_1_1"
\t\t\t(pin passive line (at -5.08 0 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t)
\t)
)`;

const SYM_LIB_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "CtxLib") (type "KiCad") (uri "\${KIPRJMOD}/CtxLib.kicad_sym") (options "") (descr ""))
)`;

const SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000047")
\t(paper "A4")
\t(lib_symbols)
)`;

const PRO = JSON.stringify({ meta: { filename: `${STEM}.kicad_pro`, version: 3 } });

type Sym = { libId: string };
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
        "CtxLib.kicad_sym": LIB,
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

/**
 * The chooser has the part selected and shows its previews. Under the footprint preview it
 * says "No footprint specified" only while a symbol without a footprint is selected, and
 * CtxPart has none.
 */
const partPreviewed = (page: Page) =>
  page.evaluate(() =>
    window.wxElementRegistry.findAll({ visible: true }).some((e) => e.label === "No footprint specified"),
  );

const placedParts = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (JSON.parse((window.Module as unknown as Mod).kicadSheetSymbols()) as Sym[]).filter((s) =>
        s.libId.endsWith(":CtxPart"),
      ).length,
  );

/** The schematic is drawn on a WebGL canvas of the page, and that canvas still has its context. */
const sheetHasItsWebGLCanvas = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const shown = Array.from(document.querySelectorAll<HTMLCanvasElement>('[id^="glcanvas-"]')).filter(
      (c) => getComputedStyle(c).display !== "none" && c.getBoundingClientRect().width > 0,
    );
    const sheet = shown.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const gl = sheet?.getContext("webgl2");
    return !!gl && !gl.isContextLost();
  });

test("Add Symbol many times in a row: the schematic keeps its WebGL canvas", async ({ page }) => {
  test.setTimeout(300000);

  const droppedContexts: string[] = [];
  page.on("console", (m) => {
    if (/too many active webgl contexts/i.test(m.text())) droppedContexts.push(m.text());
  });

  await boot(page);
  await expect
    .poll(() => sheetHasItsWebGLCanvas(page), { message: "the sheet starts on a WebGL canvas", timeout: 60000 })
    .toBe(true);

  const box = (await page.locator("#canvas").boundingBox())!;
  const first = { x: box.x + box.width / 2 - 150, y: box.y + box.height / 2 };

  for (let i = 0; i < OPENINGS; i++) {
    const at = { x: first.x + 45 * i, y: first.y };
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() =>
      (window.Module as unknown as Mod).kicadTestRunAction("eeschema.InteractiveDrawing.placeSymbol"),
    );
    await expect
      .poll(() => chooserUp(page), { message: `opening ${i + 1}: the symbol chooser opens`, timeout: 60000 })
      .toBe(true);

    // The chooser opens with the part selected, so its previews really draw: the first time
    // because the project's one library holds one symbol, after that because KiCad selects
    // the part that was used last. Nothing is typed into the search box: KiCad applies a
    // search 200 ms after the last key and then selects the first hit, which from the second
    // opening on is the copy under "Recently Used", with the heading "Already Placed" below
    // it. A key pressed next would act before or after that, depending on the machine.
    await expect
      .poll(() => partPreviewed(page), { message: `opening ${i + 1}: the chooser previews the part`, timeout: 30000 })
      .toBe(true);
    await settledShot(page, expect);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => chooserUp(page), { message: `opening ${i + 1}: the chooser closes`, timeout: 30000 })
      .toBe(false);

    await page.mouse.move(at.x + 10, at.y + 10);
    await page.mouse.click(at.x + 10, at.y + 10);
    await expect
      .poll(() => placedParts(page), { message: `opening ${i + 1}: the part is placed`, timeout: 30000 })
      .toBe(i + 1);
    await page.keyboard.press("Escape");
  }

  expect(droppedContexts, "the browser took no WebGL context away").toEqual([]);
  expect(await sheetHasItsWebGLCanvas(page), "the sheet is still drawn on its WebGL canvas").toBe(true);
});
