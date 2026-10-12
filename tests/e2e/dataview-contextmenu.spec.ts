// wxDataViewCtrl item context menu, the KiCad LIB_TREE way (footprint/symbol
// editor library tree). The app (apps/standalone/dataview-contextmenu) pops a
// menu that only fills itself on wxEVT_MENU_OPEN, takes item enable state from
// wxEVT_UPDATE_UI, and is popped by the frame at ScreenToClient(mouse), exactly
// like TOOL_MANAGER::DispatchContextMenu. Before the fix the DOM port sent no
// wxEVT_MENU_OPEN / UPDATE_UI, so KiCad's tree showed an empty menu strip,
// placed a menu-bar height above the pointer.
import { test, expect, tryLoadApp } from './utils/fixtures';
import {
  findRenderedByLabel,
  findRenderedByType,
  waitForRenderedByLabel,
  clickMenuItem,
  stableShot,
} from './utils/element-tracker';
import type { Page } from '@playwright/test';

const APP = '/standalone/dataview-contextmenu/dataview_contextmenu_test.html';

async function popupLabels(page: Page): Promise<string[]> {
  const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
  return items.map((i) => i.label);
}

/** Right-click a tree row at its registry centre; returns the click point. */
async function rightClickRow(page: Page, label: string) {
  const row = await waitForRenderedByLabel(page, label, { elementType: 'dataviewitem' });
  const x = Math.round(row.centerX);
  const y = Math.round(row.centerY);
  await page.mouse.click(x, y, { button: 'right' });
  return { x, y };
}

function logged(logs: string[], text: string): boolean {
  return logs.some((l) => l.includes(`[DVCTX] ${text}`));
}

test.describe('wxDataViewCtrl item context menu (LIB_TREE style)', () => {
  test.beforeEach(async ({ page, testLogger }) => {
    await page.goto(APP);
    expect(await tryLoadApp(page, 30000), 'dataview context-menu app should load').toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'app started')).toBe(true);
    await waitForRenderedByLabel(page, 'PartA2', { elementType: 'dataviewitem' });
  });

  test('registry rows sit below the column header, not on it', async ({ page }) => {
    const header = await waitForRenderedByLabel(page, 'Item', { elementType: 'columnheader' });
    const rows = await findRenderedByType(page, 'dataviewitem');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const top = Math.min(...rows.map((r) => r.centerY - r.height / 2));
    expect(top, 'first row starts at the header bottom').toBeGreaterThanOrEqual(
      header.centerY + header.height / 2 - 1,
    );
  });

  test('right-click selects the row and pops the populated menu at the pointer', async ({
    page,
    testLogger,
  }) => {
    const at = await rightClickRow(page, 'PartA2');

    // The row is selected before the menu event reaches the handler.
    await expect
      .poll(() => logged(testLogger.consoleLogs, "context menu on 'PartA2', selection 'PartA2'"), {
        message: 'context-menu event targets the clicked row, which is selected',
      })
      .toBe(true);

    // wxEVT_MENU_OPEN reached the frame (and through it the lazy menu).
    await expect
      .poll(() => logged(testLogger.consoleLogs, 'MENU_OPEN popup=1'), {
        message: 'the popup sends wxEVT_MENU_OPEN before it is shown',
      })
      .toBe(true);

    await waitForRenderedByLabel(page, "Rename 'PartA2'", { elementType: 'menuitem' });
    const labels = await popupLabels(page);
    expect(labels).toEqual(
      expect.arrayContaining(['New Item', "Rename 'PartA2'", 'Copy', 'Paste', 'Export']),
    );

    // wxEVT_UPDATE_UI ran: Paste is disabled until something was copied.
    const paste = await findRenderedByLabel(page, 'Paste', { elementType: 'menuitem' });
    expect(paste?.enabled, 'Paste disabled by its UPDATE_UI handler').toBe(false);

    // The menu opens at the pointer, not a menu-bar height above it.
    const box = await page.locator('.wx-menu-popup').boundingBox();
    expect(box, 'popup element present').not.toBeNull();
    expect(Math.abs(box!.x - at.x), 'popup left at the pointer').toBeLessThanOrEqual(2);
    expect(Math.abs(box!.y - at.y), 'popup top at the pointer').toBeLessThanOrEqual(2);

    await stableShot(page, 'dataview-contextmenu-01-open.png');

    await waitForRenderedByLabel(page, "Rename 'PartA2'", { elementType: 'menuitem' });
    expect(await clickMenuItem(page, "Rename 'PartA2'")).toBe(true);
    await expect
      .poll(() => logged(testLogger.consoleLogs, "chosen: Rename on 'PartA2'"), {
        message: 'the chosen entry runs its handler',
      })
      .toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'MENU_CLOSE popup=1')).toBe(true);
    await expect.poll(() => popupLabels(page)).toEqual([]);
  });

  test('right-click on another row moves the selection there', async ({ page, testLogger }) => {
    await rightClickRow(page, 'LibB');
    await expect
      .poll(() => logged(testLogger.consoleLogs, "context menu on 'LibB', selection 'LibB'"))
      .toBe(true);
    await waitForRenderedByLabel(page, 'New Item', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'New Item')).toBe(true);
    await expect
      .poll(() => logged(testLogger.consoleLogs, "chosen: New Item on 'LibB'"))
      .toBe(true);
  });

  test('UPDATE_UI state follows the app: Paste enables after Copy', async ({
    page,
    testLogger,
  }) => {
    await rightClickRow(page, 'PartA1');
    await waitForRenderedByLabel(page, 'Copy', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Copy')).toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'chosen: Copy')).toBe(true);
    await expect.poll(() => popupLabels(page)).toEqual([]);

    await rightClickRow(page, 'PartA1');
    await waitForRenderedByLabel(page, 'Paste', { elementType: 'menuitem' });
    const paste = await findRenderedByLabel(page, 'Paste', { elementType: 'menuitem' });
    expect(paste?.enabled, 'Paste enabled after Copy').toBe(true);
    expect(await clickMenuItem(page, 'Paste')).toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'chosen: Paste')).toBe(true);
  });

  test('a submenu entry of the lazily built menu fires', async ({ page, testLogger }) => {
    await rightClickRow(page, 'PartB1');
    await waitForRenderedByLabel(page, 'Export', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Export')).toBe(true);
    await waitForRenderedByLabel(page, 'Export B', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Export B')).toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'chosen: Export B')).toBe(true);
  });

  test('Escape cancels: MENU_CLOSE, no command', async ({ page, testLogger }) => {
    await rightClickRow(page, 'LibC');
    await waitForRenderedByLabel(page, 'New Item', { elementType: 'menuitem' });
    await page.keyboard.press('Escape');
    await expect.poll(() => popupLabels(page)).toEqual([]);
    await expect.poll(() => logged(testLogger.consoleLogs, 'MENU_CLOSE popup=1')).toBe(true);
    await expect.poll(() => logged(testLogger.consoleLogs, 'popup returned')).toBe(true);
    expect(testLogger.consoleLogs.filter((l) => l.includes('[DVCTX] chosen:'))).toEqual([]);
  });
});
