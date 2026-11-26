import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { clickByLabel, clickByTooltip, findByLabel, findByTooltip, waitForElement } from '../e2e/utils/element-tracker';
import { openSimulationMenu } from './overlay-menu';

/**
 * Live simulation: Play says what it left out, and why, in the real app
 * (the rules: @pcbjam/shared's sim-library/left-out.ts; the run's report:
 * web/standalone/src/wasm/live-session.ts; its place: the Simulation parts
 * list).
 *
 * A symbol that has no line in the circuit does not stop the run. It is left
 * out for one of four reasons, and what the user can do differs:
 *
 *   - no value: a resistor whose Value is still "R";
 *   - no part: a chip the library does not have, and a speaker that KiCad
 *     takes for a coil because its reference starts with L (a value would not
 *     mend it);
 *   - switched off: by our field on the symbol (KiCad's own model then runs in
 *     its place), or by KiCad's "exclude from simulation" (also what the editor
 *     makes of the field older KiCad versions wrote, Sim.Enable 0);
 *   - nothing to simulate: a pin header, a test point, a mounting hole.
 *
 * `left-out` is a 5 V source, a resistor that runs, and one symbol for each
 * of these. What is checked:
 *
 *   - the notice says the counts by reason, the missing value first, and only
 *     counts what has nothing to simulate; a click on it opens the list;
 *   - the list shows the run's report: the groups by reason, each with its
 *     symbols and with what to do, and the rows carry the same reasons;
 *   - the sheet marks only what the user may want to mend (no value, no
 *     part), with the reason on the mark;
 *   - the report stays after Stop;
 *   - a board where all that is left out was switched off or has nothing to
 *     simulate gets no notice (`run` has nothing left out at all).
 *
 * A run that does not start is another thing, and is said apart:
 *
 *   - `raw-model`: the simulator refuses the circuit. Its words name a line of
 *     the netlist; the page names the symbol that line belongs to. The report
 *     in the list says the same sentence after the notice is gone;
 *   - `lost-sheet`: a sheet whose file is not in the project. KiCad says so
 *     once, in a dialog at the load, and then has the schematic open with that
 *     sheet empty. Its symbols can be neither simulated nor counted: the run
 *     does not start and says which file is missing, and so does the list.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with a library that has no parts: every symbol runs with
 * KiCad's own model or not at all. The reference backend has no /api/me; the
 * test answers that too.
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

async function answerSession(page: Page): Promise<void> {
  await page.route('**/api/me', (route) => {
    const origin = route.request().headers()['origin'] ?? '*';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ user: null, features: { liveSimulation: true } }),
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

/**
 * KiCad rebuilds its toolbar from the event loop, and the wasm port turns the
 * loop on input: nudge the mouse over the canvas at every poll.
 */
/**
 * The circuit runs: the layer over the sheet is there. The button is no sign of it: it
 * says Stop from the click on Play, also while the run still starts.
 */
const expectRunning = (page: Page, message: string) =>
  expect(page.getByTestId('live-layer'), message).toHaveCount(1, { timeout: 60000 });

