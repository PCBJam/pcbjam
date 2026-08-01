import { test, expect } from '@playwright/test';

/**
 * The blue screen of death must actually appear (WSOD hardening, async/16
 * companion). Three prod crash reports in a row (v0.1.19–21) ended in a WHITE
 * page because the crash killed the very UI built to report it: the final
 * trap landed inside a React effect, React unmounted the root, and the fatal
 * overlay + console panel died with it. The fix is layered — window/worker
 * error listeners promote a `fatal` state rendered OUTSIDE a WasmErrorBoundary
 * that absorbs descendant render/effect throws — and this spec pins the
 * user-visible contract:
 *
 *   a terminal-looking uncaught error after boot ⇒ the blue fatal overlay is
 *   VISIBLE and the console log panel is OPEN (the log is the only account of
 *   what was loading; a collapsed console behind a mystery screen is useless).
 *
 * The throw is synthesized (a real wasm trap is not deterministically
 * available), but it exercises the identical promotion path: uncaught error →
 * terminal() match → promote → overlay + console.
 */

const SCOPE = 'default';

test('a terminal uncaught error raises the blue fatal overlay with the console open', async ({
  page,
}) => {
  test.setTimeout(300000); // one full pcbnew wasm boot

  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=fatal-probe`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: 'editor never reached the expected title',
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);

  // Synthesize the trap: an uncaught error whose message matches the
  // terminal signature set (Firefox's bare wasm trap spelling included).
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('index out of bounds');
    }, 0);
  });

  await expect(page.getByTestId('fatal-overlay')).toBeVisible({ timeout: 10000 });
  // The console panel auto-opened and carries the promotion record.
  await expect(page.locator('pre').filter({ hasText: '[fatal]' })).toBeVisible({
    timeout: 10000,
  });
  // While React's overlay is alive, the DOM floor stays out of the way.
  await expect(page.getByTestId('fatal-screen-dom')).toHaveCount(0);

  // Simulate what prod actually did three releases in a row: React unmounts
  // its whole root after the fatal. The DOM-level floor must take over —
  // blue screen + the mirrored log — instead of a white page.
  await page.evaluate(() => {
    document.querySelector('[data-testid="fatal-overlay"]')?.closest('#root, body > div')?.remove();
  });
  await expect(page.getByTestId('fatal-screen-dom')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#pcbjam-fatal-screen pre')).toContainText('[fatal]', {
    timeout: 5000,
  });
});
