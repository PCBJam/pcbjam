import { test, expect, type Page } from '@playwright/test';
import { shotPath } from '../e2e/utils/element-tracker';

/**
 * "E" (Properties...) on a HOVERED item — user report 2026-10-09:
 *
 *   "to fully access the properties of an object, the hotkey is E. This is
 *    not implemented."
 *
 * In desktop KiCad, E needs no selection: with the selection empty,
 * EDIT_TOOL::Properties → PCB_SELECTION_TOOL::RequestSelection runs
 * ACTIONS::selectionCursor, which selects whatever sits under the mouse
 * cursor and opens its dialog (after KiCad's clarify list when several items
 * are under the cursor). Users hover a part and press E. Reported for PCBJam:
 * E only works after the part was clicked (selected) first.
 *
 * Cause (probed 2026-10-09): during frame construction wx focus lands on the
 * Search pane's text box (wxDomFocus on a wx-dom <input>); the pane is then
 * hidden, but wxWindowWasm::Show(false) leaves gs_focusWindow on the hidden
 * box. The page has focus and the keydown arrives, but wx hands it to the
 * invisible text control, and KIUI::IsInputControlFocused() stops
 * WX_VIEW_CONTROLS::onEnter from moving focus to the canvas on hover. Any
 * click (canvas or panel) moves wx focus off the box, so each test starts
 * from a different focus state and ends the same way: mouse over the part,
 * nothing selected, press E, a Properties dialog must open.
 *
 * Writer session on the reference backend's demo project (no `?readonly=1`).
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabGetSelection(): string;
  kicadCollabGetViewport(): string;
  kicadCollabGetPos(id: string): string;
  kicadCollabTestSelectComponent(): string;
  kicadCollabTestClearSelection(): boolean;
};
type W = { Module: Mod };
type Pt = { x: number; y: number };

async function bootBoard(page: Page): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=props-${test.info().workerIndex}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/demo — PCB Editor/i);
  // Boot + lib fat-load overlays gone before geometry/selection is trusted.
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

const selection = (pg: Page) =>
  pg.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()) as unknown[]);

/** Visible non-file dialogs (the pre-created wxFileDialog reads visible at
 *  boot — quasimodal-strand.spec.ts). */
const openDialogs = (pg: Page) =>
  pg.evaluate(() =>
    window.wxElementRegistry
      .findAll({ visible: true })
      .filter((e) => /Dialog/i.test(e.typeName) && e.typeName !== 'wxFileDialog')
      .map((e) => `${e.typeName}:${e.label || e.name}`),
  );

/** Any open wx popup menu (KiCad's clarify-selection list renders as one). */
const popupCount = (pg: Page) => pg.locator('.wx-menu-popup').count();

/** The visible GL canvas's CSS rect. */
const glRect = (pg: Page) =>
  pg.evaluate(() => {
    const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
    }) as HTMLElement;
    const r = gl.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

/** World position (IU, "x,y") → CSS pixels through the live GAL viewport
 *  (read-only-editor.spec.ts screenPosOf). */
async function toScreen(pg: Page, worldCsv: string): Promise<Pt> {
  return pg.evaluate((csv: string) => {
    const win = window as unknown as W;
    const [wx, wy] = csv.split(',').map(Number);
    const vp = JSON.parse(win.Module.kicadCollabGetViewport()) as {
      cx: number; cy: number; scale: number; w: number; h: number;
    };
    const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
    }) as HTMLElement;
    const r = gl.getBoundingClientRect();
    const ratio = r.width / vp.w;
    return {
      x: r.x + ((wx - vp.cx) * vp.scale + vp.w / 2) * ratio,
      y: r.y + ((wy - vp.cy) * vp.scale + vp.h / 2) * ratio,
    };
  }, worldCsv);
}

/** The first footprint's anchor in world units. The test hook selects it only
 *  to learn its uuid; the selection is cleared again before return. */
async function firstFootprintWorld(pg: Page): Promise<string> {
  const id = await pg.evaluate(() => (window as unknown as W).Module.kicadCollabTestSelectComponent());
  expect(id, 'demo board has a footprint').toBeTruthy();
  const world = await pg.evaluate((i) => (window as unknown as W).Module.kicadCollabGetPos(i), id);
  await pg.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
  await expect.poll(async () => (await selection(pg)).length).toBe(0);
  console.log(`[props-e] footprint ${id} world=${world}`);
  return world;
}

/**
 * Rest the pointer on `world`. Re-aims until the mapping holds still: a late
 * infobar ("N WRL 3D models could not be matched") can push the canvas down
 * after boot, moving every board point on screen.
 */
async function hoverWorld(pg: Page, world: string): Promise<Pt> {
  let at: Pt = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        at = await toScreen(pg, world);
        await pg.mouse.move(at.x, at.y, { steps: 10 });
        const again = await toScreen(pg, world);
        return Math.hypot(again.x - at.x, again.y - at.y) < 1;
      },
      { timeout: 30000, message: 'board point never held still on screen' },
    )
    .toBe(true);
  const r = await glRect(pg);
  expect(at.x > r.x && at.x < r.x + r.w && at.y > r.y && at.y < r.y + r.h, 'target inside the canvas').toBe(true);
  return at;
}

