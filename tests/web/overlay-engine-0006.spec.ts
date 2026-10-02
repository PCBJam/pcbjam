import { test, expect, type Page } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText, waitForRegistry, shotPath } from '../e2e/utils/element-tracker';

/**
 * Engine hooks the multivibrator tutorial relies on (docs/features/overlay-system/0006 M1):
 *   - KiCad's non-modal tool FRAMES — the simulator and the Footprint Assignment tool (CvPcb) —
 *     report dialogShown / dialogClosed with `modal: false`, so a tour can point into them
 *     (`dialog:` targets), wait for them (`dialogOpen`) and keep its card clear of them (E1);
 *   - the simulator first opens as a band across the bottom of the editor, wide enough for its
 *     whole toolbar: Probe and Tune are targets (E4);
 *   - the board read lists the copper zones with their net, layers and fill state (E5).
 * The simulation events (E2 simFinished, E3 simPlotChanged) need a circuit with models:
 * tests/kicad/eeschema-sim.spec.ts drives them on KiCad's rectifier demo.
 */

type Rect = { x: number; y: number; width: number; height: number };
type EditorEvent = { type: string; cls?: string; modal?: boolean };
interface OverlayHandle {
  resolve(target: string): { rect: Rect } | null;
  onEditorEvent(cb: (e: EditorEvent) => void): () => void;
  openDialog(cls: string): { ptr: string } | null;
}
declare global {
  interface Window {
    __pcbjamOverlay?: OverlayHandle;
    __editorEvents?: EditorEvent[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module: any;
  }
}

async function boot(page: Page, file: string, title: RegExp): Promise<void> {
  await page.goto(`/default/projects/demo/${file}?overlayDemo=1`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect.poll(() => page.title(), { timeout: 150000, intervals: [1000] }).toMatch(title);
  await page.waitForFunction(() => !!window.__pcbjamOverlay, null, { timeout: 60000 });
  await expect(page.locator('div.absolute.inset-0.z-30')).toHaveCount(0, { timeout: 150000 });
  await page.evaluate(() => {
    window.__editorEvents = [];
    window.__pcbjamOverlay!.onEditorEvent((e) => window.__editorEvents!.push(e));
  });
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

async function resolved(page: Page, target: string, timeout = 60000): Promise<Rect> {
  let rect: Rect | null = null;
  await expect
    .poll(async () => (rect = await page.evaluate((t) => window.__pcbjamOverlay!.resolve(t)?.rect ?? null, target)), {
      timeout,
      message: `${target} resolves`,
    })
    .not.toBeNull();
  return rect!;
}

/** wx WASM runs posted follow-ups on the next input event: poll while nudging the mouse. */
async function pumpUntil<T>(page: Page, at: { x: number; y: number }, read: () => Promise<T>, message: string, timeout = 60000): Promise<void> {
  let probe = 0;
  await expect
    .poll(
      async () => {
        await page.mouse.move(at.x + (probe % 5) * 3, at.y + (probe % 3) * 3);
        probe++;
        return read();
      },
      { timeout, intervals: [500], message },
    )
    .toBeTruthy();
}

/** The frame's dialog events as the overlay host parsed them (only dialogShown carries `modal`). */
const frameEvents = (page: Page, cls: string) =>
  page.evaluate(
    (c) => (window.__editorEvents ?? []).filter((e) => e.cls === c).map((e) => (e.type === 'dialogShown' ? `${e.type}:${e.modal}` : e.type)),
    cls,
  );
const dialogOpen = (page: Page, cls: string) => page.evaluate((c) => !!window.__pcbjamOverlay!.openDialog(c), cls);

/** The title-bar × of the top-level window whose title matches. */
const closeButton = (page: Page, title: RegExp) =>
  page.locator('[id^="window-"]').filter({ has: page.locator('.window-titlebar-text', { hasText: title }) }).locator('.window-titlebar-close').first();

test.describe('guide overlay engine hooks (multivibrator tutorial, 0006)', () => {
  test.setTimeout(300000);

  test('eeschema: the simulator is a non-modal frame across the bottom, its whole toolbar a target', async ({ page }) => {
    await boot(page, 'demo.kicad_sch', /Schematic Editor/i);
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const idle = { x: canvas.x + 40, y: canvas.y + 60 };

    const open = await resolved(page, 'tool:eeschema.EditorControl.showSimulator');
    await page.mouse.click(center(open).x, center(open).y);
    await pumpUntil(page, idle, () => dialogOpen(page, 'SIMULATOR_FRAME'), 'the simulator reports it opened', 120000);
    expect(await frameEvents(page, 'SIMULATOR_FRAME')).toEqual(['dialogShown:false']);

    // A band across the bottom of the editor (E4), not 500×400 in the top-left corner.
    const frame = await resolved(page, 'dialog:SIMULATOR_FRAME');
    expect(frame.x - canvas.x, 'left margin').toBeLessThanOrEqual(16);
    expect(canvas.x + canvas.width - (frame.x + frame.width), 'right margin').toBeLessThanOrEqual(16);
    expect(canvas.y + canvas.height - (frame.y + frame.height), 'bottom margin').toBeLessThanOrEqual(16);
    expect(frame.height, 'tall enough for a plot').toBeGreaterThanOrEqual(Math.min(360, canvas.height * 0.5));
    expect(frame.y - canvas.y, 'the sheet stays visible above it').toBeGreaterThan(canvas.height * 0.25);

    // The whole toolbar is drawn: the tools after "Zoom to Fit" were clipped at the old size.
    for (const tool of ['tool:eeschema.Simulation.runSimulation', 'tool:eeschema.Simulation.probe', 'tool:eeschema.Simulation.tune']) {
      expect(inside(await resolved(page, tool), frame), `${tool} inside the simulator`).toBe(true);
    }
    await page.screenshot({ path: shotPath(page, 'overlay-0006-01-simulator.png') });

    await closeButton(page, /Simulator/).click();
    await pumpUntil(page, idle, async () => !(await dialogOpen(page, 'SIMULATOR_FRAME')), 'the simulator reports it closed');
    expect(await frameEvents(page, 'SIMULATOR_FRAME')).toEqual(['dialogShown:false', 'dialogClosed']);
  });

  test('eeschema: the Footprint Assignment tool is a non-modal frame a tour can point into', async ({ page }) => {
    await boot(page, 'demo.kicad_sch', /Schematic Editor/i);
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const idle = { x: canvas.x + 40, y: canvas.y + 60 };

    const open = await resolved(page, 'tool:eeschema.EditorControl.assignFootprints');
    await page.mouse.click(center(open).x, center(open).y);
    await pumpUntil(page, idle, () => dialogOpen(page, 'CVPCB_MAINFRAME'), 'CvPcb reports it opened', 180000);
    expect(await frameEvents(page, 'CVPCB_MAINFRAME')).toEqual(['dialogShown:false']);

    // Its first open loads the footprint libraries under the full-page loading cover: wait until
    // the filter box is the element under its centre again.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const r = window.__pcbjamOverlay!.resolve('dialog:CVPCB_MAINFRAME/control:textctrl')?.rect;
            return !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName === 'INPUT';
          }),
        { timeout: 180000, intervals: [500], message: 'filter box uncovered (libraries loaded)' },
      )
      .toBe(true);
    const frame = await resolved(page, 'dialog:CVPCB_MAINFRAME');
    // The tutorial's targets: the footprint filter box and OK.
    const filter = await resolved(page, 'dialog:CVPCB_MAINFRAME/control:textctrl');
    const ok = await resolved(page, 'dialog:CVPCB_MAINFRAME/control:button:OK');
    expect(inside(filter, frame), 'filter box inside CvPcb').toBe(true);
    expect(inside(ok, frame), 'OK inside CvPcb').toBe(true);
    await page.screenshot({ path: shotPath(page, 'overlay-0006-02-cvpcb.png') });

    const cancel = await resolved(page, 'dialog:CVPCB_MAINFRAME/control:button:Cancel');
    await page.mouse.click(center(cancel).x, center(cancel).y);
    await pumpUntil(page, idle, async () => !(await dialogOpen(page, 'CVPCB_MAINFRAME')), 'CvPcb reports it closed');
    expect(await frameEvents(page, 'CVPCB_MAINFRAME')).toEqual(['dialogShown:false', 'dialogClosed']);
  });

  test('pcbnew: the board read lists copper zones with their net, layers and fill state', async ({ page }) => {
    await boot(page, 'demo.kicad_pcb', /PCB Editor/i);
    const zones = () => page.evaluate(() => JSON.parse(window.Module.kicadBoardStatus()).zones as { net: string; layers: string[]; filled: boolean }[]);
    expect(await zones()).toEqual([{ net: 'GND', layers: ['B.Cu'], filled: true }]);

    const canvas = (await page.locator('#canvas').boundingBox())!;
    const idle = { x: canvas.x + canvas.width * 0.85, y: canvas.y + canvas.height * 0.85 };
    expect(await clickMenuBarItem(page, 'Edit'), 'Edit menu').toBe(true);
    await clickMenuItemByText(page, 'Unfill All Zones');
    await pumpUntil(page, idle, async () => (await zones())[0]?.filled === false, 'unfilled');

    expect(await clickMenuBarItem(page, 'Edit'), 'Edit menu').toBe(true);
    await clickMenuItemByText(page, 'Fill All Zones');
    await pumpUntil(page, idle, async () => (await zones())[0]?.filled === true, 'filled again', 120000);
    await page.screenshot({ path: shotPath(page, 'overlay-0006-03-zones.png') });
  });
});
