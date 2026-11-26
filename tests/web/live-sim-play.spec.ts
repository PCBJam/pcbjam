import { test, expect, type Page, type Route } from '@playwright/test';
import { clickByTooltip, findAll, findByTooltip } from '../e2e/utils/element-tracker';
import { openOverlayMenu, openSimulationMenu } from './overlay-menu';

/**
 * Live simulation, Play and Stop (web/standalone/src/wasm/live-session.ts), in
 * the real app. Play is in two places: a button on the schematic editor's own
 * toolbar, and a row of the Session menu that does the same. Live simulation's
 * rows are in the menu's Simulation child menu (openSimulationMenu).
 *
 *   - KiCad's toolbar has "Run live simulation". A click reads the
 *     schematic, builds its circuit and runs it in the live engine: the button
 *     is "Stop live simulation" from the click on, also while the run starts,
 *     so a start that waits can be given up. A click on Stop brings Play back,
 *     and it plays again;
 *   - a start that waits for the library is given up by Stop, and the next
 *     Play works;
 *   - a symbol nobody has a model for is left out: the rest of the circuit
 *     runs, a notice names the symbol and the sheet marks it (the reasons a
 *     symbol is left out have a test of their own, live-sim-left-out.spec.ts);
 *   - a circuit the simulator does not run stays on Play and says why, in the
 *     simulator's words, with the symbol its line belongs to;
 *   - KiCad puts the button at the far end of its toolbar, which a window of
 *     the usual size does not show. The Session menu's row plays and stops
 *     there, and also with the UI hidden, where there is no toolbar at all;
 *     the toolbars then stay hidden;
 *   - the Session menu also has the row of the serial console (what the
 *     program of a chip prints, and a line to type to it). In a circuit
 *     without such a chip the panel says what it is for and takes no text.
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
 * KiCad's own model.
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

/**
 * The circuit runs: the layer over the sheet is there. The button is no sign of it: it
 * says Stop from the click on Play, also while the run still starts.
 */
