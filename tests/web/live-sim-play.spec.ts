import { test, expect, type Page, type Route } from '@playwright/test';
import { clickByTooltip, findAll, findByTooltip } from '../e2e/utils/element-tracker';
import { openOverlayMenu } from './overlay-menu';

/**
 * Live simulation, Play and Stop (web/standalone/src/wasm/live-session.ts), in
 * the real app. Play is in two places: a button on the schematic editor's own
 * toolbar, and a row of the Session menu that does the same.
 *
 *   - without the `liveSimulation` toggle there is neither;
 *   - with it, KiCad's toolbar has "Run live simulation". A click reads the
 *     schematic, builds its circuit and runs it in the live engine: the button
 *     becomes "Stop live simulation" only once the circuit's first moment is
 *     solved. A click on Stop brings Play back, and it plays again;
 *   - a symbol nobody has a model for is left out: the rest of the circuit
 *     runs, a notice names the symbol and the sheet marks it;
 *   - a circuit the simulator does not run stays on Play and says why, in the
 *     simulator's words;
 *   - KiCad puts the button at the far end of its toolbar, which a window of
 *     the usual size does not show. The Session menu's row plays and stops
 *     there, and also with the UI hidden, where there is no toolbar at all;
 *     the toolbars then stay hidden.
 *
 * The schematics are tests/fixtures/demo/live-sim: `run` is a 5 V source and
 * a resistor; `no-model` adds a diode nobody has a model for (KiCad writes a
 * line that names its Value, "red", as the model); in `raw-model` the diode
 * asks for exactly that line itself (Sim.Device "SPICE"), so it is the user's
 * own line and stays in the circuit.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with a library that has no parts: every symbol runs with
 * KiCad's own model. The reference backend has no /api/me; the test answers
 * that too.
 *
 * Needs a wasm build with kicadSimNetlist and kicadSchToolbarButton, and an
 * ngspice_service with the live engine: rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';
const PLAY = 'Run live simulation';
const STOP = 'Stop live simulation';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function answerSession(page: Page, liveSimulation: boolean): Promise<void> {
  await page.route('**/api/me', (route) => {
    const origin = route.request().headers()['origin'] ?? '*';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ user: null, features: { liveSimulation } }),
    });
  });
}

/** A library with no parts. */
async function serveEmptyLibrary(page: Page): Promise<void> {
  const files: Record<string, unknown> = {
    'current.json': { schema: 1, version: SNAPSHOT },
    [`${SNAPSHOT}/index.json`]: { schema: 1, version: SNAPSHOT, parts: [], emulators: [] },
  };
  await page.route('**/e2e-sim-library/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, '');
    return path in files ? json(route, files[path]) : route.fulfill({ status: 404, body: 'not found' });
  });
}

