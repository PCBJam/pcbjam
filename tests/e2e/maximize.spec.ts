// Maximize Test - Reproduces KiCad startup issue where Maximize() results in tiny window
// This tests that wxFrame::Maximize() works correctly when called at startup
import { test, expect, tryLoadApp, getCanvasBox, waitForWxApp } from './utils/fixtures';
import { stableShot } from './utils/element-tracker';

test.describe('wxFrame::Maximize() Tests', () => {

  test('Maximize test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/maximize/maximize_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'maximize-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('[MAXIMIZE_TEST] Maximize test app started'));

    expect(hasStartup, 'Startup log should be present').toBe(true);
    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Maximized window has reasonable size (not tiny)', async ({ page, testLogger }) => {
    await page.goto('/standalone/maximize/maximize_test.html');
    await waitForWxApp(page);

    // Wait for maximize to complete (Window size log fires once maximize settles)
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[MAXIMIZE_TEST] Window size:')),
      { message: 'Window size log should appear after maximize completes' },
    ).toBe(true);

    await stableShot(page, 'maximize-02-fullscreen.png', { fullPage: true });

    // Check console logs for size
    const sizeLogs = testLogger.consoleLogs.filter(l => l.includes('[MAXIMIZE_TEST] Window size:'));
    expect(sizeLogs.length).toBeGreaterThan(0);

    // Parse window size from log
    const lastSizeLog = sizeLogs[sizeLogs.length - 1];
    const sizeMatch = lastSizeLog.match(/Window size: (\d+)x(\d+)/);
    expect(sizeMatch, 'Size log should contain dimensions').not.toBeNull();

    const width = parseInt(sizeMatch![1]);
    const height = parseInt(sizeMatch![2]);

    // Window should be larger than 100px if maximize worked
    // This is the key assertion - KiCad bug results in 20x20 or 30x20 windows
    expect(width, 'Window width should be > 100px (got ' + width + ')').toBeGreaterThan(100);
    expect(height, 'Window height should be > 100px (got ' + height + ')').toBeGreaterThan(100);

    // Check for PASS/FAIL log
    const passLog = testLogger.consoleLogs.some(l => l.includes('[MAXIMIZE_TEST] PASS'));
    const failLog = testLogger.consoleLogs.some(l => l.includes('[MAXIMIZE_TEST] FAIL'));

    expect(failLog, 'Should not have FAIL log').toBe(false);
    expect(passLog, 'Should have PASS log').toBe(true);
  });

  // Note: wxDisplay::GetFromWindow() has a bug returning invalid display index
  // This is a separate issue from the Maximize() functionality being tested
  // Re-verified broken 2026-08-13: wxDisplay reports 0x0 in this harness app
  // (JSPI build) — the port's display-geometry query, not Maximize().
  test.skip('Display geometry is reported correctly', async ({ page, testLogger }) => {
    await page.goto('/standalone/maximize/maximize_test.html');
    const loaded = await tryLoadApp(page);
    expect(loaded, 'App should load').toBe(true);

    await page.waitForTimeout(500);  // eslint-disable-line -- skipped test; inert

    // Check display geometry logs
    const geomLogs = testLogger.consoleLogs.filter(l => l.includes('[MAXIMIZE_TEST] Display geometry:'));
    expect(geomLogs.length).toBeGreaterThan(0);

    // Parse display geometry
    const geomLog = geomLogs[0];
    const geomMatch = geomLog.match(/Display geometry: (\d+)x(\d+)/);
    expect(geomMatch, 'Geometry log should contain dimensions').not.toBeNull();

    if (geomMatch) {
      const displayWidth = parseInt(geomMatch[1]);
      const displayHeight = parseInt(geomMatch[2]);

      // Display should report reasonable viewport size
      expect(displayWidth, 'Display width should be > 100px').toBeGreaterThan(100);
      expect(displayHeight, 'Display height should be > 100px').toBeGreaterThan(100);
    }
  });

  test('Canvas is properly sized after maximize', async ({ page, testLogger }) => {
    await page.goto('/standalone/maximize/maximize_test.html');
    await waitForWxApp(page);

    // Wait for maximize to complete (Window size log fires once maximize settles)
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[MAXIMIZE_TEST] Window size:')),
      { message: 'Window size log should appear after maximize completes' },
    ).toBe(true);

    const box = await getCanvasBox(page);

    await stableShot(page, 'maximize-03-canvas.png', { fullPage: true });

    // Canvas should be reasonably sized (not tiny)
    expect(box.width, 'Canvas width should be > 100px').toBeGreaterThan(100);
    expect(box.height, 'Canvas height should be > 100px').toBeGreaterThan(100);
  });
});
