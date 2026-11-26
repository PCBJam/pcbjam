import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { clickByTooltip, findByTooltip } from '../e2e/utils/element-tracker';

/**
 * Live simulation: simulator commands a schematic carries, in the real app with
 * the real simulator (the rule: @pcbjam/shared's sim-library/netlist.ts,
 * withoutCommands).
 *
 * A text of a sheet that holds a line with a dot in front goes into the circuit
 * as it is. Most of that defines the circuit (".param", ".model", ".ic"). A
 * block from ".control" to ".endc" and a line that begins with "*#" are
 * something else: commands the simulator carries out when it loads the
 * circuit. They come with the schematic, whoever drew it. A live run takes
 * them out, runs the circuit, and says so.
 *
 * The sheet (fixtures/demo/live-sim/commands.kicad_sch) has two dividers from
 * +5V with a voltmeter each. The upper resistor of the first has the value
 * "{rtop}", and one text of the sheet gives that parameter (30k) and holds a
 * block that tells the simulator to quit. A second text holds a line "*#quit".
 * With either of the two carried out, the simulator is gone and nothing runs.
 *
 *   - Play runs the circuit, with no error;
 *   - the parameter of the text is there: the first voltmeter shows 1.25 V
 *     (30k over 10k), the second 2.5 V;
 *   - a notice says that the commands are not run;
 *   - Stop and Play again do the same.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers that path with a snapshot of one part, a voltmeter.
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

const meter = (page: Page, ref: string) => page.locator(`[data-testid="live-meter"][data-ref="${ref}"]`);
/** The number a meter shows, as the run gave it (NaN before its first value). */
const reading = async (m: Locator): Promise<number> => Number((await m.locator('span').last().getAttribute('data-value')) ?? 'NaN');

const NOT_RUN = 'A text of this schematic holds commands for the simulator (".control" or "*#"). Live simulation does not run them: the circuit runs without them.';

test.describe('live simulation: simulator commands in a schematic\'s texts', () => {
  // KiCad puts plugin buttons at the end of its top toolbar, about 1420 px from
  // the left: a window wide enough to have that place on screen.
  test.use({ viewport: { width: 1600, height: 720 } });

  test('the circuit runs without them, what defines the circuit stays, and a notice says so', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await bootSchematic(page, 'live-sim/commands.kicad_sch');
    await expectTool(page, PLAY, 'the Play button is on the toolbar');

    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, 'the button is Stop');
    await expectRunning(page, 'the circuit runs: nothing told the simulator to quit');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    await expect(page.getByTestId('live-sim-commands'), 'a notice says the commands are not run').toContainText(NOT_RUN);

    // the parameter that the text with the block gives is in the circuit
    await expect.poll(() => reading(meter(page, 'VM1')), { message: '"{rtop}" is the 30k of the text', timeout: 60000 }).toBeCloseTo(1.25, 1);
    await expect.poll(() => reading(meter(page, 'VM2')), { message: 'the plain divider', timeout: 30000 }).toBeCloseTo(2.5, 1);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, 'stopped: the button is Play again');
    await expect(page.getByTestId('live-layer'), 'the meters go with the run').toHaveCount(0);

    // and once more: the simulator is still there
    expect(await clickByTooltip(page, PLAY, { elementType: 'tool' })).toBe(true);
    await expectTool(page, STOP, 'the button is Stop again');
    await expectRunning(page, 'it runs again');
    await expect.poll(() => reading(meter(page, 'VM1')), { message: 'the same reading', timeout: 60000 }).toBeCloseTo(1.25, 1);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    expect(await clickByTooltip(page, STOP, { elementType: 'tool' })).toBe(true);
    await expectTool(page, PLAY, 'and stops again');
  });
});
