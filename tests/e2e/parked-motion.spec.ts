// Mouse MOTION must reach wx while a dispatch chain is parked in a
// RunSynchronousAction-style spin (wxYield + wxMilliSleep).
//
// Harness: wxwidgets/tests/wasm/parked_motion_test.cpp (the bug lives in the
// wx wasm port, so the test case travels with it) — a "Start Spin" button
// whose handler spins exactly like KiCad's TOOL_MANAGER::RunSynchronousAction
// until the panel under the pointer sees a wxEVT_MOTION, or 3 s pass.
//
// Pre-fix the port's parked branch (wxApp::HandleMouseEvent) re-posted button
// events but dropped every motion, so KiCad's paste-move (which lives inside
// that spin) never followed the pointer although a click still placed it.
// The fix queues one coalesced motion per drain; the spin's own wxYield
// delivers it.
//
// Oracle discipline: the unparked-motion CHECK is the positive control (the
// panel does receive motion on the normal path); SPIN-START depth>=1 proves
// the parked path is what the spin exercises; the parked-motion CHECK and the
// SUITE-DONE failure counter are the actual assertions.

import { test, expect, waitForWxApp, clickByLabel } from './utils/fixtures';

const APP = '/standalone/parked-motion/parked_motion_test.html';

function parseLayout(logs: string[]): { x: number; y: number; w: number; h: number } | null {
  for (const l of logs) {
    const m = l.match(/\[PARKED\] LAYOUT panel=\((-?\d+),(-?\d+),(\d+),(\d+)\)/);
    if (m) return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  }
  return null;
}

test.describe('Parked-dispatch motion delivery', () => {
  test('motion reaches the window while a handler spins in wxYield + wxMilliSleep', async ({
    page,
    testLogger,
  }) => {
    await page.goto(APP);
    await waitForWxApp(page);
    await expect
      .poll(() => testLogger.consoleLogs.some(l => l.includes('[PARKED] READY')))
      .toBe(true);

    const box = await page.locator('#canvas').boundingBox();
    expect(box, 'canvas has a bounding box').not.toBeNull();
    const layout = parseLayout(testLogger.consoleLogs);
    expect(layout, 'harness logged its panel layout').not.toBeNull();

    // Panel-relative points in CSS px (the frame fills the canvas; screen
    // coords in the port are canvas coords).
    const px = (fx: number, fy: number) => ({
      x: Math.round(box!.x + layout!.x + layout!.w * fx),
      y: Math.round(box!.y + layout!.y + layout!.h * fy),
    });

    // Phase 1 — positive control: motion on the normal (unparked) path.
    const p0 = px(0.3, 0.3);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.move(p0.x + 20, p0.y + 10, { steps: 4 });
    await expect
      .poll(() => testLogger.consoleLogs.some(l => l.includes('[PARKED] CHECK unparked-motion PASS')), {
        message: 'the panel must see motion when nothing is parked (positive control)',
      })
      .toBe(true);

    // Phase 2 — the spin. The button handler parks its chain in wxMilliSleep;
    // every mouse move below arrives while it is parked.
    expect(await clickByLabel(page, 'Start Spin')).toBe(true);
    await expect
      .poll(() => testLogger.consoleLogs.some(l => /\[PARKED\] SPIN-START depth=\d+/.test(l)), {
        message: 'the spin handler should start',
      })
      .toBe(true);
    const depthLine = testLogger.consoleLogs.find(l => l.includes('[PARKED] SPIN-START depth='))!;
    const depth = parseInt(depthLine.match(/depth=(\d+)/)![1], 10);
    expect(depth, 'the spin runs inside a live dispatch chain (the parked path)').toBeGreaterThanOrEqual(1);

    const p1 = px(0.5, 0.5);
    const seen = () => testLogger.consoleLogs.some(l => l.includes('[PARKED] CHECK parked-motion'));
    // Bounded: the harness reports FAIL by itself after 3 s, so the loop ends
    // either way; each iteration is one real mousemove while parked. (The
    // spin also waits for its timers, so the CHECK lines land together.)
    for (let i = 0; i < 40 && !seen(); i++) {
      await page.mouse.move(p1.x + i * 6, p1.y + i * 3, { steps: 2 });
      await page.waitForTimeout(100); // eslint-disable-line -- documented interaction dwell: a queued motion is drained by the spin's next wxYield after its 1 ms nanosleep park resumes; poll-and-move, not a blind wait
    }
    await expect
      .poll(seen, { message: 'the spin should report its parked-motion check (PASS or FAIL)', timeout: 10000 })
      .toBe(true);

    const motionWhileParked = testLogger.consoleLogs.filter(l => /\[PARKED\] MOTION .* spinning=1/.test(l));
    console.log(`[parked-motion-spec] motions seen while the spin was parked: ${motionWhileParked.length}`);

    expect(
      testLogger.consoleLogs.some(l => /\[PARKED\] CHECK parked-motion PASS/.test(l)),
      'a mouse move must reach the panel while the button handler is parked in wxYield + wxMilliSleep (the paste-move bug)'
    ).toBe(true);
    expect(motionWhileParked.length, 'the delivered motion arrived while the spin handler was parked').toBeGreaterThan(0);

    // Timer facets (the "appears only after the first mouse move" half of the
    // paste bug): timers armed from the parked chain must fire inside its spin.
    expect(
      testLogger.consoleLogs.some(l => /\[PARKED\] CHECK parked-timer-oneshot PASS/.test(l)),
      'a one-shot wxTimer armed before the spin must fire inside wxYield + wxMilliSleep (KiCad GAL refresh timer)'
    ).toBe(true);
    expect(
      testLogger.consoleLogs.some(l => /\[PARKED\] CHECK parked-timer-periodic PASS/.test(l)),
      'a periodic wxTimer must keep ticking inside the spin (KiCad auto-pan timer)'
    ).toBe(true);
    expect(
      testLogger.consoleLogs.filter(l => /\[PARKED\] TIMER .* spinning=1/.test(l)).length,
      'the timer notifications ran while the spin handler was parked'
    ).toBeGreaterThanOrEqual(3);

    const done = testLogger.consoleLogs.find(l => l.includes('[PARKED] SUITE-DONE'));
    expect(done, 'suite completed').toBeDefined();
    expect(parseInt(done!.match(/failures=(\d+)/)![1], 10)).toBe(0);
  });
});
