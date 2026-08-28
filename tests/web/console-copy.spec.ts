import { test, expect, type Page } from '@playwright/test';

/**
 * repro for R-4 (docs/features/findings/groups/R-fixed-during-demo-record.md)
 *
 * wx's window-level keydown handler forwards every non-printable chord to the
 * wasm app and `preventDefault`s it (wxwidgets/src/wasm/app.cpp,
 * `preventDefault = !KeyEventIsPlainPrintable(...)`). Ctrl/Cmd+C is such a
 * chord, so the browser's native "copy selection" never ran: log text in the
 * console panel could be selected but not copied. WasmTool now intercepts the
 * chord in the CAPTURE phase when the selection lives in the console and stops
 * propagation, so the default copy fires; and a canvas pointerdown collapses a
 * stale console selection so it cannot steal the editor's own Ctrl+C.
 *
 * Oracle: a `copy` event on the document. Cancelling the keydown suppresses
 * the copy default, so with the guard removed no `copy` event fires. Engine-
 * neutral (no clipboard-read permission needed). The chord is ControlOrMeta+C:
 * headless engines honour the HOST platform's copy accelerator (Meta on a mac
 * dev box, Control on Linux CI) regardless of the device UA — a plain
 * Control+C never copies on macOS (probed on both engines). The guard checks
 * metaKey || ctrlKey, so either spelling exercises it.
 */

const SCOPE = 'default';

async function bootBoard(page: Page): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=copy-probe`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: 'editor never reached the expected title',
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
}

test('Ctrl+C copies a console-log selection instead of being eaten by wx', async ({ page }) => {
  test.setTimeout(300000); // one full pcbnew wasm boot

  await bootBoard(page);

  // Open the console footer (closed state is the "console (N)" tab).
  await page.getByRole('button', { name: /console \(/ }).first().click();
  const log = page.locator('pre.select-text');
  await expect(log).toBeVisible({ timeout: 10000 });
  await expect.poll(() => log.innerText()).not.toBe('');

  // Select the log text and arm the oracle.
  await page.evaluate(() => {
    const w = window as unknown as { __copyFired: number; __keydownPrevented: boolean | null };
    w.__copyFired = 0;
    w.__keydownPrevented = null;
    document.addEventListener('copy', () => { w.__copyFired++; });
    // Bubble-phase listener on window = after wx's handler; records whether the
    // chord's default was cancelled (the failure mode).
    // Diagnostics (window capture = same node as the guard, fires after it;
    // document capture = only reachable if the guard did NOT stop propagation).
    const d = window as unknown as { __diag: Record<string, unknown> };
    d.__diag = { winCapture: 0, docCapture: 0, docPreventedAtBubble: null as boolean | null };
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        (d.__diag.winCapture as number)++;
        d.__diag.active = document.activeElement?.tagName + '#' + (document.activeElement?.id || '');
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') (d.__diag.docCapture as number)++;
    }, true);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') d.__diag.docPreventedAtBubble = e.defaultPrevented;
    });
    const pre = document.querySelector('pre.select-text');
    if (!pre) throw new Error('console <pre> not found');
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);

  await page.keyboard.press('ControlOrMeta+c');
  console.log('[R-4 diag]', JSON.stringify(await page.evaluate(() => (window as unknown as { __diag: unknown }).__diag)));

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copyFired: number }).__copyFired), {
      message: 'no copy event — wx swallowed Ctrl+C with the selection in the console',
      timeout: 5000,
    })
    .toBeGreaterThan(0);

  // A canvas pointerdown collapses the console selection (wx preventDefaults the
  // native collapse), so a stale log selection cannot keep stealing Ctrl+C.
  await page.evaluate(() => {
    const c = document.querySelector('#canvas') as HTMLCanvasElement;
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true), {
      message: 'console selection should collapse on canvas pointerdown',
      timeout: 5000,
    })
    .toBe(true);
});