/**
 * Press E with the pointer resting on the footprint and nothing selected; a
 * Properties dialog must open. When several items sit under the cursor KiCad
 * pops its clarify list first (desktop does the same) — pick entry 1.
 */
async function pressEExpectProperties(pg: Page, world: string, shot: string): Promise<void> {
  const at = await hoverWorld(pg, world);
  // Documented interaction dwell: the asyncified pointer-move handler needs
  // wall-clock time to update KiCad's world cursor (pcbnew-move.spec.ts).
  await pg.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: pointer-move → world cursor has no page-observable
  expect(await selection(pg), 'hovering must not select').toEqual([]);
  expect(await openDialogs(pg), 'no dialog before E').toEqual([]);

  await pg.keyboard.press('e');
  const reacted = async () => (await openDialogs(pg)).length > 0 || (await popupCount(pg)) > 0;
  await expect
    .poll(reacted, {
      timeout: 20000,
      message:
        'E with the pointer on a footprint (nothing selected) should open its Properties dialog ' +
        '(or the clarify list first) — desktop KiCad acts on the hovered item',
    })
    .toBe(true)
    .catch(async (e) => {
      await pg.screenshot({ path: shotPath(pg, `${shot}-no-reaction.png`), scale: 'css' });
      console.log(
        `[props-e] ${shot}: no reaction at (${at.x.toFixed(0)},${at.y.toFixed(0)}); ` +
          `focus=${await pg.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`,
      );
      throw e;
    });
  if ((await openDialogs(pg)).length === 0) {
    await pg.locator('.wx-menu-popup > div').filter({ hasText: /^\s*1\s/ }).first().click();
    await expect
      .poll(() => openDialogs(pg), { timeout: 20000, message: 'clarify entry 1 should open its Properties dialog' })
      .not.toEqual([]);
  }
  console.log(`[props-e] ${shot}: dialogs=${JSON.stringify(await openDialogs(pg))}`);
  await pg.screenshot({ path: shotPath(pg, `${shot}.png`), scale: 'css' });
  await pg.keyboard.press('Escape');
}

test.describe('Properties hotkey (E)', () => {
  test('control: click a footprint, then E opens a Properties dialog', async ({ page }) => {
    test.setTimeout(300000);
    await bootBoard(page);
    const world = await firstFootprintWorld(page);
    const at = await hoverWorld(page, world);

    // Real click: selects (or pops the clarify list when items overlap → 1).
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(async () => (await selection(page)).length > 0 || (await popupCount(page)) > 0, {
        timeout: 20000,
        message: 'click on the footprint should select it or pop the clarify list',
      })
      .toBe(true);
    if ((await selection(page)).length === 0) {
      await page.locator('.wx-menu-popup > div').filter({ hasText: /^\s*1\s/ }).first().click();
      await expect.poll(async () => (await selection(page)).length).toBeGreaterThan(0);
    }

    await page.keyboard.press('e');
    await expect
      .poll(() => openDialogs(page), {
        timeout: 20000,
        message: 'E on a SELECTED item should open its Properties dialog',
      })
      .not.toEqual([]);
    console.log(`[props-e] control: dialogs=${JSON.stringify(await openDialogs(page))}`);
    await page.screenshot({ path: shotPath(page, 'web-properties-hotkey-selected.png'), scale: 'css' });
    await page.keyboard.press('Escape');
  });

  test('hover + E after clicking empty canvas', async ({ page }) => {
    test.setTimeout(300000);
    await bootBoard(page);
    const world = await firstFootprintWorld(page);
    // Focus the drawing canvas with a click on board-free space (the GL
    // canvas's top-left corner; the demo board boots zoom-fit, centred).
    const r = await glRect(page);
    await page.mouse.click(r.x + 40, r.y + 40);
    await expect.poll(async () => (await selection(page)).length).toBe(0);

    await pressEExpectProperties(page, world, 'web-properties-hotkey-hover-after-canvas-click');
  });

  test('hover + E straight after opening the board (no click at all)', async ({ page }) => {
    test.setTimeout(300000);
    await bootBoard(page);
    const world = await firstFootprintWorld(page);
    // The user's flow: open the project, point at a part, press E.
    await pressEExpectProperties(page, world, 'web-properties-hotkey-hover-fresh');
  });

  test('hover + E after clicking a side panel', async ({ page }) => {
    test.setTimeout(300000);
    await bootBoard(page);
    const world = await firstFootprintWorld(page);
    // Click the (already active) "Layers" tab of the appearance panel: no
    // state change, but wx focus leaves the canvas — the everyday case of
    // touching a panel, then going back to the board.
    const layersTab = await page.evaluate(() => {
      const tab = window.wxElementRegistry
        .findAllRendered?.({ elementType: 'tab' })
        .find((t) => (t.label || '').trim() === 'Layers');
      return tab ? { x: tab.centerX, y: tab.centerY } : null;
    });
    expect(layersTab, 'appearance panel "Layers" tab rendered').not.toBeNull();
    await page.mouse.click(layersTab!.x, layersTab!.y);

    await pressEExpectProperties(page, world, 'web-properties-hotkey-hover-after-panel-click');
  });
});