async function bootSchematic(page: Page, file: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${file}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

const tool = (page: Page, tooltip: string) => findByTooltip(page, tooltip, { elementType: 'tool' });

/** The Session menu's row: its words, and where the run stands (`data-live-state`). */
const menuRow = (page: Page) => page.getByTestId('live-sim-toggle');

async function closeOverlayMenu(page: Page): Promise<void> {
  if (await page.getByTestId('overlay-menu-panel').count()) await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
}

/** How many of KiCad's toolbars are on screen. */
async function visibleToolbars(page: Page): Promise<number> {
  return (await findAll(page, { visible: true })).filter((e) => /ToolBar/i.test(e.typeName)).length;
}

/**
 * KiCad rebuilds its toolbar from the event loop, and the wasm port turns the
 * loop on input: nudge the mouse over the canvas at every poll.
 */
async function expectTool(page: Page, tooltip: string, there: boolean, message: string, timeout = 60000): Promise<void> {
  const box = (await page.locator('#canvas').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await expect
    .poll(async () => {
      await page.mouse.move(x, y);
      await page.mouse.move(x + 4, y + 4);
      return !!(await tool(page, tooltip));
    }, { message, timeout })
    .toBe(there);
}

test.describe('live simulation: Play and Stop', () => {
  // KiCad puts plugin buttons at the end of its top toolbar, about 1420 px from
  // the left: a window wide enough to have that place on screen.
  test.use({ viewport: { width: 1600, height: 720 } });

  test('without the toggle there is no button', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page, false);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');
    // KiCad's own simulator button is there; ours is not, also after the loop has turned
    await expectTool(page, 'Simulator', true, "KiCad's toolbar is up");
    expect(await tool(page, PLAY)).toBeNull();
    await openOverlayMenu(page);
    await expect(menuRow(page), 'and the Session menu has no row for it').toHaveCount(0);
  });

  test('Play runs the circuit of the schematic; Stop halts it', async ({ page }) => {
    test.setTimeout(300000);
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (/ngspice_service\.(js|wasm)/.test(r.url())) fetched.push(r.url());
    });
    await answerSession(page, true);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(fetched, 'the engine is not fetched before the first Play').toEqual([]);

    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    // Stop appears only when the circuit runs: its first moment is solved.
    await expectTool(page, STOP, true, 'the circuit runs: the button is Stop');
    expect(await tool(page, PLAY), 'one button, not two').toBeNull();
    expect(fetched.length, 'the engine was fetched for the run').toBeGreaterThan(0);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    // the Session menu's row says the same
    await openOverlayMenu(page);
    await expect(menuRow(page)).toHaveAttribute('data-live-state', 'running');
    await expect(menuRow(page)).toHaveText(STOP);
    await closeOverlayMenu(page);

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'stopped: the button is Play again');
    expect(await tool(page, STOP)).toBeNull();

    // and once more
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, true, 'it plays again');
    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'and stops again');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });

  test('a symbol nobody has a model for is left out; the rest runs and the page says which one', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page, true);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/no-model.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, true, 'the circuit runs without D1: the button is Stop');
    await expect(page.getByTestId('live-sim-note'), 'a notice names the symbol').toContainText(
      'D1 is not simulated: nothing has a model for it. The rest of the circuit runs.',
    );
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    // and the sheet marks it
    const layer = page.getByTestId('live-layer');
    await expect(layer).toHaveAttribute('data-left-out', '1', { timeout: 30000 });
    await expect(layer.getByTestId('live-left-out')).toHaveAttribute('data-ref', 'D1');

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'stopped: the button is Play again');
    await expect(layer, 'the marks go with the run').toHaveCount(0);
  });

  test('a circuit the simulator does not run says why and stays on Play', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page, true);
    await serveEmptyLibrary(page);
    // D1 asks for the line "D1 ... red" itself: the user's own line is not left out
    await bootSchematic(page, 'live-sim/raw-model.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);

    const error = page.getByTestId('live-sim-error');
    await expect(error).toBeVisible({ timeout: 60000 });
    await expect(error).toContainText('Live simulation did not start: ngspice did not run the circuit');
    // the simulator's own words name the line and the model nobody defines
    await expect(error).toContainText(/d1 .*red/i);
    expect(await tool(page, PLAY), 'the button is still Play').not.toBeNull();
    expect(await tool(page, STOP)).toBeNull();
  });
});

test.describe('live simulation: Play and Stop in the Session menu', () => {
  // The suite's usual window (1280 px wide): the far end of KiCad's toolbar,
  // where the button is, is not on screen.

  async function expectRow(page: Page, state: string, words: string, message: string): Promise<void> {
    await openOverlayMenu(page);
    await expect(menuRow(page), message).toHaveAttribute('data-live-state', state, { timeout: 60000 });
    await expect(menuRow(page)).toHaveText(words);
  }

  test('the row plays and stops, in a window that does not show the toolbar button', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page, true);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');
    await expectTool(page, 'Simulator', true, "KiCad's toolbar is up");

    await expectRow(page, 'idle', PLAY, 'the menu has the Play row');
    await menuRow(page).click();
    await expect(page.getByTestId('overlay-menu-panel'), 'the click closes the menu').toHaveCount(0);
    await expectRow(page, 'running', STOP, 'the circuit runs: the row is Stop');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    await menuRow(page).click();
    await expectRow(page, 'idle', PLAY, 'stopped: the row is Play again');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });

  test('with the UI hidden the row plays and stops, and the toolbars stay hidden', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page, true);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');
    await expectTool(page, 'Simulator', true, "KiCad's toolbar is up");
    expect(await visibleToolbars(page), 'toolbars are on screen before the UI is hidden').toBeGreaterThan(0);

    await page.keyboard.press('Control+\\');
    await expect.poll(() => visibleToolbars(page), { message: 'the UI is hidden', timeout: 15000 }).toBe(0);

    // Play and Stop each make KiCad rebuild its toolbars: they must not come back.
    await expectRow(page, 'idle', PLAY, 'the menu has the Play row');
    await menuRow(page).click();
    await expectRow(page, 'running', STOP, 'the circuit runs');
    expect(await visibleToolbars(page), 'no toolbar came back at Play').toBe(0);
    await menuRow(page).click();
    await expectRow(page, 'idle', PLAY, 'stopped');
    await closeOverlayMenu(page);
    expect(await visibleToolbars(page), 'no toolbar came back at Stop').toBe(0);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });
});
