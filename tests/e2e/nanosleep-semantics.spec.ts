import { test, expect } from './utils/fixtures';

// Repro + regression spec for finding F-2: POSIX semantics of the main-thread
// nanosleep shim (wasm/shims/nanosleep_yield.c). The F-1 zero-duration guard is
// covered by the same harness (same function, same contract).
//
// Harness: tests/apps/standalone/nanosleep-semantics/ — single-threaded on
// purpose (the J-6 false-green was worker threads satisfying a process-wide
// counter), with a positive control proving every absence-observable can fire.
//
// Oracle discipline (J-6): assert on the SYNC-DONE pass/fail counters AND on
// the presence of each named check, never on the absence of FAIL lines.

const APP = '/standalone/nanosleep-semantics/nanosleep_semantics_test.html';

// Every check the harness must run — a silently-skipped check cannot pass.
const CHECKS = [
  'hook-chunk-present',
  'chunk-ceils-fractional',
  'chunk-floors-subms',
  'chunk-clamps-huge',
  'efault-null-req',
  'einval-neg-nsec',
  'einval-nsec-overflow',
  'einval-neg-sec',
  'zero-sleep-no-event-loop-turn',
  'zero-sleep-counters',
  'positive-yield-flips-flag',
  'rem-zeroed-on-success',
];

async function waitForLog(
  testLogger: { consoleLogs: string[] },
  needle: string,
  timeout = 60000
) {
  await expect
    .poll(() => testLogger.consoleLogs.some(l => l.includes(needle)), { timeout })
    .toBe(true);
}

test.describe('nanosleep shim POSIX semantics (F-2)', () => {
  test('validation, zero-duration guard, and chunked long sleeps', async ({
    page,
    testLogger,
  }) => {
    await page.goto(APP);

    // 1. Synchronous contract: validation, chunk helper, zero-duration guard.
    await waitForLog(testLogger, '[NANOSLEEP] SYNC-DONE');
    const done = testLogger.consoleLogs.find(l => l.includes('[NANOSLEEP] SYNC-DONE'))!;
    const m = done.match(/pass=(\d+) fail=(\d+)/)!;
    expect(+m[1], 'every synchronous check passes').toBe(CHECKS.length);
    expect(+m[2], 'no synchronous check fails').toBe(0);

    for (const name of CHECKS) {
      expect(
        testLogger.consoleLogs.some(l => l.includes(`CHECK ${name} PASS`)),
        `check ran and passed: ${name}`
      ).toBe(true);
    }

    // 2. A mid-size positive sleep completes (the chunk loop resumes) and
    // honors its full duration (no fractional/rounding early return).
    await waitForLog(testLogger, '[NANOSLEEP] TIMED-SLEEP-DONE');
    const timed = testLogger.consoleLogs.find(l =>
      l.includes('[NANOSLEEP] TIMED-SLEEP-DONE')
    )!;
    const dt = +timed.match(/dtMs=([\d.]+)/)![1];
    expect(dt, 'a 120 ms sleep sleeps at least 120 ms').toBeGreaterThanOrEqual(115);
    expect(dt, 'a 120 ms sleep is not unbounded').toBeLessThan(60000);

    // 3. The F-2 headline: a sleep beyond INT_MAX ms must NOT return early.
    // Pre-fix, setTimeout's signed-32-bit coercion wraps 3.0e9 ms negative and
    // fires within milliseconds — this dwell gives that wrapped timer every
    // chance to fire, then asserts it did not.
    await waitForLog(testLogger, '[NANOSLEEP] HUGE-SLEEP-BEGIN');
    // eslint-disable-line -- documented interaction dwell: absence oracle — the pre-fix 32-bit setTimeout wrap fires HUGE-SLEEP-END within ms, so we dwell 600 ms to give a wrapped timer every chance before asserting it never fired
    await page.waitForTimeout(600);
    expect(
      testLogger.consoleLogs.some(l => l.includes('[NANOSLEEP] HUGE-SLEEP-END')),
      'a >INT_MAX ms sleep does not return early (32-bit timer wrap)'
    ).toBe(false);
  });
});
