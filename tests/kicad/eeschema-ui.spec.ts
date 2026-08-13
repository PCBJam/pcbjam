import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { clickByTooltip, findByTooltip } from "../e2e/utils/element-tracker";

/**
 * Eeschema core-UI regressions found 2026-06-04 (both wasm-specific, both fixed):
 *
 *  - Backspace did nothing on a selection. ACTIONS::doDelete binds WXK_BACK only under
 *    __WXMAC__; our emscripten build is non-Mac so only WXK_DELETE was bound (and a Mac
 *    user's "delete" key sends Backspace). Fixed by an __EMSCRIPTEN__ DefaultHotkeyAlt(WXK_BACK)
 *    on doDelete + making ACTION_MANAGER::processHotKey apply default *alt* hotkeys.
 *
 *  - The text tool froze the app. createNewText shows DIALOG_TEXT_PROPERTIES via
 *    ShowQuasiModal, whose nested wxGUIEventLoop::DoRun re-entered emscripten_set_main_loop
 *    (simulate_infinite_loop → "unwind"), which can't be nested/resumed. Fixed by pumping
 *    nested event loops through Asyncify (wxwidgets/src/wasm/evtloop.cpp).
 */

const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000002"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = { kicadOpenFile(p: string): Promise<unknown>; kicadCollabSnapshot(): Promise<string> };

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => typeof (window as unknown as { Module?: Mod }).Module?.kicadCollabSnapshot === "function", null, { timeout: 90000 });
  await page.waitForFunction(
    () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({ visible: true }).some((e) => /Frame$/.test(e.typeName)),
    null,
    { timeout: 90000 },
  );
  await page.evaluate(async (content) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    try {
      w.FS.mkdirTree("/home/kicad/documents");
    } catch {
      /* exists */
    }
    const p = "/home/kicad/documents/ui.kicad_sch";
    w.FS.writeFile(p, content);
    await w.Module.kicadOpenFile(p);
  }, SAMPLE_SCH);
  // Wait for the async open to land the 2 fixture wires (deterministic — replaces a
  // fixed "let OpenProjectFiles settle" sleep).
  await expect.poll(() => count(page), { timeout: 90000, intervals: [300] }).toBe(2);
}

function count(page: Page): Promise<number> {
  return page.evaluate(async () =>
    JSON.parse(await window.Module.kicadCollabSnapshot()).added.length,
  );
}

async function focusCanvas(page: Page): Promise<void> {
  const box = await page.locator("#canvas").boundingBox();
  expect(box, "#canvas has a bounding box").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  // Small settle so the focus click is processed before the next keystroke — no
  // JS-observable "canvas focused" signal to poll (documented interaction wait).
  await page.waitForTimeout(300); // eslint-disable-line -- see comment above
}

test.describe("eeschema core UI (wasm)", () => {
  for (const key of ["Delete", "Backspace"]) {
    test(`${key} deletes the selection`, async ({ page, testLogger }) => {
      await bootAndOpen(page);
      expect(await count(page)).toBe(2);

      await focusCanvas(page);
      await page.keyboard.press("Control+a");
      // Let the select-all register before the delete key — selection state isn't
      // reflected in the item count, so there's no condition to poll (documented wait).
      await page.waitForTimeout(500); // eslint-disable-line -- see comment above
      await page.keyboard.press(key);

      await expect.poll(() => count(page), { timeout: 8000, intervals: [300] }).toBe(0);
      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    });
  }

  test("text tool opens its properties dialog and closes without freezing", async ({ page, testLogger }) => {
    await bootAndOpen(page);

    const dialogsOpen = () =>
      page.evaluate(() =>
        window.wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog/i.test(e.typeName)).length,
      );

    expect(await clickByTooltip(page, "Draw Text")).toBe(true);
    // Depending on where the synthetic click lands, wxWidgets can either latch
    // the tool first or immediately dispatch the canvas click and open the
    // properties dialog.  Both are valid observable states.
    await expect.poll(async () => {
      if (await dialogsOpen() > 0) {
        return true;
      }

      const t = await findByTooltip(page, "Draw Text", { elementType: "tool" });
      return (t?.label ?? "").includes("[checked]");
    }, { timeout: 5000, intervals: [200] }).toBe(true);

    if (await dialogsOpen() === 0) {
      const box = await page.locator("#canvas").boundingBox();
      expect(box, "#canvas has a bounding box").not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    }

    // The quasi-modal dialog must appear (previously the nested event loop threw "unwind").
    // Poll for it instead of a fixed 1500ms "let the dialog open" sleep.
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBeGreaterThan(0);
    // App must stay responsive while it's up (Asyncify suspend, not a frozen main thread).
    expect(await page.evaluate(() => 1 + 1).then(() => true).catch(() => false)).toBe(true);

    // Escape must close it — exercises the Asyncify resume (ShowQuasiModal returns).
    await page.keyboard.press("Escape");
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBe(0);

    // Still alive afterwards.
    expect(await count(page)).toBeGreaterThan(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