async function expectTool(page: Page, tooltip: string, message: string, timeout = 60000): Promise<void> {
  const box = (await page.locator('#canvas').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await expect
    .poll(async () => {
      await page.mouse.move(x, y);
      await page.mouse.move(x + 4, y + 4);
      return !!(await tool(page, tooltip));
    }, { message, timeout })
    .toBe(true);
}

async function closeOverlayMenu(page: Page): Promise<void> {
  if (await page.getByTestId('overlay-menu-panel').count()) await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
}

/** The Simulation parts list, opened from the Session menu. */
async function openPanel(page: Page): Promise<Locator> {
  await openSimulationMenu(page);
  await page.getByTestId('sim-parts-panel-toggle').click();
  const panel = page.getByTestId('sim-parts-panel');
  await expect(panel).toBeVisible();
  await closeOverlayMenu(page);
  return panel;
}

/** A group of the report: its reason, its symbols, and that it says what to do. */
async function expectGroup(report: Locator, reason: string, refs: string, title: string, todo: string): Promise<void> {
  const group = report.locator(`[data-testid="sim-parts-left-out"][data-reason="${reason}"]`);
  await expect(group, `the group "${title}"`).toHaveAttribute('data-refs', refs);
  await expect(group).toContainText(title);
  await expect(group).toContainText(todo);
}

/** The reason on a symbol's row of the list. */
const rowReason = (panel: Locator, ref: string): Locator =>
  panel.locator(`[data-testid="sim-part-row"][data-ref="${ref}"]`);

// What `left-out` leaves out, by reason, in the order the list shows the groups.
const NO_VALUE = 'R2';
const NO_PART = 'LS1 U1';
const OFF = 'R5 R6 R9';
const NOTHING = 'H1 J1 TP1';

test.describe('live simulation: what Play leaves out, and why', () => {
  // KiCad puts plugin buttons at the end of its top toolbar, about 1420 px from
  // the left: a window wide enough to have that place on screen.
  test.use({ viewport: { width: 1600, height: 720 } });

  test('one symbol for every reason: the notice counts them, the list groups them, the report stays after Stop', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/left-out.kicad_sch');

    await expectTool(page, PLAY, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, 'the button is Stop');
    await expectRunning(page, 'the circuit runs without them');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    // The notice: how many, and why. The missing value first, with what to do;
    // what has nothing to simulate is counted, not named.
    const note = page.getByTestId('live-sim-note');
    await expect(note).toContainText(
      '1 symbol has no value (R2): type its value and it runs. '
      + '2 symbols have no part in the library: LS1 (Speaker), U1 (ATmega4809-A). '
      + '3 symbols are switched off: R5, R6, R9. '
      + '3 symbols have nothing to simulate. '
      + 'The rest of the circuit runs.',
    );

    // The sheet marks what the user may want to mend, and says why on the mark.
    const layer = page.getByTestId('live-layer');
    await expect(layer).toHaveAttribute('data-left-out', '3', { timeout: 30000 });
    const mark = (ref: string) => layer.locator(`[data-testid="live-left-out"][data-ref="${ref}"]`);
    await expect(mark('R2')).toHaveAttribute('data-reason', 'no-value');
    await expect(mark('U1')).toHaveAttribute('data-reason', 'no-part');
    await expect(mark('LS1')).toHaveAttribute('data-reason', 'no-part');
    // (the mark's two words are drawn only when the sheet is zoomed in far enough to read them)
    await expect(mark('R2')).toHaveAttribute('aria-label', 'R2 has no value. Type one (10k) and it runs.');
    await expect(mark('U1')).toHaveAttribute('aria-label', 'U1 (ATmega4809-A) is not simulated: the library has no part for it. The rest runs without it.');

    // A click on the notice opens the list, with this run's report on top.
    await note.getByRole('button', { name: 'Show the list' }).click();
    const panel = page.getByTestId('sim-parts-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    const report = panel.getByTestId('sim-parts-report');
    await expect(report).toHaveAttribute('data-outcome', 'running');
    await expect(report).toHaveAttribute('data-left-out', '9');
    await expect(report).toHaveAttribute('data-stale', 'no');
    await expect(report).toContainText('This run');
    await expect(report.getByTestId('sim-parts-report-problem')).toHaveCount(0);

    await expectGroup(report, 'no-value', NO_VALUE, 'No value', 'Type the value on the symbol');
    await expectGroup(report, 'no-part', NO_PART, 'No part', 'The rest of the circuit runs without them.');
    await expectGroup(report, 'off', OFF, 'Switched off', 'Switch one on again where it was switched off.');
    await expectGroup(report, 'nothing', NOTHING, 'Nothing to simulate', 'they do nothing in a circuit');
    // the groups come with the reason the user can mend at once first
    expect(await report.getByTestId('sim-parts-left-out').evaluateAll((els) => els.map((e) => e.getAttribute('data-reason')))).toEqual([
      'no-value', 'no-part', 'off', 'nothing',
    ]);
    // "switched off" says where, and what runs in its place
    const remark = (ref: string) => report.locator(`[data-testid="sim-parts-left-out-remark"][data-ref="${ref}"]`);
    await expect(remark('R5')).toContainText("switched off on its symbol (PCBJam.SimPart: off); KiCad's own model runs in its place");
    // R6 has the field of older KiCad versions (Sim.Enable 0): the editor reads it as excluded
    await expect(remark('R6')).toContainText('excluded from simulation in KiCad');
    await expect(remark('R9')).toContainText('excluded from simulation in KiCad');
    await expect(remark('R9')).toHaveText('R9: excluded from simulation in KiCad, on the symbol or on its sheet');

    // The rows are the schematic as it is now: the same reasons, by the same rules.
    for (const [ref, reason, label] of [
      ['R2', 'no-value', 'no value'], ['U1', 'no-part', 'no part'], ['LS1', 'no-part', 'no part'],
      ['R5', 'off', 'switched off'], ['R6', 'off', 'excluded'], ['R9', 'off', 'excluded'],
      ['J1', 'nothing', 'nothing to simulate'], ['TP1', 'nothing', 'nothing to simulate'], ['H1', 'nothing', 'nothing to simulate'],
    ] as const) {
      await expect(rowReason(panel, ref), `the row of ${ref}`).toHaveAttribute('data-reason', reason);
      await expect(rowReason(panel, ref)).toContainText(label);
    }
    // what runs has no reason
    await expect(rowReason(panel, 'R1')).toHaveAttribute('data-reason', '');
    await expect(rowReason(panel, 'R1')).toHaveAttribute('data-state', 'kicad');
    await page.screenshot({ path: test.info().outputPath('web-live-sim-left-out.png') });

    // Stop: the marks go with the run, the report stays and says so.
    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, 'stopped: the button is Play again');
    await expect(layer, 'the marks go with the run').toHaveCount(0);
    await expect(report).toHaveAttribute('data-outcome', 'stopped');
    await expect(report).toContainText('The last run');
    await expect(report).toHaveAttribute('data-left-out', '9');
    await expectGroup(report, 'no-value', NO_VALUE, 'No value', 'Type the value on the symbol');
    await expectGroup(report, 'nothing', NOTHING, 'Nothing to simulate', 'they do nothing in a circuit');
  });

  test('before Play the list says what a run would leave out; a board that leaves nothing out gets no notice', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/left-out.kicad_sch');
    await expectTool(page, PLAY, 'the Play button is on the toolbar');

    // no run yet: the groups are the schematic's, under "When it plays"
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    const report = panel.getByTestId('sim-parts-report');
    await expect(report).toHaveAttribute('data-outcome', 'none');
    await expect(report).toContainText('When it plays');
    await expect(report).toHaveAttribute('data-left-out', '9');
    await expectGroup(report, 'no-value', NO_VALUE, 'No value', 'Type the value on the symbol');
    await expectGroup(report, 'no-part', NO_PART, 'No part', 'The rest of the circuit runs without them.');

    // `run` is a source and a resistor: nothing is left out, nothing is said
    await bootSchematic(page, 'live-sim/run.kicad_sch');
    await expectTool(page, PLAY, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, 'the button is Stop');
    await expectRunning(page, 'the circuit runs');
    const whole = await openPanel(page);
    await expect(whole).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    const fine = whole.getByTestId('sim-parts-report');
    await expect(fine).toHaveAttribute('data-outcome', 'running');
    await expect(fine).toHaveAttribute('data-left-out', '0');
    await expect(fine.getByTestId('sim-parts-report-none')).toHaveText('Nothing was left out.');
    await expect(page.getByTestId('live-sim-note'), 'no notice for a run that leaves nothing out').toHaveCount(0);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, 'stopped');
  });

  test('a run the simulator refuses names the symbol, and the list keeps the reason', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveEmptyLibrary(page);
    // D1 asks for the line "D1 ... red" itself (Sim.Device "SPICE"): the user's
    // own line stays in the circuit, and nothing defines the model "red"
    await bootSchematic(page, 'live-sim/raw-model.kicad_sch');

    await expectTool(page, PLAY, 'the Play button is on the toolbar');
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);

    const error = page.getByTestId('live-sim-error');
    await expect(error).toBeVisible({ timeout: 60000 });
    await expect(error).toContainText('Live simulation did not start. The simulator names D1: ngspice did not run the circuit');
    // a refused run is not a part left out: no notice of that kind
    await expect(page.getByTestId('live-sim-note')).toHaveCount(0);
    expect(await tool(page, PLAY), 'the button is still Play').not.toBeNull();
    expect(await tool(page, STOP)).toBeNull();

    // the report is kept: the list says the same sentence, and which symbol it is about
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    const report = panel.getByTestId('sim-parts-report');
    await expect(report).toHaveAttribute('data-outcome', 'not-started');
    await expect(report).toContainText('The last run did not start');
    const problem = report.getByTestId('sim-parts-report-problem');
    await expect(problem).toHaveAttribute('data-about', 'D1');
    await expect(problem).toContainText('Live simulation did not start. The simulator names D1: ngspice did not run the circuit');
    await expect(problem).toContainText(/d1 .*red/i);
    // and the symbol's row is marked: the reason is about this one
    await expect(rowReason(panel, 'D1')).toHaveAttribute('data-named', 'yes');
    await expect(rowReason(panel, 'D1')).toContainText('named by the simulator');
    await expect(rowReason(panel, 'R1')).toHaveAttribute('data-named', 'no');
    await page.screenshot({ path: test.info().outputPath('web-live-sim-refused.png') });
  });

  test('a sheet whose file is not in the project: the run does not start and says which file', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveEmptyLibrary(page);
    await bootSchematic(page, 'live-sim/lost-sheet.kicad_sch');

    // KiCad itself says at the load that a sheet could not be read, in a dialog. With OK the
    // schematic is open, and the sheet is there and empty.
    expect(await waitForElement(page, 'OK', { timeout: 60000 }), "KiCad's own error about the sheet").not.toBeNull();
    expect(await clickByLabel(page, 'OK')).toBe(true);
    await expect.poll(async () => !!(await findByLabel(page, 'OK')), { message: 'the dialog is closed', timeout: 30000 }).toBe(false);

    await expectTool(page, PLAY, 'the Play button is on the toolbar');

    // the list says it before any Play, above the symbols it could count
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    await expect(panel.getByTestId('sim-parts-not-loaded')).toContainText(
      'The sheet "Power" is not loaded: its file lost-sheet-power.kicad_sch is not in the project. Its symbols cannot be simulated, or even counted.',
    );
    await expect(panel.getByTestId('sim-parts-report'), 'no run yet, and nothing of what it can count is left out').toHaveCount(0);

    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);

    const error = page.getByTestId('live-sim-error');
    await expect(error).toBeVisible({ timeout: 60000 });
    await expect(error).toContainText(
      'Live simulation did not start: the sheet "Power" is not loaded: its file lost-sheet-power.kicad_sch is not in the project. '
      + 'Its symbols cannot be simulated, or even counted. Add the file to the project, or delete the sheet.',
    );
    expect(await tool(page, PLAY), 'the button is still Play').not.toBeNull();
    expect(await tool(page, STOP)).toBeNull();

    // the run's report keeps the reason, and the list says it once
    const report = panel.getByTestId('sim-parts-report');
    await expect(report).toHaveAttribute('data-outcome', 'not-started');
    await expect(report.getByTestId('sim-parts-report-problem')).toContainText(
      'Live simulation did not start: the sheet "Power" is not loaded: its file lost-sheet-power.kicad_sch is not in the project.',
    );
    await expect(panel.getByTestId('sim-parts-not-loaded')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-lost-sheet.png') });
  });
});
