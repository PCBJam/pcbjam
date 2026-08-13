import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * V2 "items" wire two-tab e2e — the PRODUCTION collab stack, end to end
 * (ysync-review miss 11): bindKicadCollab + moduleItemsBridge over the kdoc_*
 * Slot-model Y.Doc, C++ kicadCollabSnapshotItems / ApplyItems /
 * window.kicadCollab.onItems. The pre-existing *-collab.spec.ts two-tab tests
 * drive the LEGACY scalar wire, which is dead in production.
 *
 * pl_editor is the GREEN baseline: its emit is an eager OnModify hook
 * (pl_editor_embind.cpp), not the lazily-registered COLLAB_LISTENER, so bug 01
 * does not gate it — which is exactly what makes it fit for validating the
 * harness itself.
 *
 * REPRO CONVENTION (docs/features/ysync-review on the ysync-review branch):
 * each repro asserts the CORRECT behavior and is marked `test.fail()` with a
 * comment naming the bug doc. Fixing the bug flips it to "unexpected pass",
 * forcing the marker's removal — the repro becomes the regression test.
 * Expected-fail polls use short timeouts so they don't burn the clock.
 */

type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type Mod = Record<string, (...a: never[]) => unknown>;

interface ToolCfg {
  html: string;
  ext: string;
  saveFn: string;
  fixture: string;
  /** Module fns (beyond the v2 bridge pair + saveFn) boot must wait for. */
  fns: string[];
}

