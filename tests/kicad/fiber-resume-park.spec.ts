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
  kicadCollabSnapshotItems(): string;
};

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
    JSON.parse((window.Module as unknown as Mod).kicadTestFiberParkState()),
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
      (window.Module as unknown as Mod).kicadTestFiberParkStart(2000);
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(1);

    // Phase 2: legitimate resume; the body enters its 2s asyncify park.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPrime();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(2);

    // THE PROD OPERATION: resume while the body is parked. On an unguarded
    // runtime this rewinds the stale fiber suspension and traps right here
    // (the page's uncaught "unreachable executed"); with the guard it is a
    // clean no-op refusal.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPoke();
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
      (window.Module as unknown as Mod).kicadTestFiberParkPoke();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [100] })
      .toBe(4);

    // Runtime integrity: a model walk still works and no trap signature
    // appeared anywhere in the console.
    const snapshot = await page.evaluate(() =>
      (window.Module as unknown as Mod).kicadCollabSnapshotItems(),
    );
    expect(typeof snapshot, "snapshot entry still functional").toBe("string");
    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no wasm trap signature anywhere in the run").toEqual([]);
  });

  test("poisoned attribution: a second coroutine launders the parked fiber; the JS guard still quarantines it", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await bootHarness(page);

    // Prime + park the first coroutine (same staging as scenario 1).
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkStart(2500);
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(1);
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPrime();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [50] })
      .toBe(2);

    // THE LAUNDERING: start a second coroutine while the first is parked.
    // libcontext attributes this jump's old side to the PARKED fiber
    // (g_current_context is stale) — writing a fresh suspension into its
    // struct and re-marking it swap_suspended, exactly how the prod resume
    // bypassed the C++ guard on v0.1.21.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkStartSecond();
    });
    await expect
      .poll(async () => (await parkState(page)).phase2, { timeout: 10000, intervals: [50] })
      .toBe(1);

    // The fatal prod operation, now with the C++ guard blinded. The JS
    // stale-rewind guard must refuse it (quarantine beacon) instead of
    // rewinding foreign/stale data.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPoke();
    });
    const afterPoke = await parkState(page);
    console.log(`[TEST] laundered mid-park poke: ${JSON.stringify(afterPoke)}`);
    expect(afterPoke.phase, "quarantined poke left the parked body undisturbed").toBe(2);

    // The park must still complete on its own wake and yield again.
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 15000, intervals: [100] })
      .toBe(3);

    // Post-yield resume is legitimate again and completes the first body.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPoke();
    });
    await expect
      .poll(async () => (await parkState(page)).phase, { timeout: 10000, intervals: [100] })
      .toBe(4);

    // The second coroutine also completes cleanly.
    await page.evaluate(() => {
      (window.Module as unknown as Mod).kicadTestFiberParkPokeSecond();
    });
    await expect
      .poll(async () => (await parkState(page)).phase2, { timeout: 10000, intervals: [100] })
      .toBe(2);

    // Window-engagement proof: the JS guard must have actually refused the
    // laundered resume — silence means the scenario never bypassed the C++
    // guard and the test is vacuous.
    const refusals = testLogger.consoleLogs.filter((l) =>
      l.includes("fiber-resume-refused"),
    );
    console.log(`[TEST] refusal beacons: ${refusals.length}`);
    for (const l of refusals.slice(0, 4)) console.log(`[TEST]   ${l}`);
    expect(refusals.length, "the stale-rewind guard intercepted the laundered resume").toBeGreaterThan(0);

    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no wasm trap signature anywhere in the run").toEqual([]);
  });
});
