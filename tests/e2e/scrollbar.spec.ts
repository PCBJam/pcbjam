// Draggable scrollbar e2e — the DOM scrollbar widget reports drags back to
// C++ (wxEVT_SCROLL for the standalone wxScrollBar; wxEVT_SCROLLWIN for the
// wxScrolledWindow gutter, which scrolls the content). The thumb registers as
// 'slider' + 'slidertrack' so Playwright can drag it.
import { test, expect, waitForWxApp } from './utils/fixtures';
import { findRenderedByType, stableShot } from './utils/element-tracker';

test.describe('DOM-port scrollbars', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/standalone/scrollbar/scrollbar_test.html');
    await waitForWxApp(page);
  });

  test('scrollbars render draggable thumbs', async ({ page, testLogger }) => {
    await expect.poll(
      async () => (await findRenderedByType(page, 'slider')).length,
      { timeout: 8000, message: 'scrollbar thumbs should register' },
    ).toBeGreaterThanOrEqual(2);

    await stableShot(page, 'scrollbar-01-loaded.png', { fullPage: true });
    expect(testLogger.errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });

  test('dragging a thumb scrolls (standalone control fires wxEVT_SCROLL)', async ({
    page,
    testLogger,
  }) => {
    await expect.poll(
      async () => (await findRenderedByType(page, 'slider')).length,
      { timeout: 8000 },
    ).toBeGreaterThanOrEqual(2);

    const sliders = await findRenderedByType(page, 'slider');
    const tracks = await findRenderedByType(page, 'slidertrack');

    // Drag every thumb toward the far end of its track. The standalone
    // scrollbars log "[SCROLLBAR_EVENT] scrollbar pos N"; the scrolled-window
    // gutters scroll the content (captured in the screenshot).
    for (let i = 0; i < sliders.length; i++) {
      const s = sliders[i];
      const t = tracks.find((tr) => tr.parentId === s.parentId) ?? tracks[i];
      if (!t) continue;
      const horizontal = t.width > t.height;
      const tx = horizontal ? t.screenX + t.width * 0.85 : t.centerX;
      const ty = horizontal ? t.centerY : t.screenY + t.height * 0.85;

      await page.mouse.move(s.centerX, s.centerY);
      await page.mouse.down();
      await page.mouse.move(tx, ty, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell: slider drag commit before the next drag
    }

    // At least one standalone scrollbar must have reported a non-zero position.
    await expect.poll(
      () => testLogger.consoleLogs.some((l) => /\[SCROLLBAR_EVENT\] scrollbar pos [1-9]/.test(l)),
      { timeout: 8000, message: 'a standalone scrollbar drag should report a non-zero position' },
    ).toBe(true);

    await stableShot(page, 'scrollbar-02-dragged.png', { fullPage: true });
  });
});