const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const U_TITLE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const U_RECT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const U_DIVERGENT = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const PL: ToolCfg = {
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  fixture: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "${U_RECT}") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "${U_TITLE}") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`,
  fns: ["kicadCollabTestAddText"],
};

const FP1 = "66666666-0000-0000-0000-000000000001";
const FP1_TXT = "66666666-0000-0000-0000-0000000000cc";
const VIA1 = "77777777-0000-0000-0000-000000000001";
const SEG1 = "88888888-0000-0000-0000-000000000001";
const SEG2 = "88888888-0000-0000-0000-000000000002";

const PCB: ToolCfg = {
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  fixture: `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
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
\t\t(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000bb") (effects (font (size 1 1) (thickness 0.15))))
\t\t(fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "${FP1_TXT}") (effects (font (size 1 1) (thickness 0.15))))
\t)
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
\t(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG2}"))
)
`,
  fns: ["kicadCollabTestMoveFirst", "kicadCollabGetPos"],
};

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const WIRE2 = "22222222-0000-0000-0000-000000000002";

const SCH: ToolCfg = {
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  fixture: `(kicad_sch
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
`,
  fns: ["kicadCollabTestMoveFirst", "kicadCollabGetPos"],
};

// ── Harness plumbing ─────────────────────────────────────────────────────────

const BUNDLE = path.resolve(__dirname, "../apps/kicad/collab-bundle-v2.js");

async function bootOpen(page: Page, cfg: ToolCfg, name: string): Promise<void> {
  await page.goto(`/kicad/${cfg.html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    (fns) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return !!m && fns.every((f) => typeof m[f] === "function");
    },
    ["kicadOpenFile", "kicadCollabSnapshotItems", "kicadCollabApplyItems", cfg.saveFn, ...cfg.fns],
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate(
    async ({ content, ext, name }) => {
      const w = window as unknown as { FS: FS; Module: { kicadOpenFile(p: string): Promise<unknown> } };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/${name}.${ext}`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content: cfg.fixture, ext: cfg.ext, name },
  );
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
  await page.addScriptTag({ path: BUNDLE });
}

/** Start the v2 stack in a tab (window.KicadCollabV2 from the bundle). */
function startV2(
  page: Page,
  opts: { room: string; settleMs?: number; seedText?: string; editorMatchesDoc?: boolean },
): Promise<void> {
  return page.evaluate(async (o) => {
    const w = window as unknown as {
      KicadCollabV2: { start: (m: unknown, win: unknown, o: unknown) => Promise<void> };
      Module: unknown;
    };
    await w.KicadCollabV2.start(w.Module, window, o);
  }, opts);
}

/** Read a tab's current model back as text via save-to-MEMFS. */
function modelText(page: Page, cfg: ToolCfg): Promise<string> {
  return page.evaluate(
    async ({ saveFn, ext }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const out = `/home/kicad/documents/_dump.${ext}`;
      await (w.Module[saveFn] as (p: string) => Promise<unknown>)(out);
      return w.FS.readFile(out, { encoding: "utf8" });
    },
    { saveFn: cfg.saveFn, ext: cfg.ext },
  );
}

/** docToFile(yToDoc(room doc)) in-page; { err } instead of throwing. */
function renderDoc(page: Page): Promise<{ ok?: string; err?: string }> {
  return page.evaluate(() => {
    const w = window as unknown as { KicadCollabV2: { renderActiveDoc(): string } };
    try {
      return { ok: w.KicadCollabV2.renderActiveDoc() };
    } catch (e) {
      return { err: String(e) };
    }
  });
}

/** Item-level drift summary (see browser-entry-v2.ts driftReport). */
function drift(page: Page, cfg: ToolCfg) {
  return page.evaluate(
    ({ saveFn, ext }) => {
      const w = window as unknown as {
        KicadCollabV2: {
          driftReport(
            f: string,
            p: string,
          ): Promise<{ added: string[]; updated: string[]; removed: string[] } | null>;
        };
      };
      return w.KicadCollabV2.driftReport(saveFn, `/home/kicad/documents/_drift.${ext}`);
    },
    { saveFn: cfg.saveFn, ext: cfg.ext },
  );
}

function getPos(page: Page, uuid: string): Promise<string> {
  return page.evaluate(
    (id) => (window as unknown as { Module: { kicadCollabGetPos(i: string): Promise<string> } }).Module.kicadCollabGetPos(id),
    uuid,
  );
}

test.beforeAll(() => {
  // Rebuild both collab bundles so the test always exercises the current stack.
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

// ── pl_editor: the green baseline (harness validation + adopt coverage) ──────

test.describe("v2 items wire — pl_editor two tabs (green baseline)", () => {
  test.describe.configure({ timeout: 420000 });

  test("fresh room: A file-seeds, edits flow A→B and B→A, item drift silent", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-v2-pl-fresh-${test.info().workerIndex}`;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await bootOpen(tabA, PL, "tabA");
    await bootOpen(tabB, PL, "tabB");

    await startV2(tabA, { room, seedText: PL.fixture }); // fresh room → file-seed branch
    await startV2(tabB, { room }); // joins → adopt

    // A→B. pl_editor's emit hook is EAGER (OnModify, registered at module init),
    // so bug 01's never-registered-listener hole does not gate this tool.
    const uuidA = (await tabA.evaluate(() =>
      (window as unknown as { Module: { kicadCollabTestAddText(t: string, x: number, y: number): Promise<string> } })
        .Module.kicadCollabTestAddText("Hello from A", 40, 40),
    )) as string;
    expect(uuidA).toMatch(/[0-9a-f-]{36}/);
    await expect
      .poll(async () => await modelText(tabB, PL), { timeout: 20000, intervals: [300] })
      .toContain("Hello from A");
    expect(await modelText(tabB, PL)).toContain(`(uuid "${uuidA}")`);

    // B→A (the adopting side's listener registered via its seed's snapshotItems).
    const uuidB = (await tabB.evaluate(() =>
      (window as unknown as { Module: { kicadCollabTestAddText(t: string, x: number, y: number): Promise<string> } })
        .Module.kicadCollabTestAddText("Hello from B", 60, 60),
    )) as string;
    await expect
      .poll(async () => await modelText(tabA, PL), { timeout: 20000, intervals: [300] })
      .toContain("Hello from B");
    expect(await modelText(tabA, PL)).toContain(`(uuid "${uuidB}")`);

    // Drift-detect as the convergence oracle (miss 11 §5): ITEM-level silence on
    // both tabs. layoutChanged/metaChanged are NOT asserted — non-item state only
    // syncs at seed (miss 08) and the writer may normalize preamble formatting.
    for (const [tab, label] of [
      [tabA, "tabA"],
      [tabB, "tabB"],
    ] as const) {
      const d = await drift(tab, PL);
      expect(d?.added ?? [], `${label} drift added`).toEqual([]);
      expect(d?.updated ?? [], `${label} drift updated`).toEqual([]);
      expect(d?.removed ?? [], `${label} drift removed`).toEqual([]);
    }

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });

  test("cold divergent copy: the joiner adopts the doc's identity", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-v2-pl-adopt-${test.info().workerIndex}`;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await bootOpen(tabA, PL, "tabA");
    await startV2(tabA, { room, seedText: PL.fixture });

    // B cold-opened a never-saved copy: same content, DIFFERENT title uuid.
    const divergent: ToolCfg = { ...PL, fixture: PL.fixture.replace(U_TITLE, U_DIVERGENT) };
    await bootOpen(tabB, divergent, "tabB");
    await startV2(tabB, { room }); // populated room → adopt (doc authority)

    // Doc roots applied, local-only roots removed — the editor takes the doc's uuids.
    await expect
      .poll(async () => await modelText(tabB, PL), { timeout: 20000, intervals: [300] })
      .toContain(U_TITLE);
    expect(await modelText(tabB, PL)).not.toContain(U_DIVERGENT);

    const d = await drift(tabB, PL);
    expect(d?.added ?? [], "adopted tab drift added").toEqual([]);
    expect(d?.removed ?? [], "adopted tab drift removed").toEqual([]);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});

// ── Bug 01 — the fresh-room seeding tab cannot send (eeschema + pcbnew) ──────
// 01-bug-first-tab-listener-never-registered.md: seed()'s file-seed branch
// never calls snapshotItems(), so ensureBridge() never registers the C++
// COLLAB_LISTENER on the seeding tab — its local edits are never emitted. The
// joiner uses editorMatchesDoc (the ydoc-load baseline-only path) so this test
// isolates the SEEDER's emit half. Gated on the headless-emit probe in
// ysync-repros-{pcbnew,eeschema}.spec.ts: if that control is red, flip these
// to test.fixme (the harness can't drive the tool's emit at all).

for (const [cfg, label] of [
  [PCB, "pcbnew"],
  [SCH, "eeschema"],
] as const) {
  test.describe(`v2 items wire — ${label} fresh room (bug 01 repro)`, () => {
    test.describe.configure({ timeout: 420000 });

    test(`${label}: the seeding tab's local edit must reach the joiner`, async ({
      context,
      testLogger,
    }) => {
      // TWO kicad_editor instances exceed Firefox's per-content-process wasm
      // budget (the 2nd tab's #canvas never appears, even serial/isolated —
      // same SpiderMonkey wall playwright-kicad.config.ts documents for x86
      // CI, hit at 2× on ARM). V8 handles it: runs on chromium-ci in CI and
      // --project=chromium locally.
      test.skip(
        test.info().project.name.includes("firefox"),
        "two kicad_editor tabs exceed Firefox's per-process wasm budget",
      );

      const room = `ysync-v2-${label}-bug01-${test.info().workerIndex}`;
      const tabA = await context.newPage();
      const tabB = await context.newPage();
      await bootOpen(tabA, cfg, "tabA");
      await bootOpen(tabB, cfg, "tabB");

      await startV2(tabA, { room, seedText: cfg.fixture }); // fresh → FILE-SEED branch
      await startV2(tabB, { room, editorMatchesDoc: true }); // ydoc-load style joiner

      // Pre-positions of every fixture root, so the moved item is verifiable
      // whichever item the tool's forEachTopItem yields first.
      const uuids = [...cfg.fixture.matchAll(/\(uuid "([0-9a-f-]{36})"\)/g)].map((m) => m[1]!);
      const before: Record<string, string> = {};
      for (const u of uuids) before[u] = await getPos(tabA, u);

      const movedId = (await tabA.evaluate(() =>
        (window as unknown as { Module: { kicadCollabTestMoveFirst(dx: number, dy: number): Promise<string> } })
          .Module.kicadCollabTestMoveFirst(2_000_000, 0),
      )) as string;
      expect(movedId).toMatch(/[0-9a-f-]{36}/);

      // The local edit is REAL (green precondition — the move landed on A).
      await expect
        .poll(() => getPos(tabA, movedId), { timeout: 15000, intervals: [300] })
        .not.toBe(before[movedId]);
      const posA = await getPos(tabA, movedId);

      // CORRECT: the v2 loop broadcasts it (listener → flushDiff → onItems → Y →
      // peer applyItems). TODAY: A has no listener (file-seed skipped
      // snapshotItems) → nothing is ever emitted → B never converges.
      await expect
        .poll(() => getPos(tabB, movedId), { timeout: 8000, intervals: [400] })
        .toBe(posA);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
      await tabA.close();
      await tabB.close();
    });
  });
}

