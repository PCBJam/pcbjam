import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Resume-into-asyncify-parked-coroutine repro — the DECODED production
 * board-load trap (docs/features/async/15-timer-park-repro.md round 3).
 *
 * A coroutine suspended by a real yield has valid rewind data in its fiber
 * struct; one whose body is asyncify-parked inside handleSleep does NOT.
 * TOOL_MANAGER cannot tell the difference, so an event arriving during the
 * park Resume()s it → the swap rewinds the STALE suspension →
 * finishContextSwitch → doRewind → "unreachable executed", and the runtime is
 * poisoned ("index out of bounds" from every later entry). The
 * kicadTestFiberPark* levers (wasm/bindings/fiber_park.h) stage exactly that
 * state machine:
 *
 *   start(parkMs)  Call + first KiYield — valid suspension primed (phase 1)
 *   prime()        legitimate Resume; body parks in emscripten_sleep (phase 2)
 *   poke()         Resume DURING the park — the fatal prod operation
 *
 * This spec asserts the HEALTHY contract: the mid-park poke must be refused
 * (null-INVOCATION_ARGS ghost contract), the body must complete its park and
 * yield again undisturbed, a post-yield poke must resume it for real, and no
 * trap signature may appear anywhere. On a runtime without the libcontext
 * guard this is deterministically RED with the prod signature.
 */

const TRAP_SIGNATURE =
  /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function or function signature|memory access out of bounds/;

type Mod = {
  kicadTestFiberParkStart(parkMs: number): boolean;
  kicadTestFiberParkPrime(): boolean;
  kicadTestFiberParkPoke(): boolean;
  kicadTestFiberParkState(): string;
  kicadTestFiberParkStartSecond(): boolean;
  kicadTestFiberParkPokeSecond(): boolean;
  kicadCollabSnapshotItems(): Promise<string>;
};

interface NativeEntryScheduler {
  enqueueNativeEntry(
    key: string | null,
    site: string,
    run: () => void,
  ): boolean;
  nativeEntryDeferred: number;
}

interface SecondEntryProbe {
  accepted: boolean;
  calls: number;
  deferredBefore: number;
}

interface ParkState {
  phase: number;
  pokes: number;
  parkMs: number;
  running: boolean;
  phase2: number;
}

async function bootHarness(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadTestFiberParkStart === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function"
      );
    },
    null,
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 90000 },
  );
}

function parkState(page: Page): Promise<ParkState> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { Module: Mod }).Module.kicadTestFiberParkState()),
  );
}

