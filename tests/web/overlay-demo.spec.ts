import { test, expect, type Page } from '@playwright/test';
import { waitForRegistry, shotPath } from '../e2e/utils/element-tracker';

/**
 * The internal "add a resistor" demo tour (docs/features/overlay-system 0002
 * M4), walked end to end with real clicks: Place Symbols → the chooser →
 * search R → OK → click to place → the tour outlines the new resistor → Next.
 * The tour is state-driven: every step is recognized from the editor state
 * (open dialogs, engine actions, the sheet's items), not from a script.
 */

type Rect = { x: number; y: number; width: number; height: number };
interface OverlayHandle {
  resolve(target: string): { rect: Rect } | null;
  openDialog(cls: string): { ptr: string } | null;
}
declare global {
  interface Window {
    __pcbjamOverlay?: OverlayHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module: any;
  }
}

const CHOOSER = 'DIALOG_SYMBOL_CHOOSER';

async function boot(page: Page, query: string): Promise<void> {
  // The guide's pulse ring animates forever; under reduced motion it is static
  // (motion-safe:) — deterministic screenshots, and the reduced-motion path.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/default/projects/demo/-/eeschema${query}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect.poll(() => page.title(), { timeout: 150000, intervals: [1000] }).toMatch(/Schematic Editor/i);
}

const card = (page: Page) => page.getByTestId('overlay-card');
const progress = (page: Page) => page.getByTestId('overlay-progress');

async function resolved(page: Page, target: string): Promise<Rect> {
  let rect: Rect | null = null;
  await expect
    .poll(async () => (rect = await page.evaluate((t) => window.__pcbjamOverlay!.resolve(t)?.rect ?? null, target)), {
      timeout: 60000,
      message: `${target} resolves`,
    })
    .not.toBeNull();
  return rect!;
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

test.describe('guide overlay demo tour', () => {
  test.setTimeout(420000);

  test('add-resistor: walked with real clicks', async ({ page }) => {
    await boot(page, '?overlayDemo=add-resistor');

    // 1 — the tour points at Place Symbols.
    await expect(card(page)).toHaveAttribute('data-owner', 'builtin:add-resistor', { timeout: 60000 });
    await expect(progress(page)).toHaveText('1 / 4');
    await expect(card(page)).toHaveAttribute('data-target-state', 'found');
    await expect(page.getByTestId('overlay-attribution')).toHaveText('from PCBJam guide');
    await page.screenshot({ path: shotPath(page, 'overlay-demo-01-tool.png') });

    const tool = await resolved(page, 'tool:eeschema.InteractiveDrawing.placeSymbol');
    await page.mouse.click(center(tool).x, center(tool).y);

    // The armed placer opens the chooser on the first canvas click; mouse
    // moves pump wx's deferred follow-ups (see eeschema-fp-selector).
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const c = { x: canvas.x + canvas.width * 0.45, y: canvas.y + canvas.height / 2 };
    await page.mouse.click(c.x, c.y);
    let probe = 0;
    await expect
      .poll(
        async () => {
          await page.mouse.move(c.x + (probe % 5) * 4, c.y + (probe % 3) * 4);
          probe++;
          return page.evaluate((cls) => !!window.__pcbjamOverlay!.openDialog(cls), CHOOSER);
        },
        { timeout: 90000, intervals: [1000] },
      )
      .toBe(true);

    // 2 — the chooser's search field (after the library-loading cover lifts,
    // which pauses the overlay).
    await expect(progress(page)).toHaveText('2 / 4', { timeout: 120000 });
    await expect(card(page)).toHaveAttribute('data-target-state', 'found');
    await page.screenshot({ path: shotPath(page, 'overlay-demo-02-search.png') });

    const search = await resolved(page, `dialog:${CHOOSER}/control:searchctrl`);
    await page.mouse.click(center(search).x, center(search).y);
    await page.keyboard.type('R', { delay: 60 });
    // The filtered tree auto-selects the best match (Device:R for "R"). wx
    // defers the search's follow-up (filter → select) until the next input
    // event, so pump mouse moves until the SELECTED row (an owner-drawn
    // dataview item, registry subType "selected") is R — then Enter accepts.
    await expect
      .poll(
        async () => {
          await page.mouse.move(center(search).x + (probe++ % 5) * 3, center(search).y + 60);
          return page.evaluate(() =>
            window.wxElementRegistry!.findAllRendered!({ elementType: 'dataviewitem', subType: 'selected' }).map((r) => r.label),
          );
        },
        { timeout: 30000, intervals: [500], message: 'R selected in the chooser' },
      )
      .toEqual(['R']);
    await page.keyboard.press('Enter');

    // 3 — the part is on the cursor: click to place.
    await expect(progress(page)).toHaveText('3 / 4', { timeout: 30000 });
    await page.screenshot({ path: shotPath(page, 'overlay-demo-03-place.png') });
    // The part follows the cursor once the tool resumes after the chooser;
    // mouse moves pump wx's deferred follow-ups. KiCad then selects it — the
    // Properties panel header leaves "No objects selected". Clicking before
    // that re-opens the chooser.
    const drop = { x: c.x, y: c.y + 40 };
    await expect
      .poll(
        async () => {
          await page.mouse.move(drop.x + (probe++ % 3) * 2, drop.y);
          return page.evaluate(
            () => !window.wxElementRegistry!.findAll({ visible: true }).some((e) => e.label === 'No objects selected'),
          );
        },
        { timeout: 60000, intervals: [500], message: 'resistor attached to the cursor' },
      )
      .toBe(true);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.click(drop.x, drop.y);

    // 4 — the new resistor is on the sheet; the card outlines it.
    await expect(progress(page)).toHaveText('4 / 4', { timeout: 30000 });
    expect(await page.evaluate((cls) => !!window.__pcbjamOverlay!.openDialog(cls), CHOOSER)).toBe(false);
    await expect(card(page)).toHaveAttribute('data-target-state', 'found');
    await expect(page.getByTestId('overlay-ring')).toBeVisible();
    await page.keyboard.press('Escape'); // KiCad: stop placing (Esc on the canvas is KiCad's)
    await page.screenshot({ path: shotPath(page, 'overlay-demo-04-done.png') });

    await page.getByTestId('overlay-next').click();
    await expect(page.getByTestId('overlay-root')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('pcbjam:tour:add-resistor'))).toBe('done');
  });

  test('an active tour resumes after a reload; a dismissed one does not', async ({ page }) => {
    await boot(page, '?overlayDemo=add-resistor');
    await expect(progress(page)).toHaveText('1 / 4', { timeout: 60000 });

    // Reload WITHOUT the query: the tab's tour is still active → resumes.
    await boot(page, '');
    await expect(card(page)).toHaveAttribute('data-owner', 'builtin:add-resistor', { timeout: 60000 });
    await expect(progress(page)).toHaveText('1 / 4');

    await page.getByTestId('overlay-close').click();
    expect(await page.evaluate(() => sessionStorage.getItem('pcbjam:tour:add-resistor'))).toBe('dismissed');

    await boot(page, '');
    // The editor is up and the overlay host mounted (the demo handle is only
    // exposed with ?overlayDemo / dev builds, so assert on the DOM instead).
    await expect(page.locator('#canvas')).toBeVisible();
    await expect(page.getByTestId('overlay-root')).toHaveCount(0);
  });
});
