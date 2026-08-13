import { test, expect, tryLoadApp } from './utils/fixtures';

const SUMMARY = '[MIMALLOC_STORM] SUMMARY';

test.describe('mimalloc must not suspend on sleep(0)', () => {
  test('allocator storm stays synchronous while positive nanosleep still yields', async ({ page, testLogger }) => {
    await page.goto('/standalone/mimalloc-storm/mimalloc_storm_test.html');
    await tryLoadApp(page, 20000).catch(() => {}); // eslint-disable-line -- best-effort load for a self-terminating pthread probe

    await expect
      .poll(() => testLogger.consoleLogs.find((line) => line.includes(SUMMARY)) ?? null, {
        timeout: 60000,
        message: 'mimalloc storm should emit a terminal SUMMARY line',
      })
      .not.toBeNull();

    const summary = testLogger.consoleLogs.find((line) => line.includes(SUMMARY))!;
    const fields = summary.match(
      /zeroSleepCalls=(\d+)\s+mainZeroSleepCalls=(\d+)\s+stormMainZeroSleeps=(\d+)\s+stormTurns=(\d+)\s+sleepTurned=(\d+)\s+completed=(\d+)\s+invalidRejected=(\d+)\s+safePositiveDelays=(\d+)/,
    );

    expect(fields, 'SUMMARY should contain all result fields').not.toBeNull();
    expect(Number(fields![1]), 'the storm must exercise mimalloc sleep(0)').toBeGreaterThan(0);
    expect(Number(fields![2]), 'main-thread mimalloc must reach sleep(0)').toBeGreaterThan(0);
    expect(
      Number(fields![3]),
      'the measured storm window must exercise main-thread mimalloc sleep(0)',
    ).toBeGreaterThan(0);
    expect(Number(fields![4]), 'sleep(0) inside mimalloc must not turn the event loop').toBe(0);
    expect(Number(fields![5]), 'a positive nanosleep must still turn the event loop').toBe(1);
    expect(Number(fields![6]), 'the bounded contention storm must complete').toBe(1);
    expect(Number(fields![7]), 'invalid timespec values must preserve nanosleep EINVAL semantics').toBe(1);
    expect(Number(fields![8]),
      'positive sub-millisecond and oversized waits must round/chunk without returning early').toBe(1);
    expect(testLogger.errors.filter((error) => !error.includes('favicon')), 'no runtime errors').toHaveLength(0);
  });
});
