import { execSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  TRIO_PL,
  TRIO_PCB,
  TRIO_SCH,
  type ToolCfg,
  SYM1,
  WIRE1,
  WIRE2,
  FP1,
  PAD1,
  VIA1,
  SEG1,
  SEG2,
  callHook,
  closeTrio,
  drift,
  getPos,
  hasAbort,
  modelText,
  openTrio,
  oracleSweep,
  settleConverged,
  undoDepth,
} from "./utils/trio";

/**
 * Drift trio harness — S1 baseline (standalone-hardening 0008, phase A).
 *
 * Three tabs as three users in one room: A seeds + edits, B edits, C only
 * observes. After every action group the full oracle sweep runs: per-tab drift
 * silence (editor ≡ Y.Doc, production comparator), byte-identical silent saves
 * across all three, and identical room materialization. C is the pure
 * remote-apply oracle — everything it holds arrived over the wire.
 *
 * S1 drives only the EXISTING embind test hooks (move/rotate/set-field/
 * set-pad-size/remove); the action-catalog hooks land in phase B.
 *
 * Repro convention (ysync-review): known-open gaps assert the CORRECT behavior
 * and are marked test.fail() naming the tracking doc — fixing the bug flips
 * them to "unexpected pass", forcing the marker's removal.
 */

