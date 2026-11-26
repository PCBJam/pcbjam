import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { clickByTooltip, findByTooltip } from '../e2e/utils/element-tracker';
import { openSimulationMenu } from './overlay-menu';

/**
 * Live simulation: a Value that says more than the value, in the real app
 * (the rules: @pcbjam/shared's sim-library/values.ts; the netlist step that
 * uses them: sim-library/netlist.ts; where the user reads it: the Simulation
 * parts list).
 *
 * People write what they buy into the Value of a resistor or a capacitor:
 * "22uF/25V", "10k 1%", "4k7 1% 0603". KiCad hands such a text to the
 * simulator as it is, and the simulator reads no ratings: "22uF/25V" stops the
 * whole run, and of "10k 1%" it takes the last number, so the resistor runs
 * with 1 ohm and nothing says so.
 *
 * `values` is seven dividers from +5V, each with the Value under test on top, a
 * plain one of the same size below and a voltmeter between, and three
 * capacitors on the supply:
 *
 *   R1  "10k 1%"       over 10k    the meter reads half the supply
 *   R3  "4k7 1% 0603"  over 4.7k   the same: the letter stands for the decimal point
 *   R5  "1M 5%"        over 1Meg   a capital M is mega (2.38 V: the meter's own 10 megohm count)
 *   R7  "100 1W"       over 100    half the supply
 *   R9  "10k/22k"      over 10k    two values: not read, left out as a symbol without a value
 *   R11 "10k (1%)"     over 10k    a rating in brackets: half the supply (the simulator alone
 *                                  would take the 1 for the value)
 *   R13 "10k 1/4 W"    over 10k    the fraction of a power is one rating: half the supply
 *   C1  "22uF/25V", C2 "0.1uF 50V" on the supply: the run starts with them
 *   C3  "22uF 10V", and its symbol names a model of its own with no value in
 *       it (Sim.Device C, Sim.Params c=""), as a symbol of somebody's own
 *       library can: KiCad writes no line for it, whatever its Value says
 *
 * What is checked: the run starts, every meter reads what the value alone
 * gives, the list says which value runs on each such row, the one Value that
 * is not read is left out with a sentence that says what to type, and the
 * capacitor without a line is said to be left out, not to run.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with one part of its own, a voltmeter.
 *
 * Needs a wasm build with kicadSimNetlist and kicadSchToolbarButton, and an
 * ngspice_service with the live engine: rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';
const PLAY = 'Run live simulation';
const STOP = 'Stop live simulation';

// KiCad's voltmeter: pin 1 is its minus. The reading leaves as a current, 1 A for 1 V.
const VOLTMETER = {
  manifest: {
    schema: 1, id: 'e2e-voltmeter', version: 1, title: 'Test voltmeter', description: '',
    fits: [{ symbol: 'Device:Voltmeter_DC', pins: { N: '1', P: '2' } }], pins: ['P', 'N'],
    analog: { file: 'model.lib', subckt: 'E2E_VOLTMETER' },
    signals: [{ name: 'volts', current: 'Vread' }],
    overlay: [{ widget: 'meter', place: { below: 'bbox', gap: 4 }, signal: 'volts', unit: 'V' }],
  },
  model: '.subckt E2E_VOLTMETER P N\nRin P N 10meg\nBm m 0 V = V(P,N)\nRm m r 1\nVread r 0 dc 0\n.ends E2E_VOLTMETER\n',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fileEntry = (name: string, text: string) => ({ name, sha256: sha256(text), bytes: Buffer.byteLength(text) });

/** The snapshot's files by path: what a publish of the voltmeter writes. */
function snapshotFiles(): Record<string, string> {
  const { manifest, model } = VOLTMETER;
  const manifestText = JSON.stringify(manifest, null, 2);
  const index = {
    schema: 1, version: SNAPSHOT, emulators: [],
    parts: [{
      id: manifest.id, version: 1, title: manifest.title, description: '', fits: manifest.fits, pins: manifest.pins, code: false,
      files: [fileEntry('part.json', manifestText), fileEntry('model.lib', model)],
    }],
  };
  return {
    'current.json': JSON.stringify({ schema: 1, version: SNAPSHOT }),
    [`${SNAPSHOT}/index.json`]: JSON.stringify(index),
    [`${SNAPSHOT}/parts/${manifest.id}/part.json`]: manifestText,
    [`${SNAPSHOT}/parts/${manifest.id}/model.lib`]: model,
  };
}

async function serveLibrary(page: Page): Promise<void> {
  const files = snapshotFiles();
  await page.route('**/e2e-sim-library/**', (route: Route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, ''));
    const body = files[rel];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: rel.endsWith('.json') ? 'application/json' : 'text/plain', body });
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

const meter = (page: Page, ref: string) => page.locator(`[data-testid="live-meter"][data-ref="${ref}"]`);
/** The number a meter shows, as the run gave it (NaN before its first value). */
const reading = async (m: Locator): Promise<number> => Number((await m.locator('span').last().getAttribute('data-value')) ?? 'NaN');
const row = (panel: Locator, ref: string): Locator => panel.locator(`[data-testid="sim-part-row"][data-ref="${ref}"]`);

const NOT_READ = 'R9: its Value "10k/22k" is not read as one value. Type the value alone (10k) and it runs.';
const OWN_MODEL = 'C3 is left out: its symbol names a simulation model of its own with no value in it (the fields Sim.Device and Sim.Params), and its Value "22uF 10V" is not used. Delete the two fields, and the Value runs.';

