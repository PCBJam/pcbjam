import { expect, test, tryLoadApp } from './utils/fixtures';

const SUMMARY = '[PENDING_OWNER] SUMMARY';

test.describe('owner-aware wx pending events', () => {
  test('a modal child admits exact affiliated and delegated tails but blocks unscoped and stale work', async ({
    page,
    testLogger,
  }) => {
    await page.goto(
      '/standalone/pending-event-owner/pending_event_owner_test.html',
    );
    expect(await tryLoadApp(page, 30_000), 'pending-event reducer loads').toBe(true);

    await expect
      .poll(
        () =>
          testLogger.consoleLogs.find((line) => line.includes(SUMMARY)) ?? null,
        {
          timeout: 30_000,
          message: 'the exact affiliated modal tail must complete the reducer',
        },
      )
      .not.toBeNull();

    const summary = testLogger.consoleLogs.find((line) => line.includes(SUMMARY));
    expect(
      summary,
      'the reducer must report one executed, passing scenario and no hidden failure',
    ).toMatch(/total=1\s+passed=1\s+failed=0/);

    expect(
      testLogger.consoleLogs.some((line) =>
        line.includes(
          '[PENDING_OWNER] PASS modal_pending_flood_affiliated_liveness',
        ),
      ),
    ).toBe(true);

    const stats = testLogger.consoleLogs.find((line) =>
      line.includes('[PENDING_OWNER] STATS'),
    );
    expect(stats, 'the reducer reports indexed pending-event counters').toBeDefined();
    const fields = stats!.match(
      /retained=(\d+)\s+highWater=(\d+)\s+accepted=(\d+)\s+forgotten=(\d+)\s+avoidedScans=(\d+)\s+dispatchChecks=(\d+)/,
    );
    expect(fields, 'pending-event counters are parseable').not.toBeNull();
    expect(Number(fields![2]), 'the flood reached a non-zero retained high-water').toBeGreaterThan(0);
    expect(Number(fields![5]), 'the modal child used the indexed no-scan path').toBeGreaterThan(0);

    const paint = testLogger.consoleLogs.find((line) =>
      line.includes('[PENDING_OWNER] PAINT'),
    );
    expect(paint, 'the reducer reports execution-scoped paint counters').toBeDefined();
    const paintFields = paint!.match(
      /childParentDelta=(\d+)\s+childDialogDelta=(\d+)\s+rootParentDelta=(\d+)/,
    );
    expect(paintFields, 'execution-scoped paint counters are parseable').not.toBeNull();
    expect(Number(paintFields![1]), 'the modal child does not paint the parked parent').toBe(0);
    expect(Number(paintFields![2]), 'the modal child paints its exact dialog').toBeGreaterThan(0);
    expect(Number(paintFields![3]), 'the resumed root drains its pending paint').toBeGreaterThan(0);

    expect(
      testLogger.consoleLogs.filter((line) => line.includes('[PENDING_OWNER] FAIL')),
    ).toHaveLength(0);
    expect(testLogger.errors.filter((line) => !line.includes('favicon'))).toHaveLength(0);
  });
});
