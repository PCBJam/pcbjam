// Context-menu (DoPopupMenu) e2e — right-click pops a DOM popup, items route
// wxEVT_MENU back to the handler, and outside-click/Escape cancels.
import { test, expect, tryLoadApp, getCanvasBox } from './utils/fixtures';
import { findRenderedByType, clickMenuItem, shotPath } from './utils/element-tracker';

async function rightClickCanvasCentre(page: import('@playwright/test').Page) {
  const box = await getCanvasBox(page);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.click(x, y, { button: 'right' });
  return { x, y };
}

async function popupItemCount(page: import('@playwright/test').Page): Promise<number> {
  const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
  return items.length;
}

test.describe('DOM-port context menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/standalone/contextmenu/contextmenu_test.html');
    expect(await tryLoadApp(page, 30000), 'context-menu app should load').toBe(true);
    await expect
      .poll(() => true, { timeout: 1000 })
      .toBe(true);
  });

  test('right-click opens the menu with the expected items', async ({ page, testLogger }) => {
    await rightClickCanvasCentre(page);

    // The popup builds its rows + registers them in a requestAnimationFrame.
    await expect.poll(() => popupItemCount(page), {
      timeout: 8000,
      message: 'context menu items should register',
    }).toBeGreaterThanOrEqual(4); // Cut, Snap to grid, Paste, More (separators excluded)

    const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Cut');
    expect(labels).toContain('Snap to grid');
    expect(labels).toContain('More');

    // The disabled "Paste" item registers but is not enabled.
    const paste = items.find((i) => i.label === 'Paste');
    expect(paste, 'Paste should be present').toBeTruthy();
    expect(paste!.enabled, 'Paste should be disabled').toBe(false);

    await page.screenshot({ path: shotPath(page, 'contextmenu-01-open.png'), fullPage: true });

    expect(testLogger.errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });

  test('choosing an item routes wxEVT_MENU to the handler', async ({ page, testLogger }) => {
    await rightClickCanvasCentre(page);
    await expect.poll(() => popupItemCount(page), { timeout: 8000 }).toBeGreaterThanOrEqual(4);

    expect(await clickMenuItem(page, 'Cut'), 'Cut should be clickable').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some((l) => l.includes('[CTXMENU_EVENT] Cut chosen')),
      { timeout: 8000, message: 'the Cut handler should fire' },
    ).toBe(true);

    // The popup is dismissed after a choice.
    await expect.poll(() => popupItemCount(page), { timeout: 4000 }).toBe(0);
  });

  test('a checkable item toggles and reports its new state', async ({ page, testLogger }) => {
    await rightClickCanvasCentre(page);
    await expect.poll(() => popupItemCount(page), { timeout: 8000 }).toBeGreaterThanOrEqual(4);

    expect(await clickMenuItem(page, 'Snap to grid')).toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some((l) => l.includes('[CTXMENU_EVENT] Snap to grid ON')),
      { timeout: 8000, message: 'the check item should toggle ON' },
    ).toBe(true);
  });

  test('Escape cancels without firing a command', async ({ page, testLogger }) => {
    await rightClickCanvasCentre(page);
    await expect.poll(() => popupItemCount(page), { timeout: 8000 }).toBeGreaterThanOrEqual(4);

    const before = testLogger.consoleLogs.filter((l) => l.includes('chosen')).length;
    await page.keyboard.press('Escape');

    await expect.poll(() => popupItemCount(page), {
      timeout: 4000,
      message: 'Escape should dismiss the popup',
    }).toBe(0);

    const after = testLogger.consoleLogs.filter((l) => l.includes('chosen')).length;
    expect(after, 'no command should fire on cancel').toBe(before);
  });

  test('discarding the browser lifetime cancels the exact context-menu lease', async ({
    page,
    testLogger,
  }) => {
    await page.evaluate(() => {
      type PopupModule = {
        _wx_popup_lease_request_close(scope: number, result: number): number;
        wxDiscardDomBrowserLifetime(): boolean;
      };
      const state = window as unknown as {
        Module: PopupModule;
        __contextCloseCalls?: Array<{ scope: number; result: number }>;
      };
      const original = state.Module._wx_popup_lease_request_close;
      if (typeof original !== 'function' ||
          typeof state.Module.wxDiscardDomBrowserLifetime !== 'function') {
        throw new Error('context-menu lifetime hooks are missing');
      }
      state.__contextCloseCalls = [];
      state.Module._wx_popup_lease_request_close = (scope, result) => {
        state.__contextCloseCalls!.push({ scope, result });
        return original(scope, result);
      };
    });

    await rightClickCanvasCentre(page);
    await expect.poll(() => popupItemCount(page), { timeout: 8000 }).toBeGreaterThanOrEqual(4);

    const discarded = await page.evaluate(() => (
      window as unknown as {
        Module: { wxDiscardDomBrowserLifetime(): boolean };
      }
    ).Module.wxDiscardDomBrowserLifetime());
    expect(discarded).toBe(true);
    await expect(page.locator('.wx-menu-popup')).toHaveCount(0);

    const calls = await page.evaluate(() => (
      window as unknown as {
        __contextCloseCalls?: Array<{ scope: number; result: number }>;
      }
    ).__contextCloseCalls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.scope).toBeGreaterThan(0);
    expect(calls[0]!.result).toBe(-1);
    expect(testLogger.consoleLogs.filter((l) => l.includes('chosen'))).toHaveLength(0);
  });
});
