import { test, expect, tryLoadApp } from '../e2e/utils/fixtures';

/**
 * Design B D1 gate — scheduler contexts (docs/features/async/20 §6 D1, 21).
 *
 * Drives tests/apps/standalone/sched-context/sched_context_test.cpp, which
 * exercises wasm/sched/context.{h,cpp}: create / yield_park / mark_ready /
 * drain. The point of the layer is that a resume is something the REGISTRY
 * knows rather than something a guard guesses (doc 19's disease), so the
 * battery asserts the invariants, and this spec additionally gates the thing
 * doc 20 §7 risk 1 demands: contexts must be bounded and MEASURED.
 *
 * No production path runs on contexts yet — that starts at D2.
 */

const SCENARIOS = [
  'create_runs_on_drain',
  'park_and_resume',
  'no_park_in_place',
  'parked_does_not_block',
  'fifo_order',
  'one_transition_in_flight',
  'registry_refusals',
  'deep_park_sizing',
  'fiber_nests_in_context',
  'foreign_stack_refused',
  'fiber_roundtrip',
  'fiber_release_suspended',
  'fiber_and_star_coexist',
  'star_transfer_call_is_synchronous',
  'star_transfer_chain',
  'async_wake',
];

/** Frame count the deep-park scenario recurses to before parking (must match
 *  DEEP_PARK_FRAMES in the harness) — the divisor for the per-frame cost. */
const DEEP_PARK_FRAMES = 64;

/** Memory ceiling for the battery (doc 20 risk 1). The worst scenario holds
 *  ~6 live contexts; 16 leaves headroom without letting a leak hide. */
const MAX_PEAK_LIVE = 16;
/** Peak bytes the battery may charge to contexts. At 256 KB per context
 *  (128 KB C stack + 128 KB asyncify buffer) 16 contexts = 4 MB. */
const MAX_PEAK_BYTES = 4 * 1024 * 1024;

type Stats = {
  live: number;
  peakLive: number;
  created: number;
  finished: number;
  transitions: number;
  refusals: number;
  foreignStackRefusals: number;
  running: number;
  transitionInFlight: boolean;
  readyQueued: number;
  bytes: number;
  peakBytes: number;
  perContextBytes: number;
  cStackBytes: number;
  asyncifyBytes: number;
  asyncifyHighWater: number;
  // Fiber lane (doc 22 Phase A) — libcontext's clients, separate counters so
  // this battery's star assertions keep meaning what they meant.
  fiberLive: number;
  fiberPeakLive: number;
  fiberCreated: number;
  fiberReleased: number;
  fiberSwaps: number;
  fiberRefusals: number;
  fiberReleasedSuspended: number;
  fiberReleasedRunning: number;
  fiberNonEnterableSwaps: number;
  fiberRunning: number;
  fiberBytes: number;
  fiberPeakBytes: number;
  fiberAsyncifyHighWater: number;
};

function findLine(logs: string[], marker: string): string | undefined {
  return logs.find((l) => l.includes(`[SCHED_CTX] ${marker}`));
}

function parseTagged<T>(logs: string[], marker: string): T | null {
  const line = findLine(logs, marker);
  if (!line) return null;
  const json = line.slice(line.indexOf(`[SCHED_CTX] ${marker}`) + `[SCHED_CTX] ${marker}`.length);
  return JSON.parse(json.trim()) as T;
}

