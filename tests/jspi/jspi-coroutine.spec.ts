import { test, expect } from '../e2e/utils/fixtures';

// Contract battery for the JSPI libcontext coroutine backend
// (kicad/thirdparty/libcontext/libcontext.cpp under PCBJAM_JSPI). The harness
// (tests/apps/standalone/jspi-coroutine) is a wx-free MiniCoro that mirrors
// tool/coroutine.h's protocol exactly — INVOCATION_ARGS, callerStub with the
// finish_fcontext hook, jumpIn/jumpOut, CONTINUE_AFTER_ROOT — over the real
// libcontext.cpp. 15 cases: create/run/finish, yield chains, nested
// call-in-call routed by enterer inference, RunMainStack payload propagation,
// ghost-resume refusal (dead tombstones), mid-body release census.
//
// Output contract: per-case "[JSPI_CORO] CASE <name> PASS|FAIL" then
// "[JSPI_CORO] SUMMARY passed=<n> failed=<n>".

const EXPECTED_PASSES = 15;

function findSummary(logs: string[]) {
  return logs.find((l) => l.includes('[JSPI_CORO] SUMMARY'));
}

function assertSummary(logs: string[]) {
  const summary = findSummary(logs)!;
  const match = summary.match(/passed=(\d+)\s+failed=(\d+)/);
  expect(match, `summary parseable: ${summary}`).not.toBeNull();
  expect(Number(match![1]), 'all cases pass').toBe(EXPECTED_PASSES);
  expect(Number(match![2]), 'no case fails').toBe(0);
  const fails = logs.filter((l) => l.includes('[JSPI_CORO] CASE') && l.includes('FAIL'));
  expect(fails, `FAIL cases: ${fails.join(' || ')}`).toHaveLength(0);
  const fatal = logs.filter((l) => l.includes('[JSPI_CORO] FATAL'));
  expect(fatal, `harness fatal: ${fatal.join(' || ')}`).toHaveLength(0);
}

test.describe('JSPI coroutine backend contract battery', () => {
  test('single-thread build: 15/15 protocol cases pass', async ({ page, testLogger }) => {
    await page.goto('/standalone/jspi-coroutine/');
    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 60000,
        message: 'harness should emit its SUMMARY line',
      })
      .not.toBeNull();
    assertSummary(testLogger.consoleLogs);
  });

  test('pthread build: 15/15 protocol cases pass', async ({ page, testLogger }) => {
    await page.goto('/standalone/jspi-coroutine/?pt=1');
    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 60000,
        message: 'pthread harness should emit its SUMMARY line',
      })
      .not.toBeNull();
    assertSummary(testLogger.consoleLogs);
  });
});