test.describe('live simulation: a Value that says its ratings too', () => {
  // KiCad puts plugin buttons at the end of its top toolbar, about 1420 px from
  // the left: a window wide enough to have that place on screen.
  test.use({ viewport: { width: 1600, height: 720 } });

  test('the value alone runs, the list says which, and a Value that is not read is left out with what to type', async ({ page }) => {
    test.setTimeout(300000);
    await serveLibrary(page);
    await bootSchematic(page, 'live-sim/values.kicad_sch');
    await expectTool(page, PLAY, 'the Play button is on the toolbar');

    // Before Play the list says which value a run takes, by the same rules.
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    for (const [ref, value, label] of [
      ['R1', '10k 1%', "KiCad's model, as 10k"],
      ['R3', '4k7 1% 0603', "KiCad's model, as 4k7"],
      ['R5', '1M 5%', "KiCad's model, as 1M"],
      ['R7', '100 1W', "KiCad's model, as 100"],
      ['R11', '10k (1%)', "KiCad's model, as 10k"],
      ['R13', '10k 1/4 W', "KiCad's model, as 10k"],
      ['C1', '22uF/25V', "KiCad's model, as 22uF"],
      ['C2', '0.1uF 50V', "KiCad's model, as 0.1uF"],
    ] as const) {
      await expect(row(panel, ref), `the row of ${ref}`).toHaveAttribute('data-state', 'kicad');
      await expect(row(panel, ref)).toHaveAttribute('data-reason', '');
      await expect(row(panel, ref)).toContainText(value);
      await expect(row(panel, ref)).toContainText(label);
    }
    // a plain value says nothing more
    await expect(row(panel, 'R2').locator('span').last()).toHaveText("KiCad's model");
    // two values in one Value: not read, and not guessed at
    await expect(row(panel, 'R9')).toHaveAttribute('data-reason', 'no-value');
    await expect(row(panel, 'R9')).toContainText('no value');
    // a model of its own with no value: KiCad writes no line, so the row does not say it runs
    await expect(row(panel, 'C3')).toHaveAttribute('data-state', 'none');
    await expect(row(panel, 'C3')).toHaveAttribute('data-reason', 'no-value');

    // Play: the circuit starts ("22uF/25V" alone stopped it), and says what it left out.
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, 'the button is Stop');
    await expectRunning(page, 'the circuit runs');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    await expect(page.getByTestId('live-sim-note')).toContainText(
      '1 symbol has no value (R9): type its value and it runs. '
      + '1 symbol names a simulation model of its own with no value in it (C3): it is left out, and its Value is not used. '
      + 'The rest of the circuit runs.',
    );

    // Every divider has the same value on top and below: half the supply. With the last
    // number of the Value on top (1 ohm for "10k 1%") the meter would read the supply.
    await expect.poll(() => reading(meter(page, 'VM1')), { message: '"10k 1%" runs as 10k', timeout: 60000 }).toBeCloseTo(2.5, 1);
    await expect.poll(() => reading(meter(page, 'VM2')), { message: '"4k7 1% 0603" runs as 4.7k', timeout: 30000 }).toBeCloseTo(2.5, 1);
    // 1 megohm over 1 megohm with the meter's 10 megohm beside the lower one
    await expect.poll(() => reading(meter(page, 'VM3')), { message: '"1M 5%" runs as 1 megohm', timeout: 30000 }).toBeCloseTo(2.38, 1);
    await expect.poll(() => reading(meter(page, 'VM4')), { message: '"100 1W" runs as 100 ohm', timeout: 30000 }).toBeCloseTo(2.5, 1);
    await expect.poll(() => reading(meter(page, 'VM6')), { message: '"10k (1%)" runs as 10k', timeout: 30000 }).toBeCloseTo(2.5, 1);
    await expect.poll(() => reading(meter(page, 'VM7')), { message: '"10k 1/4 W" runs as 10k', timeout: 30000 }).toBeCloseTo(2.5, 1);
    // R9 is left out: nothing pulls its divider up
    await expect.poll(() => reading(meter(page, 'VM5')), { message: 'the divider of the Value that is not read has no upper resistor', timeout: 30000 }).toBeCloseTo(0, 1);

    // The sheet marks the two symbols that are left out, each with the sentence that says what to do.
    const layer = page.getByTestId('live-layer');
    await expect(layer).toHaveAttribute('data-left-out', '2', { timeout: 30000 });
    await expect(layer.locator('[data-testid="live-left-out"][data-ref="R9"]')).toHaveAttribute('aria-label', NOT_READ);
    await expect(layer.locator('[data-testid="live-left-out"][data-ref="C3"]')).toHaveAttribute('aria-label', OWN_MODEL);

    // The run's report in the list: two symbols left out, for their value, and which of
    // them a typed Value does not mend.
    const report = panel.getByTestId('sim-parts-report');
    await expect(report).toHaveAttribute('data-outcome', 'running');
    await expect(report).toHaveAttribute('data-left-out', '2');
    const group = report.locator('[data-testid="sim-parts-left-out"][data-reason="no-value"]');
    await expect(group).toHaveAttribute('data-refs', 'C3 R9');
    await expect(group).toContainText('Type the value on the symbol (10k, 100n), then it runs.');
    await expect(group).toContainText('C3 names a simulation model of its own with no value in it (the fields Sim.Device and Sim.Params on the symbol): KiCad leaves it out, and the Value is not used. Delete the two fields, and the Value runs.');
    await page.screenshot({ path: test.info().outputPath('web-live-sim-values.png') });

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, 'stopped: the button is Play again');
  });
});
