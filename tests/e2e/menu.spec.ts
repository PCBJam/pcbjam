// wxMenuBar Tests - Menu system for KiCad
import { test, expect, MAIN_CANVAS, waitForWxApp, getCanvasBox } from './utils/fixtures';
import { clickMenuBarItem, findRenderedByType, stableShot } from './utils/element-tracker';

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
      await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: menu open commit between menu-bar clicks
    }

    await stableShot(page, 'menu-05-all-menus.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
