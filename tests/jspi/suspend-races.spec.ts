import { test, expect, tryLoadApp } from '../e2e/utils/fixtures';

// Successor of tests/asyncify/asyncify-races.spec.ts (retired with the
// asyncify backend): the SEMANTIC suspension-race scenarios, run against the
// same races harness (tests/apps/standalone/asyncify-races/races_test.cpp)
// built for JSPI. The scenarios express through public wx + coroutine APIs —
// nested modal LIFO, out-of-order wake resolution, no-lost-wakes, nested-loop
// teardown-on-error — so they are exactly as meaningful under JSPI as under
// asyncify; only the failure MODES they'd catch differ (activation misnesting
// or a lost wait token instead of a clobbered rewind buffer). The harness's
// Fibers.* probes self-disable on non-asyncify glue ('n/a').
//
// Retired asyncify-mechanism gates, deliberately NOT ported: the
// Asyncify.currData single-writer tripwire (N1) and the deferred-wake books
// (readyWakes/drainedWakes) — those states are unrepresentable under JSPI.
// Their intent (coherent books at settle) lives on below via __wxWaitDump.

const BATTERY = [
  'post_park_fiber_swap',
  'sleep_inside_fiber_inside_modal',
  'out_of_order_sleep_resolution',
  'long_parked_sleep_clobbered_by_swap',
];

const CRASH_SIGNATURES = [
  // backend-agnostic trouble
  'index out of bounds',
  'indirect call to null',
  'invalid state',
  'is not a function',
  // the JSPI-specific loud failure: an un-promised export tried to suspend
  'suspenderror',
  'trying to suspend',
];

type WaitDump = {
  pendingWaits: number;
  runningActivations: number;
  suspendedActivations: unknown[];
  mutatorQueueDepth: number;
  waitsBegun: number;
  waitsResolved: number;
};

function findSummary(logs: string[]) {
  return logs.find((log) => log.includes('[ASYNCIFY_RACES] SUMMARY'));
}

function parseSummary(summary: string) {
  const match = summary.match(/total=(\d+)\s+passed=(\d+)\s+failed=(\d+)/);
  expect(match, 'summary line should be parseable').not.toBeNull();
  return { total: Number(match![1]), passed: Number(match![2]), failed: Number(match![3]) };
}

function crashLines(testLogger: { consoleLogs: string[]; errors: string[] }) {
  const all = [...testLogger.consoleLogs, ...testLogger.errors];
  return all.filter(
    (line) =>
      CRASH_SIGNATURES.some((sig) => line.toLowerCase().includes(sig)) &&
      // The harness's own meta-output mentions these words legitimately.
      !line.includes('[ASYNCIFY_RACES]')
  );
}

function realErrors(testLogger: { errors: string[] }) {
  return testLogger.errors.filter((e) => !e.includes('favicon'));
}

