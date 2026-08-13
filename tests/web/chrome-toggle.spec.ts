import { test, expect, type Browser, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';
import { shotPath } from '../e2e/utils/element-tracker';

// One shared page across ORDERED tests (beforeAll boot; the restore test needs
// the hide test's end state). Must stay a serial group in one worker —
// fullyParallel would hand each test a fresh full-chrome boot, turning the
// restore click into a hide and multiplying wasm boots.
test.describe.configure({ mode: 'serial' });

/**
 * Figma-like "hide UI" toggle e2e (desktop): Cmd/Ctrl+\ and the floating
 * button flip the editor between full UI and canvas-only, and a restore
 * brings back EXACTLY the chrome that was visible before — panes KiCad keeps
 * hidden by default (Search, Properties, …) must not appear. That last part
 * is asserted geometrically: the GAL canvas box after hide→show must equal
 * the pre-hide box (an over-shown panel would shrink the AUI center pane).
 *
 * Boots once (beforeAll) and runs the round trip over the shared page —
 * the config is workers:1 / fullyParallel:false, so file order holds.
 */

const SCOPE = 'default';
const FRONTEND_URL = process.env.WEB_APP_URL ?? 'http://localhost:3048';

let page: Page;
/** Full-UI GAL canvas box captured before the first hide — the restore-exactness baseline. */
let fullUiBox: { x: number; y: number; width: number; height: number };

/** Count of visible menubar titles (0 ⇒ menubar hidden). */
async function visibleMenuTitles(pg: Page): Promise<number> {
  return pg.evaluate(
    () =>
      Array.from(document.querySelectorAll('.wx-menu-title')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      }).length,
  );
}

/** The visible GAL WebGL canvas box (same lookup as mobile-editor.spec.ts). */
async function getGlBox(pg: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const id = await pg.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find((c) => {
        const rect = c.getBoundingClientRect();
        return window.getComputedStyle(c).display !== 'none' && rect.width > 0 && rect.height > 0;
      });
    return (visible ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null))?.id ?? null;
  });
  if (!id) throw new Error('No visible GL canvas found');
  const box = await pg.locator(`#${id}`).boundingBox();
  if (!box) throw new Error('GL canvas bounding box unavailable');
  return box;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(420_000); // cold load: 136 MB wasm download + compile
  page = await browser.newPage({ baseURL: FRONTEND_URL });
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/demo — PCB Editor/i);
  // Loading overlays (boot + lib fat-load, both `inset-0 z-30`) must be gone
  // before geometry is trusted.
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
  // The WRL→STEP migration notice self-dismisses after 10 s
  // (pcb_edit_frame.cpp ShowMessageFor) and shifts the GL canvas when it
  // goes — wait it out so the pre-hide baseline and the post-restore box
  // are measured in the same layout. It is shown synchronously during the
  // file load the title poll above already gates on, and its DOM node
  // outlives the dismiss, so wait for hidden, not absent. The un-timed
  // "older version of KiCad" infobar stays up on both sides of the
  // comparison, so it cancels out.
  await expect(page.getByText(/WRL 3D model/)).toBeHidden({ timeout: 30000 });
});

test.afterAll(async () => {
  await page?.close();
});

test('Ctrl+\\ hides every non-canvas UI element; the canvas reclaims the viewport', async () => {
  test.setTimeout(120_000);
  const vp = page.viewportSize()!;

  // full-UI baseline: menubar + console footer present, canvas NOT full-bleed
  expect(await visibleMenuTitles(page), 'menubar visible before hide').toBeGreaterThan(0);
  await expect(page.getByText(/console \(/)).toHaveCount(1);
  fullUiBox = await getGlBox(page);
  expect(fullUiBox.width, 'chrome occupies width before hide').toBeLessThan(vp.width * 0.95);

  await page.keyboard.press('Control+\\');

  await expect.poll(() => visibleMenuTitles(page), { timeout: 15000 }).toBe(0);
  await expect
    .poll(async () => (await getGlBox(page)).width, { timeout: 15000 })
    .toBeGreaterThan(vp.width * 0.95);
  expect((await getGlBox(page)).height, 'GL canvas height ≈ viewport').toBeGreaterThan(
    vp.height * 0.9,
  );
  // shell overlays follow the toggle…
  await expect(page.getByText(/console \(/)).toHaveCount(0);
  // …but the toggle stays reachable inside the overlay menu (0010) — the
  // FAB is the canvas-only survivor.
  await openOverlayMenu(page);
  await expect(page.locator('[data-testid="chrome-toggle"]')).toBeVisible();

  await page.screenshot({ path: shotPath(page, 'web-chrome-hidden.png'), scale: 'css' });
});

test('the floating button restores EXACTLY the pre-hide chrome (no over-shown panes)', async () => {
  test.setTimeout(120_000);

  // still hidden from the previous test — restore via the button (in the menu)
  await openOverlayMenu(page);
  await page.locator('[data-testid="chrome-toggle"]').click();

  await expect.poll(() => visibleMenuTitles(page), { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.getByText(/console \(/)).toHaveCount(1);

  // The restored GAL canvas box must MATCH the pre-hide baseline: a blanket
  // Show(true) would also reveal KiCad's default-hidden panels (Search,
  // Properties, …), shrinking the AUI center pane and moving this box.
  await expect
    .poll(
      async () => {
        const b = await getGlBox(page);
        return (
          Math.abs(b.x - fullUiBox.x) <= 3 &&
          Math.abs(b.y - fullUiBox.y) <= 3 &&
          Math.abs(b.width - fullUiBox.width) <= 3 &&
          Math.abs(b.height - fullUiBox.height) <= 3
        );
      },
      {
        message: 'restored GL canvas box must equal the pre-hide baseline (over-shown pane?)',
        timeout: 15000,
      },
    )
    .toBe(true);

  // hotkey round trip still works after a button toggle
  await page.keyboard.press('Control+\\'); // hide
  await expect.poll(() => visibleMenuTitles(page), { timeout: 15000 }).toBe(0);
  await page.keyboard.press('Control+\\'); // show
  await expect.poll(() => visibleMenuTitles(page), { timeout: 15000 }).toBeGreaterThan(0);

  await page.screenshot({ path: shotPath(page, 'web-chrome-restored.png'), scale: 'css' });
});

test('rapid hide→show keeps the latest intent after an older owner ticket was admitted', async () => {
  test.setTimeout(120_000);

  // Do not wait for the native hide to settle before publishing the opposite
  // intent. The former implementation compared against the last *completed*
  // value, so this second event saw "already shown", submitted no correction,
  // and the older hide won when its Promise eventually completed.
  for (let cycle = 0; cycle < 20; cycle++) {
    await page.keyboard.press('Control+\\'); // submit hide
    await page.keyboard.press('Control+\\'); // replace it with show

    await expect
      .poll(() => visibleMenuTitles(page), {
        timeout: 15_000,
        message: `cycle ${cycle + 1}: native chrome must match the latest show intent`,
      })
      .toBeGreaterThan(0);
  }

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scheduler = (
            globalThis as typeof globalThis & {
              __wxScheduler?: {
                mutatorJobs?: { size?: number };
                mutatorInFlight?: number;
              };
            }
          ).__wxScheduler;
          return {
            pending: scheduler?.mutatorJobs?.size ?? 0,
            inFlight: scheduler?.mutatorInFlight ?? 0,
          };
        }),
      { timeout: 15_000, message: 'the chrome owner lane must quiesce after the ABA storm' },
    )
    .toEqual({ pending: 0, inFlight: 0 });
});
