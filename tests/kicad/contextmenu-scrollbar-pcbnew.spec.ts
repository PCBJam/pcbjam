import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickMenuItem, findRenderedByType, waitForEditorReady, stableShot } from '../e2e/utils/element-tracker';

/**
 * Secondary in-app proof on pcbnew (the user's explicit ask): the right-side
 * Appearance/Layers panel is a wxScrolledWindow whose layer list always
 * overflows, so its built-in scrollbar gutter is a reliable demonstration of
 * the draggable scrollbar; the GAL canvas right-click demonstrates the context
 * menu. pcbnew is the largest app — this spec is slow by design.
 *
 * Screenshots: test-results/pcbnew-sidebar-scrollbar.png, pcbnew-context-menu.png.
 */

async function getGlBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const id = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find((c) => {
        const rect = c.getBoundingClientRect();
        return window.getComputedStyle(c).display !== 'none' && rect.width > 0 && rect.height > 0;
      });
    return (visible ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null))?.id ?? null;
  });
  if (!id) throw new Error('No visible GL canvas found');
  const box = await page.locator(`#${id}`).boundingBox();
  if (!box) throw new Error('GL canvas bounding box unavailable');
  return box;
}

test.describe('pcbnew: DOM-port scrollbar + context menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/kicad/pcbnew.html');
  });

  test('the appearance/layers panel shows a draggable scrollbar gutter', async ({ page }) => {
    await waitForEditorReady(page);

    await expect.poll(async () => (await findRenderedByType(page, 'slidertrack')).length, {
      timeout: 15000,
      message: 'the overflowing layers panel should show a built-in scrollbar gutter',
    }).toBeGreaterThan(0);

    await stableShot(page, 'pcbnew-sidebar-scrollbar.png', { fullPage: true });

    const tracks = await findRenderedByType(page, 'slidertrack');
    const sliders = await findRenderedByType(page, 'slider');
    const vTrack = tracks.find((t) => t.height > t.width) ?? tracks[0];
    const vThumb = sliders.find((s) => s.parentId === vTrack.parentId) ?? sliders[0];
    expect(vThumb, 'a vertical gutter thumb should exist').toBeTruthy();

    await page.mouse.move(vThumb.centerX, vThumb.centerY);
    await page.mouse.down();
    await page.mouse.move(vTrack.centerX, vTrack.screenY + vTrack.height * 0.7, { steps: 6 });
    await page.mouse.up();
    await stableShot(page, 'pcbnew-sidebar-scrollbar-dragged.png', { fullPage: true });
  });

  // Labels of the items in the currently-open DOM context-menu popup.
  async function popupLabels(page: Page): Promise<string[]> {
    const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
    return items.map((i) => i.label);
  }

  test('right-click on the canvas opens the tool-framework context menu', async ({
    page,
    testLogger,
  }) => {
    await waitForEditorReady(page);

    // Right-click the drawing canvas. pcbnew's selection tool builds its menu
    // (common/tool/tool_manager.cpp) and calls frame->PopupMenu() from inside
    // a suspended tool coroutine — the DOM port renders it as a popup at the
    // cursor and routes the chosen command back synchronously.
    const box = await getGlBox(page);
    const x = Math.round(box.x + box.width * 0.5);
    const y = Math.round(box.y + box.height * 0.5);
    await page.mouse.click(x, y); // activate the selection tool
    // Small settle so the activation click is processed before the right-click — no
    // JS-observable "selection tool active" signal to poll (documented interaction wait).
    await page.waitForTimeout(400); // eslint-disable-line -- see comment above
    await page.mouse.click(x, y, { button: 'right' });

    // The popup items register in the e2e registry under parentId 'popupmenu'.
    await expect.poll(async () => (await popupLabels(page)).length, {
      timeout: 15000,
      message: 'the canvas right-click should open a DOM context menu',
    }).toBeGreaterThan(0);

    // It must be the REAL pcbnew context menu: Zoom and Grid submenus are
    // always present regardless of selection/clipboard state.
    const labels = await popupLabels(page);
    expect(labels, `menu items were: ${JSON.stringify(labels)}`).toEqual(
      expect.arrayContaining(['Zoom', 'Grid']),
    );

    // Every shown item is enabled and routable.
    const items = await findRenderedByType(page, 'menuitem', { parentId: 'popupmenu' });
    expect(items.every((i) => i.enabled)).toBe(true);

    await stableShot(page, 'pcbnew-context-menu.png', { fullPage: true });

    // The menu is interactive: opening the "Zoom" submenu cascades its items
    // beside the row, under their own registry parent, and the top-level menu
    // (with "Grid") stays open (issue #34).
    expect(await clickMenuItem(page, 'Zoom'), 'Zoom submenu should be clickable').toBe(true);
    const subItems = async () =>
      (await findRenderedByType(page, 'menuitem')).filter((i) => i.parentId.startsWith('popupmenu:sub:'));
    await expect.poll(async () => (await subItems()).length, {
      timeout: 5000,
      message: 'clicking "Zoom" should cascade its submenu',
    }).toBeGreaterThan(0);
    expect(await popupLabels(page), 'the top-level menu stays open').toEqual(expect.arrayContaining(['Grid']));
    await expect(page.locator('.wx-menu-popup')).toHaveCount(2);
    await stableShot(page, 'pcbnew-context-submenu.png', { fullPage: true });

    // Escape dismisses the popup without firing a command (registry clears).
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await popupLabels(page)).length, {
      timeout: 5000,
      message: 'Escape should dismiss the context menu',
    }).toBe(0);
    expect(await subItems(), 'the submenu rows leave the registry too').toHaveLength(0);

    expect(
      testLogger.errors.filter((e) => !e.includes('favicon') && !e.includes('WebGL')),
      'no page errors during the context-menu flow',
    ).toHaveLength(0);
  });
});
