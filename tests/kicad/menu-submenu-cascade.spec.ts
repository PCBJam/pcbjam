import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  clickMenuBarItem,
  findRenderedByLabel,
  findRenderedByType,
  waitForEditorReady,
  waitForRenderedByLabel,
  stableShot,
} from '../e2e/utils/element-tracker';

/**
 * Menubar submenus cascade (issue #34).
 *
 * The DOM menus (wx-dom.js) kept a single popup slot: opening a submenu
 * removed the parent popup first, then read the (now detached) row's rect,
 * so Tools → Multi-Channel opened at 0,0 and the Tools menu was gone. The
 * popups are now a chain: hovering a submenu row opens its items beside the
 * row, the parent stays open, a sibling row swaps or closes the child, and
 * Escape closes the whole chain.
 */

type Box = { x: number; y: number; width: number; height: number };

async function popupBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.wx-menu-popup')).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

async function hoverMenuRow(page: Page, label: string): Promise<{ x: number; y: number }> {
  const row = await waitForRenderedByLabel(page, label, { elementType: 'menuitem' });
  await page.mouse.move(row.centerX, row.centerY);
  // DOM menu rows register x/y (not screenX/screenY): derive from the centre
  return { x: row.centerX - row.width / 2, y: row.centerY - row.height / 2 };
}

test.describe('pcbnew: menubar submenus', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/kicad/pcbnew.html');
    await waitForEditorReady(page);
  });

  test('Tools → Multi-Channel opens beside its row and keeps Tools open', async ({ page }) => {
    expect(await clickMenuBarItem(page, 'Tools'), 'Tools menu').toBe(true);
    const row = await hoverMenuRow(page, 'Multi-Channel');

    await expect.poll(async () => (await popupBoxes(page)).length, {
      message: 'the parent popup and the submenu are both open',
    }).toBe(2);
    await waitForRenderedByLabel(page, 'Repeat Layout', { elementType: 'menuitem' });

    const [parent, child] = await popupBoxes(page);
    expect(Math.abs(child.x - (parent.x + parent.width)), 'submenu starts at the parent right edge')
      .toBeLessThanOrEqual(4);
    expect(Math.abs(child.y - row.y), 'submenu top level with its row').toBeLessThanOrEqual(6);
    await stableShot(page, 'menu-submenu-cascade-01-multichannel.png');

    // the Tools rows are still there and still registered
    const mc = await findRenderedByLabel(page, 'Multi-Channel', { elementType: 'menuitem' });
    expect(mc, 'the Tools rows stay registered').not.toBeNull();

    // a plain sibling row closes the submenu, the parent stays
    const toolsRows = await findRenderedByType(page, 'menuitem', { parentId: mc!.parentId });
    const plain = toolsRows.find((r) => r.enabled && r.subType === 'normal');
    expect(plain, 'a plain Tools row to hover').toBeTruthy();
    await page.mouse.move(plain!.centerX, plain!.centerY);
    await expect.poll(async () => (await popupBoxes(page)).length).toBe(1);

    await page.keyboard.press('Escape');
    await expect.poll(async () => (await popupBoxes(page)).length, {
      message: 'Escape closes the menu',
    }).toBe(0);
    await expect.poll(async () => (await findRenderedByLabel(page, 'Repeat Layout', { elementType: 'menuitem' })),
      { message: 'closed rows leave the registry' }).toBeNull();
  });

  test('File → Import then Export swaps the cascaded submenu', async ({ page }) => {
    expect(await clickMenuBarItem(page, 'File'), 'File menu').toBe(true);

    await hoverMenuRow(page, 'Import');
    await waitForRenderedByLabel(page, 'Netlist...', { elementType: 'menuitem' });
    expect((await popupBoxes(page)).length).toBe(2);

    await hoverMenuRow(page, 'Export');
    await waitForRenderedByLabel(page, 'Specctra DSN...', { elementType: 'menuitem' });
    await expect.poll(async () => (await popupBoxes(page)).length).toBe(2);
    expect(await findRenderedByLabel(page, 'Netlist...', { elementType: 'menuitem' }),
      'the Import submenu closed').toBeNull();

    // a click outside every popup closes the chain
    await page.mouse.click(5, (await page.viewportSize())!.height - 5);
    await expect.poll(async () => (await popupBoxes(page)).length).toBe(0);
  });
});
