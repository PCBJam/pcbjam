import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * N2 — message ordering under a parked open (scheduler-build target semantics).
 * docs/features/async/17-mailbox-scheduler-plan.md §3d N2, §3b.
 *
 * Legacy glue (open_gate, doc 14): collab entries issued while `kicadOpenFile`
 * is asyncify-parked are DROPPED — collab-load-fuzz.spec.ts asserts that drop
 * contract on legacy builds, and it is correct for the guard architecture.
 *
 * The mailbox flips drop→deliver: a mutating entry issued during the open
 * becomes a queued message, applied IN ORDER after the open completes. GREEN
 * since S1's embind lane — the scheduler shim wraps the audited mutators
 * (doc 18) at the Module boundary, queueing busy-window calls and delivering
 * after settle with promise-returned results. S4 moves queueing worker-side.
 * Self-skips on legacy glue (the lane is a build variant until S5).
 *
 * Ordering probe: apply A ADDS a segment, apply B MOVES that same segment.
 * B can only land if A landed first — the single final-position check proves
 * both delivery and order (drop-A-deliver-B leaves B targetless).
 */

const NEW_SEG = "fa2c0000-0000-0000-0000-00000000beef";
const B_TARGET = "60000000,60000000"; // where apply B moves A's segment (IU)

function smallBoard(): string {
  return `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(segment (start 10 10) (end 15 10) (width 0.2) (layer "F.Cu") (net 0) (uuid "fa2b0000-0000-0000-0000-000000000001"))
)`;
}

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadOpenFileBusy(): boolean;
  kicadTestSetOpenPark(ms: number): void;
  kicadCollabApplyItems(j: string): Promise<void>;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadCollabTestRunOnFiberPark(ms: number): Promise<boolean>;
  kicadTestRunOnFiberParkState(): string;
  kicadCollabTestRunOnFiberModal(): Promise<boolean>;
  kicadTestRunOnFiberModalState(): string;
};

type DeliveryObservation = {
  returned: boolean;
  resultReady: boolean;
  nativeComplete: boolean;
};

type RunOnFiberParkState = {
  stage: number;
  parkMs: number;
  firstRuns: number;
  secondRuns: number;
  violations: number;
  busy: boolean;
};

type RunOnFiberModalState = {
  stage: number;
  parentRuns: number;
  childHandlers: number;
  childRuns: number;
  jobsAtChild: number;
  lanesAtChild: number;
  parentReturns: number;
  modalResult: number;
  violations: number;
  jobs: number;
  lanes: number;
  busy: boolean;
};