// ── Bug 06 — concurrent first-seed duplicates kdoc_layout ────────────────────
// 06-bug-concurrent-seed-duplicates-layout.md: seed-vs-adopt is client-side
// check-then-act; two tabs opening the same fresh room inside the settle
// window can both file-seed. FIXED by the arbitrated seed (seedDocToY nonce +
// LWW-loser layout retraction — deterministic unit coverage in
// web/pcbjam-shared/test/ysync-repros.test.ts); this drives the real window
// and asserts the room ends on one clean sequence either way.

test.describe("v2 items wire — concurrent seed (bug 06 repro)", () => {
  test.describe.configure({ timeout: 420000 });

  test("both tabs seed a fresh room at once: the room converges on one clean sequence", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-v2-pl-race-${test.info().workerIndex}`;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await bootOpen(tabA, PL, "tabA");
    await bootOpen(tabB, PL, "tabB");

    // Equal settle windows, started together: both pass ydocHasState("empty").
    await Promise.all([
      startV2(tabA, { room, seedText: PL.fixture, settleMs: 400 }),
      startV2(tabB, { room, seedText: PL.fixture, settleMs: 400 }),
    ]);

    // Let the CRDT converge (not part of the repro — both docs must agree).
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([renderDoc(tabA), renderDoc(tabB)]);
          return !!a.ok && a.ok === b.ok;
        },
        { timeout: 15000, intervals: [300] },
      )
      .toBe(true);

    const merged = (await renderDoc(tabA)).ok!;

    // Whether or not both tabs raced into the seed branch this run, the
    // arbitrated seed (seedDocToY + LWW-loser layout retraction) must leave a
    // SINGLE clean sequence: each root exactly once, the preamble not doubled.
    // (Byte-comparing against singleSeedRender(fixture) is no longer valid: the
    // file-seed path deliberately re-upserts item BODIES in the editor's
    // serialization, so the room's render is editor-normalized, not file-verbatim.)
    expect(merged.match(new RegExp(U_RECT, "g")), "border rect appears once").toHaveLength(1);
    expect(merged.match(new RegExp(U_TITLE, "g")), "title text appears once").toHaveLength(1);
    expect(merged.match(/\(version 20220228\)/g), "preamble not doubled").toHaveLength(1);
    expect(merged.match(/\(setup /g), "setup block not doubled").toHaveLength(1);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});

// ── Bug 03 (Y half) — bare child removal poisons the room doc ────────────────
// 03-bug-child-removal-dangling-slot.md: the C++ emit for a child-only delete
// is `{removed:[childUuid]}` with no parent re-blob (pcbnew_embind.cpp
// flushDiff's removed loop). applyDeltaToY drops the item but leaves the
// parent's `{item}` slot dangling → the room stops materializing.

test.describe("v2 items wire — pcbnew bare child removal (bug 03 Y-half repro)", () => {
  test.describe.configure({ timeout: 420000 });

  test("a bare child removal must keep the room materializable", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-v2-pcb-bug03-${test.info().workerIndex}`;
    const tabA = await context.newPage();
    await bootOpen(tabA, PCB, "tabA");
    await startV2(tabA, { room, seedText: PCB.fixture }); // file-seed: fp + children in kdoc_items

    // Simulate exactly the wire the C++ sends for "delete the fp_text child"
    // through the binding's REAL hook (moduleItemsBridge registered it).
    await tabA.evaluate((uuid) => {
      const w = window as unknown as { kicadCollab: { onItems(j: string): void } };
      w.kicadCollab.onItems(JSON.stringify({ added: [], changed: [], removed: [uuid] }));
    }, FP1_TXT);

    // CORRECT: the room still materializes, without the child. TODAY:
    // renderItem throws `missing item ${FP1_TXT}` through the dangling slot.
    const r = await renderDoc(tabA);
    expect(r.err, "room must still materialize (docToFile)").toBeUndefined();
    expect(r.ok!).not.toContain(FP1_TXT);
    expect(r.ok!).toContain(FP1); // the parent footprint survives

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
  });
});
