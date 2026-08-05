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
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadTestSetOpenPark(ms: number): void;
  kicadCollabApplyItems(j: string): unknown;
  kicadCollabGetPos(id: string): string;
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

    // The delivery contract under test is the scheduler build's embind lane;
    // on legacy glue the open gate drops both applies by design.
    const lane = await page.evaluate(() => {
      const s = (globalThis as unknown as { __wxScheduler?: { mutatorsWrapped: number } })
        .__wxScheduler;
      return s ? s.mutatorsWrapped : 0;
    });
    test.skip(lane === 0, "legacy glue — embind lane absent (drop contract in collab-load-fuzz)");

    const issued = await page.evaluate(async ({ newSeg, board }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const path = `${dir}/n2.kicad_pcb`;
      w.FS.writeFile(path, board);
      // Deterministic park window on entry AND post-load (open_gate.h test lever)
      w.Module.kicadTestSetOpenPark(1500);
      w.Module.kicadOpenFile(path);

      // Wait until the busy window is observably open, then issue A and B once.
      const t0 = performance.now();
      while (!w.Module.kicadOpenFileBusy() && performance.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!w.Module.kicadOpenFileBusy()) return { inWindow: false };

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
      w.Module.kicadCollabApplyItems(applyA);
      w.Module.kicadCollabApplyItems(applyB);

      // Wait for the open chain to settle.
      const t1 = performance.now();
      while (w.Module.kicadOpenFileBusy() && performance.now() - t1 < 120000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      w.Module.kicadTestSetOpenPark(0);
      return { inWindow: true, settled: !w.Module.kicadOpenFileBusy() };
    }, { newSeg: NEW_SEG, board: smallBoard() });

    expect(issued.inWindow, "the busy window was observed").toBe(true);
    expect(issued.settled, "the open settled").toBe(true);

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