async function bootHarness(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabApplyItems === "function" &&
        typeof m?.kicadTestSetOpenPark === "function"
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

test.describe("mailbox N2: entries during a parked open are delivered in order", () => {
  test("apply A (add) then apply B (move) mid-park land in order after settle", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    void testLogger;
    await bootHarness(page);

    // This regression test requires the scheduler build's Embind owner lane.
    // A fresh staged build without it is a broken test artifact, not a reason
    // to quarantine the delivery contract.
    const lane = await page.evaluate(() => {
      const s = (globalThis as unknown as { __wxScheduler?: { mutatorsWrapped: number } })
        .__wxScheduler;
      return s ? s.mutatorsWrapped : 0;
    });
    expect(lane, "the staged scheduler must wrap stateful Embind entry points").toBeGreaterThan(0);

    const issued = await page.evaluate(async ({ newSeg, board }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const scheduler = (globalThis as unknown as {
        __wxScheduler: {
          deliverMutator(id: number): number;
          mutatorJobs: Map<
            number,
            { name: string; resultReady: boolean; nativeComplete: boolean }
          >;
        };
      }).__wxScheduler;
      const originalDeliver = scheduler.deliverMutator;
      let delivery: DeliveryObservation | null = null;

      // Observe the exact shallow-return edge. The raw Embind wrapper must
      // return its placeholder to deliverMutator before its queued coroutine
      // starts. Native completion comes later, when the retained owner retires.
      scheduler.deliverMutator = function (id: number): number {
        const accepted = originalDeliver.call(scheduler, id);
        const job = scheduler.mutatorJobs.get(id);
        if (!delivery && job?.name === "kicadCollabApplyItems") {
          delivery = {
            returned: true,
            resultReady: job.resultReady,
            nativeComplete: job.nativeComplete,
          };
        }
        return accepted;
      };

      const dir = "/home/kicad/documents";
      try {
        try {
          w.FS.mkdirTree(dir);
        } catch {
          /* exists */
        }
        const path = `${dir}/n2.kicad_pcb`;
        w.FS.writeFile(path, board);
        // Deterministic park window on entry AND post-load (open_gate.h test lever)
        w.Module.kicadTestSetOpenPark(1500);
        const open = Promise.resolve(w.Module.kicadOpenFile(path));
        // Observe rejection now while the test deliberately keeps the exact
        // ticket in flight and submits owner work behind it. Retain the exact
        // outcome so the intended join point below asserts, rather than hides,
        // an early rejection.
        const openOutcome = open.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error: String(error) }),
        );

        // Wait until the busy window is observably open, then issue A and B once.
        const t0 = performance.now();
        while (!w.Module.kicadOpenFileBusy() && performance.now() - t0 < 30000) {
          await new Promise((r) => setTimeout(r, 5));
        }
        if (!w.Module.kicadOpenFileBusy()) {
          return { inWindow: false, settled: false, delivery, appliesSettled: false };
        }

        const applyA = JSON.stringify({
          added: [
            {
              sexpr: `(segment (start 50 50) (end 55 50) (width 0.2) (layer "F.Cu") (net 0) (uuid "${newSeg}"))`,
              parent: null,
            },
          ],
          changed: [],
          removed: [],
        });
        const applyB = JSON.stringify({
          added: [],
          changed: [
            {
              sexpr: `(segment (start 60 60) (end 65 60) (width 0.2) (layer "F.Cu") (net 0) (uuid "${newSeg}"))`,
              parent: null,
            },
          ],
          removed: [],
        });
        const applies = [
          Promise.resolve(w.Module.kicadCollabApplyItems(applyA)),
          Promise.resolve(w.Module.kicadCollabApplyItems(applyB)),
        ];

        // Exact tickets, not a sampled busy flag, prove that every queued
        // command reached its retained-owner tail.
        const [openResult] = await Promise.all([openOutcome, ...applies]);
        if (!openResult.ok) throw new Error(`open failed: ${openResult.error}`);
        const settled = !w.Module.kicadOpenFileBusy();
        return { inWindow: true, settled, delivery, appliesSettled: settled };
      } finally {
        w.Module.kicadTestSetOpenPark(0);
        scheduler.deliverMutator = originalDeliver;
      }
    }, { newSeg: NEW_SEG, board: smallBoard() });

    expect(issued.inWindow, "the busy window was observed").toBe(true);
    expect(issued.settled, "the open settled").toBe(true);
    expect(issued.appliesSettled, "both apply tickets reached their native tails").toBe(true);
    expect(
      issued.delivery,
      "the raw Embind return is captured before retained-owner completion",
    ).toEqual({ returned: true, resultReady: true, nativeComplete: false });

    // Both queued applies were delivered, in order — A's segment exists and
    // sits where B moved it. (Drop-A-deliver-B leaves B targetless; drop-both
    // leaves GetPos empty — either failure mode misses B_TARGET.)
    await expect
      .poll(
        () =>
          page.evaluate((id) => (window.Module as unknown as Mod).kicadCollabGetPos(id), NEW_SEG),
        { timeout: 10000, intervals: [200] },
      )
      .toBe(B_TARGET);
  });
});