test.describe('Design B D1 — scheduler contexts', () => {
  test('battery: every context invariant holds', async ({ page, testLogger }) => {
    await page.goto('/standalone/sched-context/sched_context_test.html');
    expect(await tryLoadApp(page, 30000), 'sched-context harness should load').toBe(true);

    await expect
      .poll(() => findLine(testLogger.consoleLogs, 'SUMMARY') ?? null, {
        timeout: 30000,
        message: 'battery should emit SUMMARY (a missing one means a wedge — e.g. a context that never resumed)',
      })
      .not.toBeNull();

    const summary = findLine(testLogger.consoleLogs, 'SUMMARY')!;
    const m = summary.match(/total=(\d+)\s+passed=(\d+)\s+failed=(\d+)/);
    expect(m, `unparseable summary: ${summary}`).not.toBeNull();
    const [total, passed, failed] = [Number(m![1]), Number(m![2]), Number(m![3])];

    const fails = testLogger.consoleLogs.filter((l) => l.includes('[SCHED_CTX] FAIL '));
    expect(fails, `failures: ${fails.join(' || ')}`).toHaveLength(0);
    expect(failed).toBe(0);
    expect(total, 'every scenario ran').toBe(SCENARIOS.length);
    expect(passed).toBe(SCENARIOS.length);

    for (const name of SCENARIOS) {
      expect
        .soft(
          testLogger.consoleLogs.some((l) => l.includes(`[SCHED_CTX] PASS ${name}`)),
          `scenario ${name} should PASS`,
        )
        .toBe(true);
    }
  });

  test('memory: contexts are bounded and measured (doc 20 risk 1)', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/sched-context/sched_context_test.html');
    expect(await tryLoadApp(page, 30000)).toBe(true);

    await expect
      .poll(() => findLine(testLogger.consoleLogs, 'STATS') ?? null, { timeout: 30000 })
      .not.toBeNull();

    const stats = parseTagged<Stats>(testLogger.consoleLogs, 'STATS')!;
    console.log(`[TEST] context stats: ${JSON.stringify(stats)}`);

    // --- the ceiling: a leak must fail here, not in a user's tab ------------
    expect(stats.peakLive, 'peak live contexts within the ceiling').toBeLessThanOrEqual(
      MAX_PEAK_LIVE,
    );
    expect(stats.peakBytes, 'peak context bytes within the budget').toBeLessThanOrEqual(
      MAX_PEAK_BYTES,
    );

    // --- no leaks: every context the battery created was destroyed ----------
    expect(stats.live, 'no context left live after the battery').toBe(0);
    expect(stats.bytes, 'no context bytes left charged').toBe(0);
    expect(stats.finished, 'every created context finished').toBe(stats.created);

    // --- the layer did real work (guards against a vacuous pass) -----------
    expect(stats.created, 'the battery created contexts').toBeGreaterThan(5);
    expect(stats.transitions, 'the scheduler performed swaps').toBeGreaterThan(
      stats.created,
    );

    // --- the invariant: nothing left mid-transition ------------------------
    expect(stats.transitionInFlight, 'no transition left in flight').toBe(false);
    expect(stats.running, 'no context left running').toBe(0);
    expect(stats.readyQueued, 'ready queue drained').toBe(0);

    // --- refusals are EXPECTED here: three scenarios provoke them ----------
    // (yield_park off a context, destroy while parked, mark_ready twice /
    // unknown id). Zero would mean those scenarios stopped provoking.
    expect(stats.refusals, 'illegal operations were refused and counted').toBeGreaterThan(0);

    // --- the D3 blocker, pinned -------------------------------------------
    // A wait called from a fiber running ON TOP of a context (a KiCad tool
    // coroutine opening a dialog) must be refused, not allowed to yield
    // someone else's context — that would save the tool fiber's stack into the
    // host context's fiber struct. Exactly one scenario provokes it.
    expect(
      stats.foreignStackRefusals,
      'a yield from a foreign stack was refused rather than corrupting the host context',
    ).toBe(1);

    // --- sizing evidence (doc 20 risk 1: derive, don't inherit) ------------
    // The high-water mark is what a future buffer size must be justified by.
    // Assert it is both real (>0 — the parks did save frames) and comfortably
    // inside the buffer, so the number in the log is trustworthy.
    expect(stats.asyncifyHighWater, 'asyncify use was measured').toBeGreaterThan(0);
    expect(
      stats.asyncifyHighWater,
      'asyncify high-water inside the per-context buffer',
    ).toBeLessThan(stats.asyncifyBytes);
    // Per-frame cost from the deep-park scenario: the number a future buffer
    // size must be derived from. The high-water is dominated by that park
    // (every other scenario parks 1-2 frames deep).
    //
    // CAVEAT, do not skip when quoting this number: the harness's frames carry
    // three locals each, so this is a FLOOR for per-frame cost, not a
    // production estimate. Real park sites (a lib fetch inside commit.Push →
    // connectivity → font work) save far more per frame — that is why
    // libcontext runs a 512 K buffer after a 64 K one silently overflowed.
    // Treat this as "the measurement apparatus works and these are its units";
    // the sizing decision needs deep-park numbers from real bridges at D3/D4.
    const perFrame = stats.asyncifyHighWater / DEEP_PARK_FRAMES;
    console.log(
      `[TEST] asyncify sizing: high-water ${stats.asyncifyHighWater}B of ` +
        `${stats.asyncifyBytes}B buffer ` +
        `(${((stats.asyncifyHighWater / stats.asyncifyBytes) * 100).toFixed(1)}%); ` +
        `~${perFrame.toFixed(0)}B per frame over ${DEEP_PARK_FRAMES} frames ` +
        `→ the ${stats.asyncifyBytes}B buffer holds ~${Math.floor(
          stats.asyncifyBytes / Math.max(perFrame, 1),
        )} frames`,
    );

    // The deep park must actually dominate — otherwise the per-frame number
    // above is noise from a shallow park and cannot justify any size.
    expect(
      stats.asyncifyHighWater,
      'the deep park (64 frames) drove the high-water mark',
    ).toBeGreaterThan(1024);

    // No buffer-pressure beacon should have fired (>75% use).
    const pressure = testLogger.consoleLogs.filter((l) => l.includes('BUFFER-PRESSURE'));
    expect(pressure, `buffer pressure: ${pressure.join(' || ')}`).toHaveLength(0);

    // --- fiber lane (doc 22 Phase A): libcontext semantics over the registry --
    // The adopted root is the only fiber that outlives the battery (libcontext's
    // main context never dies); everything else was released.
    expect(stats.fiberLive, 'only the adopted root fiber remains').toBe(1);
    // Phase B invariant, stronger than the Phase A one it replaces: once the
    // pump is quiescent NO fiber is on the CPU — the scheduler is. Under the
    // star that is what "between transitions" means.
    expect(stats.fiberRunning, 'no fiber is current when the pump is quiescent').toBe(0);
    expect(stats.fiberCreated, 'every fiber the battery made').toBeGreaterThanOrEqual(8);
    expect(stats.fiberReleased, 'all but the adopted root were released').toBe(
      stats.fiberCreated - 1,
    );
    expect(stats.fiberSwaps, 'symmetric swaps and star transfers happened').toBeGreaterThanOrEqual(
      12,
    );
    // Both releases happened mid-suspend — libcontext's refcount-drop shape.
    expect(stats.fiberReleasedSuspended, 'suspended releases are legal and counted').toBe(2);
    // One deliberate stale-id swap was refused (use-after-free made loud).
    expect(stats.fiberRefusals, 'a stale fiber id was refused').toBeGreaterThanOrEqual(1);
    // THE Phase A tripwires: no swap ever entered a non-enterable fiber, and
    // no release ever hit a fiber the registry believed was running.
    expect(stats.fiberNonEnterableSwaps, 'zero swaps into stale rewind state').toBe(0);
    expect(stats.fiberReleasedRunning, 'zero releases of a running fiber').toBe(0);
    // The sizing input Phase E reads: a suspended fiber's capture was measured
    // (sampled before the resume consumes it, when the buffer is non-empty).
    expect(
      stats.fiberAsyncifyHighWater,
      'fiber-lane asyncify use was measured while suspended',
    ).toBeGreaterThan(0);
  });
});
