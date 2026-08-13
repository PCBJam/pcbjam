import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * onSave hook e2e (standalone-hardening 0005, save routing): a real user
 * File→Save (Ctrl+S through the wx accelerator path) must fire
 * window.kicadCollab.onSave(absPath) AFTER the bytes hit MEMFS — the signal the
 * standalone app's save router (web/standalone/src/wasm/save-flow.ts) uses to
 * persist saves out of the browser (API upload / local-disk write-back /
 * download). The per-tool embind save helpers (kicadSaveDrawingSheet /
 * kicadSaveSchematic / kicadSaveBoard) intentionally BYPASS the frame save
 * chokepoint and must not fire it — they are test/materialize plumbing, not
 * user saves.
 */

interface ToolCfg {
  tool: string;
  html: string;
  ext: string;
  saveFn: string;
  /** Embind helper performing a genuine local edit (marks the doc modified, so
   *  the Save action is enabled when Ctrl+S arrives). */
  modify: { fn: string; args: (string | number)[] };
  fixture: string;
}

type Mod = Record<string, (...a: (string | number)[]) => unknown> & {
  kicadOpenFile(path: string): Promise<unknown>;
};
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type HookWindow = Window & {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
  __savedPaths: string[];
};

const BOOT_TIMEOUT = 150000;
const NAME = "savehook";

/** Boot a fresh tool page and open the fixture from MEMFS (roundtrip.spec pattern). */
async function bootOpen(page: Page, cfg: ToolCfg): Promise<string> {
  await page.goto(`/kicad/${cfg.html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    ({ saveFn, modFn }) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.[saveFn] === "function" &&
        typeof m?.[modFn] === "function"
      );
    },
    { saveFn: cfg.saveFn, modFn: cfg.modify.fn },
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
  const abs = `/home/kicad/documents/${NAME}.${cfg.ext}`;
  await page.evaluate(
    async ({ content, abs }) => {
      const w = window as unknown as HookWindow;
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      w.FS.writeFile(abs, content);
      await w.Module.kicadOpenFile(abs);
    },
    { content: cfg.fixture, abs },
  );
  // Wait for the async OpenProjectFiles to complete: the editor title switches to
  // the opened file (deterministic, replaces a fixed "let it settle" sleep).
  await expect.poll(() => page.title(), { timeout: BOOT_TIMEOUT, intervals: [300] }).toMatch(new RegExp(NAME, "i"));
  return abs;
}

/** Click the drawing-area CENTER (clicking near the top edge hits the menubar —
 *  the wx canvas hosts the whole app UI). */
async function focusCanvas(page: Page): Promise<void> {
  const box = await page.locator("#canvas").boundingBox();
  expect(box, "#canvas has a bounding box").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  // Small settle so the focus click is processed before the Ctrl+S accelerator —
  // no JS-observable "canvas focused" signal to poll (documented interaction wait).
  await page.waitForTimeout(300); // eslint-disable-line -- see comment above
}

async function expectSaveHookFires(page: Page, cfg: ToolCfg): Promise<void> {
  const abs = await bootOpen(page, cfg);

  // Register the collector the way the standalone save router does (spread-merge
  // so sibling bridge hooks survive).
  await page.evaluate(() => {
    const w = window as unknown as HookWindow;
    w.__savedPaths = [];
    w.kicadCollab = { ...w.kicadCollab, onSave: (p: string) => w.__savedPaths.push(p) };
  });

  // The embind save helper bypasses the frame chokepoint: NO hook.
  await page.evaluate(
    ({ saveFn, ext }) => {
      const w = window as unknown as HookWindow;
      w.Module[saveFn](`/home/kicad/documents/helper_dump.${ext}`);
    },
    { saveFn: cfg.saveFn, ext: cfg.ext },
  );
  expect(
    await page.evaluate(() => (window as unknown as HookWindow).__savedPaths.length),
    "embind save helper must not fire onSave",
  ).toBe(0);

  // A genuine local edit (enables Save), then the user save: Ctrl+S.
  await page.evaluate(
    ({ fn, args }) => (window as unknown as HookWindow).Module[fn](...args),
    cfg.modify,
  );
  // Let the local edit mark the document modified (enables Save) before Ctrl+S —
  // no JS-observable dirty-state signal to poll (documented interaction wait).
  await page.waitForTimeout(500); // eslint-disable-line -- see comment above
  await focusCanvas(page);
  await page.keyboard.press("Control+s");

  await page.waitForFunction(
    () => (window as unknown as HookWindow).__savedPaths.length > 0,
    null,
    { timeout: 30000 },
  );
  const saved = await page.evaluate(() => (window as unknown as HookWindow).__savedPaths);
  expect(saved[0], "onSave must carry the opened file's MEMFS path").toBe(abs);

  // And the bytes were on MEMFS by the time the hook fired: the saved file
  // carries the fixture's uuids (i.e. it is a real serialized document).
  const text = await page.evaluate(
    (p) => (window as unknown as HookWindow).FS.readFile(p, { encoding: "utf8" }),
    saved[0],
  );
  expect(text).toContain('(uuid "');
}

// ── Fixtures (trimmed copies of roundtrip.spec's known-good documents) ────────

const PL: ToolCfg = {
  tool: "pl_editor",
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  modify: { fn: "kicadCollabTestAddText", args: ["save-hook", 30, 30] },
  fixture: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`,
};

const SCH: ToolCfg = {
  tool: "eeschema",
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  modify: { fn: "kicadCollabTestMoveFirst", args: [2, 2] },
  fixture: `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "11111111-1111-1111-1111-111111111111")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))
	(sheet_instances (path "/" (page "1")))
)
`,
};

const PCB: ToolCfg = {
  tool: "pcbnew",
  // pcbnew-collab.html seeds kicad_common.json so the first-run wizard is skipped.
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  modify: { fn: "kicadCollabTestMoveFirst", args: [2, 2] },
  fixture: `(kicad_pcb
	(version 20241229)
	(generator "pcbnew")
	(generator_version "9.0")
	(general (thickness 1.6))
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(2 "B.Cu" signal)
		(37 "F.SilkS" user)
		(25 "Edge.Cuts" user)
	)
	(setup)
	(net 0 "")
	(footprint "TestLib:R"
		(layer "F.Cu")
		(uuid "66666666-0000-0000-0000-000000000001")
		(at 100 100)
		(attr smd)
		(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
	)
)
`,
};

test.describe("user File→Save fires window.kicadCollab.onSave", () => {
  // The heavy tools need well beyond the config's default per-test budget to boot.
  test.describe.configure({ timeout: 300000 });

  test("pl_editor: Ctrl+S → onSave with the saved MEMFS path", async ({ page, testLogger }) => {
    void testLogger;
    await expectSaveHookFires(page, PL);
  });

  test("eeschema: Ctrl+S → onSave with the saved MEMFS path", async ({ page, testLogger }) => {
    void testLogger;
    await expectSaveHookFires(page, SCH);
  });

  test("pcbnew: Ctrl+S → onSave with the saved MEMFS path", async ({ page, testLogger }) => {
    void testLogger;
    await expectSaveHookFires(page, PCB);
  });
});
