import { test, expect, tryLoadApp } from '../e2e/utils/fixtures';

/**
 * S2 scheduler-core gates (docs/features/async/17 §3d N1/N4, §4 S2).
 * Runs against the races harness built with WX_SCHEDULER=1 (scheduler-only
 * glue — the legacy handlesleep shim is NOT injected on scheduler builds).
 * Both tests self-skip on legacy glue, so the file is safe in either variant.
 *
 * N1 — single-writer tripwire: Asyncify.currData is an accessor; a pure-JS
 * write without scheduler authorization beacons (and throws in strict mode).
 * The meta-test INTRODUCES a stray writer and expects the tripwire to fire —
 * proving the alarm works, not merely that nobody tripped it.
 *
 * N4 — wake-never-rewinds-mid-transition: across the races battery (which
 * stages overlapping parks, nested modals, out-of-order wakes) the
 * scheduler's books must be coherent at settle: no queued wake left, every
 * deferral drained, zero unplanned strays, battery green.
 */

type SchedulerState = {
  state(): string;
  strayWrites: number;
  strictStrays: boolean;
  readyWakes: unknown[];
  deferredWakes: number;
  drainedWakes: number;
};

function findSummary(logs: string[]) {
  return logs.find((log) => log.includes('[ASYNCIFY_RACES] SUMMARY'));
}

async function bootAndSettle(
  page: import('@playwright/test').Page,
  testLogger: { consoleLogs: string[] },
): Promise<boolean> {
  await page.goto('/standalone/asyncify-races/races_test.html');
  const loaded = await tryLoadApp(page, 30000);
  expect(loaded, 'races harness should load').toBe(true);
  await expect
    .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
      timeout: 60000,
      message: 'battery should emit its SUMMARY line',
    })
    .not.toBeNull();
  return page.evaluate(
    () => !!(globalThis as unknown as { __wxScheduler?: unknown }).__wxScheduler,
  );
}

test.describe('S2 scheduler core (WX_SCHEDULER=1 glue)', () => {
  test('N4: battery leaves coherent books — wakes drained, no strays, battery green', async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    const scheduler = await bootAndSettle(page, testLogger);
    test.skip(!scheduler, 'legacy glue — scheduler core absent');

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __wxScheduler: SchedulerState }).__wxScheduler
                .readyWakes.length,
          ),
        { timeout: 30000, intervals: [250] },
      )
      .toBe(0);

    const books = await page.evaluate(() => {
      const S = (globalThis as unknown as { __wxScheduler: SchedulerState }).__wxScheduler;
      return {
        ready: S.readyWakes.length,
        deferred: S.deferredWakes,
        drained: S.drainedWakes,
        strays: S.strayWrites,
        state: S.state(),
      };
    });
    console.log(`[TEST] scheduler books: ${books.state}`);

    expect(books.ready, 'no wake left queued after settle').toBe(0);
    expect(books.drained, 'every deferred wake was drained').toBe(books.deferred);
    expect(books.strays, 'no stray currData writes during the battery').toBe(0);
    const fails = testLogger.consoleLogs.filter((l) => l.includes('[ASYNCIFY_RACES] FAIL '));
    expect(fails, 'battery green under the scheduler core').toEqual([]);
  });

  test('N1 meta: an introduced stray currData write trips the alarm', async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    const scheduler = await bootAndSettle(page, testLogger);
    test.skip(!scheduler, 'legacy glue — scheduler core absent');

    const result = await page.evaluate(() => {
      const S = (globalThis as unknown as { __wxScheduler: SchedulerState }).__wxScheduler;
      const A = (globalThis as unknown as { Asyncify: { currData: number | null } }).Asyncify;
      const before = S.strayWrites;
      const saved = A.currData;
      A.currData = saved; // value-preserving, still a stray WRITE
      const counted = S.strayWrites === before + 1;
      S.strictStrays = true;
      let threw = false;
      try {
        A.currData = saved;
      } catch {
        threw = true;
      }
      S.strictStrays = false;
      return { counted, threw };
    });

    expect(result.counted, 'stray write was counted').toBe(true);
    expect(result.threw, 'strict mode throws on stray write').toBe(true);
    const beacons = testLogger.consoleLogs.filter((l) => l.includes('stray-currdata-write'));
    expect(beacons.length, 'stray write beaconed to the console').toBeGreaterThan(0);
  });
});
