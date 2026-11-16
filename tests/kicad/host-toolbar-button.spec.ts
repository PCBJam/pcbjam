import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { clickByTooltip, findAll, findByTooltip } from "../e2e/utils/element-tracker";

/**
 * A button of the page on the schematic editor's top toolbar
 * (wasm/stubs/host_toolbar_buttons.h, wasm/bindings/host_toolbar_button.h).
 *
 * KiCad draws it: it is an "action" of an API plugin as far as KiCad's toolbar
 * code can tell, and in this build the plugin manager is a file of ours. Live
 * simulation's Play button is the first user. Against the real editor:
 *
 *   - there is no such button until the page asks for one;
 *   - Module.kicadSchToolbarButton(id, tooltip, icon) puts it on the top
 *     toolbar, in the row of KiCad's own tools, which all stay. KiCad puts
 *     plugin buttons at the END of that toolbar, after "Switch to PCB Editor"
 *     and the variant list: about 1420 px from the left. The test window is
 *     made wide enough to have that place on screen;
 *   - a click tells the page: Module.onHostToolbarButton(id);
 *   - the same call with another tooltip and icon changes the button in place
 *     (Play becomes Stop), and a click still tells the page;
 *   - an icon name the build does not know is refused and changes nothing;
 *   - an empty icon takes the button away;
 *   - through all of it the toolbars keep the size the window leaves them.
 *     KiCad rebuilds its toolbars for every such change and, for this kind of
 *     change, does not lay the frame out after; a toolbar then takes the size
 *     it would like to have, runs out of the window and loses its arrow for
 *     the tools that do not fit. Our side lays the frame out (api_plugin_stub).
 */

type Mod = {
  kicadSchToolbarButton(id: string, tooltip: string, icon: string): boolean;
  onHostToolbarButton?: (id: string) => void;
};
type W = { Module: Mod; __toolbarClicks: string[] };

const BOOT_TIMEOUT = 150000;
const ID = "com.pcbjam.sim.play";
const PLAY = "Run live simulation";
const STOP = "Stop live simulation";
/** Two of KiCad's own tools on the same toolbar; the second is its last. */
const NEIGHBOUR = "Electrical Rules Checker";
const LAST = "Switch to PCB Editor";
const WIDTH = 1600;
const HEIGHT = 720;

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadSchToolbarButton === "function",
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
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__toolbarClicks = [];
    w.Module.onHostToolbarButton = (id) => { w.__toolbarClicks.push(id); };
  });
}

const tool = (page: Page, tooltip: string) => findByTooltip(page, tooltip, { elementType: "tool" });

const setButton = (page: Page, tooltip: string, icon: string): Promise<boolean> =>
  page.evaluate(({ id, tooltip, icon }) => (window as unknown as W).Module.kicadSchToolbarButton(id, tooltip, icon),
    { id: ID, tooltip, icon });

const clicks = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as W).__toolbarClicks);

/**
 * The toolbar is rebuilt from the event loop, and this port turns the loop on
 * input: nudge the mouse at every poll.
 */
async function expectTool(page: Page, tooltip: string, there: boolean, message: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.mouse.move(4, 4);
      await page.mouse.move(8, 8);
      return !!(await tool(page, tooltip));
    }, { message, timeout: 30000 })
    .toBe(there);
}

type Bar = { x: number; y: number; w: number; h: number };

