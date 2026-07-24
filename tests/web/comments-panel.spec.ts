import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Floating comments panel e2e (comments-ux 0001 B): the list is a draggable
 * window with its own scrollbar, independent of the overlay menu, with an
 * always-onscreen restore guarantee (a stored position that no longer fits
 * the viewport — e.g. a gone secondary display — resets to the default
 * anchor; live shrinks clamp it back in).
 */

const SCOPE = 'default';
const ROUTE = 'demo.kicad_sch';
const TITLE = /demo — Schematic Editor/i;

async function bootAs(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(TITLE);
  await openOverlayMenu(page);
  await expect(page.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30000 });
}

async function resetComments(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctl = (window as unknown as {
      __pcbjamComments?: {
        threads(): Array<{ id: string }>;
        deleteThread(id: string): void;
        create(anchor: { pos: { x: number; y: number } }, body: string): string;
      };
    }).__pcbjamComments;
    ctl?.threads().forEach((t) => ctl.deleteThread(t.id));
  });
  await expect(page.getByTestId('comment-pin')).toHaveCount(0);
}

function createThread(page: Page, body: string, x: number): Promise<void> {
  return page.evaluate(
    ([bodyText, wx]) => {
      const ctl = (window as unknown as {
        __pcbjamComments: {
          create(anchor: { pos: { x: number; y: number } }, body: string): string;
        };
      }).__pcbjamComments;
      ctl.create({ pos: { x: Number(wx), y: 0 } }, String(bodyText));
    },
    [body, String(x)],
  );
}

test('floating panel: open, scroll, drag, offscreen-reset, clamp', async ({ page }) => {
  test.setTimeout(300000); // one full tool boot

  await bootAs(page, 'alice');
  await resetComments(page);

  for (let i = 0; i < 12; i++) await createThread(page, `note ${i}`, i * 100000);

  // A stored position from a "bigger display" must NOT be honored: the panel
  // opens at its default anchor instead. (Legacy px entry deliberately.)
  await page.evaluate(() =>
    localStorage.setItem('pcbjam:comments-panel-pos', JSON.stringify({ x: 5000, y: 120 })),
  );

  await openOverlayMenu(page);
  await page.getByTestId('comment-panel-toggle').click();
  const panel = page.getByTestId('comments-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('comment-panel-item')).toHaveCount(12);

  const vp = page.viewportSize()!;
  let box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.x).toBeGreaterThanOrEqual(-1);

  // The list scrolls inside the panel (12 rows > max height).
  const scrollable = await page
    .getByTestId('comments-panel-list')
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrollable).toBe(true);

  // Header carries the primary comment actions: "+" arms comment mode
  // (click catcher appears), the eye hides the pin hit targets.
  await page.getByTestId('comments-panel-add').click();
  await expect(page.getByTestId('comment-click-catcher')).toBeVisible();
  await page.getByTestId('comments-panel-add').click(); // cancel again
  await expect(page.getByTestId('comment-click-catcher')).toHaveCount(0);
  await page.getByTestId('comments-panel-pins').click();
  await expect(page.getByTestId('comment-pin')).toHaveCount(0);
  await page.getByTestId('comments-panel-pins').click();
  // ≥1, not 12: pins whose anchors fall outside the viewport render no DOM
  // hit target (culling), and the fit depends on the demo sheet.
  await expect(page.getByTestId('comment-pin').first()).toBeVisible();

  // Collapse to header-only; the state survives close/reopen.
  await page.getByTestId('comments-panel-collapse').click();
  await expect(page.getByTestId('comments-panel-list')).toHaveCount(0);
  await expect(page.getByTestId('comments-panel-header')).toBeVisible();
  await page.getByTestId('comments-panel-collapse').click();
  await expect(page.getByTestId('comments-panel-list')).toBeVisible();

  // Drag by the header to a chosen spot.
  const header = page.getByTestId('comments-panel-header');
  const hb = (await header.boundingBox())!;
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(120, 300, { steps: 5 });
  await page.mouse.up();
  box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThan(200);
  expect(box.x).toBeLessThan(200);

  // Live viewport shrink clamps the handle back onscreen.
  await page.setViewportSize({ width: 700, height: 400 });
  await expect
    .poll(async () => {
      const b = (await panel.boundingBox())!;
      return b.x >= 0 && b.y >= 0 && b.x + 288 <= 700 + 1 && b.y + 36 <= 400 + 1;
    })
    .toBe(true);

  // Close persists; the open state itself is storage-backed.
  await page.getByTestId('comments-panel-close').click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pcbjam:comments-panel-open'))).toBe('0');
});
