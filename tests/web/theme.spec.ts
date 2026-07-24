import { test, expect } from '@playwright/test';

/**
 * Standalone theme follow e2e (comments-ux 0002): resolution precedence
 * (?theme= param > storage > OS), no-flash application before first paint,
 * persistence across a param-less reload, and the shell toggle. Kept on the
 * HOME page — no tool boot needed; the canvas half (seeded KiCad color theme
 * + the kicadSetColorTheme bridge) is covered by unit seeding assertions and
 * manual Firefox verification per the standalone UI workflow.
 */

test('?theme=dark applies before paint, persists, and the toggle flips it', async ({ page }) => {
  await page.goto('/?theme=dark', { waitUntil: 'domcontentloaded' });
  // The inline boot script ran before first paint — no React needed yet.
  await expect(page.locator('html')).toHaveClass(/dark/);

  // The param persisted; a param-less reload stays dark.
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('pcbjam-theme'))).toBe('dark');

  // Shell toggle flips class + storage.
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('pcbjam-theme'))).toBe('light');

  // A later ?theme= wins over the stored choice.
  await page.goto('/?theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('invalid ?theme= falls back to the stored/OS preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?theme=purple', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});
