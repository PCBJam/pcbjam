import { test, expect, type Page } from '@playwright/test';

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

/**
 * A report screenshot must show the editor: not blank (a blank capture has one
 * or two colors) and not the crash screen (#1a1a2e covers about half of a
 * capture of it; an editor capture has next to none). Sampled every 97th pixel.
 */
async function expectEditorScreenshot(page: Page, testId: string): Promise<void> {
  const stats = await page.getByTestId(testId).evaluate(async (node) => {
    const img = node as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set<number>();
    let samples = 0;
    let crashBlue = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      samples++;
      seen.add((r << 16) | (g << 8) | b);
      crashBlue += Number(Math.abs(r - 26) <= 6 && Math.abs(g - 26) <= 6 && Math.abs(b - 46) <= 6);
    }
    return { colors: seen.size, crashBlueShare: crashBlue / samples };
  });
  expect(stats.colors, `${testId} is blank`).toBeGreaterThan(8);
  expect(stats.crashBlueShare, `${testId} shows the crash screen`).toBeLessThan(0.2);
}

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

  // Note whether the DOM floor is ever added while React is alive: it used to
  // go up in the same tick as the fatal and cover React's overlay (and its
  // "Report this problem" button) until the next 1 Hz check took it down.
  await page.evaluate(() => {
    const w = window as Window & { __floorSeen?: boolean };
    w.__floorSeen = false;
    new MutationObserver(() => {
      if (document.getElementById('pcbjam-fatal-screen')) w.__floorSeen = true;
    }).observe(document.body, { childList: true });
  });

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
  // Its "Report this problem" is not under the open console, and the dialog's
  // screenshot shows the editor, not the blue overlay on top of it.
  await page.getByTestId('fatal-report-problem').click();
  const dialog = page.getByTestId('report-problem-dialog');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expectEditorScreenshot(page, 'report-problem-screenshot');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  // While React's overlay is alive, the DOM floor stays out of the way.
  await expect(page.getByTestId('fatal-screen-dom')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as Window & { __floorSeen?: boolean }).__floorSeen),
    'the DOM floor flashed over the React overlay',
  ).toBe(false);

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

  // With React gone the floor still sends a problem report. The example
  // backend has no such route, so it is answered here (preflight included);
  // what the page posts is what a real backend would get.
  const captured: { body?: { description?: string; logs?: { editor?: string[] } } } = {};
  const cors = {
    'access-control-allow-origin': new URL(page.url()).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST',
  };
  await page.route('**/api/problem-reports', async (route) => {
    const preflight = route.request().method() === 'OPTIONS';
    captured.body = preflight ? captured.body : route.request().postDataJSON();
    await route.fulfill({
      status: preflight ? 204 : 201,
      headers: cors,
      contentType: 'application/json',
      body: preflight ? '' : JSON.stringify({ id: '0badc0de-0000-4000-8000-000000000000', shortId: '0badc0de', supportAccessUntil: null }),
    });
  });
  await page.getByTestId('fatal-screen-report').click();
  // The editor as it was at the crash: React took its DOM with it since.
  await expectEditorScreenshot(page, 'fatal-report-screenshot');
  await page.getByTestId('fatal-report-description').fill('the board froze while routing');
  await page.getByTestId('fatal-report-send').click();
  await expect(page.getByTestId('fatal-report-sent')).toHaveText('Report #0badc0de sent. Thank you!', {
    timeout: 30000,
  });
  expect(captured.body?.description).toBe('the board froze while routing');
  expect(captured.body?.logs?.editor?.some((line) => line.startsWith('[fatal]'))).toBe(true);
});
