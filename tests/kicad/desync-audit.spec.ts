import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * 2026-09-21 multiplayer desync audit — the NATIVE findings
 * (docs/features/ysync-review/2026-09-21-multiplayer-desync-audit.md; the
 * binding-level ones are pinned in web/standalone …/collab/desync-audit.test.ts).
 *
 *  1. eeschema: a commit that touches items of a sheet OTHER than the shown one
 *     (annotate all, global edits) used to emit those roots on the shown
 *     sheet's wire → peers added a subsheet's items to the root sheet while the
 *     subsheet's room never heard of the change. They now leave on
 *     `onSheetItems(<owning sheet>, wire)`.
 *  2. pl_editor never called the apply-time resolver, so the binding kept the
 *     pre-apply baseline: a local move BACK to it was swallowed as "unchanged".
 *  3. pl_editor's change detector was a scalar projection without the repeat
 *     fields: a repeat-count-only edit never emitted.
 */

type Mod = Record<string, (...a: never[]) => unknown>;
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};

const BOOT_TIMEOUT = 150000;
const DOCS = "/home/kicad/documents";
const BUNDLE = path.resolve(__dirname, "../apps/kicad/collab-bundle-v2.js");

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function boot(page: Page, html: string, fns: string[]): Promise<void> {
  await page.goto(`/kicad/${html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    (names) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return !!m && names.every((f) => typeof m[f] === "function");
    },
    ["kicadOpenFile", "kicadCollabSnapshotItems", "kicadCollabApplyItems", ...fns],
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
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

// ── 1. eeschema cross-sheet commits ──────────────────────────────────────────

const ROOT_WIRE = "1aaaaaaa-0000-0000-0000-000000000001";
const SHEET_SYM = "5ee70000-0000-0000-0000-000000000001";
const CHILD_WIRE = "2ccccccc-0000-0000-0000-000000000001";

const ROOT_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "10000000-0000-0000-0000-000000000000")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${ROOT_WIRE}"))
	(sheet (at 127 50.8) (size 20 20)
		(stroke (width 0.1524) (type solid))
		(fill (color 0 0 0 0.0000))
		(uuid "${SHEET_SYM}")
		(property "Sheetname" "child" (at 127 50 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
		(property "Sheetfile" "child.kicad_sch" (at 127 71 0) (effects (font (size 1.27 1.27)) (justify left top)))
		(instances (project "rt" (path "/10000000-0000-0000-0000-000000000000" (page "2"))))
	)
	(sheet_instances (path "/" (page "1")))
)
`;

const CHILD_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "20000000-0000-0000-0000-000000000000")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "${CHILD_WIRE}"))
	(sheet_instances (path "/" (page "1")))
)
`;

interface Captured {
  items: string[];
  sheetItems: Array<{ sheet: string; json: string }>;
}

function captured(page: Page): Promise<Captured> {
  return page.evaluate(() => (window as unknown as { __cap: Captured }).__cap);
}

test.describe("desync audit — eeschema cross-sheet commits", () => {
  test.describe.configure({ timeout: 420000 });

  test("an off-sheet commit leaves on onSheetItems for ITS sheet, never on the shown sheet's wire", async ({
    page,
    testLogger,
  }) => {
    await boot(page, "eeschema.html", ["kicadCollabTestRotateItem", "kicadCollabTestRemoveItem"]);
    await page.evaluate(
      ({ root, child, docs }) => {
        const w = window as unknown as { FS: FS; Module: { kicadOpenFile(p: string): unknown } };
        try {
          w.FS.mkdirTree(docs);
        } catch {
          /* exists */
        }
        w.FS.writeFile(`${docs}/child.kicad_sch`, child);
        w.FS.writeFile(`${docs}/root.kicad_sch`, root);
        w.Module.kicadOpenFile(`${docs}/root.kicad_sch`);
      },
      { root: ROOT_SCH, child: CHILD_SCH, docs: DOCS },
    );

    // Baseline the differ on the shown (root) screen — what a binding's seed does.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as { Module: { kicadCollabSnapshotItems(): string } }).Module.kicadCollabSnapshotItems(),
          ),
        { timeout: 30000, intervals: [500] },
      )
      .toContain(ROOT_WIRE);

    await page.evaluate(() => {
      const cap: Captured = { items: [], sheetItems: [] };
      const w = window as unknown as { __cap: Captured; kicadCollab?: Record<string, unknown> };
      w.__cap = cap;
      w.kicadCollab = {
        ...w.kicadCollab,
        onItems: (json: string) => cap.items.push(json),
        onSheetItems: (sheet: string, json: string) => cap.sheetItems.push({ sheet, json }),
      };
    });

    // A genuine local commit on the CHILD screen while the root is shown (the
    // hook resolves hierarchy-wide, like annotate-all's per-screen staging).
    expect(
      await page.evaluate(
        (id) =>
          (window as unknown as { Module: { kicadCollabTestRotateItem(id: string, deg: number): boolean } })
            .Module.kicadCollabTestRotateItem(id, 90),
        CHILD_WIRE,
      ),
    ).toBe(true);

    // The flush ran once either channel fired (pre-fix: the WRONG one).
    await expect
      .poll(async () => {
        const c = await captured(page);
        return c.items.length + c.sheetItems.length;
      }, { timeout: 25000, intervals: [300] })
      .toBeGreaterThan(0);
    // THE BUG: the child's wire used to be emitted here, into the root's room.
    expect(
      (await captured(page)).items.join("\n"),
      "child item must not ride the shown sheet's wire",
    ).not.toContain(CHILD_WIRE);

    await expect.poll(async () => (await captured(page)).sheetItems.length, {
      timeout: 25000,
      intervals: [300],
    }).toBe(1);
    let cap = await captured(page);
    expect(cap.sheetItems[0]!.sheet).toMatch(/child\.kicad_sch$/);
    const wire = JSON.parse(cap.sheetItems[0]!.json) as { changed: Array<{ sexpr: string }>; removed: string[] };
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.sexpr).toContain(CHILD_WIRE);

    // An off-sheet deletion is that sheet's removal.
    expect(
      await page.evaluate(
        (id) =>
          (window as unknown as { Module: { kicadCollabTestRemoveItem(id: string): boolean } }).Module.kicadCollabTestRemoveItem(id),
        CHILD_WIRE,
      ),
    ).toBe(true);
    await expect.poll(async () => (await captured(page)).sheetItems.length, {
      timeout: 25000,
      intervals: [300],
    }).toBe(2);
    cap = await captured(page);
    expect(cap.sheetItems[1]!.sheet).toMatch(/child\.kicad_sch$/);
    expect((JSON.parse(cap.sheetItems[1]!.json) as { removed: string[] }).removed).toEqual([CHILD_WIRE]);
    expect(cap.items.join("\n")).not.toContain(CHILD_WIRE);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

// ── 2 + 3. pl_editor ─────────────────────────────────────────────────────────

const U_TITLE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WKS = `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "${U_TITLE}") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`;

async function openWks(page: Page, name: string): Promise<void> {
  await boot(page, "pl_editor.html", [
    "kicadSaveDrawingSheet",
    "kicadCollabTestSetPos",
    "kicadCollabTestSetRepeat",
  ]);
  await page.evaluate(
    ({ content, name, docs }) => {
      const w = window as unknown as { FS: FS; Module: { kicadOpenFile(p: string): unknown } };
      try {
        w.FS.mkdirTree(docs);
      } catch {
        /* exists */
      }
      w.FS.writeFile(`${docs}/${name}.kicad_wks`, content);
      w.Module.kicadOpenFile(`${docs}/${name}.kicad_wks`);
    },
    { content: WKS, name, docs: DOCS },
  );
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
  await page.addScriptTag({ path: BUNDLE });
  await page.addScriptTag({ content: FORM_AROUND });
}

function startV2(page: Page, room: string, seedText?: string): Promise<void> {
  return page.evaluate(
    async (o) => {
      const w = window as unknown as {
        KicadCollabV2: { start: (m: unknown, win: unknown, o: unknown) => Promise<void> };
        Module: unknown;
      };
      await w.KicadCollabV2.start(w.Module, window, o);
    },
    { room, settleMs: 500, seedText },
  );
}

/** In-page helper: the whole `(tbtext …)` form containing `id` (paren-balanced). */
const FORM_AROUND = `window.formAround = (text, id) => {
  const at = text.indexOf(id);
  if (at < 0) return "";
  const start = text.lastIndexOf("(tbtext", at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1).replace(/\\s+/g, " ");
  }
  return text.slice(start);
};`;
declare function formAround(text: string, id: string): string;

/** The title item's form in the tab's NATIVE model (save-to-MEMFS). */
function nativeTitle(page: Page): Promise<string> {
  return page.evaluate(
    ({ docs, id }) => {
      const w = window as unknown as { FS: FS; Module: { kicadSaveDrawingSheet(p: string): unknown } };
      const out = `${docs}/_dump.kicad_wks`;
      w.Module.kicadSaveDrawingSheet(out);
      const text = w.FS.readFile(out, { encoding: "utf8" });
      return formAround(text, id);
    },
    { docs: DOCS, id: U_TITLE },
  );
}

/** The title item as the tab's ROOM DOC materializes it. */
function docTitle(page: Page): Promise<string> {
  return page.evaluate((id) => {
    const w = window as unknown as { KicadCollabV2: { renderActiveDoc(): string } };
    return formAround(w.KicadCollabV2.renderActiveDoc(), id);
  }, U_TITLE);
}

const setPos = (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ id, x, y }) =>
      (window as unknown as { Module: { kicadCollabTestSetPos(i: string, x: number, y: number): boolean } })
        .Module.kicadCollabTestSetPos(id, x, y),
    { id: U_TITLE, x, y },
  );

test.describe("desync audit — pl_editor", () => {
  test.describe.configure({ timeout: 420000 });

  test("a remotely moved item can be moved BACK; a repeat-only edit reaches the peer", async ({
    context,
    testLogger,
  }) => {
    const room = `desync-audit-pl-${test.info().workerIndex}-${test.info().repeatEachIndex}`;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await openWks(tabA, "auditA");
    await openWks(tabB, "auditB");
    await startV2(tabA, room, WKS);
    await startV2(tabB, room);

    // A moves the title 100 → 140; B's native model follows.
    expect(await setPos(tabA, 140, 20)).toBe(true);
    await expect.poll(() => nativeTitle(tabB), { timeout: 15000, intervals: [300] }).toContain("(pos 140 20");

    // B moves it back to where B's binding baseline still was before the fix.
    expect(await setPos(tabB, 100, 20)).toBe(true);
    // THE BUG: nothing was written — docs and A stayed at 140 while B showed 100.
    await expect.poll(() => docTitle(tabB), { timeout: 15000, intervals: [300] }).toContain("(pos 100 20");
    await expect.poll(() => nativeTitle(tabA), { timeout: 15000, intervals: [300] }).toContain("(pos 100 20");

    // A changes ONLY the repeat count — invisible to the old scalar differ.
    expect(await nativeTitle(tabB)).not.toContain("(repeat 3)");
    expect(
      await tabA.evaluate(
        (id) =>
          (window as unknown as { Module: { kicadCollabTestSetRepeat(i: string, n: number): boolean } })
            .Module.kicadCollabTestSetRepeat(id, 3),
        U_TITLE,
      ),
    ).toBe(true);
    await expect.poll(() => nativeTitle(tabB), { timeout: 15000, intervals: [300] }).toContain("(repeat 3)");
    expect(await docTitle(tabA)).toContain("(repeat 3)");

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});
