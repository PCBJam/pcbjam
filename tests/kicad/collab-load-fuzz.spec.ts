import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Collab-entry-during-load gate test + fuzz (docs/features/async/14-open-settle-gate.md).
 *
 * The prod trap: `kicadOpenFile` runs `OpenProjectFiles` under Asyncify; on a
 * slow machine the chain parks mid-load (thread-pool futex waits), and any bare
 * embind entry that walks the model during such a park (the collab seed
 * snapshot, an adopt apply) can virtual-dispatch through half-mutated state and
 * trap with "indirect call signature mismatch". The fix is two-layered: the
 * shell defers the attach on `kicadOpenFileBusy` (open-flow.ts), and the
 * snapshot/apply entries themselves early-return while the open is in flight
 * (open_gate.h guards).
 *
 * Natural in-load parks are scheduler-dependent — on a fast idle machine the
 * whole open runs synchronously and NO window exists — so the deterministic
 * test arms `kicadTestSetOpenPark`: kicadOpenFile then context-parks for a
 * fixed time on entry AND after OpenProjectFiles returns (model fully loaded,
 * owner still held). Calling the entries inside that window asserts the
 * serialization contract sharply:
 *   - `kicadOpenFileBusy()` reads true during the parks, false after;
 *   - legacy glue returns the EMPTY delta and DROPS applies at the open gate;
 *   - scheduler glue defers reads and writes behind the open owner, so the
 *     snapshots resolve with the loaded board and the applies land in order;
 *   - after settle the entries work normally (guard released).
 *
 * VARIANT CONTRACT (docs/features/async/17 §3b): on scheduler glue the
 * shim's embind lane queues busy-window mutators and delivers them after
 * settle, so both the snapshot and apply assertions branch on the lane's
 * presence.
 *
 * The second test is the scheduler-dependent stress fuzz (spinning-worker CPU
 * starvation to force real futex-wait parks, issuing entries during the load).
 * It is skipped unless PCBJAM_FUZZ_STRESS=1: engagement of the window is not
 * guaranteed on a fast machine, so it cannot gate CI — it exists to hunt this
 * reentrancy class by hand (loop it on a loaded box).
 */

const SEG_TARGET = "fa220000-0000-0000-0000-00000000cafe"; // apply probe
const PROBE_HOME = "10000000,10000000"; // its on-disk position (IU)

/** Deterministic large board (~13k items) — a realistic snapshot/apply load. */
function bigBoard(): string {
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
  lines.push('\t\t(37 "F.SilkS" user)');
  lines.push('\t\t(25 "Edge.Cuts" user)');
  lines.push("\t)");
  lines.push("\t(setup)");
  lines.push('\t(net 0 "")');
  const NETS = 40;
  for (let i = 1; i <= NETS; i++) lines.push(`\t(net ${i} "N${i}")`);
  const uuid = (n: number) => `fa2${(n + 1).toString(16).padStart(5, "0")}-0000-0000-0000-000000000000`;
  let n = 0;
  for (let i = 0; i < 12000; i++) {
    const x = 20 + (i % 120) * 1.5;
    const y = 20 + Math.floor(i / 120) * 1;
    lines.push(
      `\t(segment (start ${x} ${y}) (end ${x + 1.2} ${y}) (width 0.2) (layer "F.Cu") (net ${
        (i % NETS) + 1
      }) (uuid "${uuid(n++)}"))`,
    );
  }
  for (let i = 0; i < 800; i++) {
    const x = 21 + (i % 80) * 2;
    const y = 21 + Math.floor(i / 80) * 10;
    lines.push(
      `\t(via (at ${x} ${y}) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net ${
        (i % NETS) + 1
      }) (uuid "${uuid(n++)}"))`,
    );
  }
  // Footprints with text children (the field/text walk of the snapshot).
  for (let i = 0; i < 200; i++) {
    const x = 30 + (i % 20) * 8;
    const y = 140 + Math.floor(i / 20) * 6;
    lines.push(`\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${uuid(n++)}")
\t\t(at ${x} ${y})
\t\t(attr smd)
\t\t(property "Reference" "R${i}"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${uuid(n++)}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(property "Value" "R"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "${uuid(n++)}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t)`);
  }
  lines.push(
    `\t(segment (start 10 10) (end 15 10) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG_TARGET}"))`,
  );
  lines.push(")");
  return lines.join("\n");
}

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadOpenFileBusy(): boolean;
  kicadTestSetOpenPark(ms: number): void;
  kicadCollabSnapshot(): Promise<string>;
  kicadCollabSnapshotItems(): Promise<string>;
  kicadCollabApply(j: string): Promise<void>;
  kicadCollabApplyItems(j: string): Promise<void>;
  kicadCollabGetPos(id: string): Promise<string>;
};

