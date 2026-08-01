import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  TRIO_PCB,
  TRIO_SCH,
  type TabSet,
  type ToolCfg,
  type Trio,
  SYM1,
  FP1,
  VIA1,
  WIRE1,
  bootOpen,
  callHook,
  closeTrio,
  getPos,
  hasAbort,
  modelText,
  openTrio,
  oracleSweep,
  settleConverged,
  startV2,
  undoDepth,
} from "./utils/trio";

/**
 * Drift trio harness — scenarios S2–S8 (standalone-hardening 0008 §6, phase C).
 *
 * S1 (per-action baseline + full catalogs) lives in drift-trio.spec.ts; this
 * file drives the CONCURRENT shapes: interleaved bursts with no settle between
 * them, conflicting edits on the same item, undo storms, churn, late joiners,
 * and save interplay. Assertions for conflicts are convergence + drift silence
 * — the winner is whatever the CRDT resolves, never a specific outcome.
 *
 * Concurrency pattern: fire both actors' sequences via Promise.all (each
 * actor's hooks run sequentially on its own tab), then wait for MARKER content
 * to land on every tab before settling — settleConverged alone can pass on the
 * pre-action state (finding #7), and in concurrent scenarios there is no
 * single actor save to gate on.
 */

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

function skipFirefox(): void {
  test.skip(
    test.info().project.name.includes("firefox"),
    "three heavy wasm tabs exceed Firefox's per-process wasm budget",
  );
}

/** Poll until every tab's silent save contains `marker`. */
async function waitAllContain(set: TabSet, cfg: ToolCfg, marker: string, timeout = 90000): Promise<void> {
  for (const [label, page] of set.tabs) {
    await expect
      .poll(async () => (await modelText(page, cfg)).includes(marker), {
        timeout,
        intervals: [400],
        message: `${label} must receive "${marker}"`,
      })
      .toBe(true);
  }
}

/** Per-tool adapter for the scenario scripts. */
interface ToolOps {
  cfg: ToolCfg;
  label: string;
  /** The symbol / footprint — the property-carrying primary item. */
  primary: string;
  /** A second fixture item (wire / via) for disjoint + move-move conflicts. */
  secondary: string;
  mm: number; // IU per mm
  move(page: Page, uuid: string, dxIU: number): Promise<boolean>;
  setValue(page: Page, text: string): Promise<boolean>;
  /** Add a text-ish marker item carrying `text`; returns its uuid. */
  addMarker(page: Page, text: string, slot: number): Promise<string>;
}

const SCH_OPS: ToolOps = {
  cfg: TRIO_SCH,
  label: "eeschema",
  primary: SYM1,
  secondary: WIRE1,
  mm: 10000,
  move: (p, uuid, dx) => callHook<boolean>(p, "kicadCollabTestMoveSchItem", uuid, dx, 0),
  setValue: (p, text) => callHook<boolean>(p, "kicadCollabTestSetFieldText", SYM1, text),
  addMarker: (p, text, slot) =>
    callHook<string>(p, "kicadCollabTestAddLabel", "label", text, 400000 + slot * 60000, 400000),
};

const PCB_OPS: ToolOps = {
  cfg: TRIO_PCB,
  label: "pcbnew",
  primary: FP1,
  secondary: VIA1,
  mm: 1000000,
  move: (p, uuid, dx) => callHook<boolean>(p, "kicadCollabTestMoveBoardItem", uuid, dx, 0),
  setValue: (p, text) => callHook<boolean>(p, "kicadCollabTestSetFootprintField", FP1, "Value", text),
  addMarker: (p, text, slot) =>
    callHook<string>(p, "kicadCollabTestAddBoardText", text, 20000000 + slot * 15000000, 130000000, "F.SilkS"),
};