const expectRunning = (page: Page, message: string) =>
  expect(page.getByTestId('live-layer'), message).toHaveCount(1, { timeout: 60000 });

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

  test('Play runs the circuit of the schematic; Stop halts it', async ({ page }) => {
    test.setTimeout(300000);
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (/ngspice_service\.(js|wasm)/.test(r.url())) fetched.push(r.url());
    });
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(fetched, 'the engine is not fetched before the first Play').toEqual([]);

    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, true, 'the button is Stop');
    expect(await tool(page, PLAY), 'one button, not two').toBeNull();
    await expectRunning(page, 'the circuit runs: its first moment is solved');
    expect(fetched.length, 'the engine was fetched for the run').toBeGreaterThan(0);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    // the Session menu's row says the same
    await openSimulationMenu(page);
    await expect(menuRow(page)).toHaveAttribute('data-live-state', 'running');
    await expect(menuRow(page)).toHaveText(STOP);
    await closeOverlayMenu(page);

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'stopped: the button is Play again');
    expect(await tool(page, STOP)).toBeNull();

    // and once more
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, true, 'the button is Stop again');
    await expectRunning(page, 'it plays again');
    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'and stops again');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });

  test('a symbol nobody has a model for is left out; the rest runs and the page says which one', async ({ page }) => {
    test.setTimeout(300000);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/no-model.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, true, 'the button is Stop');
    await expectRunning(page, 'the circuit runs without D1');
    await expect(page.getByTestId('live-sim-note'), 'a notice names the symbol, and says why').toContainText(
      'D1 (red) is not simulated: the library has no part for it. The rest runs without it.',
    );
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    // and the sheet marks it, with the reason
    const layer = page.getByTestId('live-layer');
    await expect(layer).toHaveAttribute('data-left-out', '1', { timeout: 30000 });
    await expect(layer.getByTestId('live-left-out')).toHaveAttribute('data-ref', 'D1');
    await expect(layer.getByTestId('live-left-out')).toHaveAttribute('data-reason', 'no-part');

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, true, 'stopped: the button is Play again');
    await expect(layer, 'the marks go with the run').toHaveCount(0);
  });

  test('a circuit the simulator does not run says why and stays on Play', async ({ page }) => {
    test.setTimeout(300000);
    await serveEmptyLibrary(page);
    // D1 asks for the line "D1 ... red" itself: the user's own line is not left out
    await bootSchematic(page, 'live-sim/raw-model.kicad_sch');

    await expectTool(page, PLAY, true, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);

    const error = page.getByTestId('live-sim-error');
    await expect(error).toBeVisible({ timeout: 60000 });
    // the simulator names a line of the netlist; the page says which symbol that is
    await expect(error).toContainText('Live simulation did not start. The simulator names D1: ngspice did not run the circuit');
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
    await openSimulationMenu(page);
    await expect(menuRow(page), message).toHaveAttribute('data-live-state', state, { timeout: 60000 });
    await expect(menuRow(page)).toHaveText(words);
  }

  test('the row plays and stops, in a window that does not show the toolbar button', async ({ page }) => {
    test.setTimeout(300000);
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

  // A start waits for the library. When the library does not answer, the start can be
  // given up, and the next Play works.
  test('a start that waits for the library is given up by Stop, and Play works again', async ({ page }) => {
    test.setTimeout(300000);
    const files: Record<string, unknown> = {
      'current.json': { schema: 1, version: SNAPSHOT },
      [`${SNAPSHOT}/index.json`]: { schema: 1, version: SNAPSHOT, parts: [], emulators: [] },
    };
    // the library's first file gets no answer until the test gives one
    const held: Route[] = [];
    let answers = false;
    await page.route('**/e2e-sim-library/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, '');
      if (!answers && path === 'current.json') return void held.push(route);
      return path in files ? json(route, files[path]) : route.fulfill({ status: 404, body: 'not found' });
    });
    await bootSchematic(page, 'live-sim/run.kicad_sch');

    await expectRow(page, 'idle', PLAY, 'the menu has the Play row');
    await menuRow(page).click();
    await expectRow(page, 'starting', 'Starting live simulation... Stop', 'the start waits for the library: the row offers Stop');
    await expect(menuRow(page)).toBeEnabled();
    await expect.poll(() => held.length, { message: 'the library was asked and got no answer' }).toBeGreaterThan(0);

    await menuRow(page).click();
    await expectRow(page, 'idle', PLAY, 'the start is given up: the row is Play again');
    await expect(page.getByTestId('live-sim-error'), 'giving a start up is no error').toHaveCount(0);

    // the library answers now, also the request that waited
    answers = true;
    for (const route of held) await json(route, files['current.json']);
    await menuRow(page).click();
    await expectRow(page, 'running', STOP, 'Play works again: the circuit runs');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    await menuRow(page).click();
    await expectRow(page, 'idle', PLAY, 'stopped');
  });

  test('with the UI hidden the row plays and stops, and the toolbars stay hidden', async ({ page }) => {
    test.setTimeout(300000);
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

test.describe('live simulation: the serial console', () => {
  const row = (page: Page) => page.getByTestId('sim-console-panel-toggle');
  const panel = (page: Page) => page.getByTestId('sim-console-panel');

  test('the row shows and hides the panel; a circuit without a chip that runs firmware has nothing to show', async ({ page }) => {
    test.setTimeout(300000);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/run.kicad_sch');
    await expectTool(page, 'Simulator', true, "KiCad's toolbar is up");

    await openSimulationMenu(page);
    await expect(row(page)).toHaveText('Serial console');
    await expect(panel(page), 'the panel is not there until it is asked for').toHaveCount(0);
    await row(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId('sim-console-empty')).toContainText('What the program of a chip prints shows here');
    await expect(page.getByTestId('sim-console-input')).toBeDisabled();
    await expect(page.getByTestId('sim-console-input')).toHaveAttribute('placeholder', 'Press Play to type to the chip');
    await expect(page.getByTestId('sim-console-panel-clear')).toBeDisabled();

    // The circuit runs: it has no chip, so there is still nothing to show and nobody to type to.
    await openSimulationMenu(page);
    await expect(row(page)).toHaveText('Hide serial console');
    await menuRow(page).click();
    await openSimulationMenu(page);
    await expect(menuRow(page)).toHaveAttribute('data-live-state', 'running', { timeout: 60000 });
    await closeOverlayMenu(page);
    await expect(panel(page)).toHaveAttribute('data-can-send', 'no');
    await expect(page.getByTestId('sim-console-empty')).toBeVisible();
    await expect(page.getByTestId('sim-console-input')).toBeDisabled();

    // Collapsed to its header and back, then closed.
    await page.getByTestId('sim-console-panel-collapse').click();
    await expect(page.getByTestId('sim-console-text')).toHaveCount(0);
    await page.getByTestId('sim-console-panel-collapse').click();
    await expect(page.getByTestId('sim-console-text')).toBeVisible();
    await page.getByTestId('sim-console-panel-close').click();
    await expect(panel(page)).toHaveCount(0);
    await openSimulationMenu(page);
    await expect(row(page)).toHaveText('Serial console');

    await menuRow(page).click();
    await openSimulationMenu(page);
    await expect(menuRow(page)).toHaveAttribute('data-live-state', 'idle', { timeout: 60000 });
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });
});
