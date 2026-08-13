// wxToolBar and wxStatusBar Tests - Toolbar and status bar KiCad uses
import { test, expect, MAIN_CANVAS, getCanvasBox, waitForWxApp } from './utils/fixtures';
import { clickToolbarTool, findRenderedByType, stableShot } from './utils/element-tracker';

test.describe('wxToolBar & wxStatusBar Tests', () => {

  test('Toolbar test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'toolbar-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('Toolbar test app started'));

    expect(hasStartup, 'the native toolbar app must reach its startup marker').toBe(true);
    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Toolbar buttons are visible', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar created')),
      { message: 'Toolbar-created event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-02-buttons.png', { fullPage: true });
  });

  test('New tool button can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    // Click New button using element registry
    const clicked = await clickToolbarTool(page, 'New');
    expect(clicked, 'New tool should be found and clicked').toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar: New clicked')),
      { message: 'New-clicked event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-03-new-clicked.png', { fullPage: true });
  });

  test('Zoom tools can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    // Click Zoom In using element registry
    const zoomInClicked = await clickToolbarTool(page, 'Zoom In');
    expect(zoomInClicked, 'Zoom In tool should be found and clicked').toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar: Zoom In clicked')),
      { message: 'Zoom-In-clicked event should be logged' }
    ).toBe(true);

    // Click Zoom Out using element registry
    const zoomOutClicked = await clickToolbarTool(page, 'Zoom Out');
    expect(zoomOutClicked, 'Zoom Out tool should be found and clicked').toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar: Zoom Out clicked')),
      { message: 'Zoom-Out-clicked event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-04-zoom.png', { fullPage: true });
  });

  test('Toggle tool changes state', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    // Click Toggle button using element registry
    const toggleClicked1 = await clickToolbarTool(page, 'Toggle');
    expect(toggleClicked1, 'Toggle tool should be found and clicked').toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar: Toggle ON')),
      { message: 'Toggle-ON event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-05-toggle-on.png', { fullPage: true });

    // Click again to toggle off
    const toggleClicked2 = await clickToolbarTool(page, 'Toggle');
    expect(toggleClicked2, 'Toggle tool should be found and clicked again').toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Toolbar: Toggle OFF')),
      { message: 'Toggle-OFF event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-06-toggle-off.png', { fullPage: true });

    const schedulerLive = await page.evaluate(() => {
      const scheduler = (globalThis as any).__wxScheduler;
      return !!scheduler && !scheduler.dead;
    });
    expect(schedulerLive, 'back-to-back DOM receipts must not terminalize the scheduler').toBe(true);
  });

  test('repeated toggle receipts survive Asyncify transition windows', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    const CLICKS = 12;
    for (let i = 0; i < CLICKS; i++) {
      expect(await clickToolbarTool(page, 'Toggle'), `toggle click ${i + 1}`).toBe(true);
      await expect.poll(
        () => testLogger.consoleLogs.filter(l => l.includes('Toolbar: Toggle ')).length,
        { message: `toggle receipt ${i + 1} should be delivered exactly once` }
      ).toBe(i + 1);
      const expected = i % 2 === 0 ? 'ON' : 'OFF';
      const toggleLogs = testLogger.consoleLogs.filter(l => l.includes('Toolbar: Toggle '));
      expect(toggleLogs[toggleLogs.length - 1]).toContain(`Toolbar: Toggle ${expected}`);
    }

    const books = await page.evaluate(() => {
      const scheduler = (globalThis as any).__wxScheduler;
      return scheduler ? { dead: scheduler.dead, deferred: scheduler.nativeEntryDeferred } : null;
    });
    expect(books, 'scheduler should be installed').not.toBeNull();
    expect(books!.dead, 'receipt bursts must leave the scheduler live').toBe(false);
    expect(books!.deferred, 'the reducer should exercise a physical transition window').toBeGreaterThan(0);
  });

  test('Status bar shows messages', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('Status bar created')),
      { message: 'Status-bar-created event should be logged' }
    ).toBe(true);

    await stableShot(page, 'toolbar-07-statusbar.png', { fullPage: true });
  });

  test('All toolbar buttons accessible', async ({ page, testLogger }) => {
    await page.goto('/standalone/toolbar/toolbar_test.html');
    await waitForWxApp(page);

    // Verify all tools are registered
    const tools = await findRenderedByType(page, 'tool');
    expect(tools.length, 'Should have 6 tools registered').toBeGreaterThanOrEqual(6);

    // Click all toolbar buttons by label
    const toolLabels = ['New', 'Open', 'Save', 'Zoom In', 'Zoom Out', 'Toggle'];
    const clickEvent: Record<string, string> = {
      'New': 'Toolbar: New clicked',
      'Open': 'Toolbar: Open clicked',
      'Save': 'Toolbar: Save clicked',
      'Zoom In': 'Toolbar: Zoom In clicked',
      'Zoom Out': 'Toolbar: Zoom Out clicked',
      'Toggle': 'Toolbar: Toggle',
    };
    for (const label of toolLabels) {
      const clicked = await clickToolbarTool(page, label);
      expect(clicked, `Tool "${label}" should be found and clicked`).toBe(true);
      await expect.poll(
        () => testLogger.consoleLogs.some(l => l.includes(clickEvent[label])),
        { message: `Tool "${label}" click event should be logged` }
      ).toBe(true);
    }

    await stableShot(page, 'toolbar-08-all-buttons.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
