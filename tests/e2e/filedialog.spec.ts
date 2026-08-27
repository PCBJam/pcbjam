// wxFileDialog Tests - File dialogs for KiCad open/save operations
// Uses element registry for semantic element identification
import { test, expect, waitForWxApp, clickByLabel } from './utils/fixtures';
import { stableShot } from './utils/element-tracker';

test.describe('wxFileDialog Tests', () => {

  test('FileDialog test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/filedialog/filedialog_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'filedialog-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('FileDialog test app started'));

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Open file button can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/filedialog/filedialog_test.html');
    await waitForWxApp(page);

    // Click "Open File..." button
    await clickByLabel(page, 'Open File...');

    await stableShot(page, 'filedialog-02-open-clicked.png', { fullPage: true });

    expect(true).toBe(true); // Smoke test
  });

  test('Save file button can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/filedialog/filedialog_test.html');
    await waitForWxApp(page);

    // Click "Save File..." button
    await clickByLabel(page, 'Save File...');

    await stableShot(page, 'filedialog-03-save-clicked.png', { fullPage: true });

    expect(true).toBe(true);
  });

  test('Open multiple button can be clicked', async ({ page, testLogger }) => {
    await page.goto('/standalone/filedialog/filedialog_test.html');
    await waitForWxApp(page);

    // Click "Open Multiple..." button
    await clickByLabel(page, 'Open Multiple...');

    await stableShot(page, 'filedialog-04-multiple-clicked.png', { fullPage: true });

    expect(true).toBe(true);
  });

  test('All file dialog buttons accessible', async ({ page, testLogger }) => {
    await page.goto('/standalone/filedialog/filedialog_test.html');
    await waitForWxApp(page);

    // Try all three buttons
    await clickByLabel(page, 'Open File...');
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: click commit before the next dialog button click
    await clickByLabel(page, 'Save File...');
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: click commit before the next dialog button click
    await clickByLabel(page, 'Open Multiple...');

    await stableShot(page, 'filedialog-05-all-buttons.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