/** The editor's toolbars as they are laid out now, left to right, top to bottom. */
async function toolbars(page: Page): Promise<Bar[]> {
  const all = await findAll(page, { visible: true });
  return all
    .filter((e) => /ToolBar/i.test(e.typeName))
    .map((e) => ({ x: Math.round(e.screenX), y: Math.round(e.screenY), w: Math.round(e.width), h: Math.round(e.height) }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Every toolbar is inside the window, and where and as large as it was (2 px of rounding). */
async function expectToolbarsAsBefore(page: Page, before: Bar[], message: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.mouse.move(4, 4);
      await page.mouse.move(8, 8);
      const now = await toolbars(page);
      if (now.length !== before.length) return `${now.length} toolbars, were ${before.length}`;
      for (const [i, bar] of now.entries()) {
        const was = before[i];
        if (bar.x + bar.w > WIDTH + 1 || bar.y + bar.h > HEIGHT + 1) return `out of the window: ${JSON.stringify(bar)}`;
        if (Math.abs(bar.x - was.x) > 2 || Math.abs(bar.y - was.y) > 2 || Math.abs(bar.w - was.w) > 2 || Math.abs(bar.h - was.h) > 2)
          return `was ${JSON.stringify(was)}, is ${JSON.stringify(bar)}`;
      }
      return "as before";
    }, { message, timeout: 30000 })
    .toBe("as before");
}

test.describe("a button of the page on the schematic editor's toolbar", () => {
  test.describe.configure({ timeout: 300000 });

  test("is drawn by KiCad, tells the page about a click, changes and goes away", async ({ page }) => {
    await boot(page);

    const neighbour = await tool(page, NEIGHBOUR);
    expect(neighbour, "KiCad's own tool is on the toolbar").not.toBeNull();
    expect(await tool(page, PLAY), "no button before the page asks for one").toBeNull();
    const bars = await toolbars(page);
    expect(bars.length, "the editor's toolbars are up").toBeGreaterThanOrEqual(3);

    // Play appears, in the row of KiCad's own tools.
    expect(await setButton(page, PLAY, "sim_run")).toBe(true);
    await expectTool(page, PLAY, true, "the button is on the toolbar");
    const play = (await tool(page, PLAY))!;
    expect(play.enabled).toBe(true);
    const row = (await tool(page, NEIGHBOUR))!;
    expect(row, "KiCad's own tools stay").not.toBeNull();
    expect(Math.abs(row.centerX - neighbour!.centerX), "and stay where they were").toBeLessThanOrEqual(1);
    expect(Math.abs(play.centerY - row.centerY), "in the same row as KiCad's tools").toBeLessThanOrEqual(2);
    expect(Math.abs(play.height - row.height), "the same size as its neighbours").toBeLessThanOrEqual(2);
    const last = (await tool(page, LAST))!;
    expect(last, "the toolbar's last tool of KiCad's own").not.toBeNull();
    expect(play.screenX, "at the end of the toolbar, where KiCad puts plugin buttons").toBeGreaterThan(last.screenX + last.width);
    expect(play.screenX + play.width, "on screen in a window this wide").toBeLessThan(WIDTH);
    await expectToolbarsAsBefore(page, bars, "the toolbars still fit the window with the button on");

    // A click tells the page, once.
    expect(await clickByTooltip(page, PLAY, { elementType: "tool" })).toBe(true);
    await expect.poll(() => clicks(page), { message: "the page hears the click", timeout: 30000 }).toEqual([ID]);

    // The same button becomes Stop.
    expect(await setButton(page, STOP, "sim_stop")).toBe(true);
    await expectTool(page, STOP, true, "the button changed to Stop");
    expect(await tool(page, PLAY), "there is one button, not two").toBeNull();
    const stop = (await tool(page, STOP))!;
    expect(Math.abs(stop.centerX - play.centerX), "in the same place").toBeLessThanOrEqual(2);
    await expectToolbarsAsBefore(page, bars, "the toolbars still fit the window after the change");
    expect(await clickByTooltip(page, STOP, { elementType: "tool" })).toBe(true);
    await expect.poll(() => clicks(page), { message: "the page hears the second click", timeout: 30000 }).toEqual([ID, ID]);

    // An icon the build does not know: refused, and nothing changes.
    expect(await setButton(page, PLAY, "no_such_icon")).toBe(false);
    await page.mouse.move(4, 4);
    await page.mouse.move(8, 8);
    expect(await tool(page, STOP), "still Stop").not.toBeNull();

    // And away again; KiCad's tools stay.
    expect(await setButton(page, "", "")).toBe(true);
    await expectTool(page, STOP, false, "the button is gone");
    const still = await tool(page, NEIGHBOUR);
    expect(still, "KiCad's own tools stay").not.toBeNull();
    expect(Math.abs(still!.centerX - neighbour!.centerX), "where they were").toBeLessThanOrEqual(1);
    await expectToolbarsAsBefore(page, bars, "the toolbars still fit the window with the button gone");
    expect(await clicks(page), "no click was made up").toEqual([ID, ID]);
  });
});
