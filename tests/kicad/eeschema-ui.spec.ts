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
 *    (simulate_infinite_loop → "unwind"), which can't be nested/resumed. Fixed by running
 *    nested event loops as suspending waits (wxwidgets/src/wasm/evtloop.cpp; asyncify
 *    then, JSPI now).
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
type Mod = { kicadOpenFile(p: string): unknown; kicadCollabSnapshot(): string };

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
  await page.evaluate((content) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    try {
      w.FS.mkdirTree("/home/kicad/documents");
    } catch {
      /* exists */
    }
    const p = "/home/kicad/documents/ui.kicad_sch";
    w.FS.writeFile(p, content);
    w.Module.kicadOpenFile(p);
  }, SAMPLE_SCH);
  // Wait for the async open to land the 2 fixture wires (deterministic — replaces a
  // fixed "let OpenProjectFiles settle" sleep).
  await expect.poll(() => count(page), { timeout: 90000, intervals: [300] }).toBe(2);
}

function count(page: Page): Promise<number> {
  return page.evaluate(() => JSON.parse(window.Module.kicadCollabSnapshot()).added.length);
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

    expect(await clickByTooltip(page, "Draw Text")).toBe(true);
    // Wait for the tool to latch selected (replaces a fixed 600ms).
    await expect.poll(async () => {
      const t = await findByTooltip(page, "Draw Text", { elementType: "tool" });
      return (t?.label ?? "").includes("[checked]");
    }, { timeout: 5000, intervals: [200] }).toBe(true);

    const box = await page.locator("#canvas").boundingBox();
    expect(box, "#canvas has a bounding box").not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const dialogsOpen = () =>
      page.evaluate(() =>
        window.wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog/i.test(e.typeName)).length,
      );

    // The quasi-modal dialog must appear (previously the nested event loop threw "unwind").
    // Poll for it instead of a fixed 1500ms "let the dialog open" sleep.
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBeGreaterThan(0);
    // App must stay responsive while it's up (JSPI suspend, not a frozen main thread).
    expect(await page.evaluate(() => 1 + 1).then(() => true).catch(() => false)).toBe(true);

    // Escape must close it — exercises the suspension resume (ShowQuasiModal returns).
    await page.keyboard.press("Escape");
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBe(0);

    // Still alive afterwards.
    expect(await count(page)).toBeGreaterThan(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  /**
   * Regression: unpositioned dialogs must open CENTRED, not at the (0,0) origin.
   *
   * The wasm port maps wxDefaultPosition to a literal (0,0) with no platform
   * centring (native ports get it from the window manager / CW_USEDEFAULT).
   * That was masked for years by DIALOG_SHIM::Show re-centring every dialog
   * whenever wxDisplay::GetFromWindow() returned wxNOT_FOUND — which it always
   * did here until the display-index fix. With the lookup working, dialogs
   * surfaced at the origin; on CI the text-properties dialog then opened UNDER
   * the just-clicked canvas-centre point with its OK/Cancel corner at the
   * pointer, swallowed the trailing mouse event, and insta-closed (staging run
   * 32739091966: the dialog exists in exactly one trace snapshot). The port
   * now centres any dialog still at the default spot when first shown.
   */
  test("text properties dialog opens centred, not at the top-left origin", async ({ page, testLogger }) => {
    await bootAndOpen(page);

    expect(await clickByTooltip(page, "Draw Text")).toBe(true);
    await expect.poll(async () => {
      const t = await findByTooltip(page, "Draw Text", { elementType: "tool" });
      return (t?.label ?? "").includes("[checked]");
    }, { timeout: 5000, intervals: [200] }).toBe(true);

    const box = await page.locator("#canvas").boundingBox();
    expect(box, "#canvas has a bounding box").not.toBeNull();
    // Click a point AWAY from where a centred dialog will sit, so the dialog can
    // never land under the pointer regardless of centring (the CI insta-close mode).
    await page.mouse.click(box!.x + box!.width * 0.85, box!.y + box!.height * 0.85);

    const dialogsOpen = () =>
      page.evaluate(() =>
        window.wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog/i.test(e.typeName)).length,
      );
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBeGreaterThan(0);

    // The dialog window div (the newest window-N) must be roughly viewport-centred.
    const geo = await page.evaluate(() => {
      const wins = Array.from(document.querySelectorAll<HTMLElement>("#window-container [id^=\"window-\"]"));
      const w = wins[wins.length - 1];
      return {
        id: w.id,
        left: parseInt(w.style.left || "0", 10) || 0,
        top: parseInt(w.style.top || "0", 10) || 0,
        width: parseInt(w.style.width || "0", 10) || 0,
        height: parseInt(w.style.height || "0", 10) || 0,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    console.log(`[TEST] dialog geometry: ${JSON.stringify(geo)}`);
    const cx = geo.left + geo.width / 2;
    const cy = geo.top + geo.height / 2;
    expect(Math.abs(cx - geo.vw / 2),
      `dialog ${geo.id} horizontal centre ${cx} should be near viewport centre ${geo.vw / 2} `
      + `(left=${geo.left} — 0 means the port skipped default-position centring)`)
      .toBeLessThanOrEqual(60);
    expect(Math.abs(cy - geo.vh / 2),
      `dialog ${geo.id} vertical centre ${cy} should be near viewport centre ${geo.vh / 2} `
      + `(top=${geo.top} — 0 means the port skipped default-position centring)`)
      .toBeLessThanOrEqual(60);

    await page.keyboard.press("Escape");
    await expect.poll(dialogsOpen, { timeout: 8000, intervals: [300] }).toBe(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
