import { test, expect } from '../e2e/utils/fixtures';

// The permanent regression tripwire for the JSPI shadow-stack hazard
// (emscripten #27364): JSPI switches the native stack per activation but NOT
// the C spill stack (__stack_pointer), so concurrently-suspended activations
// corrupt each other unless a discipline is applied. The harness
// (tests/apps/standalone/jspi-stack, browser battery in its index.html) runs:
//
//   red/single           mitigation OFF  → MUST detect corruption (the
//                        harness can still see the bug; a silent red means
//                        the tripwire itself broke)
//   green-copy/single    per-suspension [sp, entrySp] snapshot+restore — the
//                        discipline jspi-scheduler.js applies to wx entries
//   green-region/single  per-activation stack region + SP swap — the
//                        discipline libcontext's JSPI backend applies to
//                        KiCad coroutines
//   green-copy/pthread   both disciplines again with cross-thread allocator
//   green-region/pthread churn running during the parks
//
// Output contract per combo:
//   [JSPI_STACK] SCENARIO <mode>/<variant> corruptA=.. corruptB=.. corruptNested=.. verdict=<RED|GREEN|UNEXPECTED>

const COMBOS = [
  { name: 'red/single', verdict: 'RED' },
  { name: 'green-copy/single', verdict: 'GREEN' },
  { name: 'green-region/single', verdict: 'GREEN' },
  { name: 'green-copy/pthread', verdict: 'GREEN' },
  { name: 'green-region/pthread', verdict: 'GREEN' },
];

test.describe('JSPI shadow-stack red/green battery', () => {
  test('red detects corruption; both mitigations hold, incl. pthread churn', async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(120000);
    await page.goto('/standalone/jspi-stack/');

    await expect
      .poll(
        () =>
          testLogger.consoleLogs.find((l) => l.includes('[JSPI_STACK] DONE')) ??
          testLogger.consoleLogs.find((l) => l.includes('[JSPI_STACK] FATAL')) ??
          null,
        {
          timeout: 90000,
          message: 'battery should emit DONE (FATAL/silence = harness wedge)',
        },
      )
      .not.toBeNull();

    const fatal = testLogger.consoleLogs.filter((l) => l.includes('[JSPI_STACK] FATAL'));
    expect(fatal, `harness fatal: ${fatal.join(' || ')}`).toHaveLength(0);

    for (const combo of COMBOS) {
      const line = testLogger.consoleLogs.find((l) =>
        l.includes(`[JSPI_STACK] SCENARIO ${combo.name} `),
      );
      expect.soft(line, `combo ${combo.name} should have run`).toBeTruthy();
      if (line) {
        expect
          .soft(line, `combo ${combo.name} verdict`)
          .toContain(`verdict=${combo.verdict}`);
      }
    }
  });
});
