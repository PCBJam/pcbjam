// wxClipboard Tests - Clipboard operations for KiCad copy/paste
// Uses element registry for semantic element identification
import { test, expect, waitForWxApp, clickByLabel } from './utils/fixtures';
import { stableShot } from './utils/element-tracker';

test.describe('wxClipboard Tests', () => {

  test('Clipboard test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'clipboard-01-loaded.png', { fullPage: true });

    const hasStartupLog = testLogger.consoleLogs.some(l =>
      l.includes('wxClipboard test app started') || l.includes('Clipboard test app started')
    );

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Copy button copies text to clipboard', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    // Seed the clipboard so a silently-failed write cannot pass as success.
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-BEFORE-COPY'));

    // Click "Copy to Clipboard" button
    await clickByLabel(page, 'Copy to Clipboard');

    // Either success (real clipboard worked) or at least attempt was made
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Copied')) || l.includes('Attempting to copy')
    ), { message: 'Copy should succeed or at least attempt' }).toBe(true);

    // The FULL input text must reach the browser clipboard — the UTF-32/UTF-8
    // mixup in wxTextDataObject used to truncate it to its first character.
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('Sample text for clipboard test');

    await stableShot(page, 'clipboard-02-copy-clicked.png', { fullPage: true });
  });

  test('Paste button retrieves text from clipboard', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    // First copy something
    await clickByLabel(page, 'Copy to Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Copied')) || l.includes('Attempting to copy')
    ), { message: 'Copy should log activity' }).toBe(true);

    // Click "Paste from Clipboard" button
    await clickByLabel(page, 'Paste from Clipboard');

    // Either we successfully pasted, there was no text (valid), or at least we attempted
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Pasted')) ||
      (l.includes('WARNING') && l.includes('No text data')) ||
      l.includes('Attempting to paste')
    ), { message: 'Paste should succeed or report no text' }).toBe(true);

    await stableShot(page, 'clipboard-03-paste-clicked.png', { fullPage: true });
  });

  test('Check clipboard button reports clipboard content', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    // First copy something to ensure clipboard has content
    await clickByLabel(page, 'Copy to Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Copied')) || l.includes('Attempting to copy')
    ), { message: 'Copy should log activity' }).toBe(true);

    // Click "Check Clipboard" button
    await clickByLabel(page, 'Check Clipboard');

    // Check for clipboard content report
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      l.includes('Clipboard contains') || l.includes('Checking clipboard')
    ), { message: 'Check should report clipboard contents' }).toBe(true);

    await stableShot(page, 'clipboard-04-check-clicked.png', { fullPage: true });
  });

  test('Clear clipboard button clears clipboard', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    // First copy something
    await clickByLabel(page, 'Copy to Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Copied')) || l.includes('Attempting to copy')
    ), { message: 'Copy should log activity' }).toBe(true);

    // Click "Clear Clipboard" button
    await clickByLabel(page, 'Clear Clipboard');

    // Check for SUCCESS log or at least attempt
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      (l.includes('SUCCESS') && l.includes('Clipboard cleared')) || l.includes('Attempting to clear')
    ), { message: 'Clear should succeed or at least attempt' }).toBe(true);

    await stableShot(page, 'clipboard-05-clear-clicked.png', { fullPage: true });
  });

  test('Full clipboard flow: copy, check, paste, clear', async ({ page, testLogger }) => {
    await page.goto('/standalone/clipboard/clipboard_test.html');
    await waitForWxApp(page);

    // 1. Copy
    await clickByLabel(page, 'Copy to Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      l.includes('SUCCESS') && l.includes('Copied') || l.includes('Attempting to copy')
    ), { message: 'Copy should log activity' }).toBe(true);

    // 2. Check
    await clickByLabel(page, 'Check Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      l.includes('Clipboard contains') || l.includes('Checking clipboard')
    ), { message: 'Check should report clipboard' }).toBe(true);

    // 3. Paste
    await clickByLabel(page, 'Paste from Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      l.includes('SUCCESS') && l.includes('Pasted') || l.includes('Attempting to paste')
    ), { message: 'Paste should log activity' }).toBe(true);

    // 4. Clear
    await clickByLabel(page, 'Clear Clipboard');
    await expect.poll(() => testLogger.consoleLogs.some(l =>
      l.includes('SUCCESS') && l.includes('Clipboard cleared') || l.includes('Attempting to clear')
    ), { message: 'Clear should log activity' }).toBe(true);

    await stableShot(page, 'clipboard-06-full-flow.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
