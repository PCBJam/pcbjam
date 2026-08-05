import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { expectGuardsSilent } from "./utils/guard-beacons";

/**
 * Timer-park concurrent-Asyncify repro (gal-refresh-timer investigation).
 *
 * The prod trap ("index out of bounds" + "unreachable executed" in doRewind,
 * v0.1.17–19, still un-reproduced naturally): a wx timer callback is a FRESH
 * JS→wasm entry (emscripten_async_call → TimerCallbackFunc::Run → Notify()),
 * and the main loop spends most wall-clock time Asyncify-parked inside
 * wxWasmYieldToBrowser. A timer handler that itself parks therefore creates
 * TWO live Asyncify contexts over the single-slot `Asyncify.currData` — the
 * emscripten #9153 family that the scheduler shim
 * (scripts/common/shims/asyncify-scheduler.js) silently repairs. The collab entries add the third ingredient: they run on
 * TOOL_MANAGER coroutines (emscripten_fiber_swap), which bypass the shim's
 * allocateData accounting entirely — and `finishContextSwitch` is exactly
 * where the prod trap's second stack dies.
 *
 * The natural trigger needs a timer handler that parks mid-paint
 * (scheduler-dependent; never hit locally). `kicadTestArmTimerPark` makes the
 * window deterministic: a one-shot wx timer whose Notify() emscripten_sleep()s
 * for a fixed time. Three escalating cycles:
 *
 *   1. timer park alone           (timer chain × main-loop yield park)
 *   2. + collab entry hammering   (adds fiber swaps through the window)
 *   3. same again                 (interleaving lottery, second draw)
 *
 * The spec asserts the runtime SURVIVES every cycle — on a build where the
 * hypothesis holds this is deterministically RED, and after the real fix it
 * is the regression gate. The `[wx-asyncify]` shim diagnostics must report
 * the concurrent-park window engaging; that assert fails only if the lever
 * itself never created the overlap (a broken repro, not a passing one).
 */

const SEG_TARGET = "fa220000-0000-0000-0000-00000000cafe";
const PROBE_HOME = "10000000,10000000"; // on-disk position (IU)

/** Compact deterministic board — enough items for a real snapshot walk. */
function board(): string {
  const lines: string[] = [];
  lines.push("(kicad_pcb");
  lines.push("\t(version 20241229)");
  lines.push('\t(generator "pcbnew")');
  lines.push('\t(generator_version "9.0")');
  lines.push("\t(general (thickness 1.6))");
  lines.push('\t(paper "A4")');
  lines.push("\t(layers");
  lines.push('\t\t(0 "F.Cu" signal)');
  lines.push('\t\t(2 "B.Cu" signal)');
  lines.push('\t\t(25 "Edge.Cuts" user)');
  lines.push("\t)");
  lines.push("\t(setup)");
  lines.push('\t(net 0 "")');
  const uuid = (n: number) =>
    `fa2${(n + 1).toString(16).padStart(5, "0")}-0000-0000-0000-000000000000`;
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const x = 20 + (i % 100) * 1.5;
    const y = 20 + Math.floor(i / 100) * 1;
    lines.push(
      `\t(segment (start ${x} ${y}) (end ${x + 1.2} ${y}) (width 0.2) (layer "F.Cu") (net 0) (uuid "${uuid(n++)}"))`,
    );
  }
  lines.push(
    `\t(segment (start 10 10) (end 15 10) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG_TARGET}"))`,
  );
  lines.push(")");
  return lines.join("\n");
}

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadTestArmTimerPark(delayMs: number, parkMs: number): boolean;
  kicadTestTimerParkState(): string;
  kicadCollabSnapshotItems(): string;
  kicadCollabApply(j: string): unknown;
  kicadCollabGetPos(id: string): string;
};

interface CycleStats {
  armed: boolean;
  fired: boolean;
  done: boolean;
  sawParked: boolean;
  hammerIters: number;
  /** Bytes the wasm heap grew mid-park (growHeap cycles; 0 = no growth). */
  grewBytes: number;
  errors: string[];
  elapsedMs: number;
}

const TRAP_SIGNATURE =
  /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function or function signature|memory access out of bounds/;

