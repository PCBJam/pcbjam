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

    // Critical: catch the historic nested-suspension crash signature
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
