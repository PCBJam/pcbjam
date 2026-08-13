import { test, expect, tryLoadApp } from './utils/fixtures';
import { shotPath } from './utils/element-tracker';

const EXPECTED_CASES = [
  'baseline_modal_alone',
  'baseline_fiber_alone',
  'fiber_create_run_destroy_inside_modal',
  'fiber_multi_swap_inside_modal',
  'fiber_yield_across_modal_close',
  'fiber_deep_yield_loop_inside_modal',
  'modal_fiber_modal_sequence',
  'nested_fibers_inside_modal',
  'nested_dispatch_roots_preserve_fiber_identity',
];

function findSummary(logs: string[]) {
  return logs.find((log) => log.includes('[COROUTINE_TEST] SUMMARY'));
}

test.describe('Nested Coroutine+Modal Tests', () => {
  test('nested harness loads and reports its case inventory', async ({ page, testLogger }) => {
    await page.goto('/standalone/coroutine-nested/nested_test.html');
    const loaded = await tryLoadApp(page, 30000);

    await expect
      .poll(
        () => testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] CASE ')).length,
        { timeout: 45000 }
      )
      .toBe(EXPECTED_CASES.length);

    const caseLogs = testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] CASE '));

    for (const caseName of EXPECTED_CASES) {
      expect(
        caseLogs.some((log) => log.includes(`[COROUTINE_TEST] CASE ${caseName}`)),
        `case ${caseName} should appear in logs`
      ).toBe(true);
    }

    await page.screenshot({ path: shotPath(page, 'coroutine-nested-01-loaded.png'), fullPage: true });

    expect(loaded, 'Nested harness should load').toBe(true);
  });

  test('nested suite reports zero failures', async ({ page, testLogger }) => {
    await page.goto('/standalone/coroutine-nested/nested_test.html');
    const loaded = await tryLoadApp(page, 30000);
    expect(loaded, 'Nested harness should load').toBe(true);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 45000,
        message: 'Nested suite should emit a final summary line',
      })
      .not.toBeNull();

    const summary = findSummary(testLogger.consoleLogs)!;
    const match = summary.match(/total=(\d+)\s+passed=(\d+)\s+failed=(\d+)/);
    expect(match, 'Nested summary should be parseable').not.toBeNull();

    const total = Number(match![1]);
    const passed = Number(match![2]);
    const failed = Number(match![3]);

    const failLogs = testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] FAIL '));
    const passLogs = testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] PASS '));

    expect(total).toBe(EXPECTED_CASES.length);
    expect(passed).toBe(EXPECTED_CASES.length);
    expect(failed).toBe(0);
    expect(failLogs).toHaveLength(0);
    expect(passLogs).toHaveLength(EXPECTED_CASES.length);

    const topology = testLogger.consoleLogs.find((line) =>
      line.includes('[COROUTINE_TEST] NESTED-ROOTS ')
    );
    expect(topology, 'exact A/F1 -> B/F2 -> F1/A topology should be reported').toBeTruthy();
    const ids = topology!.match(
      /rootA=(\d+)\s+rootB=(\d+)\s+f1=(\d+)\s+f1Resume=(\d+)\s+f2=(\d+)\s+f2Resume=(\d+)\s+rootAResume=(\d+)\s+f2ReturnBefore=(\d+)\s+f2ReturnAfter=(\d+)\s+rootBProtocol=(\d+)\s+fiberReleasedDelta=(\d+)\s+rootProxyLive=(\d+)\s+rootProxyPeak=(\d+)\s+rootProxyCapacity=(\d+)\s+rootProxyCreated=(\d+)\s+rootProxyReleased=(\d+)\s+rootProxySchedulerReleases=(\d+)\s+rootProxyUnsafeSweeps=(\d+)/
    );
    expect(ids, 'nested-root identity report should be parseable').not.toBeNull();
    const [
      rootA, rootB, f1, f1Resume, f2, f2Resume, rootAResume,
      f2ReturnBefore, f2ReturnAfter, rootBProtocol, released,
      rootProxyLive, rootProxyPeak, rootProxyCapacity, rootProxyCreated,
      rootProxyReleased, rootProxySchedulerReleases, rootProxyUnsafeSweeps,
    ] = ids!
      .slice(1)
      .map(Number);
    expect(new Set([rootA, rootB, f1, f2]).size, 'A, B, F1 and F2 are physically distinct').toBe(4);
    expect(f1Resume, 'F1 exact wake returns to F1').toBe(f1);
    expect(f2Resume, 'F2 resumes on F2').toBe(f2);
    expect(rootAResume, 'F1 terminal handoff returns to root A').toBe(rootA);
    expect(f2ReturnBefore, 'F2 initially stores root B as its return target').toBe(rootBProtocol);
    expect(f2ReturnAfter, 'F1 wake cannot rewrite F2’s root-B return target').toBe(rootBProtocol);
    expect(released, 'exactly F1 and F2 retire').toBe(2);
    expect(rootProxyLive, 'live root proxies stay within capacity').toBeLessThanOrEqual(rootProxyCapacity);
    expect(rootProxyPeak, 'root-proxy high-water stays within capacity').toBeLessThanOrEqual(rootProxyCapacity);
    expect(rootProxyCapacity, 'root proxy capacity matches dispatch depth').toBe(16);
    expect(rootProxyCreated, 'both physical dispatch roots received proxies').toBeGreaterThanOrEqual(2);
    expect(rootProxyReleased, 'release count is non-negative').toBeGreaterThanOrEqual(0);
    expect(rootProxySchedulerReleases, 'proxies never release scheduler-owned stacks').toBe(0);
    expect(rootProxyUnsafeSweeps, 'proxies sweep only after physical retirement').toBe(0);

    const integrityErrors = [...testLogger.consoleLogs, ...testLogger.errors].filter((line) =>
      /sched-divergence|jump-ghost|swap-lost|hot-main-swap-refused|root-proxy-capacity/i.test(line)
    );
    expect(integrityErrors, 'no stale capture, divergence, ghost return or lost swap').toEqual([]);

    // Critical: catch the nested-asyncify crash
    const indexOobErrors = testLogger.errors.filter((e) =>
      e.toLowerCase().includes('index out of bounds')
    );
    expect(indexOobErrors, 'no index out of bounds errors').toHaveLength(0);

    expect(
      testLogger.errors.filter((error) => !error.includes('favicon')),
      'no unexpected page errors'
    ).toHaveLength(0);

    await page.screenshot({ path: shotPath(page, 'coroutine-nested-02-summary.png'), fullPage: true });
  });

  test('per-scenario status (diagnostic)', async ({ page, testLogger }) => {
    await page.goto('/standalone/coroutine-nested/nested_test.html');
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 45000,
      })
      .not.toBeNull();

    // Use soft assertions so we see the full failure map instead of stopping at the first FAIL.
    for (const name of EXPECTED_CASES) {
      const passed = testLogger.consoleLogs.some((log) =>
        log.includes(`[COROUTINE_TEST] PASS ${name}`)
      );
      expect.soft(passed, `scenario ${name} should PASS`).toBe(true);
    }
  });
});
