import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * eeschema Yjs collaborative bridge (features/yjs-bridge commit 3).
 *
 * eeschema reuses the same wire contract + generic JS reconciler as pl_editor; the new
 * code is the C++ adapter — native SCHEMATIC_LISTENER emit + SCH_COMMIT apply, the latter
 * run inside a COROUTINE so SCH_ITEM::Move has the tool-coroutine context
 * it requires. Coverage:
 *   - snapshot (read): kicadCollabSnapshot reflects items by uuid/type/position.
 *   - apply (single page): kicadCollabApply moves/removes by uuid (deferred via CallAfter
 *     + coroutine, so poll for the result).
 *   - two-tab: a real local move propagates A→B over BroadcastChannel.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const WIRE2 = "22222222-0000-0000-0000-000000000002";
const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "${WIRE2}"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabSnapshot(): string;
  kicadCollabApply(j: string): unknown;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
  kicadCollabGetPos(id: string): string;
};

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootAndOpen(page: Page, name: string): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshot === "function" &&
        typeof m?.kicadCollabApply === "function" &&
        typeof m?.kicadCollabTestMoveFirst === "function"
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

  await page.evaluate(
    ({ content, name }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/${name}.kicad_sch`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_SCH, name },
  );

  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

test.describe("eeschema collab bridge — single page", () => {
  test("snapshot reflects schematic by uuid/type/position", async ({ page, testLogger }) => {
    await bootAndOpen(page, "snap");
    const snap = await page.evaluate(() => JSON.parse(window.Module.kicadCollabSnapshot()));
    const byId = new Map<string, { type: string; x: number; y: number }>(
      snap.added.map((i: { id: string; type: string; x: number; y: number }) => [i.id, i]),
    );
    expect(byId.has(WIRE1)).toBe(true);
    expect(byId.get(WIRE1)!.type).toBe("SCH_LINE");
    expect(byId.get(WIRE1)!.x).toBe(508000); // 50.8mm × 10000 IU
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // Apply mutates the model headless: kicadOpenFile returns false (the incomplete-project
  // load skips some late steps) but the schematic + screens ARE built, so SCH_COMMIT::Push
  // takes effect. (Earlier this was skipped on the belief Push no-ops headless; that predated
  // the dyncall-shim fix — apply now works here. Rendering still needs the real app.)
  const TEXT_ID = "33333333-0000-0000-0000-000000000001";
  const RECT_ID = "33333333-0000-0000-0000-000000000002";

  test("apply moves/removes/adds by uuid, no echo", async ({ page, testLogger }) => {
    await bootAndOpen(page, "apply");

    const before = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), WIRE1);
    const [bx, by] = before.split(",").map(Number);
    const nx = bx + 1_000_000;

    await page.evaluate(() => {
      (window as unknown as { __echo: string[] }).__echo = [];
      (window as unknown as { kicadCollab: { onDelta: (j: string) => void } }).kicadCollab = {
        onDelta: (j: string) => (window as unknown as { __echo: string[] }).__echo.push(j),
      };
    });

    // changed: move WIRE1. A wire reshapes via its endpoints (SetStart/EndPoint) — the same
    // sx/sy/ex/ey form the emit side always produces for a SCH_LINE (a bare x/y Move is a no-op
    // for a line, whose endpoints only move when flagged). Deferred via CallAfter → poll.
    await page.evaluate(
      ({ id, nx, by }) =>
        window.Module.kicadCollabApply(
          JSON.stringify({
            changed: [{ id, type: "SCH_LINE", sx: nx, sy: by, ex: nx + 508000, ey: by }],
            added: [],
            removed: [],
          }),
        ),
      { id: WIRE1, nx, by },
    );
    await expect
      .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), WIRE1), {
        timeout: 10000,
        intervals: [200],
      })
      .toBe(`${nx},${by}`);

    // removed: delete WIRE2.
    await page.evaluate(
      (wire) =>
        window.Module.kicadCollabApply(JSON.stringify({ changed: [], added: [], removed: [wire] })),
      WIRE2,
    );
    await expect
      .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), WIRE2), {
        timeout: 10000,
        intervals: [200],
      })
      .toBe("");

    // added: a graphic text reconstructs by uuid.
    await page.evaluate(
      (textId) =>
        window.Module.kicadCollabApply(
          JSON.stringify({
            changed: [],
            removed: [],
            added: [{ id: textId, type: "SCH_TEXT", x: 600000, y: 600000, text: "hello" }],
          }),
        ),
      TEXT_ID,
    );
    await expect
      .poll(
        async () => (await page.evaluate(() => window.Module.kicadCollabSnapshot())).includes(TEXT_ID),
        { timeout: 10000, intervals: [250] },
      )
      .toBe(true);

    // added: a SCH_SHAPE (rectangle). Committing a newly-constructed shape used to trap in
    // SCH_COMMIT::Push's CHT_ADD (GAL view->Add of a new shape → an asyncify-era invoke_viii
    // mis-dispatch) when doApply ran off a bare stack; doApply now runs inside a COROUTINE, so
    // the add dispatches like a native draw. stype 1 = SHAPE_T::RECTANGLE, fill 1 = NO_FILL.
    await page.evaluate(
      (rectId) =>
        window.Module.kicadCollabApply(
          JSON.stringify({
            changed: [],
            removed: [],
            added: [
              {
                id: rectId,
                type: "SCH_SHAPE",
                stype: 1,
                sx: 700000,
                sy: 700000,
                ex: 900000,
                ey: 850000,
                width: 0,
                fill: 1,
              },
            ],
          }),
        ),
      RECT_ID,
    );
    await expect
      .poll(
        async () => (await page.evaluate(() => window.Module.kicadCollabSnapshot())).includes(RECT_ID),
        { timeout: 10000, intervals: [250] },
      )
      .toBe(true);

    const echoes = await page.evaluate(() => (window as unknown as { __echo: string[] }).__echo);
    expect(echoes, "apply() must not echo a local onDelta").toHaveLength(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

test.describe("eeschema collab bridge — two tabs (BroadcastChannel)", () => {
  // SKIP headless for the same reason as the single-page apply test (harness open=false →
  // SCH_COMMIT no-ops). Verified working in the real web app.
  // re-enabled 2026-08-13 on the JSPI build; chromium is solid, Firefox is
  // ~50% flaky even solo (the observer tab's move sometimes never lands
  // within 15s — same shape as the FF FootprintEnumerate slowness; suspected
  // slow-wasm-tier upstream #42199). Gated to chromium 2026-08-14; the
  // pcbnew-collab twin covers both engines.
  test("a local move propagates A→B", async ({ context, testLogger }) => {
    test.skip(
      test.info().project.name.includes("firefox"),
      "flaky on Firefox (~50% even solo): observer move misses the 15s window — chromium covers this; pcbnew twin runs both engines",
    );
    const channel = `ee-collab-e2e-${test.info().workerIndex}`;
    const bundle = path.resolve(__dirname, "../apps/kicad/collab-bundle.js");

    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await bootAndOpen(tabA, "tabA");
    await bootAndOpen(tabB, "tabB");
    for (const p of [tabA, tabB]) await p.addScriptTag({ path: bundle });

    const startCollab = (p: Page) =>
      p.evaluate(async (ch) => {
        const w = window as unknown as {
          KicadCollab: { start: (m: unknown, win: unknown, o: unknown) => Promise<unknown> };
          Module: unknown;
        };
        await w.KicadCollab.start(w.Module, window, { provider: { kind: "broadcastchannel", settleMs: 500 }, room: ch });
      }, channel);
    await startCollab(tabA);
    await startCollab(tabB);

    // Read the pre-move baseline BEFORE triggering the move: TestMoveFirst
    // queues the commit through CallAfter + the apply coroutine, and the drain
    // can land between two consecutive page.evaluate round-trips. A GetPos
    // taken after the call raced that drain (~50% under CI load) and captured
    // the ALREADY-MOVED position, so the not-toBe poll waited on itself.
    const preSnap = await tabA.evaluate(() => JSON.parse(window.Module.kicadCollabSnapshot()));
    const prePos = new Map<string, string>(
      preSnap.added.map((i: { id: string; x: number; y: number }) => [i.id, `${i.x},${i.y}`]),
    );
    const uuid = await tabA.evaluate(() => window.Module.kicadCollabTestMoveFirst(2_000_000, 0));
    expect(uuid).toMatch(/[0-9a-f-]{36}/);
    const orig = prePos.get(uuid);
    expect(orig, "moved item present in pre-move snapshot").toBeTruthy();

    // Wait until tab A's item actually moved (guards against a no-op false pass).
    await expect
      .poll(() => tabA.evaluate((id) => window.Module.kicadCollabGetPos(id), uuid), {
        timeout: 15000,
        intervals: [300],
      })
      .not.toBe(orig);
    const posA = await tabA.evaluate((id) => window.Module.kicadCollabGetPos(id), uuid);

    await expect
      .poll(() => tabB.evaluate((id) => window.Module.kicadCollabGetPos(id), uuid), {
        timeout: 15000,
        intervals: [300],
      })
      .toBe(posA);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});