test.describe("Resume() into an asyncify-parked coroutine (libcontext guard)", () => {
  test("mid-park resume is refused; the parked body completes undisturbed", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await bootHarness(page);

    // Phase 1: prime a real suspension (Call + first KiYield). NOTE: embind
    // return values are asyncify unwind PLACEHOLDERS for anything that
    // crosses a fiber swap (the real return lands in the discarded ghost
    // rewind) — every assertion here is on polled state, never on returns.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkStart(2000);
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(1);

    // Phase 2: legitimate resume; the body enters its 2s asyncify park.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPrime();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(2);

    // THE PROD OPERATION: resume while the body is parked. On an unguarded
    // runtime this rewinds the stale fiber suspension and traps right here
    // (the page's uncaught "unreachable executed"); with the guard it is a
    // clean no-op refusal.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPoke();
    });
    const afterPoke = await parkState(page);
    console.log(`[TEST] mid-park poke: ${JSON.stringify(afterPoke)}`);
    expect(afterPoke.pokes, "poke reached the coroutine layer").toBe(1);
    expect(afterPoke.phase, "refused poke left the parked body undisturbed").toBe(2);

    // The park must complete on its own wake and yield again (phase 3) —
    // if the poke corrupted the fiber, the wake rewind dies instead.
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 15000, intervals: [100] })
      .toBe(3);

    // A post-yield poke is a LEGITIMATE resume and must work (the guard must
    // not refuse valid suspensions): body runs to completion.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPoke();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [100] })
      .toBe(4);

    // Production COROUTINE::Resume() must reject an already-finished body
    // before asking libcontext to enter its retired opaque handle.
    const resumedAfterFinish = await page.evaluate(() =>
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPoke(),
    );
    expect(resumedAfterFinish, "finished Resume() is a stable no-op").toBe(false);
    expect((await parkState(page)).phase, "finished Resume() cannot re-enter the body").toBe(4);

    // Runtime integrity: a model walk still works and no trap signature
    // appeared anywhere in the console.
    const snapshot = await page.evaluate(() =>
      (window as unknown as { Module: Mod }).Module.kicadCollabSnapshotItems(),
    );
    expect(typeof snapshot, "snapshot entry still functional").toBe("string");
    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no wasm trap signature anywhere in the run").toEqual([]);
  });

  test("an independent fiber request waits for the parked fiber's exact wake", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await bootHarness(page);

    // Prime + park the first coroutine (same staging as scenario 1).
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkStart(2500);
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(1);
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPrime();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(2);

    // Receive a request for independent work while the first coroutine is
    // parked. Production DOM/service adapters put this exact kind of fresh
    // JavaScript-to-Wasm entry through the physical native-entry arbiter. Do
    // the same here while keeping the native start lever raw: calling it
    // directly would deliberately bypass the architecture and make two
    // coroutine branches borrow the same active browser-root continuation.
    const accepted = await page.evaluate(() => {
      const g = globalThis as unknown as {
        Module: Mod;
        __wxScheduler?: NativeEntryScheduler;
        __fiberParkSecondEntry?: SecondEntryProbe;
      };
      const scheduler = g.__wxScheduler;
      if (!scheduler)
        throw new Error("scheduler native-entry arbiter is unavailable");

      const probe: SecondEntryProbe = {
        accepted: false,
        calls: 0,
        deferredBefore: scheduler.nativeEntryDeferred,
      };
      g.__fiberParkSecondEntry = probe;
      probe.accepted = scheduler.enqueueNativeEntry(
        null,
        "fiber-park independent request",
        () => {
          probe.calls++;
          // The raw Embind return may be an Asyncify unwind placeholder. The
          // monotonic call count and native phase transition are the oracles.
          g.Module.kicadTestFiberParkStartSecond();
        },
      );
      return probe.accepted;
    });
    expect(accepted, "arbiter accepted the independent request exactly once").toBe(true);

    // Let the arbiter's one readiness probe run. The retained FIFO head must
    // not poll and, more importantly, must not enter native code while the
    // first branch owns an in-place park.
    await expect
      .poll(async () => page.evaluate(() => {
        const g = globalThis as unknown as {
          Module: Mod;
          __wxScheduler: NativeEntryScheduler;
          __fiberParkSecondEntry: SecondEntryProbe;
        };
        const state = JSON.parse(g.Module.kicadTestFiberParkState()) as ParkState;
        return {
          phase: state.phase,
          phase2: state.phase2,
          calls: g.__fiberParkSecondEntry.calls,
          readinessRefused:
            g.__wxScheduler.nativeEntryDeferred
              > g.__fiberParkSecondEntry.deferredBefore,
        };
      }), {
        timeout: 10000,
        intervals: [25, 50, 100],
      })
      .toEqual({ phase: 2, phase2: 0, calls: 0, readinessRefused: true });

    // The original parked coroutine is still protected by its exact wake.
    // A direct Resume() is refused too; neither attempted entry is allowed to
    // replace or consume that wake capture.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPoke();
    });
    const afterPoke = await parkState(page);
    console.log(`[TEST] source-mismatch mid-park poke: ${JSON.stringify(afterPoke)}`);
    expect(afterPoke.phase, "refused poke left the parked body undisturbed").toBe(2);
    expect(afterPoke.phase2,
      "queued independent request did not cross the busy native-entry gate").toBe(0);

    // The first branch must consume its exact sleep wake and reach its second
    // real KiYield before the retained request is admitted. This composite is
    // intentionally exact, not `phase >= 3`: phase 4 would prove that the
    // yield ghost-returned and the body ran past its suspension. Once the
    // queued callback has run exactly once, phase 3 is stable until our later
    // explicit poke, so this cannot pass by sampling a transient value.
    await expect
      .poll(async () => page.evaluate(() => {
        const g = globalThis as unknown as {
          Module: Mod;
          __fiberParkSecondEntry: SecondEntryProbe;
        };
        const state = JSON.parse(g.Module.kicadTestFiberParkState()) as ParkState;
        return {
          phase: state.phase,
          phase2: state.phase2,
          calls: g.__fiberParkSecondEntry.calls,
        };
      }), { timeout: 15000, intervals: [50, 100] })
      .toEqual({ phase: 3, phase2: 1, calls: 1 });

    // Post-yield resume is legitimate again and completes the first body.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPoke();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [100] })
      .toBe(4);

    // The second coroutine kept its valid suspension throughout the first
    // fiber's wake. Its one post-yield Resume now completes it.
    await page.evaluate(() => {
      (window as unknown as { Module: Mod }).Module.kicadTestFiberParkPokeSecond();
    });
    await expect
      .poll(async () => (await parkState(page)).phase2, { timeout: 10000, intervals: [100] })
      .toBe(2);

    // The direct mid-park poke remains the intentional bypass.  Because its
    // browser callback runs on the root while libcontext's logical current
    // still names the sleeping fiber, the authoritative refusal is the
    // source-attribution guard (before target enterability is consulted).
    // The independent request is different: the arbiter retains and later
    // delivers it, so no requested work is lost.
    const sourceRefusals = testLogger.consoleLogs.filter((l) =>
      l.includes("[collab-fcontext] sched-divergence-current:"),
    );
    expect(sourceRefusals.length,
      "the raw poke still exercises the parked-source attribution guard").toBeGreaterThan(0);

    const deliveryCalls = await page.evaluate(() =>
      (globalThis as unknown as { __fiberParkSecondEntry: SecondEntryProbe })
        .__fiberParkSecondEntry.calls,
    );
    expect(deliveryCalls, "independent request was delivered once, without replay").toBe(1);

    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no wasm trap signature anywhere in the run").toEqual([]);
  });
});