test.describe("runOnFiber retained-owner tail", () => {
  test("a parked first body keeps its ticket and FIFO slot through affiliated cleanup", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    void testLogger;
    await bootHarness(page);

    await page.waitForFunction(
      () =>
        typeof (window.Module as unknown as Partial<Mod>).kicadCollabTestRunOnFiberPark ===
          "function",
      null,
      { timeout: 90000 },
    );

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const m = window.Module as unknown as Mod;
            return JSON.parse(m.kicadTestRunOnFiberParkState()).busy as boolean;
          }),
        { timeout: 10000, intervals: [50] },
      )
      .toBe(false);

    const result = await page.evaluate(async () => {
      const m = window.Module as unknown as Mod;
      const scheduler = (globalThis as unknown as {
        __wxScheduler: {
          deliverMutator(id: number): number;
          mutatorJobs: Map<
            number,
            { name: string; resultReady: boolean; nativeComplete: boolean }
          >;
        };
      }).__wxScheduler;
      const originalDeliver = scheduler.deliverMutator;
      let delivery: DeliveryObservation | null = null;
      let settled = false;

      scheduler.deliverMutator = function (id: number): number {
        const accepted = originalDeliver.call(scheduler, id);
        const job = scheduler.mutatorJobs.get(id);
        if (!delivery && job?.name === "kicadCollabTestRunOnFiberPark") {
          delivery = {
            returned: true,
            resultReady: job.resultReady,
            nativeComplete: job.nativeComplete,
          };
        }
        return accepted;
      };

      try {
        const ticket = m.kicadCollabTestRunOnFiberPark(1000).then((accepted) => {
          settled = true;
          return accepted;
        });

        let during = JSON.parse(m.kicadTestRunOnFiberParkState()) as RunOnFiberParkState;
        const deadline = performance.now() + 10000;
        while (during.stage === 0 && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          during = JSON.parse(m.kicadTestRunOnFiberParkState()) as RunOnFiberParkState;
        }

        const duringSettled = settled;
        const accepted = await ticket;
        const final = JSON.parse(m.kicadTestRunOnFiberParkState()) as RunOnFiberParkState;
        return { accepted, delivery, during, duringSettled, final };
      } finally {
        scheduler.deliverMutator = originalDeliver;
      }
    });

    expect(result.delivery, "raw Embind return precedes retained-owner completion").toEqual({
      returned: true,
      resultReady: true,
      nativeComplete: false,
    });
    expect(result.duringSettled, "the command ticket stays pending during the park").toBe(false);
    expect(result.during).toMatchObject({
      stage: 1,
      firstRuns: 1,
      secondRuns: 0,
      violations: 0,
      busy: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.final).toMatchObject({
      stage: 3,
      firstRuns: 1,
      secondRuns: 1,
      violations: 0,
      busy: false,
    });
  });

  test("a modal child lane runs while its parent fiber lane is parked", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    void testLogger;
    await bootHarness(page);

    await page.waitForFunction(
      () => {
        const m = window.Module as unknown as Partial<Mod>;
        return (
          typeof m.kicadCollabTestRunOnFiberModal === "function" &&
          typeof m.kicadTestRunOnFiberModalState === "function"
        );
      },
      null,
      { timeout: 90000 },
    );

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const m = window.Module as unknown as Mod;
            return JSON.parse(m.kicadTestRunOnFiberModalState()).busy as boolean;
          }),
        { timeout: 10000, intervals: [50] },
      )
      .toBe(false);

    await page.evaluate(() => {
      const m = window.Module as unknown as Mod;
      const result = {
        settled: false,
        accepted: false,
        error: "",
      };
      (globalThis as unknown as { __runOnFiberModalResult?: typeof result })
        .__runOnFiberModalResult = result;

      void m.kicadCollabTestRunOnFiberModal().then(
        (accepted) => {
          result.accepted = accepted;
          result.settled = true;
        },
        (error) => {
          result.error = String(error);
          result.settled = true;
        },
      );
    });

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const m = window.Module as unknown as Mod;
            return JSON.parse(m.kicadTestRunOnFiberModalState()) as RunOnFiberModalState;
          }),
        { timeout: 30000, intervals: [50] },
      )
      .toMatchObject({
        stage: 1,
        parentRuns: 1,
        childHandlers: 0,
        childRuns: 0,
        parentReturns: 0,
        violations: 0,
        jobs: 1,
        lanes: 1,
        busy: true,
      });

    const button = await page.evaluate(() => {
      const element = window.wxElementRegistry
        ?.findAll({ visible: true, enabled: true })
        .find(
          (candidate) =>
            candidate.label === "Run child fiber" &&
            candidate.typeName.includes("Button"),
        );

      return element
        ? {
            x: element.centerX,
            y: element.centerY,
            domId: element.domId && element.domId > 0 ? element.domId : 0,
          }
        : null;
    });
    expect(button, "the reducer's real modal button must be visible").not.toBeNull();

    if (button!.domId > 0) {
      await page.locator(`[data-wx-dom-id="${button!.domId}"]`).click();
    } else {
      await page.mouse.click(button!.x, button!.y);
    }

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const m = window.Module as unknown as Mod;
            return JSON.parse(m.kicadTestRunOnFiberModalState()) as RunOnFiberModalState;
          }),
        { timeout: 30000, intervals: [50] },
      )
      .toMatchObject({
        stage: 4,
        parentRuns: 1,
        childHandlers: 1,
        childRuns: 1,
        jobsAtChild: 2,
        lanesAtChild: 2,
        parentReturns: 1,
        violations: 0,
        jobs: 0,
        lanes: 0,
        busy: false,
      });

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as {
                __runOnFiberModalResult?: {
                  settled: boolean;
                  accepted: boolean;
                  error: string;
                };
              }).__runOnFiberModalResult,
          ),
        { timeout: 10000, intervals: [50] },
      )
      .toEqual({ settled: true, accepted: true, error: "" });
  });
});
