// wxTimer Tests - Timer functionality for KiCad animations, auto-save, periodic updates
// Uses element registry for semantic element identification.
//
// Determinism: no waitForTimeout. Readiness via waitForWxApp; each button click's effect
// is the console event it emits, so we poll for that event (deterministic) instead of
// sleeping. The timer *tick* is a genuine scheduled event — the app logs each tick, so we
// poll for the tick log rather than guessing a duration. Mid-run "ticking"/"running"
// screenshots (which asserted nothing and whose pixels are timing-dependent) are dropped;
// the static loaded/started/stopped/reset states use stableShot.
import { test, expect, waitForWxApp, findByLabel, clickByLabel } from './utils/fixtures';
import { stableShot } from './utils/element-tracker';

test.describe('wxTimer Tests', () => {

  test('Timer test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/timer/timer_test.html');
    await waitForWxApp(page);

    await stableShot(page, 'timer-01-loaded.png', { fullPage: true });

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('Slow timer can be started and stopped', async ({ page, testLogger }) => {
    await page.goto('/standalone/timer/timer_test.html');
    await waitForWxApp(page);

    // Click Start for the slow timer (the first "Start" button, in the Slow Timer section).
    const startButton = await findByLabel(page, 'Start', { exact: true });
    expect(startButton, 'Slow-timer Start button should exist').not.toBeNull();
    await page.mouse.click(startButton!.centerX, startButton!.centerY);

    // The click's effect is the console event — poll for it (replaces waitForTimeout(500)).
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Slow timer started')),
      { message: 'Should log slow timer started' }).toBe(true);
    await stableShot(page, 'timer-02-started.png', { fullPage: true });

    // Wait for the timer to actually tick (the app logs each tick — deterministic,
    // replaces waitForTimeout(1500)).
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Slow timer tick')),
      { message: 'slow timer should tick', timeout: 8000 }).toBe(true);
    await stableShot(page, 'timer-03-ticked.png', { fullPage: true });

    // Click Stop for the slow timer.
    const stopButton = await findByLabel(page, 'Stop', { exact: true });
    expect(stopButton, 'Slow-timer Stop button should exist').not.toBeNull();
    await page.mouse.click(stopButton!.centerX, stopButton!.centerY);

    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Slow timer stopped')),
      { message: 'Should log slow timer stopped' }).toBe(true);
    await stableShot(page, 'timer-04-stopped.png', { fullPage: true });
  });

  test('Fast timer can be started and updates gauge', async ({ page, testLogger }) => {
    await page.goto('/standalone/timer/timer_test.html');
    await waitForWxApp(page);

    await clickByLabel(page, 'Start Fast');
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Fast timer started')),
      { message: 'Should log fast timer started' }).toBe(true);
    await stableShot(page, 'timer-05-fast-started.png', { fullPage: true });

    // Let the fast timer tick (deterministic). The fast timer continuously animates the
    // gauge, so this mid-run frame is timing-dependent; stableShot just captures a frame
    // for the offline gate (non-asserting) rather than trying to stabilize it.
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Fast timer tick')),
      { message: 'fast timer should tick', timeout: 8000 }).toBe(true);
    await stableShot(page, 'timer-06-fast-running.png', { fullPage: true });

    await clickByLabel(page, 'Stop Fast');
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Fast timer stopped')),
      { message: 'Should log fast timer stopped' }).toBe(true);
    // Screenshot the stopped (now-static) state.
    await stableShot(page, 'timer-07-fast-stopped.png', { fullPage: true });
  });

  test('Reset counters button works', async ({ page, testLogger }) => {
    await page.goto('/standalone/timer/timer_test.html');
    await waitForWxApp(page);

    // Start the slow timer and let it run briefly (poll for a tick) so there are counters
    // to reset — replaces waitForTimeout(1500).
    const startButton = await findByLabel(page, 'Start', { exact: true });
    expect(startButton, 'Slow-timer Start button should exist').not.toBeNull();
    await page.mouse.click(startButton!.centerX, startButton!.centerY);
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Slow timer tick')),
      { message: 'slow timer should tick before reset', timeout: 8000 }).toBe(true);

    await clickByLabel(page, 'Reset All Counters');
    await expect.poll(() => testLogger.consoleLogs.some(l => l.includes('Counters reset')),
      { message: 'Should log counters reset' }).toBe(true);
    await stableShot(page, 'timer-08-reset.png', { fullPage: true });
  });

  test('Stop and restart release exact long-delay mailbox reservations', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/timer/timer_test.html');
    await waitForWxApp(page);

    const result = await page.evaluate(() => new Promise<{
      accepted: boolean;
      nativeResult: number;
      beforeReserved: number;
      afterReserved: number;
      beforeRecords: number;
      afterRecords: number;
      dead: boolean;
    }>((resolve) => {
      const runtime = window as unknown as {
        Module: { _wx_timer_cancellation_probe(): number };
        __wxScheduler: {
          mailboxReserved: number;
          mailboxReservations: Map<number, unknown>;
          dead: boolean;
          enqueueNativeEntry(
            key: string | null,
            site: string,
            run: () => void,
          ): boolean;
        };
      };
      const scheduler = runtime.__wxScheduler;
      const beforeReserved = scheduler.mailboxReserved;
      const beforeRecords = scheduler.mailboxReservations.size;
      const accepted = scheduler.enqueueNativeEntry(
        null,
        'wxTimer cancellation probe',
        () => {
          const nativeResult = runtime.Module._wx_timer_cancellation_probe();
          resolve({
            accepted: true,
            nativeResult,
            beforeReserved,
            afterReserved: scheduler.mailboxReserved,
            beforeRecords,
            afterRecords: scheduler.mailboxReservations.size,
            dead: scheduler.dead,
          });
        },
      );
      if (!accepted) {
        resolve({
          accepted: false,
          nativeResult: 0,
          beforeReserved,
          afterReserved: scheduler.mailboxReserved,
          beforeRecords,
          afterRecords: scheduler.mailboxReservations.size,
          dead: scheduler.dead,
        });
      }
    }));

    expect(result).toEqual({
      accepted: true,
      nativeResult: 1,
      beforeReserved: result.beforeReserved,
      afterReserved: result.beforeReserved,
      beforeRecords: result.beforeRecords,
      afterRecords: result.beforeRecords,
      dead: false,
    });
    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
