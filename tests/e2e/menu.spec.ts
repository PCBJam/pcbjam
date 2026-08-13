// wxMenuBar Tests - Menu system for KiCad
import { test, expect, MAIN_CANVAS, waitForWxApp, getCanvasBox } from './utils/fixtures';
import {
  clickMenuBarItem,
  clickMenuItem,
  findRenderedByType,
  stableShot,
} from './utils/element-tracker';

test.describe('wxMenuBar Tests', () => {

  test('Menu test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'menu-01-loaded.png', { fullPage: true });

    const hasStartupLog = testLogger.consoleLogs.some(l =>
      l.includes('wxMenuBar test app started') || l.includes('Menu test app started')
    );

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Menu bar is visible', async ({ page, testLogger }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'menu-02-menubar.png', { fullPage: true });

    // Check that app started with menu bar created
    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('Menu bar created') || l.includes('Menu test app started')
      ),
      { message: 'menu bar created / app started log should appear' }
    ).toBe(true);
  });

  test('File menu can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    // Click on File menu using element registry
    const clicked = await clickMenuBarItem(page, 'File');
    expect(clicked, 'File menu should be found and clicked').toBe(true);

    await stableShot(page, 'menu-03-file-clicked.png', { fullPage: true });
  });

  test('Edit menu can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    // Click on Edit menu using element registry
    const clicked = await clickMenuBarItem(page, 'Edit');
    expect(clicked, 'Edit menu should be found and clicked').toBe(true);

    await stableShot(page, 'menu-04-edit-clicked.png', { fullPage: true });
  });

  test('Multiple menus can be accessed', async ({ page, testLogger }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    // Verify all menu bar items are registered
    const menuItems = await findRenderedByType(page, 'menuitem', { subType: 'menubar' });
    expect(menuItems.length, 'Should have 5 menu bar items').toBeGreaterThanOrEqual(5);

    // Click through all menus using element registry
    const menuLabels = ['File', 'Edit', 'View', 'Tools', 'Help'];
    for (const label of menuLabels) {
      const clicked = await clickMenuBarItem(page, label);
      expect(clicked, `Menu "${label}" should be found and clicked`).toBe(true);
      await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell
    }

    await stableShot(page, 'menu-05-all-menus.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('popup teardown and menubar rebuild retire exact browser identities', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    const originalTitles = await findRenderedByType(page, 'menuitem', {
      subType: 'menubar',
    });
    expect(originalTitles.length).toBeGreaterThanOrEqual(5);
    expect(originalTitles.every((item) => !!item.browserId),
      'every DOM menubar title publishes a stable browser identity').toBe(true);

    expect(await clickMenuBarItem(page, 'File')).toBe(true);
    await expect.poll(async () => {
      const items = await findRenderedByType(page, 'menuitem', { subType: 'normal' });
      return items.filter((item) => item.parentId !== originalTitles[0].parentId).length;
    }).toBeGreaterThan(0);

    const firstPopup = (await findRenderedByType(page, 'menuitem', { subType: 'normal' }))
      .filter((item) => item.parentId !== originalTitles[0].parentId);
    const firstParent = firstPopup[0]!.parentId;
    const firstBrowserIds = firstPopup.map((item) => item.browserId).filter(Boolean) as string[];
    expect(firstBrowserIds).toHaveLength(firstPopup.length);

    // Clicking the same title closes the popup. The registry must retire the
    // rows at the same edge as their DOM nodes, not leave stale coordinates.
    expect(await clickMenuBarItem(page, 'File')).toBe(true);
    await expect.poll(() => page.evaluate((parent) =>
      window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', parentId: parent,
      }).length ?? -1, firstParent)).toBe(0);
    expect(await page.locator(firstBrowserIds.map((id) => `#${id}`).join(',')).count()).toBe(0);

    // Reopening creates new identities. An old locator can never resolve to a
    // replacement row which happens to reuse the same menu index.
    expect(await clickMenuBarItem(page, 'File')).toBe(true);
    await expect.poll(() => page.evaluate((parent) =>
      window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', parentId: parent,
      }).length ?? 0, firstParent)).toBeGreaterThan(0);
    const secondIds = await page.evaluate((parent) =>
      (window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', parentId: parent,
      }) ?? []).map((item) => item.browserId), firstParent);
    expect(secondIds.every((id) => !!id && !firstBrowserIds.includes(id!))).toBe(true);

    expect(await clickMenuItem(page, 'New'), 'the live row dispatches its native command').toBe(true);
    await expect.poll(() => testLogger.consoleLogs.filter(
      (line) => line.includes('[MENU_EVENT] File > New clicked')).length).toBe(1);

    // Exercise a structure replacement directly. Capture the generation which
    // is live at this exact edge: native update-UI work is allowed to have
    // replaced the startup projection while the command above was in flight.
    const liveTitles = await findRenderedByType(page, 'menuitem', {
      subType: 'menubar',
    });
    const oldTitleIds = liveTitles.map((item) => item.browserId!).filter(Boolean);
    expect(oldTitleIds).toHaveLength(liveTitles.length);
    await page.evaluate(() => {
      const titles = window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', subType: 'menubar',
      }) ?? [];
      const domId = Number(titles[0]?.parentId);
      const rebuild = (window as unknown as {
        wxDomMenuSetStructure?: (id: number, json: string) => void;
      }).wxDomMenuSetStructure;
      if (!domId || !rebuild) throw new Error('menubar rebuild hook is missing');
      rebuild(domId, JSON.stringify([{ title: 'Replacement', items: [] }]));
    });
    await expect.poll(() => page.evaluate(() =>
      (window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', subType: 'menubar',
      }) ?? []).map((item) => item.label))).toEqual(['Replacement']);
    await expect.poll(() => page.evaluate((retiredIds) =>
      (window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', subType: 'menubar',
      }) ?? []).some((item) => !!item.browserId && retiredIds.includes(item.browserId)),
      oldTitleIds)).toBe(false);
    expect(await page.locator(oldTitleIds.map((id) => `#${id}`).join(',')).count()).toBe(0);
  });

  test('destroying a menubar retires its open popup and exact live generation', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    const fileTitle = (await findRenderedByType(page, 'menuitem', {
      subType: 'menubar',
    })).find((item) => item.label.includes('File'));
    expect(fileTitle?.browserId).toBeTruthy();
    const domId = Number(fileTitle!.parentId);
    const popupParent = `${domId}:0`;

    expect(await clickMenuBarItem(page, 'File')).toBe(true);
    await expect.poll(() => page.evaluate((parentId) =>
      window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', parentId,
      }).length ?? 0, popupParent)).toBeGreaterThan(0);

    await page.evaluate((id) => {
      const destroy = (window as unknown as {
        wxDomDestroyControl?: (domId: number) => void;
      }).wxDomDestroyControl;
      if (!destroy) throw new Error('DOM control destroy hook is missing');
      destroy(id);
    }, domId);

    await expect(page.locator('.wx-menu-popup')).toHaveCount(0);
    await expect.poll(() => page.evaluate(([barParent, popupParentId]) => {
      const all = window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem',
      }) ?? [];
      return all.filter((item) =>
        item.parentId === barParent || item.parentId === popupParentId).length;
    }, [String(domId), popupParent] as const)).toBe(0);
    expect(testLogger.errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });

  test('submenu popup uses the anchor geometry captured before teardown', async ({ page }) => {
    await page.goto('/standalone/menu/menu_test.html');
    await waitForWxApp(page);

    await page.evaluate(() => {
      const titles = window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', subType: 'menubar',
      }) ?? [];
      const domId = Number(titles[0]?.parentId);
      const rebuild = (window as unknown as {
        wxDomMenuSetStructure?: (id: number, json: string) => void;
      }).wxDomMenuSetStructure;
      if (!domId || !rebuild) throw new Error('menubar rebuild hook is missing');
      rebuild(domId, JSON.stringify([{ title: 'Nested', items: [{
        id: 9001, label: 'More', kind: 'submenu', enabled: true, items: [{
          id: 9002, label: 'Child', kind: 'normal', enabled: true,
        }],
      }] }]));
    });
    await expect.poll(() => page.evaluate(() =>
      (window.wxElementRegistry?.findAllRendered?.({
        elementType: 'menuitem', subType: 'menubar',
      }) ?? []).map((item) => item.label))).toEqual(['Nested']);

    expect(await clickMenuBarItem(page, 'Nested')).toBe(true);
    await expect.poll(() => findRenderedByType(page, 'menuitem', {
      subType: 'normal',
    })).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'More' })]));
    const more = (await findRenderedByType(page, 'menuitem', { subType: 'normal' }))
      .find((item) => item.label === 'More');
    expect(more?.browserId).toBeTruthy();
    const anchor = await page.locator(`#${more!.browserId}`).boundingBox();
    expect(anchor).toBeTruthy();

    expect(await clickMenuItem(page, 'More')).toBe(true);
    await expect.poll(() => findRenderedByType(page, 'menuitem', {
      subType: 'normal',
    })).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Child' })]));
    const popup = await page.locator('.wx-menu-popup').boundingBox();
    expect(popup).toBeTruthy();
    expect(Math.abs(popup!.x - anchor!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(popup!.y - (anchor!.y + anchor!.height))).toBeLessThanOrEqual(1);
  });
});