async function bootHarness(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function" &&
        typeof m?.kicadTestArmTimerPark === "function"
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

/** Open the board and poll until the open chain truly settles. */
async function openAndSettle(page: Page, content: string): Promise<void> {
  await page.evaluate((c) => {
    const w = window as unknown as {
      FS: { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
      Module: Mod;
    };
    const dir = "/home/kicad/documents";
    try {
      w.FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    w.FS.writeFile(`${dir}/timerpark.kicad_pcb`, c);
    w.Module.kicadOpenFile(`${dir}/timerpark.kicad_pcb`);
  }, content);
  await expect
    .poll(
      () => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()),
      { timeout: 120000, intervals: [250] },
    )
    .toBe(false);
}

/**
 * One repro cycle in-page: arm the parking timer, then poll its state until
 * the park completes — optionally hammering the fiber-based collab entries
 * through the window (the prod settle fan-out shape). Every embind entry here
 * runs while the timer chain is Asyncify-parked and the main loop's yield
 * park keeps cycling: the exact concurrent-context interleaving under test.
 */
async function armAndRide(
  page: Page,
  opts: { parkMs: number; hammer: boolean; growHeap?: boolean },
): Promise<CycleStats> {
  return page.evaluate(async ({ parkMs, hammer, growHeap }) => {
    const m = (window as unknown as { Module: Mod }).Module;
    const before = JSON.parse(m.kicadTestTimerParkState()) as { fired: number; done: number };
    const stats = {
      armed: false,
      fired: false,
      done: false,
      sawParked: false,
      hammerIters: 0,
      grewBytes: 0,
      errors: [] as string[],
      elapsedMs: 0,
    };
    if (!m.kicadTestArmTimerPark(30, parkMs)) return stats;
    stats.armed = true;

    const t0 = performance.now();
    // Bound = park length + generous rewind budget; exits on completion.
    while (performance.now() - t0 < parkMs + 20000) {
      try {
        const st = JSON.parse(m.kicadTestTimerParkState()) as {
          fired: number;
          done: number;
          parked: boolean;
        };
        if (st.fired > before.fired) stats.fired = true;
        if (st.parked) stats.sawParked = true;
        if (st.done > before.done) {
          stats.done = true;
          break;
        }
      } catch (e) {
        stats.errors.push(`state poll: ${String(e)}`);
        break;
      }
      // Heap growth mid-park (prod trace: `stage:done … GREW +187MB`): growth
      // detaches every JS heap view; a stale view held across it is one of
      // the few mechanisms that yields a bad function-table index LATER.
      // 256 MB per shot, deliberately leaked — the asyncify buffers of the
      // parked chains live in linear memory on both sides of the boundary.
      if (stats.fired && growHeap && !stats.grewBytes) {
        const alloc = (
          m as unknown as { ___libc_malloc?: (n: number) => number }
        ).___libc_malloc;
        if (typeof alloc === "function") {
          const before = (window as unknown as { Module: { HEAPU8: Uint8Array } }).Module
            .HEAPU8.byteLength;
          alloc(256 * 1024 * 1024);
          const after = (window as unknown as { Module: { HEAPU8: Uint8Array } }).Module
            .HEAPU8.byteLength;
          stats.grewBytes = after - before;
        } else {
          stats.errors.push("growHeap: ___libc_malloc not exported");
        }
      }
      if (stats.fired && hammer) {
        for (const [name, fn] of [
          ["snapshotItems", () => m.kicadCollabSnapshotItems()],
          ["getPos", () => m.kicadCollabGetPos("fa220000-0000-0000-0000-00000000cafe")],
        ] as const) {
          try {
            fn();
            stats.hammerIters++;
          } catch (e) {
            stats.errors.push(`${name} during park: ${String(e)}`);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    stats.elapsedMs = Math.round(performance.now() - t0);
    return stats;
  }, opts);
}

test.describe("timer Notify() Asyncify-park during main-loop yield (concurrent currData)", () => {
  test("runtime survives a parking timer handler, alone and under fiber hammering", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(300000);
    await bootHarness(page);
    await openAndSettle(page, board());

    const cycles: Array<{ label: string; hammer: boolean; growHeap?: boolean }> = [
      { label: "park only", hammer: false },
      { label: "park + fiber hammer", hammer: true },
      { label: "park + fiber hammer (2nd draw)", hammer: true },
      // Prod trace showed `GREW +187MB` on the crashing load: growth detaches
      // every JS heap view while TWO chains are parked (timer + main-loop
      // yield) and fibers swap through — the stale-view stale-buffer scenario.
      { label: "park + heap growth + fiber hammer", hammer: true, growHeap: true },
    ];
    for (const { label, hammer, growHeap } of cycles) {
      const stats = await armAndRide(page, { parkMs: 1500, hammer, growHeap });
      console.log(
        `[TEST] ${label}: fired=${stats.fired} done=${stats.done} parked=${stats.sawParked} ` +
          `hammerIters=${stats.hammerIters} grew=${stats.grewBytes} ` +
          `elapsed=${stats.elapsedMs}ms errors=${stats.errors.length}`,
      );
      expect(stats.armed, `${label}: timer armed`).toBe(true);
      expect(stats.fired, `${label}: Notify() entered`).toBe(true);
      expect(stats.sawParked, `${label}: the park window engaged`).toBe(true);
      expect(stats.done, `${label}: Notify() survived its park and rewound`).toBe(true);
      expect(stats.errors, `${label}: no embind entry trapped`).toEqual([]);
      if (growHeap) {
        expect(stats.grewBytes, `${label}: the heap actually grew mid-park`).toBeGreaterThan(0);
      }
    }

    // The runtime is still fully functional: snapshots walk the board and a
    // real apply lands (a poisoned Asyncify state fails one of these first).
    const itemCount = await page.evaluate(
      () =>
        JSON.parse((window.Module as unknown as Mod).kicadCollabSnapshotItems()).added.length,
    );
    expect(itemCount, "post-cycle snapshot sees the board").toBeGreaterThan(2000);
    await page.evaluate(
      (id) =>
        (window.Module as unknown as Mod).kicadCollabApply(
          JSON.stringify({
            added: [],
            changed: [
              {
                id,
                type: "PCB_TRACK",
                sx: 12_000_000,
                sy: 34_000_000,
                ex: 17_000_000,
                ey: 34_000_000,
                width: 200000,
              },
            ],
            removed: [],
          }),
        ),
      SEG_TARGET,
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => (window.Module as unknown as Mod).kicadCollabGetPos(id),
            SEG_TARGET,
          ),
        { timeout: 10000, intervals: [200] },
      )
      .toBe("12000000,34000000");

    // Console-level trap sweep: the prod signatures must not have appeared
    // anywhere (the page survives some of them as "Uncaught" noise).
    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no wasm trap signature anywhere in the run").toEqual([]);

    // Doc 17 S1 tripwire (arms itself when the wasm ships the C mailbox lane,
    // detected via the wxWasmMailboxTick export): timers are then delivered
    // from the mailbox only when the interlock is free, so the legacy 17 ms
    // parked-retry path must be SILENT. On legacy wasm this is skipped — the
    // retry storm there is expected and covered by the assertions above.
    // Both halves must be present: the wasm export (C lane compiled in) AND
    // the shim (variant injected) — a C-lane wasm on legacy glue keeps legacy
    // timer semantics, and its retry storms are expected.
    const cLane = await page.evaluate(
      () =>
        typeof (window.Module as unknown as { _wxWasmMailboxTick?: unknown })
          ._wxWasmMailboxTick === "function" &&
        !!(globalThis as unknown as { __wxScheduler?: unknown }).__wxScheduler,
    );
    if (cLane) expectGuardsSilent(testLogger.consoleLogs, ["timerRetry"]);

    // Window-engagement proof, independent of survival: the scheduler shim
    // must have SEEN the concurrent parks (its reporting is new — silence here
    // means the lever never created the overlap and the repro is vacuous).
    const shimLines = testLogger.consoleLogs.filter((l) => l.includes("[wx-asyncify]"));
    console.log(`[TEST] shim diagnostics: ${shimLines.length} line(s)`);
    for (const l of shimLines.slice(0, 10)) console.log(`[TEST]   ${l}`);
    expect(
      shimLines.length,
      "scheduler shim observed the concurrent-park window",
    ).toBeGreaterThan(0);
  });
});
