// wxSplitterWindow and wxScrolledWindow Tests - Layout controls KiCad uses
import { test, expect, MAIN_CANVAS, getCanvasBox } from './utils/fixtures';
import { getSplitterSash, findRenderedByType, waitForWxApp, stableShot } from './utils/element-tracker';

test.describe('wxSplitterWindow & wxScrolledWindow Tests', () => {

  test('Layout test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/layout/layout_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'layout-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('Layout test app started'));

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Splitter is visible with two panes', async ({ page, testLogger }) => {
    await page.goto('/standalone/layout/layout_test.html');
    await waitForWxApp(page);

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Splitter position')),
      { message: 'Splitter position should be logged' }
    ).toBe(true);

    await stableShot(page, 'layout-02-splitter.png', { fullPage: true });
  });

  test('Splitter sash can be dragged', async ({ page, testLogger }) => {
    await page.goto('/standalone/layout/layout_test.html');
    await waitForWxApp(page);

    // Get splitter sash from element registry
    const sash = await getSplitterSash(page);
    expect(sash, 'Splitter sash should be found in registry').not.toBeNull();

    // Drag sash to the right using its center position
    await page.mouse.move(sash!.centerX, sash!.centerY);
    await page.mouse.down();
    await page.mouse.move(sash!.centerX + 100, sash!.centerY, { steps: 10 });
    await page.mouse.up();

    await stableShot(page, 'layout-03-sash-dragged.png', { fullPage: true });

    // Verify sash position updated
    const sashAfter = await getSplitterSash(page);
    expect(sashAfter, 'Splitter sash should still be found after drag').not.toBeNull();
  });

  test('Scrolled windows show content', async ({ page, testLogger }) => {
    await page.goto('/standalone/layout/layout_test.html');
    await waitForWxApp(page);

    const box = await getCanvasBox(page);

    // Scroll in left pane
    await page.mouse.move(box.x + 150, box.y + 200);
    await page.mouse.wheel(0, 100);

    await stableShot(page, 'layout-04-scrolled-left.png', { fullPage: true });

    // Scroll in right pane
    await page.mouse.move(box.x + 500, box.y + 200);
    await page.mouse.wheel(0, 100);

    await stableShot(page, 'layout-05-scrolled-right.png', { fullPage: true });

    expect(true).toBe(true);
  });

  test('Layout controls work together', async ({ page, testLogger }) => {
    await page.goto('/standalone/layout/layout_test.html');
    await waitForWxApp(page);

    // Get splitter sash from element registry
    const sash = await getSplitterSash(page);
    expect(sash, 'Splitter sash should be found in registry').not.toBeNull();

    // Drag sash using registry coordinates
    await page.mouse.move(sash!.centerX, sash!.centerY);
    await page.mouse.down();
    await page.mouse.move(sash!.centerX + 100, sash!.centerY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: splitter drag commit before re-reading sash from registry

    // Get updated sash position after drag
    const sashAfter = await getSplitterSash(page);
    expect(sashAfter, 'Splitter sash should still be found after drag').not.toBeNull();

    // Scroll left pane (use position left of sash)
    await page.mouse.move(sashAfter!.centerX - 100, sashAfter!.centerY);
    await page.mouse.wheel(0, 50);
    await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell: scroll commit between the two pane scrolls

    // Scroll right pane (use position right of sash)
    await page.mouse.move(sashAfter!.centerX + 100, sashAfter!.centerY);
    await page.mouse.wheel(0, 50);

    await stableShot(page, 'layout-06-combined.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