test.beforeAll(() => {
  // Rebuild the v2 bundle so the harness always exercises the current stack.
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

/** Heavy editors exceed Firefox's per-content-process wasm budget at 2+
 *  instances (see ysync-two-tab.spec.ts) — at 3 it is strictly worse. */
function skipFirefox(): void {
  // 2026-08-13: guard retired — the JSPI build (~half the asyncify size) fits
  // three editor tabs inside Firefox 153's per-process wasm budget; the
  // whole file passes on kicad-firefox. Kept as a hook in case the wall
  // returns with future growth.
}

// ── pl_editor: green baseline validating the trio plumbing itself ────────────

test.describe("drift trio — pl_editor (plumbing baseline)", () => {
  test.describe.configure({ timeout: 420000 });

  test("A and B add text, C observes: all three drift-silent and converged", async ({
    context,
    testLogger,
  }) => {
    const room = `drift-trio-pl-${test.info().workerIndex}`;
    const trio = await openTrio(context, TRIO_PL, room);

    const uuidA = await callHook<string>(trio.A, "kicadCollabTestAddText", "From A", 40, 40);
    expect(uuidA).toMatch(/[0-9a-f-]{36}/);
    await expect
      .poll(async () => await modelText(trio.C, TRIO_PL), { timeout: 20000, intervals: [300] })
      .toContain("From A");
    await settleConverged(trio, TRIO_PL);
    await oracleSweep(trio, TRIO_PL);

    const uuidB = await callHook<string>(trio.B, "kicadCollabTestAddText", "From B", 60, 60);
    expect(uuidB).toMatch(/[0-9a-f-]{36}/);
    await expect
      .poll(async () => await modelText(trio.A, TRIO_PL), { timeout: 20000, intervals: [300] })
      .toContain("From B");
    await settleConverged(trio, TRIO_PL);
    await oracleSweep(trio, TRIO_PL);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await closeTrio(trio);
  });
});

// ── The heavy editors: eeschema + pcbnew S1 ──────────────────────────────────

interface S1Actions {
  /** [hookName, ...args] for B's rotate target and A's property edit. */
  rotateTarget: string;
  propertyEdit: { fn: string; args: (string | number)[]; expectInSave: string };
  removeTarget: string;
  moveDx: number;
}

const S1: ReadonlyArray<readonly [ToolCfg, string, S1Actions]> = [
  [
    TRIO_SCH,
    "eeschema",
    {
      rotateTarget: SYM1,
      // Assign-footprint-shaped edit: symbol field text (Value).
      propertyEdit: {
        fn: "kicadCollabTestSetFieldText",
        args: [SYM1, "trio-10k"],
        expectInSave: '"trio-10k"',
      },
      removeTarget: WIRE2,
      moveDx: 40000, // eeschema IU = 1e4/mm → 4mm
    },
  ],
  [
    TRIO_PCB,
    "pcbnew",
    {
      rotateTarget: FP1,
      propertyEdit: {
        fn: "kicadCollabTestSetPadSize",
        args: [PAD1, 1500000, 1000000], // pcbnew IU = 1e6/mm → 1.5 × 1 mm
        expectInSave: "(size 1.5 1)",
      },
      removeTarget: VIA1,
      moveDx: 2000000, // 2mm
    },
  ],
];

for (const [cfg, label, act] of S1) {
  test.describe(`drift trio — ${label} S1 baseline`, () => {
    test.describe.configure({ timeout: 900000 });

    test(`${label}: A+B interleave move/rotate/property/delete, C observes`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const room = `drift-trio-${label}-${test.info().workerIndex}`;
      const trio = await openTrio(context, cfg, room);

      // 1. A moves the first item (the seeder's emit half — bug 01 regression
      //    surface: seed()'s snapshotItems registered A's listener). The hooks
      //    run on a coroutine, so first poll A's OWN pos until the move landed
      //    (two-tab's green precondition), then compare the peers against it.
      const uuids = [...cfg.fixture.matchAll(/\(uuid "([0-9a-f-]{36})"\)/g)].map((m) => m[1]!);
      const before: Record<string, string> = {};
      for (const u of uuids) before[u] = await getPos(trio.A, u);
      const movedId = await callHook<string>(trio.A, "kicadCollabTestMoveFirst", act.moveDx, 0);
      expect(movedId).toMatch(/[0-9a-f-]{36}/);
      await expect
        .poll(() => getPos(trio.A, movedId), { timeout: 15000, intervals: [300] })
        .not.toBe(before[movedId]);
      const posA = await getPos(trio.A, movedId);
      for (const peer of [trio.B, trio.C]) {
        await expect
          .poll(() => getPos(peer, movedId), { timeout: 20000, intervals: [300] })
          .toBe(posA);
      }
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      // 2. B rotates the symbol/footprint (joiner's emit half).
      expect(await callHook<boolean>(trio.B, "kicadCollabTestRotateItem", act.rotateTarget, 90)).toBe(
        true,
      );
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      // 3. A edits a property (field text / pad size — the "assign footprint,
      //    change value" family).
      expect(
        await callHook<boolean>(trio.A, act.propertyEdit.fn, ...act.propertyEdit.args),
      ).toBe(true);
      for (const peer of [trio.B, trio.C]) {
        await expect
          .poll(async () => await modelText(peer, cfg), { timeout: 20000, intervals: [300] })
          .toContain(act.propertyEdit.expectInSave);
      }
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      // 4. B deletes a top-level item.
      expect(await callHook<boolean>(trio.B, "kicadCollabTestRemoveItem", act.removeTarget)).toBe(
        true,
      );
      for (const peer of [trio.A, trio.C]) {
        await expect
          .poll(async () => await modelText(peer, cfg), { timeout: 20000, intervals: [300] })
          .not.toContain(act.removeTarget);
      }
      await settleConverged(trio, cfg);
      await oracleSweep(trio, cfg);

      // 5. Undo isolation: remote applies ride SKIP_UNDO — the observer's undo
      //    stack must still be empty; the editors accumulated only their own ops.
      expect(await undoDepth(trio.C), "observer undo stack").toBe(0);
      expect(await undoDepth(trio.A), "A undo stack").toBeGreaterThan(0);
      expect(await undoDepth(trio.B), "B undo stack").toBeGreaterThan(0);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });
  });
}

// ── pcbnew segment CHANGE apply (the envelope-parse path) ────────────────────
// A changed track rides wrapInBoardEnvelope → the `(kicad_pcb …)` envelope
// parse on the receiver. ysync 0008 "known limit 1" recorded that path as
// dying silently in the commit — this trio run shows the CHANGE path works
// under the current build (the still-fixme'd roundtrip full-board case is the
// bulk-ADD rebuild, a different path). Kept green as the regression guard.

test.describe("drift trio — pcbnew segment edit (envelope-parse change path)", () => {
  test.describe.configure({ timeout: 900000 });

  test("a segment endpoint edit reaches the peers' editors", async ({
    context,
    testLogger,
  }) => {
    skipFirefox();

    const room = `drift-trio-pcbseg-${test.info().workerIndex}`;
    const trio = await openTrio(context, TRIO_PCB, room);

    expect(await callHook<boolean>(trio.A, "kicadCollabTestMoveEndpoint", SEG1, 2000000, 0)).toBe(
      true,
    );

    // B applies the changed segment blob (envelope parse) and stays
    // drift-silent; all three converge on the moved endpoint.
    await expect
      .poll(async () => (await drift(trio.B, TRIO_PCB))?.updated ?? [], {
        timeout: 20000,
        intervals: [400],
      })
      .toEqual([]);
    await settleConverged(trio, TRIO_PCB);
    await oracleSweep(trio, TRIO_PCB);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await closeTrio(trio);
  });
});

// ── S1 catalog: every phase-B action primitive, A/B alternating, sweep each ──
// One trio session per tool; each step runs on its actor, converges, and the
// full oracle sweep must stay silent. A step that returns a uuid parks it in
// `ctx` for later steps ("A adds a symbol → B moves THAT symbol").

type CatalogStep = {
  name: string;
  actor: "A" | "B";
  run(page: import("@playwright/test").Page, ctx: Record<string, string>): Promise<void>;
};

async function hookUuid(
  page: import("@playwright/test").Page,
  ctx: Record<string, string>,
  key: string,
  fn: string,
  ...args: (string | number)[]
): Promise<void> {
  const uuid = await callHook<string>(page, fn, ...args);
  expect(uuid, `${fn} must return a uuid`).toMatch(/[0-9a-f-]{36}/);
  ctx[key] = uuid;
}

async function hookOk(
  page: import("@playwright/test").Page,
  fn: string,
  ...args: (string | number | boolean)[]
): Promise<void> {
  expect(await callHook<boolean>(page, fn, ...(args as (string | number)[])), `${fn} must hit`).toBe(
    true,
  );
}

// eeschema IU = 1e4/mm; pcbnew IU = 1e6/mm.
const SCH_CATALOG: CatalogStep[] = [
  { name: "A adds a wire", actor: "A", run: (p, c) => hookUuid(p, c, "wire", "kicadCollabTestAddWire", 600000, 600000, 700000, 600000) },
  // A junction dropped mid-wire with no branch is REDUNDANT — eeschema's
  // connectivity cleanup deletes it in the same commit (net-zero, the landed
  // gate would time out). A branch wire off A's wire is the realistic edit;
  // the cleanup auto-inserts the junction at the T, which then syncs.
  { name: "B branches a wire off A's wire", actor: "B", run: (p, c) => hookUuid(p, c, "branch", "kicadCollabTestAddWire", 650000, 600000, 650000, 650000) },
  { name: "A adds a local label", actor: "A", run: (p, c) => hookUuid(p, c, "label", "kicadCollabTestAddLabel", "label", "NET_A", 620000, 600000) },
  { name: "B adds a global label", actor: "B", run: (p, c) => hookUuid(p, c, "glabel", "kicadCollabTestAddLabel", "global", "VCC", 700000, 600000) },
  { name: "A adds a hier label", actor: "A", run: (p, c) => hookUuid(p, c, "hlabel", "kicadCollabTestAddLabel", "hier", "H1", 640000, 600000) },
  { name: "B adds a no-connect", actor: "B", run: (p, c) => hookUuid(p, c, "nc", "kicadCollabTestAddNoConnect", 710000, 600000) },
  { name: "A places a symbol from the doc lib", actor: "A", run: (p, c) => hookUuid(p, c, "sym2", "kicadCollabTestAddSymbol", "Device:R", 800000, 800000, "R2") },
  { name: "B moves that symbol", actor: "B", run: (p, c) => hookOk(p, "kicadCollabTestMoveSchItem", c.sym2!, 40000, 0) },
  { name: "A mirrors it", actor: "A", run: (p, c) => hookOk(p, "kicadCollabTestMirrorSchItem", c.sym2!, true) },
  { name: "B duplicates it", actor: "B", run: (p, c) => hookUuid(p, c, "sym3", "kicadCollabTestDuplicateSchItem", c.sym2!, 100000, 0) },
  { name: "A renames the duplicate's value", actor: "A", run: (p, c) => hookOk(p, "kicadCollabTestSetFieldText", c.sym3!, "dup-R") },
  { name: "B deletes the fixture wire", actor: "B", run: (p) => hookOk(p, "kicadCollabTestRemoveItem", WIRE1) },
];

const PCB_CATALOG: CatalogStep[] = [
  { name: "A adds a track", actor: "A", run: (p, c) => hookUuid(p, c, "track", "kicadCollabTestAddTrack", 50000000, 90000000, 60000000, 90000000, 300000, "F.Cu") },
  { name: "B adds a via", actor: "B", run: (p, c) => hookUuid(p, c, "via2", "kicadCollabTestAddVia", 55000000, 90000000, 800000, 400000) },
  { name: "A adds board text", actor: "A", run: (p, c) => hookUuid(p, c, "text", "kicadCollabTestAddBoardText", "T1", 70000000, 90000000, "F.SilkS") },
  { name: "B adds a zone", actor: "B", run: (p, c) => hookUuid(p, c, "zone", "kicadCollabTestAddZone", 30000000, 30000000, 40000000, 40000000, "F.Cu") },
  { name: "A flips the footprint", actor: "A", run: (p) => hookOk(p, "kicadCollabTestFlipBoardItem", FP1) },
  { name: "B edits the footprint value", actor: "B", run: (p) => hookOk(p, "kicadCollabTestSetFootprintField", FP1, "Value", "R-edited") },
  { name: "A locks a segment", actor: "A", run: (p) => hookOk(p, "kicadCollabTestSetBoardItemLocked", SEG2, true) },
  { name: "B moves the fixture via", actor: "B", run: (p) => hookOk(p, "kicadCollabTestMoveBoardItem", VIA1, 2000000, 0) },
  { name: "A duplicates the footprint", actor: "A", run: (p, c) => hookUuid(p, c, "fp2", "kicadCollabTestDuplicateBoardItem", FP1, 10000000, 0) },
  { name: "B deletes a fixture segment", actor: "B", run: (p) => hookOk(p, "kicadCollabTestRemoveItem", SEG1) },
];

for (const [cfg, label, catalog] of [
  [TRIO_SCH, "eeschema", SCH_CATALOG],
  [TRIO_PCB, "pcbnew", PCB_CATALOG],
] as const) {
  test.describe(`drift trio — ${label} S1 action catalog`, () => {
    test.describe.configure({ timeout: 900000 });

    test(`${label}: full catalog, A/B alternating, sweep after every step`, async ({
      context,
      testLogger,
    }) => {
      skipFirefox();
      const room = `drift-trio-cat-${label}-${test.info().workerIndex}`;
      const trio = await openTrio(context, cfg, room);
      const ctx: Record<string, string> = {};

      for (const step of catalog) {
        await test.step(step.name, async () => {
          const actor = step.actor === "A" ? trio.A : trio.B;
          // The hooks commit on a coroutine: settleConverged alone can pass on the
          // PRE-action state (all tabs still equal) and the sweep then reads
          // legitimate mid-propagation state as drift. Gate on the actor's own
          // save changing first, so convergence is convergence ON the edit.
          const before = await modelText(actor, cfg);
          await step.run(actor, ctx);
          await expect
            .poll(() => modelText(actor, cfg), { timeout: 15000, intervals: [300] })
            .not.toBe(before);
          await settleConverged(trio, cfg);
          await oracleSweep(trio, cfg);
        });
      }

      expect(await undoDepth(trio.C), "observer undo stack").toBe(0);
      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await closeTrio(trio);
    });
  });
}
