/**
 * Horizontal wheel scrolls a wx grid (issue #35).
 *
 * The browser WheelEvent's deltaX never reached wx: the canvas WheelCallback
 * (src/wasm/app.cpp) built the horizontal wxMouseEvent and dropped it, and the
 * DOM-control path (wx_dom_mouse, domevents.cpp) only took deltaY. A trackpad
 * sideways swipe or shift+wheel (the browser sends both as deltaX) did
 * nothing in the Symbol Fields Table, whose columns overflow sideways: only
 * dragging the scrollbar moved it. Now each axis becomes its own
 * wxEVT_MOUSEWHEEL, and wxScrollHelper scrolls the grid on the horizontal one.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForRenderedByLabel, stableShot } from "../e2e/utils/element-tracker";

const DIR = "/home/kicad/documents";
const FILE = `${DIR}/grid-wheel.kicad_sch`;

// Long field values so the auto-sized columns overflow the dialog's width.
const LONG = "x".repeat(160);
const FIELDS = ["Manufacturer", "MPN", "Supplier", "SupplierPN", "Tolerance", "Power"]
  .map((n, i) => `\t\t(property "${n}" "${n}-${LONG}" (at 100 ${110 + i} 0) (effects (font (size 1.27 1.27)) (hide yes)))`)
  .join("\n");

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000035")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R"
\t\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54)
\t\t\t\t\t(stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t)
\t)
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 100 100 0)
\t\t(unit 1)
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "dddd0000-0000-0000-0000-000000000035")
\t\t(property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "10k-${LONG}" (at 102 101 0) (effects (font (size 1.27 1.27))))
\t\t(property "Datasheet" "https://example.com/${LONG}" (at 100 100 0) (effects (font (size 1.27 1.27)) (hide yes)))
${FIELDS}
\t\t(instances (project "grid-wheel" (path "/cccc0000-0000-0000-0000-000000000035" (reference "R1") (unit 1))))
\t)
)`;

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadTestRunAction(name: string): unknown;
};
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 120000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadOpenFile === "function",
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 120000 },
  );
  await page.evaluate(
    ({ sch, dir, file }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      w.FS.writeFile(file, sch);
      w.Module.kicadOpenFile(file);
    },
    { sch: SCH, dir: DIR, file: FILE },
  );
  await expect
    .poll(() => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()), {
      timeout: 120000,
      intervals: [250],
    })
    .toBe(false);
}

type Gutter = { pos: number; range: number; thumb: number; x: number; y: number; w: number };

/** Visible horizontal scrollbar gutters that can actually scroll. */
const horizontalGutters = (page: Page): Promise<Gutter[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-wx-scrollbar]"))
      .map((el) => el as HTMLElement & { _wxSb?: { pos: number; range: number; thumb: number; vertical: boolean } })
      .filter((el) => el._wxSb && !el._wxSb.vertical && getComputedStyle(el).display !== "none")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { pos: el._wxSb!.pos, range: el._wxSb!.range, thumb: el._wxSb!.thumb, x: r.x, y: r.y, w: r.width };
      })
      .filter((g) => g.w > 0 && g.range > g.thumb),
  );

test.describe("wx grid: horizontal wheel", () => {
  test.setTimeout(240000);

  test("Symbol Fields Table scrolls sideways on a horizontal wheel", async ({ page }) => {
    await bootAndOpen(page);
    await page.evaluate(() =>
      (window.Module as unknown as Mod).kicadTestRunAction("eeschema.EditorControl.editSymbolFields"),
    );
    // the data grid (the dialog's left grid lists the fields); its own
    // horizontal gutter is the one below the R1 cell
    const cell = await waitForRenderedByLabel(page, "R1", { elementType: "gridcell", timeout: 30000 });
    let gutter: Gutter | undefined;
    await expect
      .poll(
        async () => {
          gutter = (await horizontalGutters(page)).find(
            (g) => g.y > cell.screenY && g.x <= cell.centerX && g.x + g.w >= cell.centerX,
          );
          return !!gutter;
        },
        { message: "the fields grid overflows sideways (a horizontal gutter)", timeout: 20000 },
      )
      .toBe(true);
    expect(gutter!.pos, "starts scrolled to the left").toBe(0);
    await stableShot(page, "grid-wheel-horizontal-01-before.png");

    const at = { x: cell.centerX, y: cell.centerY };
    await page.mouse.move(at.x, at.y);

    await page.mouse.wheel(240, 0);
    const sameGutter = async () =>
      (await horizontalGutters(page)).find((g) => Math.abs(g.y - gutter!.y) < 2 && Math.abs(g.x - gutter!.x) < 2);
    await expect
      .poll(async () => (await sameGutter())?.pos ?? -1, { message: "deltaX scrolls the grid right" })
      .toBeGreaterThan(0);
    const moved = (await sameGutter())!.pos;
    await stableShot(page, "grid-wheel-horizontal-02-scrolled.png");

    await page.mouse.wheel(-240, 0);
    await expect
      .poll(async () => (await sameGutter())?.pos ?? -1, { message: "negative deltaX scrolls back left" })
      .toBeLessThan(moved);
  });
});