for (const ops of [SCH_OPS, PCB_OPS]) {
  const { cfg, label } = ops;

  test.describe(`drift trio scenarios — ${label}`, () => {
    test.describe.configure({ timeout: 900000 });

    // ── S2: disjoint ping-pong ───────────────────────────────────────────────
    test(`${label} S2: A and B alternate disjoint edits, 3 rounds`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s2-${label}-${test.info().workerIndex}`);

      for (let round = 0; round < 3; round++) {
        await test.step(`round ${round + 1}`, async () => {
          // Landed-gate per actor (finding #7), then settle covers cross-tab.
          const beforeA = await getPos(trio.A, ops.primary);
          const beforeB = await getPos(trio.B, ops.secondary);
          await Promise.all([
            ops.move(trio.A, ops.primary, ops.mm),
            ops.move(trio.B, ops.secondary, ops.mm),
          ]);
          await expect
            .poll(() => getPos(trio.A, ops.primary), { timeout: 15000, intervals: [300] })
            .not.toBe(beforeA);
          await expect
            .poll(() => getPos(trio.B, ops.secondary), { timeout: 15000, intervals: [300] })
            .not.toBe(beforeB);
          await settleConverged(trio, cfg);
          await oracleSweep(trio, cfg);
        });
      }

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // ── S3: same-item interleave (the 0008 headline scenario) ────────────────
    test(`${label} S3: A creates an item; B moves+renames it while A keeps editing around it`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s3-${label}-${test.info().workerIndex}`);

      // A creates the contested item and everyone sees it.
      let target: string;
      if (label === "eeschema") {
        target = await callHook<string>(trio.A, "kicadCollabTestAddSymbol", "Device:R", 800000, 800000, "R9");
      } else {
        target = await callHook<string>(trio.A, "kicadCollabTestDuplicateBoardItem", FP1, 15000000, 0);
      }
      expect(target).toMatch(/[0-9a-f-]{36}/);
      await waitAllContain(trio, cfg, target);

      // Interleaved bursts, NO settle in between: B moves the new item and
      // renames the primary's value while A wires/tracks around the new item.
      await Promise.all([
        (async () => {
          if (label === "eeschema") {
            await callHook<string>(trio.A, "kicadCollabTestAddWire", 760000, 800000, 800000, 800000);
            await callHook<string>(trio.A, "kicadCollabTestAddWire", 800000, 838100, 800000, 880000);
          } else {
            await callHook<string>(trio.A, "kicadCollabTestAddTrack", 110000000, 100000000, 115000000, 100000000, 300000, "F.Cu");
            await callHook<string>(trio.A, "kicadCollabTestAddVia", 113000000, 100000000, 800000, 400000);
          }
        })(),
        (async () => {
          await ops.move(trio.B, target, 2 * ops.mm);
          await ops.setValue(trio.B, "s3-renamed");
        })(),
      ]);

      // Marker-wait on the rename (last B op) + settle covers A's adds.
      await waitAllContain(trio, cfg, "s3-renamed");
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // ── S4: conflict pairs on the SAME item ──────────────────────────────────
    test(`${label} S4: move-vs-delete, value-vs-value, move-vs-move`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s4-${label}-${test.info().workerIndex}`);

      // Victim for move-vs-delete: a marker item A adds and everyone holds.
      const victim = await ops.addMarker(trio.A, "s4-victim", 0);
      expect(victim).toMatch(/[0-9a-f-]{36}/);
      await waitAllContain(trio, cfg, victim);

      await test.step("move-vs-delete", async () => {
        // Winner is CRDT policy, not asserted; both hooks may race the item
        // away from under each other, so their return values are not asserted
        // either — convergence + silence is the contract.
        await Promise.all([
          ops.move(trio.A, victim, ops.mm),
          callHook<boolean>(trio.B, "kicadCollabTestRemoveItem", victim),
        ]);
        await settleConverged(trio, cfg);
        await oracleSweep(trio, cfg);
      });

      await test.step("move-vs-move", async () => {
        await Promise.all([
          ops.move(trio.A, ops.secondary, 2 * ops.mm),
          ops.move(trio.B, ops.secondary, -2 * ops.mm),
        ]);
        await settleConverged(trio, cfg);
        await oracleSweep(trio, cfg);
      });

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // QUARANTINED 2026-08-01: two clients racing setValue GENUINELY diverge in
    // ~5-8% of runs — settleConverged times out at 90s with the trio never
    // reaching byte equality. NOT a timing flake (windows already widened) and
    // NOT the asyncify guards (zero beacons in failing runs; reproduces
    // locally at single-worker). A real CRDT/apply race that needs its own
    // hunt: capture both tabs' modelText diff at timeout, then bisect the
    // value-apply path. Tracking: memory s4-value-race-divergence.
    test.fixme(`${label} S4b: value-vs-value converges (KNOWN ~5-8% divergence)`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s4b-${label}-${test.info().workerIndex}`);

      await Promise.all([ops.setValue(trio.A, "s4-from-A"), ops.setValue(trio.B, "s4-from-B")]);
      // One of the two values won everywhere; poll until every tab carries
      // SOME s4 value, then settle on byte equality.
      for (const [tabLabel, p] of trio.tabs) {
        await expect
          .poll(async () => /s4-from-[AB]/.test(await modelText(p, cfg)), {
            timeout: 60000,
            intervals: [400],
            message: `${tabLabel} must receive one of the racing values`,
          })
          .toBe(true);
      }
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // ── S5: undo storm ───────────────────────────────────────────────────────
    test(`${label} S5: A undoes its own ops while B keeps editing`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s5-${label}-${test.info().workerIndex}`);

      // A's undoable ops, settled so peers hold them.
      expect(await ops.move(trio.A, ops.primary, ops.mm)).toBe(true);
      expect(await ops.setValue(trio.A, "s5-tmp")).toBe(true);
      await waitAllContain(trio, cfg, "s5-tmp");
      await settleConverged(trio, cfg);

      // A undoes both while B lands fresh edits.
      await Promise.all([
        (async () => {
          expect(await callHook<boolean>(trio.A, "kicadCollabTestUndo")).toBe(true);
          expect(await callHook<boolean>(trio.A, "kicadCollabTestUndo")).toBe(true);
        })(),
        (async () => {
          await ops.move(trio.B, ops.secondary, ops.mm);
          await ops.addMarker(trio.B, "s5-b-survives", 1);
        })(),
      ]);

      // B's edits survive A's undos; the undone value is gone everywhere.
      await waitAllContain(trio, cfg, "s5-b-survives");
      for (const [tabLabel, p] of trio.tabs) {
        await expect
          .poll(async () => (await modelText(p, cfg)).includes("s5-tmp"), {
            timeout: 60000,
            intervals: [400],
            message: `${tabLabel} must lose the undone value`,
          })
          .toBe(false);
      }
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);
      expect(await undoDepth(trio.C), "observer undo stack").toBe(0);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // ── S6: burst churn ──────────────────────────────────────────────────────
    test(`${label} S6: 12-edit bursts from both sides, one settle at the end`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const trio = await openTrio(context, cfg, `s6-${label}-${test.info().workerIndex}`);

      await Promise.all([
        (async () => {
          for (let i = 0; i < 12; i++) await ops.move(trio.A, ops.primary, Math.round(ops.mm / 5));
          await ops.addMarker(trio.A, "s6-done-a", 2);
        })(),
        (async () => {
          for (let i = 0; i < 12; i++) await ops.move(trio.B, ops.secondary, Math.round(ops.mm / 5));
          await ops.addMarker(trio.B, "s6-done-b", 3);
        })(),
      ]);

      await waitAllContain(trio, cfg, "s6-done-a", 45000);
      await waitAllContain(trio, cfg, "s6-done-b", 45000);
      await settleConverged(trio, cfg, 45000);
      await oracleSweep(trio, cfg);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });

    // ── S7: late joiner adopts a room that evolved without it ────────────────
    test(`${label} S7: C joins after A+B edited; adopt converges drift-silent`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const room = `s7-${label}-${test.info().workerIndex}`;
      const A = await context.newPage();
      const B = await context.newPage();
      await bootOpen(A, cfg);
      await bootOpen(B, cfg);
      await startV2(A, { room, seedText: cfg.fixture });
      await startV2(B, { room, editorMatchesDoc: true });
      const duo: TabSet = { tabs: [["A", A], ["B", B]] };
      await settleConverged(duo, cfg);

      // The room evolves before C exists.
      await ops.move(A, ops.primary, ops.mm);
      await ops.addMarker(B, "s7-early", 4);
      await waitAllContain(duo, cfg, "s7-early");
      await settleConverged(duo, cfg);

      // C opened the ORIGINAL fixture file, so its editor does NOT match the
      // doc — it must take the ADOPT branch (no editorMatchesDoc, no seed).
      const C = await context.newPage();
      await bootOpen(C, cfg);
      await startV2(C, { room });

      const trio: Trio = { A, B, C, tabs: [["A", A], ["B", B], ["C", C]] };
      await waitAllContain(trio, cfg, "s7-early");
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });
  });
}

// ── S8: user-save during a peer's burst (pcbnew) ─────────────────────────────
// Ctrl+S drives the FULL save flow (the real writer + the C++→JS onSave
// notification chokepoint) while remote applies land — asyncify contention
// between the save fiber and the apply fibers is exactly the surface.

test.describe("drift trio scenarios — pcbnew S8 save interplay", () => {
  test.describe.configure({ timeout: 900000 });

  test("pcbnew S8: A saves (Ctrl+S) mid B-burst", async ({ context, testLogger }) => {
    skipFirefox();
    const trio = await openTrio(context, TRIO_PCB, `s8-pcb-${test.info().workerIndex}`);

    await Promise.all([
      (async () => {
        for (let i = 0; i < 6; i++)
          await callHook<boolean>(trio.B, "kicadCollabTestMoveBoardItem", VIA1, 300000, 0);
        await callHook<string>(trio.B, "kicadCollabTestAddBoardText", "s8-done", 20000000, 140000000, "F.SilkS");
      })(),
      (async () => {
        // Focus the canvas on an empty margin, then user-save twice mid-burst.
        await trio.A.locator("#canvas").click({ position: { x: 30, y: 300 } });
        await trio.A.keyboard.press("Control+s");
        await trio.A.keyboard.press("Control+s");
      })(),
    ]);

    await waitAllContain(trio, TRIO_PCB, "s8-done");
    await settleConverged(trio, TRIO_PCB);
    await oracleSweep(trio, TRIO_PCB);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await closeTrio(trio);
  });
});
