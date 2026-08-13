// wxInfoBar Tests - Notification bar for KiCad messages
import { test, expect } from './utils/fixtures';
import { clickByLabel, waitForWxApp, stableShot } from './utils/element-tracker';

test.describe('wxInfoBar Tests', () => {

  test('InfoBar test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'infobar-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('INFOBAR_TEST'));

    expect(hasStartup, 'the native InfoBar app must reach its startup marker').toBe(true);
    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Show Info Message button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    // Click Show Info Message button using element registry
    const clicked = await clickByLabel(page, 'Show Info Message');
    expect(clicked, 'Show Info Message button should be found and clicked').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[INFOBAR_EVENT] Showed info message')),
      { message: 'Info message should show' }
    ).toBe(true);

    await stableShot(page, 'infobar-02-info.png', { fullPage: true });
  });

  test('Show Warning Message button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    // Click Show Warning Message button using element registry
    const clicked = await clickByLabel(page, 'Show Warning Message');
    expect(clicked, 'Show Warning Message button should be found and clicked').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[INFOBAR_EVENT] Showed warning message')),
      { message: 'Warning message should show' }
    ).toBe(true);

    await stableShot(page, 'infobar-03-warning.png', { fullPage: true });
  });

  test('Show Error Message button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    // Click Show Error Message button using element registry
    const clicked = await clickByLabel(page, 'Show Error Message');
    expect(clicked, 'Show Error Message button should be found and clicked').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[INFOBAR_EVENT] Showed error message')),
      { message: 'Error message should show' }
    ).toBe(true);

    await stableShot(page, 'infobar-04-error.png', { fullPage: true });
  });

  test('Dismiss button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    // First show a message using element registry
    const infoClicked = await clickByLabel(page, 'Show Info Message');
    expect(infoClicked, 'Show Info Message button should be found').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[INFOBAR_EVENT] Showed info message')),
      { message: 'Info message should show before dismiss' }
    ).toBe(true);

    // Then dismiss using element registry
    const dismissClicked = await clickByLabel(page, 'Dismiss');
    expect(dismissClicked, 'Dismiss button should be found and clicked').toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[INFOBAR_EVENT] Info bar dismissed')),
      { message: 'Dismiss should work' }
    ).toBe(true);

    await stableShot(page, 'infobar-05-dismiss.png', { fullPage: true });
  });

  test('DOM-backed click keeps control identity across stale registry geometry', async ({ page, testLogger }) => {
    await page.goto('/standalone/infobar/infobar_test.html');
    await waitForWxApp(page);

    expect(await clickByLabel(page, 'Show Info Message')).toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some((line) =>
        line.includes('[INFOBAR_EVENT] Showed info message')),
      { message: 'the show event must be applied before constructing stale geometry' }
    ).toBe(true);

    const setup = await page.evaluate(() => {
      const registry = window.wxElementRegistry;
      const dismiss = registry?.findByLabel('Dismiss', { exact: true })[0];
      const wrongTarget = registry?.findByLabel('Show With Action Button', { exact: true })[0];
      if (!dismiss || !wrongTarget) return null;

      // Model the real failure deterministically: a queued relayout made this
      // cached point belong to a different control before the pointer action.
      // The DOM identity remains valid and is the authoritative click target.
      dismiss.screenX = wrongTarget.screenX;
      dismiss.screenY = wrongTarget.screenY;
      dismiss.centerX = wrongTarget.centerX;
      dismiss.centerY = wrongTarget.centerY;
      return { domId: dismiss.domId };
    });

    expect(setup?.domId, 'tracked DOM controls must publish stable browser identity')
      .toBeGreaterThan(0);
    expect(await clickByLabel(page, 'Dismiss', { exact: true })).toBe(true);

    await expect.poll(
      () => testLogger.consoleLogs.some((line) =>
        line.includes('[INFOBAR_EVENT] Info bar dismissed')),
      { message: 'semantic click must follow the Dismiss control, not its stale point' }
    ).toBe(true);
    expect(testLogger.consoleLogs.some((line) =>
      line.includes('[INFOBAR_EVENT] Showed message with action button'))).toBe(false);
  });

});
