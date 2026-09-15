import { test, expect } from '@playwright/test';

/**
 * Mobile session-mode gate e2e (mobile 0002) — runs under the `web-mobile`
 * project (Pixel 7 emulation). On a phone a WRITER is asked, before the wasm
 * boots, whether to open the file view-only, comment-only or in the full
 * editor; the answer lands in the URL as `?mode=` and, when asked to, in
 * localStorage for the next open.
 *
 * Deliberately cheap: none of these wait for the editor to boot — the gate
 * renders (or not) on the boot payload alone, and the assertions are on the
 * dialog and the URL. The full mobile editor is mobile-editor.spec.ts.
 */

const SCOPE = 'default';
const FILE = `/${SCOPE}/projects/demo/demo.kicad_pcb`;

test.describe('mobile session-mode gate', () => {
  test('a writer on a phone is asked; the choice lands in ?mode=', async ({ page }) => {
    await page.goto(`${FILE}?mobile=1`);
    const gate = page.getByTestId('mobile-mode-gate');
    await expect(gate).toBeVisible();
    // A board offers all three; the wasm must NOT be booting behind it.
    await expect(page.getByTestId('mobile-mode-view')).toBeVisible();
    await expect(page.getByTestId('mobile-mode-comment')).toBeVisible();
    await expect(page.getByTestId('mobile-mode-edit')).toBeVisible();
    await expect(page.locator('#canvas')).toHaveCount(0);

    await page.getByTestId('mobile-mode-comment').click();
    await expect(gate).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('comment');
    // Not remembered: a fresh open asks again.
    expect(await page.evaluate(() => localStorage.getItem('pcbjam-mobile-mode'))).toBeNull();
  });

  test('"remember on this device" skips the dialog next time; ?mode= wins over it', async ({ page }) => {
    await page.goto(`${FILE}?mobile=1`);
    await page.getByTestId('mobile-mode-remember').check();
    await page.getByTestId('mobile-mode-view').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('view');
    expect(await page.evaluate(() => localStorage.getItem('pcbjam-mobile-mode'))).toBe('view');

    // Next open: applied silently.
    await page.goto(`${FILE}?mobile=1`);
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('view');
    await expect(page.getByTestId('mobile-mode-gate')).toHaveCount(0);

    // An explicit URL answer is never overridden by the stored one.
    await page.goto(`${FILE}?mobile=1&mode=edit`);
    await expect(page.getByTestId('mobile-mode-gate')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('mode')).toBe('edit');
  });

  test('not asked on a desktop pointer, nor on a fileless tool without comments', async ({ page }) => {
    await page.goto(`${FILE}?mobile=0`);
    await expect(page.getByTestId('mobile-mode-gate')).toHaveCount(0);
    // The calculator has nothing to comment on: two options only.
    await page.goto(`/${SCOPE}/projects/demo/-/calculator?mobile=1`);
    await expect(page.getByTestId('mobile-mode-gate')).toBeVisible();
    await expect(page.getByTestId('mobile-mode-comment')).toHaveCount(0);
    await expect(page.getByTestId('mobile-mode-edit')).toBeVisible();
  });
});
