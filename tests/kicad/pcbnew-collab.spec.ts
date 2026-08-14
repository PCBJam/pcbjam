import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * pcbnew Yjs collaborative bridge (features/yjs-bridge commit 4).
 *
 * pcbnew reuses the same wire contract + generic JS reconciler as pl_editor/eeschema; the new
 * code is the C++ adapter — a native BOARD_LISTENER trigger + post-settle snapshot-diff emit,
 * and a BOARD_COMMIT apply run inside a COROUTINE (so a freshly-built item's GAL view->Add has
 * the tool-coroutine context it needs, exactly as eeschema). Coverage:
 *   - snapshot (read): kicadCollabSnapshot reflects items by uuid/type/position.
 *   - apply (single page): kicadCollabApply moves/removes/adds tracks by uuid (deferred via
 *     CallAfter + coroutine, so poll for the result).
 *   - two-tab: a real local move propagates A→B over BroadcastChannel (skipped headless — the
 *     harness can't PAINT; verified in the real web app).
 *
 * pcbnew internal units are nanometres (1 mm = 1e6 IU), unlike eeschema (1e4 IU/mm).
 */

const SEG1 = "44444444-0000-0000-0000-000000000001";
const SEG2 = "44444444-0000-0000-0000-000000000002";
// A footprint and two of its TEXT children (a silkscreen Reference field + a user fp_text), each
// with a stable uuid so the test can move them independently of the footprint — the bug 1 case.
const FP1 = "66666666-0000-0000-0000-000000000001";
const FP1_REF = "66666666-0000-0000-0000-0000000000aa"; // Reference field (PCB_FIELD, F.SilkS)
const FP1_TXT = "66666666-0000-0000-0000-0000000000cc"; // user fp_text (PCB_TEXT, F.SilkS)
const VIA1 = "77777777-0000-0000-0000-000000000001"; // a through via (PCB_VIA)
const ZONE1 = "77777777-0000-0000-0000-000000000002"; // a copper zone (ZONE)
const TEXT1 = "77777777-0000-0000-0000-000000000003"; // a board graphic text (PCB_TEXT)
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general
\t\t(thickness 1.6)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -4.2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${FP1_REF}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(property "Value" "R"
\t\t\t(at 0 4.6 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000bb")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(fp_text user "HELLO"
\t\t\t(at 0 0 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${FP1_TXT}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t)
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(zone
\t\t(net 0)
\t\t(net_name "")
\t\t(layer "F.Cu")
\t\t(uuid "${ZONE1}")
\t\t(hatch edge 0.5)
\t\t(connect_pads (clearance 0))
\t\t(min_thickness 0.25)
\t\t(polygon (pts (xy 60 110) (xy 75 110) (xy 75 125) (xy 60 125)))
\t)
\t(gr_text "BOARDTEXT"
\t\t(at 90 95 0)
\t\t(layer "F.SilkS")
\t\t(uuid "${TEXT1}")
\t\t(effects (font (size 1 1) (thickness 0.15)) (justify left bottom))
\t)
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
\t(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG2}"))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabSnapshot(): string;
  kicadCollabApply(j: string): unknown;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
  kicadCollabGetPos(id: string): string;
  kicadCollabTestItemBlob(id: string): string;
};

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootAndOpen(page: Page, name: string): Promise<void> {
  // Use the seeded collab harness (pcbnew-collab.html), which skips the first-run setup
  // wizard via a kicad_common.json seed — exactly like eeschema.html. The plain pcbnew.html
  // deliberately keeps the wizard (pcbnew.spec.ts tests it), which would block boot here.
  await page.goto("/kicad/pcbnew-collab.html");
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
      const p = `${dir}/${name}.kicad_pcb`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_PCB, name },
  );

  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

test.describe("pcbnew collab bridge — single page", () => {
  test("snapshot reflects board by uuid/type/position", async ({ page, testLogger }) => {
    await bootAndOpen(page, "snap");
    const snap = await page.evaluate(() => JSON.parse(window.Module.kicadCollabSnapshot()));
    const byId = new Map<string, { type: string; x: number; y: number }>(
      snap.added.map((i: { id: string; type: string; x: number; y: number }) => [i.id, i]),
    );
    expect(byId.has(SEG1)).toBe(true);
    expect(byId.get(SEG1)!.type).toBe("PCB_TRACK");
    expect(byId.get(SEG1)!.x).toBe(50_800_000); // 50.8mm × 1e6 IU (nm)
    // The footprint AND its text children are emitted individually by uuid (bug 1 fix) — that's
    // what lets a silkscreen text move sync without the footprint moving.
    expect(byId.has(FP1), "footprint present").toBe(true);
    expect(byId.get(FP1)!.type).toBe("FOOTPRINT");
    expect(byId.has(FP1_REF), "footprint Reference field present").toBe(true);
    expect(byId.get(FP1_REF)!.type).toBe("PCB_FIELD");
    expect(byId.has(FP1_TXT), "footprint user fp_text present").toBe(true);
    expect(byId.get(FP1_TXT)!.type).toBe("PCB_TEXT");
    // Via/zone carry the native geometry their `added` reconstruction needs (no blob path).
    expect(byId.has(VIA1), "via present").toBe(true);
    expect(byId.get(VIA1)!.type).toBe("PCB_VIA");
    expect((byId.get(VIA1) as { drill?: number }).drill, "via drill emitted").toBeGreaterThan(0);
    expect(byId.has(ZONE1), "zone present").toBe(true);
    expect(byId.get(ZONE1)!.type).toBe("ZONE");
    expect(
      (byId.get(ZONE1) as { poly?: number[][] }).poly?.length,
      "zone outline emitted",
    ).toBeGreaterThanOrEqual(3);
    expect(byId.has(TEXT1), "board text present").toBe(true);
    expect(byId.get(TEXT1)!.type).toBe("PCB_TEXT");
    expect((byId.get(TEXT1) as { text?: string }).text, "board text string emitted").toBe(
      "BOARDTEXT",
    );
    // The text is on F.SilkS (=5). Asserting the ACTUAL layer (not just "round-trips") catches the
    // GetLayer() emit bug, where every item reported layer 0 (F.Cu) and added items landed on the
    // wrong copper layer on the peer.
    expect((byId.get(TEXT1) as { layer?: number }).layer, "board text on F.SilkS (not stuck at 0)").toBe(5);
    expect((byId.get(SEG1) as { layer?: number }).layer, "segment on F.Cu").toBe(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // `added` reconstruction of a footprint, via and zone. The emit side attaches BOTH the full
  // itemToJson fields AND an s-expr clipboard blob; makeItem then reconstructs a footprint from
  // the bare `(footprint …)` blob, and a via/zone NATIVELY from the geometry fields (the
  // `(kicad_pcb …)` envelope parse was asyncify-fragile in wasm for those; healthy under JSPI —
  // roundtrip.spec.ts pins it — the native path stays as the lean route). Round-trip each: read
  // its full snapshot item + blob, delete it, re-add, confirm it returns at the same position.
  for (const [label, id, type] of [
    ["footprint", FP1, "FOOTPRINT"],
    ["via", VIA1, "PCB_VIA"],
    ["zone", ZONE1, "ZONE"],
    ["board text", TEXT1, "PCB_TEXT"],
  ] as const) {
    test(`apply adds a ${label} (footprint via blob, via/zone/text native)`, async ({ page, testLogger }) => {
      await bootAndOpen(page, `add-${label}`);

      // Full emit-equivalent payload: snapshot item (native geometry fields) + the clipboard blob.
      const payload = await page.evaluate((i) => {
        const snap = JSON.parse(window.Module.kicadCollabSnapshot());
        const item = snap.added.find((it: { id: string }) => it.id === i);
        return { ...item, sexpr: window.Module.kicadCollabTestItemBlob(i) };
      }, id);
      expect(payload.id, `${label} in snapshot`).toBe(id);
      const posBefore = await page.evaluate((i) => window.Module.kicadCollabGetPos(i), id);
      expect(posBefore, `${label} resolvable before`).not.toBe("");

      // delete it
      await page.evaluate(
        (i) => window.Module.kicadCollabApply(JSON.stringify({ added: [], changed: [], removed: [i] })),
        id,
      );
      await expect
        .poll(() => page.evaluate((i) => window.Module.kicadCollabGetPos(i), id), {
          timeout: 10000,
          intervals: [200],
        })
        .toBe("");

      // re-add it
      await page.evaluate(
        (p) => window.Module.kicadCollabApply(JSON.stringify({ added: [p], changed: [], removed: [] })),
        payload,
      );
      await expect
        .poll(() => page.evaluate((i) => window.Module.kicadCollabGetPos(i), id), {
          timeout: 10000,
          intervals: [200],
        })
        .toBe(posBefore);

      // Fidelity beyond the anchor: a text's justification anchors its glyphs, so a peer that
      // dropped it would render the text visibly offset even though GetPosition matches. Confirm
      // the reconstructed item round-trips its type-defining fields.
      const after = await page.evaluate((i) => {
        const snap = JSON.parse(window.Module.kicadCollabSnapshot());
        return snap.added.find((it: { id: string }) => it.id === i);
      }, id);
      // The item's own layer travels in the delta and is applied explicitly by makeItem — it does
      // NOT pick up the peer editor's active layer. (Footprint layer = which side it sits on.)
      expect(after.layer, `${label} layer preserved`).toBe(payload.layer);
      if (type === "PCB_TEXT") {
        expect(after.text, "text string preserved").toBe(payload.text);
        expect(after.hjust, "text horizontal justification preserved").toBe(payload.hjust);
        expect(after.vjust, "text vertical justification preserved").toBe(payload.vjust);
      }
      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    });
  }

  // REGRESSION (native-EH vtable-slot skew, task #54): a second consecutive collab apply must also
  // take effect. Root cause: the embind TU was compiled without -DDEBUG while the core TU (CMake
  // Config=Debug) had it, so a DEBUG-gated virtual (EDA_ITEM::Show) occupied a vtable slot the embind
  // didn't account for, shifting every later slot by one. Embind virtual calls in the apply
  // (SetWidth/GetPosition/the rebaseline snapshot getters) then read the wrong slot → call_indirect
  // signature-mismatch trap, swallowed by the apply coroutine's catch_all → silent loop, so the apply
  // never completed. Fixed by building the embind TU with -DDEBUG in Debug builds
  // (scripts/kicad/build-kicad-target.sh). RED before the fix (move times out), GREEN after.
  test("native-EH: a second consecutive collab apply also takes effect", async ({ page, testLogger }) => {
    await bootAndOpen(page, "apply");

    const before = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), SEG1);
    const [bx, by] = before.split(",").map(Number);

    const moveTo = async (x: number) => {
      await page.evaluate(
        ({ id, x, by }) =>
          window.Module.kicadCollabApply(
            JSON.stringify({
              changed: [{ id, type: "PCB_TRACK", sx: x, sy: by, ex: x + 50_800_000, ey: by, width: 200000 }],
              added: [],
              removed: [],
            }),
          ),
        { id: SEG1, x, by },
      );
      await expect
        .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), SEG1), {
          timeout: 10000,
          intervals: [200],
        })
        .toBe(`${x},${by}`);
    };

    await moveTo(bx + 5_000_000); // 1st apply
    await moveTo(bx + 8_000_000); // 2nd apply — RED before the -DDEBUG fix (apply mis-dispatches), GREEN after
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // Apply mutates the model headless: kicadOpenFile returns false (the incomplete-project load
  // skips some late steps) but the board IS built, so BOARD_COMMIT::Push takes effect. Rendering
  // still needs the real app. (Same headless reality as the eeschema apply test.)
  const TRACK_ID = "55555555-0000-0000-0000-000000000001";

  test("apply moves/removes/adds tracks by uuid, no echo", async ({ page, testLogger }) => {
    await bootAndOpen(page, "apply");

    const before = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), SEG1);
    const [bx, by] = before.split(",").map(Number);
    const nx = bx + 5_000_000; // +5mm

    await page.evaluate(() => {
      (window as unknown as { __echo: string[] }).__echo = [];
      (window as unknown as { kicadCollab: { onDelta: (j: string) => void } }).kicadCollab = {
        onDelta: (j: string) => (window as unknown as { __echo: string[] }).__echo.push(j),
      };
    });

    // changed: reshape SEG1's endpoints (a track moves via its two endpoints, like an eeschema
    // wire — the sx/sy/ex/ey form the emit side always produces). Deferred via CallAfter → poll.
    await page.evaluate(
      ({ id, nx, by }) =>
        window.Module.kicadCollabApply(
          JSON.stringify({
            changed: [{ id, type: "PCB_TRACK", sx: nx, sy: by, ex: nx + 50_800_000, ey: by, width: 200000 }],
            added: [],
            removed: [],
          }),
        ),
      { id: SEG1, nx, by },
    );
    await expect
      .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), SEG1), {
        timeout: 10000,
        intervals: [200],
      })
      .toBe(`${nx},${by}`);

    // removed: delete SEG2.
    await page.evaluate(
      (seg) =>
        window.Module.kicadCollabApply(JSON.stringify({ changed: [], added: [], removed: [seg] })),
      SEG2,
    );
    await expect
      .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), SEG2), {
        timeout: 10000,
        intervals: [200],
      })
      .toBe("");

    // added: a new track reconstructs by uuid (native PCB_TRACK build — no clipboard Parse).
    await page.evaluate(
      (trackId) =>
        window.Module.kicadCollabApply(
          JSON.stringify({
            changed: [],
            removed: [],
            added: [
              {
                id: trackId,
                type: "PCB_TRACK",
                sx: 60_000_000,
                sy: 60_000_000,
                ex: 90_000_000,
                ey: 60_000_000,
                width: 200000,
                layer: 0, // F_Cu
              },
            ],
          }),
        ),
      TRACK_ID,
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.Module.kicadCollabSnapshot())).includes(TRACK_ID),
        { timeout: 10000, intervals: [250] },
      )
      .toBe(true);

    const echoes = await page.evaluate(() => (window as unknown as { __echo: string[] }).__echo);
    expect(echoes, "apply() must not echo a local onDelta").toHaveLength(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // Bug 1: a footprint's silkscreen text (a child item) can be moved independently of its
  // footprint. apply resolves the child by uuid (BOARD::ResolveItem sees footprint children) and
  // commits a Modify — which BOARD_COMMIT::undoLevelItem rolls up to the parent footprint — then
  // SetPosition. The footprint itself does NOT move. Covers both the Reference field (PCB_FIELD)
  // and a user fp_text (PCB_TEXT).
  test("apply moves a footprint's silkscreen text child by uuid (footprint stays put)", async ({
    page,
    testLogger,
  }) => {
    await bootAndOpen(page, "fptext");

    const fpBefore = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), FP1);

    for (const childId of [FP1_REF, FP1_TXT]) {
      const before = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), childId);
      expect(before, `child ${childId} resolvable`).not.toBe("");
      const [cx, cy] = before.split(",").map(Number);
      const ny = cy + 3_000_000; // +3mm in Y

      await page.evaluate(
        ({ id, cx, ny }) =>
          window.Module.kicadCollabApply(
            JSON.stringify({ changed: [{ id, x: cx, y: ny }], added: [], removed: [] }),
          ),
        { id: childId, cx, ny },
      );
      await expect
        .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), childId), {
          timeout: 10000,
          intervals: [200],
        })
        .toBe(`${cx},${ny}`);
    }

    // The footprint origin must be unchanged — only the child text moved.
    const fpAfter = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), FP1);
    expect(fpAfter, "footprint did not move").toBe(fpBefore);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

test.describe("pcbnew collab bridge — two tabs (BroadcastChannel)", () => {
  // SKIP headless for the same reason as the single-page apply test (harness can't PAINT).
  // Verified working in the real web app.
  // re-enabled 2026-08-13: passes on the JSPI build (both engines)
  test("a local move propagates A→B", async ({ context, testLogger }) => {
    const channel = `pcb-collab-e2e-${test.info().workerIndex}`;
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
