// Specialized wxWidgets Controls Tests - Treebook, RearrangeCtrl, BitmapComboBox
import { test, expect } from './utils/fixtures';
import {
  clickByLabel,
  clickComboButton,
  selectComboItem,
  clickListboxItem,
  clickTreeItem,
  findAllTreeItems,
  waitForWxApp,
  waitUntil,
  stableShot,
} from './utils/element-tracker';

test.describe('Specialized wxWidgets Controls Tests', () => {

  test('Specialized controls test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'specialized-01-loaded.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('wxTreebook displays tree with pages', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    const labels = (await findAllTreeItems(page)).map((item) => item.label);
    expect(labels, 'treebook paints and publishes all top-level pages').toEqual(
      expect.arrayContaining(['General', 'Display', 'Editing', 'Printing']),
    );

    // Treebook should show General page by default with tree on left.
    await stableShot(page, 'specialized-02-treebook-initial.png', { fullPage: true });
  });

  test('wxTreebook can navigate between pages', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // Click on Display page using element registry
    expect(await clickTreeItem(page, 'Display'), 'Display tree item is clickable').toBe(true);
    await waitUntil(
      page,
      () => !!window.wxElementRegistry?.findByLabel('Display Settings', {}).length,
      'Display page is projected after the tree click',
    );

    // Click on Printing page using element registry
    expect(await clickTreeItem(page, 'Printing'), 'Printing tree item is clickable').toBe(true);
    await waitUntil(
      page,
      () => !!window.wxElementRegistry?.findByLabel('Print Settings', {}).length,
      'Printing page is projected after the tree click',
    );

    await stableShot(page, 'specialized-03-treebook-subpage.png', { fullPage: true });
  });

  test('wxTreebook can expand tree nodes', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // Click on Editing page using element registry
    expect(await clickTreeItem(page, 'Editing'), 'Editing tree item is clickable').toBe(true);

    await stableShot(page, 'specialized-04-treebook-expand.png', { fullPage: true });
  });

  test('wxBitmapComboBox displays layer swatches', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // Click on layer combo box to open dropdown using element tracking
    const opened = await clickComboButton(page);
    expect(opened, 'Should be able to open BitmapComboBox dropdown').toBe(true);

    await stableShot(page, 'specialized-05-bitmapcombo-dropdown.png', { fullPage: true });
  });

  test('wxBitmapComboBox can select different layer', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // Select B.Cu layer using element tracking
    const selected = await selectComboItem(page, 'B.Cu');
    expect(selected, 'Should be able to select B.Cu from dropdown').toBe(true);

    await stableShot(page, 'specialized-06-bitmapcombo-select.png', { fullPage: true });
  });

  test('wxRearrangeCtrl displays layer order', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // RearrangeCtrl should show list of layers with checkboxes
    await stableShot(page, 'specialized-07-rearrange-list.png', { fullPage: true });
  });

  test('wxRearrangeCtrl Get Layer Status button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/specialized/specialized_test.html');
    await waitForWxApp(page);

    // Click Get Layer Status button using element registry
    await clickByLabel(page, 'Get Layer Status');

    await stableShot(page, 'specialized-08-get-order.png', { fullPage: true });
  });
});
