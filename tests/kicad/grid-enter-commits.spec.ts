/**
 * Enter in a grid cell editor commits the typed text (issue #36).
 *
 * Schematic Setup → Project → Text Variables: typing into a value cell and
 * pressing Enter removed the text. The cell editor is a wx-dom <input>; its
 * Enter went to wx as EVT.ENTER → wxEVT_CHAR_HOOK, where GRID_TRICKS commits
 * on the last row and the grid takes focus. That blurred the input before the
 * browser sent the same Enter's keypress, which then reached the canvas
 * KeyCallback as a second wxEVT_CHAR(WXK_RETURN): wxGrid reopened the editor
 * with it and wrote '\r' over the committed value. On the other rows Enter
 * did nothing, since no wxEVT_KEY_DOWN reached the cell editor's handler
 * (native: commit and move down).
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  clickMenuBarItem,
  clickMenuItemByText,
  clickTreeItem,
  findGridCell,
  waitForRenderedByLabel,
  stableShot,
} from "../e2e/utils/element-tracker";

const STEM = "grid-enter";
const DIR = "/home/kicad/documents";
const SCH_FILE = `${DIR}/${STEM}.kicad_sch`;
const PRO_FILE = `${DIR}/${STEM}.kicad_pro`;

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000036")
\t(paper "A4")
\t(lib_symbols)
)`;

const PRO = JSON.stringify({
  meta: { filename: `${STEM}.kicad_pro`, version: 3 },
  text_variables: { ALPHA: "one", BETA: "two" },
});

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
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
    ({ sch, pro, dir, schFile, proFile }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      w.FS.writeFile(proFile, pro);
      w.FS.writeFile(schFile, sch);
      w.Module.kicadOpenFile(schFile);
    },
    { sch: SCH, pro: PRO, dir: DIR, schFile: SCH_FILE, proFile: PRO_FILE },
  );
  await expect
    .poll(() => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()), {
      timeout: 120000,
      intervals: [250],
    })
    .toBe(false);
}

async function openTextVariables(page: Page): Promise<void> {
  expect(await clickMenuBarItem(page, "File"), "File menu").toBe(true);
  await clickMenuItemByText(page, "Schematic Setup");
  await waitForRenderedByLabel(page, "Text Variables", { elementType: "treeitem", timeout: 30000 });
  expect(await clickTreeItem(page, "Text Variables"), "Text Variables page").toBe(true);
  await waitForRenderedByLabel(page, "ALPHA", { elementType: "gridcell", timeout: 20000 });
}

const cellLabel = async (page: Page, row: number, col: number) =>
  (await findGridCell(page, row, col))?.label ?? null;

/** Visible wx-dom text inputs: an open cell editor shows up here. */
const visibleEditors = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("input.wx-dom-control[type=text]"))
      .map((i) => i as HTMLInputElement)
      .filter((i) => i.style.display !== "none" && i.getBoundingClientRect().width > 0)
      .map((i) => i.value),
  );

/** Open the value cell's editor, replace its text, press Enter. */
async function typeIntoValueCell(page: Page, row: number, text: string): Promise<void> {
  const cell = await findGridCell(page, row, 1);
  expect(cell, `value cell of row ${row}`).not.toBeNull();
  await page.mouse.dblclick(cell!.centerX, cell!.centerY);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""), {
      message: "the cell editor input takes focus",
    })
    .toBe("INPUT");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test.describe("grid cell editor: Enter commits", () => {
  test.setTimeout(240000);

  test("Text Variables: Enter keeps the typed value, on the last row and above it", async ({ page }) => {
    await bootAndOpen(page);
    await openTextVariables(page);
    expect(await cellLabel(page, 1, 1)).toBe("two");

    // last row: GRID_TRICKS commits on the char hook, then the stray keypress
    await typeIntoValueCell(page, 1, "second");
    await expect.poll(() => cellLabel(page, 1, 1), { message: "last row keeps its text" }).toBe("second");
    await expect
      .poll(async () => (await visibleEditors(page)).some((v) => v === "" || v === "second"), {
        message: "the editor is not reopened by the Enter",
      })
      .toBe(false);
    await stableShot(page, "grid-enter-commits-01-last-row.png");

    // a row above the last: the cell editor's own KEY_DOWN handler commits
    await typeIntoValueCell(page, 0, "first");
    await expect.poll(() => cellLabel(page, 0, 1), { message: "row 0 commits on Enter" }).toBe("first");
    expect(await cellLabel(page, 1, 1), "row 1 unchanged").toBe("second");
  });
});
