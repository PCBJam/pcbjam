import { test, expect, tryLoadApp } from '../e2e/utils/fixtures';
import { clickByLabel } from '../e2e/utils/element-tracker';

// Red-green specs for the Asyncify race-condition harness
// (tests/apps/standalone/asyncify-races/races_test.cpp — see docs/features/async/).
//
// GREEN-target tests assert the desired end state (clean pass, clean console).
// While a fix is missing they FAIL — that failing run is the recorded "red".
// (The shim-ablation builds and their pins were retired at doc 20 D-1 together
// with the legacy runtime they exercised; the scheduler shim is the only
// runtime, and the battery below runs every scenario against it.)

const BATTERY = [
  'post_park_fiber_swap',
  'sleep_inside_fiber_inside_modal',
  'queued_suspensions_preserve_fifo',
  'long_parked_sleep_clobbered_by_swap',
  'modal_child_yield_skips_ineligible_pending',
  'retained_child_delays_modal_close',
];

const CRASH_SIGNATURES = [
  'index out of bounds',
  'indirect call to null',
  'invalid state',
  'unwind',
  // assertion-free builds surface a clobbered doRewind as a TypeError
  'is not a function',
];

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

test.describe('Asyncify races — green targets (full shims)', () => {
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

  test('modal_in_modal_in_modal: three nested ShowModals resolve LIFO', async ({
    page,
    testLogger,
  }) => {
    // Historical red: the pre-scheduler wx dialog.cpp kept the modal resolver
    // in a single slot (Module._endModal), so with three nested modals the
    // middle EndModal resolved nothing and its ShowModal parked forever.
    // Green since the LIFO resolver semantics, now the scheduler wait
    // registry's per-kind stacks (doc 17 S4; legacy machinery deleted at
    // doc 20 D-1).
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

  test('affiliated close passes blocked ordinary work and preserves the owner tail', async ({
    page,
    testLogger,
  }) => {
    await page.goto(
      '/standalone/asyncify-races/races_test.html#only=affiliated_close_unblocks_ordinary',
    );
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

  test('retained modal child: EndModal waits for the exact affiliated tail', async ({
    page,
    testLogger,
  }) => {
    await page.goto(
      '/standalone/asyncify-races/races_test.html#only=retained_child_delays_modal_close'
    );
    await tryLoadApp(page, 30000);

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 45000,
        message:
          'ShowModal must stay parked until the retained child releases, then resume exactly once',
      })
      .not.toBeNull();

    const { total, passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(total).toBe(1);
    expect(passed).toBe(1);
    expect(failed).toBe(0);
    expect(crashLines(testLogger), 'no crash signatures in console').toHaveLength(0);
    expect(realErrors(testLogger), 'no page errors').toHaveLength(0);
  });

  test('nested modal close hands browser receipt back to the accepting parent', async ({
    page,
    testLogger,
  }) => {
    await page.goto(
      '/standalone/asyncify-races/races_test.html#only=nested_modal_receipt_handback'
    );
    await tryLoadApp(page, 30000);

    await page.waitForFunction(() => window.wxElementRegistry
      ?.findByLabel('Close child', { exact: true })
      .some((element) => element.visible));
    expect(await clickByLabel(page, 'Close child', { exact: true })).toBe(true);

    await page.waitForFunction(() => {
      const registry = window.wxElementRegistry;
      const childVisible = registry?.findByLabel('Close child', { exact: true })
        .some((element) => element.visible) ?? false;
      const parentVisible = registry?.findByLabel('Parent action', { exact: true })
        .some((element) => element.visible) ?? false;
      return !childVisible && parentVisible;
    });

    // L2 is deliberately held in BeginClose here. The real parent DOM event
    // must be receipted for L1, but cannot execute until the retained L2 child
    // is released through its exact affiliated owner.
    expect(await clickByLabel(page, 'Parent action', { exact: true })).toBe(true);
    await page.evaluate(() => {
      const module = (window as any).Module;
      module.ccall('races_release_handback_child', null, [], []);
    });

    await expect
      .poll(() => findSummary(testLogger.consoleLogs) ?? null, {
        timeout: 30000,
        message: 'queued parent input must run after L2 closes',
      })
      .not.toBeNull();

    const { total, passed, failed } = parseSummary(findSummary(testLogger.consoleLogs)!);
    expect(total).toBe(1);
    expect(passed).toBe(1);
    expect(failed).toBe(0);
    expect(crashLines(testLogger), 'no crash signatures in console').toHaveLength(0);
    expect(realErrors(testLogger), 'no page errors').toHaveLength(0);
  });

  test('startup sleep: the internal unwind sentinel never escapes its Promise reaction', async ({
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

    const unwindLeaks = [...testLogger.errors, ...testLogger.consoleLogs].filter(
      (l) =>
        l.toLowerCase().includes('unwind') &&
        !l.includes('[ASYNCIFY_RACES]') &&
        // console *log* lines about unwind from our own shims are fine; errors are not
        (testLogger.errors.includes(l) || l.toLowerCase().includes('uncaught'))
    );
    expect(unwindLeaks, `unwind escaped the park: ${unwindLeaks.join(' || ')}`).toHaveLength(0);
  });
});
