import { test, expect, tryLoadApp } from './utils/fixtures';

// Red-green reproduction: hiding the window that holds focus must move focus
// off it (wxWindowWasm::Show, src/wasm/window.cpp).
//
// KiCad's board editor focuses the Search pane's text box while the frame is
// built, then hides the pane. The port left wx focus on the hidden box, so every
// hotkey went to it, and KiCad's canvas would not take focus on hover while a
// text control "had" it: hover a part + E (Properties) did nothing until the
// first click (tests/web/properties-hotkey.spec.ts is the in-app repro). The app
// replays that boot (text box in a side pane takes focus, pane hidden), then
// this spec presses a key and the app reports which window received it.
//
//   RED  (bug present): focus stays on the hidden box; the key goes there.
//   GREEN (fixed):      focus moves to the canvas; the key arrives there.

function reproLine(logs: string[], name: string): string | undefined {
  return logs.find((l) => l.includes(`[REPRO] ${name}:`));
}

test.describe('hiding the focused window releases focus', () => {
  test('focus leaves a hidden pane and keys reach the canvas', async ({ page, testLogger }) => {
    await page.goto('/standalone/hidden-focus/hidden-focus_test.html');
    expect(await tryLoadApp(page, 30000), 'repro app should load').toBe(true);

    await expect
      .poll(() => reproLine(testLogger.consoleLogs, 'ready_for_key') ?? null, {
        timeout: 30000,
        message: 'repro app should hide its pane and report ready',
      })
      .not.toBeNull();

    const released = reproLine(testLogger.consoleLogs, 'hidden_window_releases_focus')!;
    expect(released, `repro line was: ${released}`).toContain('[REPRO] hidden_window_releases_focus: PASS');

    await page.keyboard.press('e');
    await expect
      .poll(() => reproLine(testLogger.consoleLogs, 'key_target') ?? null, {
        timeout: 15000,
        message: 'the key should reach some wx window (canvas or the hidden box)',
      })
      .not.toBeNull();
    const target = reproLine(testLogger.consoleLogs, 'key_target')!;
    expect(target, `repro line was: ${target}`).toContain('[REPRO] key_target: PASS');
  });
});