interface FuzzStats {
  busySamples: number;
  iterations: number;
  errors: string[];
  /** Largest `added` length from a snapshot requested while the open was busy. */
  maxBusySnapshotItems: number;
  settled: boolean;
  loadMs: number;
  contextSleepsScheduledDelta: number;
  contextSleepsDeliveredDelta: number;
  inPlaceFiberParksDelta: number;
}

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

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
        typeof m?.kicadCollabApply === "function"
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

/**
 * In-page: write the board, open it, and hammer every collab entry for as long
 * as `kicadOpenFileBusy()` reports the open in flight. Mid-load applies try to
 * MOVE the probe segment: the legacy gate drops them, while the scheduler
 * gateway defers them behind the open owner. `starve` additionally saturates
 * every core with spinning workers so natural thread-pool waits park too.
 */
async function openAndHammer(
  page: Page,
  opts: { content: string; probeUuid: string; parkMs: number; starve: boolean },
): Promise<FuzzStats> {
  return page.evaluate(async ({ content, probeUuid, parkMs, starve }) => {
    const w = window as unknown as {
      FS: FS;
      Module: Mod & { kicadTestSetOpenPark?: (ms: number) => void };
      __wxScheduler?: {
        contextSleepsScheduled: number;
        contextSleepsDelivered: number;
        inplaceParksOnFiberStack: number;
      };
    };
    const dir = "/home/kicad/documents";
    try {
      w.FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    const path = `${dir}/fuzz.kicad_pcb`;
    w.FS.writeFile(path, content);
    if (parkMs > 0) w.Module.kicadTestSetOpenPark!(parkMs);

    const schedulerBefore = {
      contextSleepsScheduled: w.__wxScheduler?.contextSleepsScheduled ?? 0,
      contextSleepsDelivered: w.__wxScheduler?.contextSleepsDelivered ?? 0,
      inPlaceFiberParks: w.__wxScheduler?.inplaceParksOnFiberStack ?? 0,
    };

    // Mid-load applies try to move the probe AWAY from home; both wire families.
    const wireDelta = JSON.stringify({
      added: [],
      changed: [
        {
          sexpr: `(segment (start 55 55) (end 60 55) (width 0.2) (layer "F.Cu") (net 0) (uuid "${probeUuid}"))`,
          parent: null,
        },
      ],
      removed: [],
    });
    const scalarDelta = JSON.stringify({
      added: [],
      changed: [
        {
          id: probeUuid,
          type: "PCB_TRACK",
          sx: 55_000_000,
          sy: 55_000_000,
          ex: 60_000_000,
          ey: 55_000_000,
          width: 200000,
        },
      ],
      removed: [],
    });

    const burners: Worker[] = [];
    let burnUrl = "";
    if (starve) {
      burnUrl = URL.createObjectURL(
        new Blob(["for(;;){let x=0;for(let i=0;i<1e7;i++)x+=i;}"], {
          type: "text/javascript",
        }),
      );
      const cores = navigator.hardwareConcurrency || 8;
      for (let i = 0; i < cores * 2; i++) burners.push(new Worker(burnUrl));
    }

    const t0 = performance.now();
    let busySamples = 0;
    let iterations = 0;
    let maxBusySnapshotItems = 0;
    const errors: string[] = [];

    // Owned opens start on a fresh execution-owner task and return an exact-tail
    // Promise. Do not sample Busy synchronously: the shallow starter has only
    // queued the native body at that point. Attach rejection handling before
    // yielding, then wait for either real activation or exact completion.
    let openDone = false;
    let openError: unknown;
    const openCompletion = Promise.resolve(w.Module.kicadOpenFile(path)).then(
      () => {
        openDone = true;
      },
      (error) => {
        openDone = true;
        openError = error;
      },
    );
    const activationStart = performance.now();
    while (
      !w.Module.kicadOpenFileBusy() &&
      !openDone &&
      performance.now() - activationStart < 30000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // On scheduler glue, awaiting the first gateway read queues it behind the
    // open owner and resumes this callback after settle. One pass therefore
    // proves deferred read/write delivery without building a replay backlog.
    // Legacy glue remains synchronous and continues hammering the guarded path.
    // Every Asyncify park of the open chain hands the event loop to this
    // timer — exactly how the prod shell's collab attach interleaved.
    while (performance.now() - t0 < 120000) {
      if (!w.Module.kicadOpenFileBusy()) break;
      busySamples++;
      iterations++;
      // Submit the whole batch before awaiting any ticket. On scheduler glue,
      // all four entries are therefore admitted while the open owner is still
      // parked; awaiting the first one then waits for the ordered batch.
      const calls: Array<[string, Promise<unknown>]> = [];
      for (const [name, fn] of [
        ["snapshotItems", () => w.Module.kicadCollabSnapshotItems()],
        ["snapshot", () => w.Module.kicadCollabSnapshot()],
        ["applyItems", () => w.Module.kicadCollabApplyItems(wireDelta)],
        ["apply", () => w.Module.kicadCollabApply(scalarDelta)],
      ] as const) {
        try {
          calls.push([name, Promise.resolve(fn())]);
        } catch (e) {
          errors.push(`${name} during load: ${String(e)}`);
        }
      }
      for (const [name, pending] of calls) {
        try {
          const out = await pending;
          if (typeof out === "string" && name.startsWith("snapshot")) {
            const added = (JSON.parse(out) as { added: unknown[] }).added.length;
            if (added > maxBusySnapshotItems) maxBusySnapshotItems = added;
          }
        } catch (e) {
          errors.push(`${name} during load: ${String(e)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await openCompletion;
    if (openError !== undefined) errors.push(`open: ${String(openError)}`);
    for (const b of burners) b.terminate();
    if (burnUrl) URL.revokeObjectURL(burnUrl);
    if (parkMs > 0) w.Module.kicadTestSetOpenPark!(0);
    const schedulerAfter = {
      contextSleepsScheduled: w.__wxScheduler?.contextSleepsScheduled ?? 0,
      contextSleepsDelivered: w.__wxScheduler?.contextSleepsDelivered ?? 0,
      inPlaceFiberParks: w.__wxScheduler?.inplaceParksOnFiberStack ?? 0,
    };
    return {
      busySamples,
      iterations,
      errors,
      maxBusySnapshotItems,
      settled: !w.Module.kicadOpenFileBusy(),
      loadMs: Math.round(performance.now() - t0),
      contextSleepsScheduledDelta:
        schedulerAfter.contextSleepsScheduled - schedulerBefore.contextSleepsScheduled,
      contextSleepsDeliveredDelta:
        schedulerAfter.contextSleepsDelivered - schedulerBefore.contextSleepsDelivered,
      inPlaceFiberParksDelta:
        schedulerAfter.inPlaceFiberParks - schedulerBefore.inPlaceFiberParks,
    };
  }, opts);
}

/** Post-settle assertions shared by the legacy-gate and scheduler-gateway variants. */
async function assertSettledContract(page: Page, stats: FuzzStats): Promise<void> {
  expect(stats.settled, "kicadOpenFileBusy cleared after the load").toBe(true);
  expect(stats.errors, "no traps while hammering entries mid-load").toEqual([]);
  const schedulerLane = await page.evaluate(
    () =>
      ((globalThis as unknown as { __wxScheduler?: { mutatorsWrapped: number } }).__wxScheduler
        ?.mutatorsWrapped ?? 0) > 0,
  );
  if (schedulerLane && stats.busySamples > 0) {
    expect(
      stats.maxBusySnapshotItems,
      "a busy-window scheduler read resolved after the open owner with the loaded board",
    ).toBeGreaterThan(12000);
  } else {
    expect(
      stats.maxBusySnapshotItems,
      "legacy busy-window reads stayed gated (or the stress run saw no busy window)",
    ).toBe(0);
  }
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(/fuzz/i);

  // Variant contract (docs/features/async/17 §3b). Legacy glue drops the
  // mid-load applies; scheduler glue delivers them after the open owner.
  const HAMMER_TARGET = "55000000,55000000"; // both hammer deltas move the probe here
  await expect
    .poll(
      () =>
        page.evaluate((id) => (window.Module as unknown as Mod).kicadCollabGetPos(id), SEG_TARGET),
      { timeout: 10000, intervals: [200] },
    )
    .toBe(schedulerLane && stats.busySamples > 0 ? HAMMER_TARGET : PROBE_HOME);

  // Guard released: the snapshot now walks the real, fully-loaded board…
  const itemCount = await page.evaluate(
    async () =>
      JSON.parse(await (window.Module as unknown as Mod).kicadCollabSnapshotItems()).added.length,
  );
  expect(itemCount, "post-load snapshot sees the board").toBeGreaterThan(12000);

  // …and a real apply lands.
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
        page.evaluate((id) => (window.Module as unknown as Mod).kicadCollabGetPos(id), SEG_TARGET),
      { timeout: 10000, intervals: [200] },
    )
    .toBe("12000000,34000000");
}

test.describe("collab entries during a parked board load (open_gate)", () => {
  test("deterministic park window: entries serialize behind the open owner", async ({
    page,
    testLogger,
  }) => {
    // Budget for the large board load plus the deterministic parked window.
    test.setTimeout(420000);
    await bootHarness(page);

    const hooks = await page.evaluate(() => {
      const m = window.Module as unknown as Partial<Mod>;
      return {
        busy: typeof m.kicadOpenFileBusy === "function",
        park: typeof m.kicadTestSetOpenPark === "function",
      };
    });
    expect(hooks.busy, "kicadOpenFileBusy export present (open_gate.h)").toBe(true);
    expect(hooks.park, "kicadTestSetOpenPark export present (open_gate.h)").toBe(true);

    const stats = await openAndHammer(page, {
      content: bigBoard(),
      probeUuid: SEG_TARGET,
      parkMs: 1500, // entry + post-load parks — a guaranteed hammer window
      starve: false,
    });
    console.log(
      `[TEST] gate: ${stats.iterations} iterations over ${stats.loadMs}ms, ` +
        `${stats.busySamples} busy samples, maxBusySnap=${stats.maxBusySnapshotItems}, ` +
        `contextSleeps=${stats.contextSleepsDeliveredDelta}/` +
        `${stats.contextSleepsScheduledDelta}, ` +
        `inPlaceFiberParks=${stats.inPlaceFiberParksDelta}, ${stats.errors.length} errors`,
    );

    // The armed parks make the window unconditional on any machine.
    expect(stats.busySamples, "the busy window was observed").toBeGreaterThan(0);
    expect(
      stats.contextSleepsScheduledDelta,
      "both deterministic waits used scheduler-owned context parks",
    ).toBeGreaterThanOrEqual(2);
    expect(
      stats.contextSleepsDeliveredDelta,
      "every scheduled deterministic context park received its exact wake",
    ).toBe(stats.contextSleepsScheduledDelta);
    expect(
      stats.inPlaceFiberParksDelta,
      "the owned open never bypassed suspension centralization",
    ).toBe(0);
    await assertSettledContract(page, stats);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // Scheduler-dependent stress hunt — NOT a CI gate: window engagement is not
  // guaranteed on a fast idle machine (see header). Loop it manually:
  //   PCBJAM_FUZZ_STRESS=1 npx playwright test --project=kicad-firefox kicad/collab-load-fuzz.spec.ts
  test("stress: hammer through natural thread-wait parks under CPU starvation", async ({
    page,
    testLogger,
  }) => {
    test.skip(!process.env.PCBJAM_FUZZ_STRESS, "manual stress hunt (PCBJAM_FUZZ_STRESS=1)");
    test.setTimeout(300000);
    await bootHarness(page);

    const stats = await openAndHammer(page, {
      content: bigBoard(),
      probeUuid: SEG_TARGET,
      parkMs: 0, // natural parks only
      starve: true,
    });
    console.log(
      `[TEST] stress: ${stats.iterations} iterations over ${stats.loadMs}ms, ` +
        `${stats.busySamples} busy samples, maxBusySnap=${stats.maxBusySnapshotItems}, ` +
        `${stats.errors.length} errors`,
    );

    // No busySamples assert: with no natural park the window legitimately
    // never opens. Everything that DID interleave must have been safe.
    await assertSettledContract(page, stats);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
