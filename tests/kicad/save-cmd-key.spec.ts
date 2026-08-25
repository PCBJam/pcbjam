import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Cmd+S (Meta+S — the Mac save chord) must save exactly like Ctrl+S does.
 *
 * save-hook.spec pins Ctrl+S → window.kicadCollab.onSave for every frame; every
 * other spec in the tree presses "Control+s" too, so the Meta chord had no
 * coverage at all. A Mac user reported "Cmd+S didn't save, the Save icon did"
 * (libs 0017). This spec is the red side of that report: same boot / edit /
 * hook recipe as save-hook.spec, chord swapped for Meta+S. A Ctrl+S control
 * run in the same session guards against blaming the chord for a boot
 * problem.
 *
 * wx side: keyboard.cpp SetKeyboardModifiers maps metaKey → ControlDown only
 * when wxGetOsVersion() reports a Mac (wx.js platformInfo from the UA), and
 * app.cpp TranslateMenuAccel matches "\tCtrl+S" on ControlDown — so the Meta
 * chord has two places to fall through.
 */

interface ToolCfg {
  html: string;
  ext: string;
  modify: { fn: string; args: (string | number)[] };
  fixture: string;
}

type Mod = Record<string, (...a: (string | number)[]) => unknown>;
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
};
type HookWindow = Window & {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
  __savedPaths: string[];
};

const BOOT_TIMEOUT = 150000;
const NAME = "savecmd";

async function bootOpen(page: Page, cfg: ToolCfg): Promise<string> {
  await page.goto(`/kicad/${cfg.html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    (modFn) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.[modFn] === "function";
    },
    cfg.modify.fn,
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
    ({ content, abs }) => {
      const w = window as unknown as HookWindow;
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      w.FS.writeFile(abs, content);
      w.Module.kicadOpenFile(abs);
    },
    { content: cfg.fixture, abs },
  );
  await expect.poll(() => page.title(), { timeout: BOOT_TIMEOUT, intervals: [300] }).toMatch(new RegExp(NAME, "i"));
  return abs;
}

async function focusCanvas(page: Page): Promise<void> {
  const box = await page.locator("#canvas").boundingBox();
  expect(box, "#canvas has a bounding box").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForTimeout(300); // eslint-disable-line -- focus click settle, no JS signal
}

/** Edit, press `chord`, return the number of onSave calls it produced within 10 s. */
async function savesAfter(page: Page, cfg: ToolCfg, chord: string): Promise<number> {
  await page.evaluate(() => {
    (window as unknown as HookWindow).__savedPaths = [];
  });
  await page.evaluate(
    ({ fn, args }) => (window as unknown as HookWindow).Module[fn](...args),
    cfg.modify,
  );
  await page.waitForTimeout(500); // eslint-disable-line -- dirty flag settle (save-hook.spec)
  await focusCanvas(page);
  await page.keyboard.press(chord);
  await page
    .waitForFunction(() => (window as unknown as HookWindow).__savedPaths.length > 0, null, {
      timeout: 10000,
    })
    .catch(() => undefined);
  return page.evaluate(() => (window as unknown as HookWindow).__savedPaths.length);
}

async function expectMetaSaves(page: Page, cfg: ToolCfg): Promise<void> {
  await bootOpen(page, cfg);
  await page.evaluate(() => {
    const w = window as unknown as HookWindow;
    w.__savedPaths = [];
    w.kicadCollab = { ...w.kicadCollab, onSave: (p: string) => w.__savedPaths.push(p) };
  });
  // Control: the Ctrl chord saves in this very session (else the boot is the
  // problem, not the chord).
  expect(await savesAfter(page, cfg, "Control+s"), "Ctrl+S control save").toBeGreaterThan(0);
  // The claim: Cmd+S saves too.
  expect(await savesAfter(page, cfg, "Meta+s"), "Meta+S (Cmd+S) save").toBeGreaterThan(0);
}

const SCH: ToolCfg = {
  html: "eeschema.html",
  ext: "kicad_sch",
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
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
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

test.describe("Cmd+S (Meta+S) saves like Ctrl+S", () => {
  test.describe.configure({ timeout: 300000 });
  // The Playwright device presets carry a WINDOWS user agent; wx.js derives the
  // OS from the UA and only maps the Meta key to wx's ControlDown on a Mac.
  // Pin a macOS UA so the chord is judged the way a Mac browser sends it.
  test.use({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0",
  });

  test("eeschema: Meta+S → onSave", async ({ page, testLogger }) => {
    void testLogger;
    await expectMetaSaves(page, SCH);
  });

  test("pcbnew: Meta+S → onSave", async ({ page, testLogger }) => {
    void testLogger;
    await expectMetaSaves(page, PCB);
  });
});
