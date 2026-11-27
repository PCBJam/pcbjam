import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { findNativeFailure } from "./utils/native-failure";
import { clickWxButton, findWxButton, pendingModalWaits } from "./utils/wx-dialogs";

/**
 * File > Plot on a board whose pads have a shape per layer (custom padstacks), then the router.
 *
 * KiCad's plot code sets a pad's size for the layer it plots. In a custom padstack that write made
 * a new entry for the mask, paste and silkscreen layers; the router took the entry for a copper
 * layer the next time it read the board and stopped on an assertion (pns_index.cpp), its tool
 * stuck. KiCad fixed the write on its 10.0 branch (issue 25636, PADSTACK::CopperLayer); our fork
 * carries those lines until the rebase that brings them.
 *
 * The board is KiCad's own qa/data/pcbnew/padstacks_complex.
 */

const BOARD = path.resolve(__dirname, "../fixtures/padstacks/padstacks_complex.kicad_pcb");
const DOCS = "/home/kicad/documents";

type Mod = { kicadOpenFile(p: string): unknown; kicadTestRunAction(name: string): boolean; kicadPluginSelectItems(uuidsJson: string): string };
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void; readdir(p: string): string[] };
type W = { Module: Mod; FS: FS };

async function bootAndOpen(page: Page): Promise<void> {
  const name = path.basename(BOARD);
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadPluginSelectItems === "function", null, { timeout: 90000 });
  await page.waitForFunction(
    () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({ visible: true }).some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 90000 },
  );
  await page.evaluate(({ dir, name, content, project }) => {
    const w = window as unknown as W;
    try { w.FS.mkdirTree(dir); } catch { /* exists */ }
    w.FS.writeFile(`${dir}/${name.replace(/\.kicad_pcb$/, ".kicad_pro")}`, project);
    w.FS.writeFile(`${dir}/${name}`, content);
    w.Module.kicadOpenFile(`${dir}/${name}`);
  }, { dir: DOCS, name, content: fs.readFileSync(BOARD, "utf8"), project: fs.readFileSync(BOARD.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8") });
  await expect.poll(() => page.title(), { timeout: 90000, intervals: [500] }).toMatch(/padstacks_complex/i);
}

/** Runs a KiCad action by name; resolves once KiCad has run it (kicadTestRunAction queues it and reports back). */
function action(page: Page, name: string): Promise<boolean> {
  return page.evaluate((name) => new Promise<boolean>((resolve) => {
    const done = (e: Event) => {
      if ((e as CustomEvent<{ name: string }>).detail?.name !== name) return;
      window.removeEventListener("pcbjam:test-action-done", done);
      resolve(true);
    };
    window.addEventListener("pcbjam:test-action-done", done);
    if (!(window as unknown as W).Module.kicadTestRunAction(name)) resolve(false);
  }), name);
}

/** Whether a tool is running: an empty selection request is refused with TOOL_ACTIVE while one is. */
const toolState = (page: Page) =>
  page.evaluate(() => {
    const reply = JSON.parse((window as unknown as W).Module.kicadPluginSelectItems("[]")) as { ok: boolean; error?: string };
    return reply.ok ? "idle" : reply.error;
  });

const plotted = (page: Page) =>
  page.evaluate((dir) => (window as unknown as W).FS.readdir(dir).filter((name) => /\.(gbr|gbrjob)$/.test(name)).sort(), DOCS);

test("after File > Plot on a board with custom padstacks the router starts and can be left", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  expect(await toolState(page)).toBe("idle");

  // The Plot dialog with its defaults: Gerbers of the board's layers next to the board.
  const modals = await pendingModalWaits(page);
  // Not awaited to its end: the dialog holds the action until it closes.
  expect(await page.evaluate(() => (window as unknown as W).Module.kicadTestRunAction("common.Control.plot"))).toBe(true);
  await expect.poll(() => findWxButton(page, "Plot"), { message: "the Plot dialog opens", timeout: 30000 }).not.toBeNull();
  expect(await clickWxButton(page, "Plot")).toBe(true);
  await expect.poll(() => plotted(page), { message: "the layers and the job file are written", timeout: 30000 })
    .toEqual(expect.arrayContaining(["padstacks_complex-Top Layer.gbr", "padstacks_complex-Top Solder.gbr", "padstacks_complex-Top Paste.gbr", "padstacks_complex-job.gbrjob"]));
  expect(await clickWxButton(page, "Close")).toBe(true);
  await expect.poll(() => pendingModalWaits(page), { message: "the Plot dialog closes", timeout: 15000 }).toBe(modals);

  // The router reads every pad when it starts.
  expect(await action(page, "pcbnew.InteractiveRouter.SingleTrack")).toBe(true);
  expect(await toolState(page)).toBe("TOOL_ACTIVE");
  // The toolbar's arrow leaves it.
  expect(await action(page, "common.InteractiveSelection.selectionTool")).toBe(true);
  await expect.poll(() => toolState(page), { timeout: 15000 }).toBe("idle");

  expect(findNativeFailure([...testLogger.consoleLogs, ...testLogger.errors])).toBeUndefined();
});