test.describe('Suspension races — green targets (jspi backend)', () => {
  test('battery: all chained scenarios pass with a clean console', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/asyncify-races/races_test.html');
    const loaded = await tryLoadApp(page, 30000);
    expect(loaded, 'races harness should load').toBe(true);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 60000,
        message: 'battery should emit a final SUMMARY line (a missing one means a wedge/hang)',
      })
      .not.toBeNull();

    const { total, passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    const failLogs = testLogger.consoleLogs.filter((l) => l.includes('[ASYNCIFY_RACES] FAIL '));
    const passLogs = testLogger.consoleLogs.filter((l) => l.includes('[ASYNCIFY_RACES] PASS '));

    expect(total).toBe(BATTERY.length);
    expect(passed).toBe(BATTERY.length);
    expect(failed).toBe(0);
    expect(failLogs, `FAIL lines: ${failLogs.join(' || ')}`).toHaveLength(0);
    expect(passLogs).toHaveLength(BATTERY.length);

    for (const name of BATTERY) {
      expect.soft(
        testLogger.consoleLogs.some((l) => l.includes(`[ASYNCIFY_RACES] PASS ${name}`)),
        `scenario ${name} should PASS`
      ).toBe(true);
    }

    expect(crashLines(testLogger), 'no crash signatures in console').toHaveLength(0);
    expect(realErrors(testLogger), 'no page errors').toHaveLength(0);
  });

  test('battery leaves coherent books — no pending waits, no stuck activations', async ({
    page,
    testLogger,
  }) => {
    // Successor of the retired N4 gate: after the battery settles, the
    // scheduler's books must be clean — every begun wait resolved or
    // consumed, no activation left suspended, no queued mutators.
    test.setTimeout(180000);
    await page.goto('/standalone/asyncify-races/races_test.html');
    const loaded = await tryLoadApp(page, 30000);
    expect(loaded, 'races harness should load').toBe(true);
    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, { timeout: 60000 })
      .not.toBeNull();

    const hasDump = await page.evaluate(
      () => typeof (globalThis as unknown as { __wxWaitDump?: unknown }).__wxWaitDump === 'function',
    );
    test.skip(!hasDump, 'stale build — no __wxWaitDump');

    // The last scenario's teardown can lag the SUMMARY line by a tick.
    // main() legitimately parks on its per-frame yield forever ("frame") —
    // the invariant is that no TOKEN wait (modal/nested/sleep/…) and no
    // queued mutator survives the battery.
    const stuck = (dump: WaitDump) =>
      (dump.suspendedActivations as { waitKind: string | null }[]).filter(
        (a) => a.waitKind !== 'frame',
      ).length + dump.mutatorQueueDepth;
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const dump = (
              globalThis as unknown as { __wxWaitDump: () => WaitDump }
            ).__wxWaitDump();
            return (dump.suspendedActivations as { waitKind: string | null }[]).filter(
              (a) => a.waitKind !== 'frame',
            ).length + dump.mutatorQueueDepth;
          }),
        { timeout: 30000, intervals: [250] },
      )
      .toBe(0);

    const books = await page.evaluate(() =>
      (globalThis as unknown as { __wxWaitDump: () => WaitDump }).__wxWaitDump(),
    );
    console.log(`[TEST] scheduler books: ${JSON.stringify(books)}`);
    expect(stuck(books), 'no token wait or mutator left stuck').toBe(0);
  });

  test('modal_in_modal_in_modal: three nested ShowModals resolve LIFO', async ({
    page,
    testLogger,
  }) => {
    // Historical red: the pre-scheduler wx dialog.cpp kept the modal resolver
    // in a single slot (Module._endModal), so with three nested modals the
    // middle EndModal resolved nothing and its ShowModal parked forever.
    // Green since the LIFO resolver semantics — under JSPI the wait
    // registry's per-kind LIFO stacks (jspi-scheduler.js, contract-identical
    // to the asyncify shim's S4).
    await page.goto('/standalone/asyncify-races/races_test.html#only=modal_in_modal_in_modal');
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 45000,
        message: 'triple modal should complete (middle EndModal must not be lost)',
      })
      .not.toBeNull();

    const { passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(passed).toBe(1);
    expect(failed).toBe(0);
    expect(crashLines(testLogger), 'no crash signatures in console').toHaveLength(0);
  });

  test('wakeup_during_transition: modal teardown over parked sleeps stays clean', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/asyncify-races/races_test.html#only=wakeup_during_transition');
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, { timeout: 45000 })
      .not.toBeNull();

    const { passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(passed).toBe(1);
    expect(failed).toBe(0);
    expect(crashLines(testLogger), 'no crash signatures in console').toHaveLength(0);
    expect(realErrors(testLogger), 'no page errors').toHaveLength(0);
  });

  test('nested_quasi_modal_pump_error: pump rejection must not leak the parked DoRun', async ({
    page,
    testLogger,
  }) => {
    await page.goto(
      '/standalone/asyncify-races/races_test.html#only=nested_quasi_modal_pump_error'
    );
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 45000,
        message:
          'nested loop must exit after a pump error (silent stall = the c27fe8bf bug, fixed in wx evtloop.cpp)',
      })
      .not.toBeNull();

    const { passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(passed).toBe(1);
    expect(failed).toBe(0);
  });

  test('sleep-park mode: park throw must not escape as an unhandled rejection', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/asyncify-races/races_test.html#mode=sleep-park');
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, { timeout: 45000 })
      .not.toBeNull();

    const { passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(passed).toBe(1);
    expect(failed).toBe(0);

    const rejectionLeaks = testLogger.errors.filter(
      (l) => !l.includes('[ASYNCIFY_RACES]') && !l.includes('favicon')
    );
    expect(
      rejectionLeaks,
      `park throw escaped: ${rejectionLeaks.join(' || ')}`
    ).toHaveLength(0);
  });
});
