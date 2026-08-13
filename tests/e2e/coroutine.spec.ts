import { test, expect, tryLoadApp } from './utils/fixtures';
import { shotPath } from './utils/element-tracker';

const EXPECTED_CASES = [
  'first_entry_runs_once',
  'yield_resume_preserves_state',
  'deep_stack_preserved_across_yield',
  'nested_coroutine_call_and_resume',
  'nested_parent_yield_preserves_suspend',
  'nested_root_resume_releases_caller_once',
  'async_wait_loop_stays_suspended',
  'async_nested_resume_from_child_tool',
  'root_bounce_continue_after_root',
  'completion_returns_control_without_exit',
  'resume_after_finish_does_not_reenter',
  'finished_release_retires_handle',
  'suspended_cancel_retires_handle',
  'registry_refusal_ghost_returns_without_swap',
  'interleaving_multiple_coroutines',
  'stress_many_round_trips',
  'transfer_values_round_trip',
];

function findSummary(logs: string[]) {
  return logs.find((log) => log.includes('[COROUTINE_TEST] SUMMARY'));
}

test.describe('Coroutine Harness Tests', () => {
  test('coroutine harness loads and reports its case inventory', async ({ page, testLogger }) => {
    await page.goto('/standalone/coroutine/coroutine_test.html');
    const loaded = await tryLoadApp(page, 30000);

    await expect.poll(
      () => testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] CASE ')).length,
      { timeout: 15000 }
    ).toBe(EXPECTED_CASES.length);

    const caseLogs = testLogger.consoleLogs.filter((log) => log.includes('[COROUTINE_TEST] CASE '));

    for (const caseName of EXPECTED_CASES) {
      expect(caseLogs.some((log) => log.includes(`[COROUTINE_TEST] CASE ${caseName}`))).toBe(true);
    }

    await page.screenshot({ path: shotPath(page, 'coroutine-01-loaded.png'), fullPage: true });

    expect(loaded, 'Coroutine harness should load').toBe(true);
  });

  test('coroutine stress suite reports zero failures', async ({ page, testLogger }) => {
    await page.goto('/standalone/coroutine/coroutine_test.html');
    const loaded = await tryLoadApp(page, 30000);
    expect(loaded, 'Coroutine harness should load').toBe(true);

    await expect.poll(
      () => findSummary(testLogger.consoleLogs) ?? null,
      { timeout: 20000, message: 'Coroutine suite should emit a final summary line' }
    ).not.toBeNull();

    const summary = findSummary(testLogger.consoleLogs)!;
    const match = summary.match(/total=(\d+)\s+passed=(\d+)\s+failed=(\d+)/);
    expect(match, 'Coroutine summary should be parseable').not.toBeNull();

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
    expect(testLogger.errors.filter((error) => !error.includes('favicon'))).toHaveLength(0);

    await page.screenshot({ path: shotPath(page, 'coroutine-02-summary.png'), fullPage: true });
  });
});
