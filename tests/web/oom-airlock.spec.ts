import { test, expect, type Page } from '@playwright/test';

/**
 * OOM process airlock — standalone-hardening 0009.
 *
 * Firefox runs every cross-origin-isolated pcbjam page in ONE content process,
 * so recovering from an out-of-memory by reloading lands back in the exhausted
 * process. Recovery now goes through /recover, a page served WITHOUT COOP/COEP
 * (the tab leaves the isolated process), which then returns to the editor.
 *
 * The OOM is synthesized through the same seam emscripten uses (Module.onAbort);
 * a real OOM is not deterministically available. Whether Firefox actually
 * retires the process is a release-browser property (checked by hand with
 * about:processes), not something Playwright's patched Firefox can show.
 */

const SCOPE = 'default';
const EDITOR = `/${SCOPE}/projects/demo/demo.kicad_pcb`;

async function openEditor(page: Page, user: string) {
  await page.goto(`${EDITOR}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: 'editor never reached the expected title',
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
}

test('/recover is served without cross-origin isolation, the editor with it', async ({ request }) => {
  const recover = await request.get('/recover?to=/');
  expect(recover.ok()).toBe(true);
  expect(recover.headers()['cross-origin-opener-policy']).toBeUndefined();
  expect(recover.headers()['cross-origin-embedder-policy']).toBeUndefined();
  const editor = await request.get(EDITOR);
  expect(editor.headers()['cross-origin-opener-policy']).toBe('same-origin');
});

test('/recover refuses to send the tab off-origin', async ({ page }) => {
  await page.goto('/recover?to=https://example.com/');
  const origin = new URL(page.url()).origin;
  await page.getByTestId('airlock-continue').click();
  await page.waitForURL((u) => u.pathname === '/', { timeout: 30000 });
  expect(new URL(page.url()).origin).toBe(origin);
});

test('a soft OOM abort goes through the airlock and the editor boots isolated again', async ({ page }) => {
  test.setTimeout(420000); // two full pcbnew wasm boots

  await openEditor(page, 'oom-airlock');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.evaluate(() => {
    const mod = (window as unknown as { Module?: { onAbort?: (what: unknown) => void } }).Module;
    setTimeout(() => mod?.onAbort?.('Aborted(OOM synthesized by oom-airlock.spec)'), 0);
  });

  await page.waitForURL(/\/recover\?to=/, { timeout: 30000 });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  const back = new URL(new URL(page.url()).searchParams.get('to')!, page.url());
  expect(back.pathname).toBe(EDITOR);
  expect(back.searchParams.get('oomRetry')).toBe('1');

  await page.getByTestId('airlock-continue').click();
  await page.waitForURL((u) => u.pathname === EDITOR, { timeout: 30000 });
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect.poll(() => page.title(), { timeout: 120000, intervals: [1000] }).toMatch(/demo — PCB Editor/i);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('the airlock lists editor tabs that are still open', async ({ context }) => {
  test.setTimeout(300000);
  const editor = await context.newPage();
  await openEditor(editor, 'oom-census');

  const airlock = await context.newPage();
  await airlock.goto(`/recover?to=${encodeURIComponent(EDITOR)}`);
  await expect(airlock.getByTestId('airlock-tabs')).toContainText(/demo — PCB Editor/i, { timeout: 10000 });

  // Closing the editor lets the airlock move on to its countdown.
  await editor.close();
  await expect(airlock.getByTestId('airlock-continue')).toBeVisible({ timeout: 15000 });
});
