import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * ysync bug 07 (UP side) — `kicadCollabApplyItems` runs deferred on whatever
 * sheet is shown WHEN IT RUNS. The binding stamps each envelope with its
 * room's project-relative sheet path; the tool must drop an envelope whose
 * `sheet` is not the shown screen (8/28 mega-demo-v2: the root's `(sheet …)`
 * items were applied onto a subsheet, which then referenced itself and could
 * not be loaded). Untagged envelopes keep the legacy behaviour.
 */

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabApplyItems(j: string): unknown;
  kicadSaveSchematic(p: string): unknown;
};
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};

const BOOT_TIMEOUT = 150000;
const DIR = "/home/kicad/documents/Arduino Mega 2560";
const REL = "Arduino Mega 2560/root.kicad_sch";

const FIXTURE = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "11111111-1111-1111-1111-111111111111")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))
	(sheet_instances (path "/" (page "1")))
)
`;

const text = (label: string, uuid: string) =>
  `(text "${label}" (exclude_from_sim no) (at 60.96 60.96 0) (effects (font (size 1.27 1.27))) (uuid "${uuid}"))`;
const WRONG = "33333333-0000-0000-0000-0000000000aa";
const RIGHT = "33333333-0000-0000-0000-0000000000bb";
const PLAIN = "33333333-0000-0000-0000-0000000000cc";

async function saveRead(page: Page): Promise<string> {
  return page.evaluate((dir) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const out = `${dir}/probe.kicad_sch`;
    w.Module.kicadSaveSchematic(out);
    return w.FS.readFile(out, { encoding: "utf8" });
  }, DIR);
}

test.describe("eeschema applyItems sheet guard (ysync bug 07 UP side)", () => {
  test.describe.configure({ timeout: 420000 });

  test("an envelope tagged for another sheet is dropped; the shown sheet's and untagged ones apply", async ({
    page,
    testLogger,
  }) => {
    await page.goto("/kicad/eeschema.html");
    await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.waitForFunction(
      () => {
        const m = (window as unknown as { Module?: Partial<Mod> }).Module;
        return typeof m?.kicadOpenFile === "function" && typeof m?.kicadCollabApplyItems === "function";
      },
      null,
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
      ({ dir, content }) => {
        const w = window as unknown as { FS: FS; Module: Mod };
        w.FS.mkdirTree(dir);
        w.FS.writeFile(`${dir}/root.kicad_sch`, content);
        w.Module.kicadOpenFile(`${dir}/root.kicad_sch`);
      },
      { dir: DIR, content: FIXTURE },
    );
    await expect.poll(async () => (await saveRead(page)).includes("22222222-0000"), {
      timeout: 60000,
      intervals: [500],
    }).toBe(true);

    // Applies are serialized on the tool's coroutine: wrong → right → plain.
    await page.evaluate(
      ({ wrong, right, plain, rel }) => {
        const m = (window as unknown as { Module: Mod }).Module;
        m.kicadCollabApplyItems(JSON.stringify({ added: [{ sexpr: wrong }], sheet: "Arduino Mega 2560/ATMEGA2560-16AU.kicad_sch" }));
        m.kicadCollabApplyItems(JSON.stringify({ added: [{ sexpr: right }], sheet: rel }));
        m.kicadCollabApplyItems(JSON.stringify({ added: [{ sexpr: plain }] }));
      },
      { wrong: text("Wrong", WRONG), right: text("Right", RIGHT), plain: text("Plain", PLAIN), rel: REL },
    );

    await expect.poll(async () => (await saveRead(page)).includes(PLAIN), {
      timeout: 25000,
      intervals: [400],
    }).toBe(true);
    const saved = await saveRead(page);
    expect(saved, "shown-sheet envelope applied").toContain(RIGHT);
    expect(saved, "foreign-sheet envelope dropped").not.toContain(WRONG);
    expect(
      testLogger.consoleLogs.some((l) => l.includes("[collab] applyItems dropped")),
      "drop is logged",
    ).toBe(true);
    expect([...testLogger.consoleLogs, ...testLogger.errors].some((s) => s.includes("Aborted(")), "no WASM abort").toBe(false);
  });
});
