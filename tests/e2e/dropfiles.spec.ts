// repro for G-14: browser file drops must reach the DragAcceptFiles() owner.
//
// Harness: wxwidgets/tests/wasm/dropfiles_test.cpp (the bug lives in the wx
// wasm port, so the test case travels with it) — a frame that registered via
// DragAcceptFiles(true) + EVT_DROP_FILES, fully covered by child panels, so
// the leaf under every drop point is never the frame. Pre-fix, the port
// delivered the synthesized wxDropFilesEvent to wxFindWindowAtPoint()'s leaf;
// wxDropFilesEvent does not propagate, so both drops below died silently.
//
// Oracle discipline: the JS receipt logs are the positive control (the drop
// reached the page and was written to MEMFS); the [DROPFILES] delivery logs +
// the cumulative SUMMARY counter are the actual assertions. The dnd.spec.ts
// suite historically asserted only the receipt half — the false-green this
// spec exists to prevent.

import { test, expect, waitForCanvasApp } from './utils/fixtures';

const APP = '/standalone/dropfiles/dropfiles_test.html';

// Fixed canvas-relative drop points, matching the harness layout (frame fills
// the canvas): A lands on the outer panel, B inside the nested panel at
// (300,200)+300x200. The harness logs its LAYOUT rects for debugging drift.
const POINT_A = { x: 100, y: 100 };
const POINT_B = { x: 400, y: 300 };

async function dropFileAt(
  page: import('@playwright/test').Page,
  box: { x: number; y: number },
  point: { x: number; y: number },
  fileName: string
) {
  await page.evaluate(
    ({ x, y, name }) => {
      const canvas = document.getElementById('canvas');
      if (!canvas) return;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['g14 drop payload'], name, { type: 'text/plain' }));
      canvas.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer,
        })
      );
    },
    { x: box.x + point.x, y: box.y + point.y, name: fileName }
  );
}

test.describe('DropFiles delivery (G-14)', () => {
  test('drops over leaf children reach the DragAcceptFiles frame', async ({
    page,
    testLogger,
  }) => {
    await page.goto(APP);
    await waitForCanvasApp(page);
    await expect
      .poll(() => testLogger.consoleLogs.some(l => l.includes('[DROPFILES] READY')))
      .toBe(true);

    const box = await page.locator('#canvas').boundingBox();
    expect(box, 'canvas has a bounding box').not.toBeNull();

    // Drop A: over the outer panel (leaf = outer panel, not the frame).
    await dropFileAt(page, box!, POINT_A, 'g14-outer.txt');

    // Positive control: the JS side received and wrote the file.
    await expect
      .poll(() =>
        testLogger.consoleLogs.some(
          l => l.includes('[DND] Wrote file:') && l.includes('g14-outer.txt')
        )
      )
      .toBe(true);

    // The delivery assertion (dies pre-fix): the frame handler ran.
    await expect
      .poll(() =>
        testLogger.consoleLogs.some(
          l => l.includes('[DROPFILES] delivered n=1') && l.includes('g14-outer.txt')
        )
      )
      .toBe(true);

    // Drop B: over the nested panel (a deeper leaf exercises the walk-up).
    await dropFileAt(page, box!, POINT_B, 'g14-nested.txt');

    await expect
      .poll(() =>
        testLogger.consoleLogs.some(
          l => l.includes('[DND] Wrote file:') && l.includes('g14-nested.txt')
        )
      )
      .toBe(true);

    await expect
      .poll(() =>
        testLogger.consoleLogs.some(
          l => l.includes('[DROPFILES] delivered n=1') && l.includes('g14-nested.txt')
        )
      )
      .toBe(true);

    // Counter, not FAIL-line absence: exactly two deliveries happened.
    expect(
      testLogger.consoleLogs.some(l => l.includes('[DROPFILES] SUMMARY delivered=2')),
      'both drops were delivered to the frame'
    ).toBe(true);
  });
});
