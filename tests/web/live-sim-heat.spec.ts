import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { openSimulationMenu } from './overlay-menu';

/**
 * Live simulation, heat (web/pcbjam-shared/src/sim-library/thermal.ts): the heat is
 * a circuit the user draws, and a part gets onto one of its wires by the wire's name.
 *
 * The schematic is tests/fixtures/demo/live-sim/heat.kicad_sch.
 *
 *   The 5 V circuit: a switch and a heater (S1, H1), a switch and a fan (S2, F1),
 *   two temperature sensors over 1 k each (T1, T2).
 *
 *   The heat circuit, with ordinary symbols: a 25 V source is the air outside
 *   (the label OUT), 4 ohm lead from it to the air in a box (the label BOX),
 *   which holds 0.1 J for every degree. On these wires 1 V is 1 degree Celsius
 *   and 1 A is 1 W.
 *
 * In the file H1 says the wire BOX, F1 the wires BOX and OUT, T2 a wire nobody
 * drew (OVEN), and T1 says none: the test types it in the Simulation parts list.
 *
 * What the numbers are. A closed switch is 0.102 ohm, the heater 10 ohm: it takes
 * 2.45 W. Through 4 ohm that warms the box by 9.8 degrees, to 34.8. The turning fan
 * carries 0.25 W for every degree the box is warmer than the outside, as much as
 * the 4 ohm do: the box is 4.9 degrees warmer, 29.9. A sensor is 1 k at 25 degrees
 * and 20 ohm more for every degree: over its 1 k it takes 2.50 mA at 25 degrees and
 * 2.28 mA at 34.8.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with small parts of its own.
 *
 * Needs a wasm build with kicadSimPlaces, kicadSimNetlist and an
 * ngspice_service with the live engine: rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';
const PLAY = 'Run live simulation';
const STOP = 'Stop live simulation';
const FIELD = 'PCBJam.SimThermal';

// --- the test's own library --------------------------------------------------

interface TestPart {
  manifest: Record<string, unknown>;
  model: string;
}

const part = (id: string, symbol: string, subckt: string, model: string[], more: Record<string, unknown>): TestPart => ({
  manifest: {
    schema: 1, id, version: 1, title: id, description: '',
    fits: [{ symbol }], pins: ['1', '2'],
    analog: { file: 'model.lib', subckt },
    ...more,
  },
  model: [`.subckt ${subckt} 1 2`, ...model, `.ends ${subckt}`, ''].join('\n'),
});

const PARTS: TestPart[] = [
  part('e2e-switch', 'Test:TOGGLE', 'E2E_SWITCH', ['Vctl ctl 0 dc 0', "R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'"], {
    inputs: [{ name: 'closed', type: 'toggle', source: 'Vctl', off: 0, on: 1, default: 'off' }],
    overlay: [{ widget: 'toggle-zone', place: { over: 'bbox', margin: [1.5, 1.5] }, input: 'closed' }],
  }),
  // All the power the heater takes is heat: Vpower's current is that power, 1 A for 1 W.
  part('e2e-heater', 'Test:LAMP', 'E2E_HEATER', [
    'Vsense 1 m dc 0', 'R1 m 2 10',
    'Bpower pw 0 V = I(Vsense) * V(m, 2)', 'Rpower pw pwi 1', 'Vpower pwi 0 dc 0',
  ], {
    signals: [{ name: 'power', current: 'Vpower' }],
    overlay: [{ widget: 'glow', place: { at: 'origin', size: [12, 12] }, signal: 'power', full: 2, color: 'red' }],
    thermal: { heat: 'power' },
  }),
  // The fan is at full speed at 5 V. Its air carries 0.25 W for every degree then.
  part('e2e-fan', 'Test:METER', 'E2E_FAN', [
    'R1 1 2 50',
    'Bspeed sp 0 V = V(1, 2) / 5', 'Rspeed sp spi 1', 'Vspeed spi 0 dc 0',
  ], {
    signals: [{ name: 'speed', current: 'Vspeed' }],
    overlay: [{ widget: 'spin', place: { rect: [-3, -3, 3, 3] }, signal: 'speed' }],
    thermal: { air: { signal: 'speed', full: '0.25' } },
  }),
  // The sensor's temperature is the user's (a slider) until it stands on a wire: then the
  // slider is gone and the wire's temperature is shown. Its current is shown either way.
  part('e2e-sensor', 'Test:DIAL', 'E2E_SENSOR', [
    'Vtemp temp 0 dc 25', 'Vsense 1 m dc 0',
    "R1 m 2 r = '1000 + 20 * (V(temp) - 25)'",
  ], {
    inputs: [{ name: 'temperature', type: 'range', source: 'Vtemp', min: -40, max: 125, default: 25 }],
    signals: [{ name: 'current', current: 'Vsense' }],
    overlay: [
      { widget: 'meter', place: { below: 'bbox', gap: 2 }, signal: 'current', unit: 'A' },
      { widget: 'slider', place: { below: 'bbox', gap: 8 }, input: 'temperature', unit: '°C' },
    ],
    thermal: {
      temperature: 'temperature',
      overlay: [{ widget: 'meter', place: { below: 'bbox', gap: 8 }, signal: 'wire', unit: '°C', prefix: false, decimals: 1 }],
    },
  }),
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fileEntry = (name: string, text: string) => ({ name, sha256: sha256(text), bytes: Buffer.byteLength(text) });

/** What a part does with heat, as the library's index says it. */
const roles = (thermal: Record<string, unknown>): string[] => ['heat', 'temperature', 'air'].filter((role) => thermal[role] !== undefined);

/** The snapshot's files by path: what a publish of these parts writes. */
function snapshotFiles(parts: TestPart[]): Record<string, string> {
  const files: Record<string, string> = { 'current.json': JSON.stringify({ schema: 1, version: SNAPSHOT }) };
  const index = { schema: 1, version: SNAPSHOT, parts: [] as unknown[], emulators: [] };
  for (const { manifest, model } of parts) {
    const id = manifest.id as string;
    const manifestText = JSON.stringify(manifest, null, 2);
    files[`${SNAPSHOT}/parts/${id}/part.json`] = manifestText;
    files[`${SNAPSHOT}/parts/${id}/model.lib`] = model;
    index.parts.push({
      id, version: 1, title: manifest.title, description: '', fits: manifest.fits, pins: manifest.pins, code: false,
      ...(manifest.thermal ? { thermal: roles(manifest.thermal as Record<string, unknown>) } : {}),
      files: [fileEntry('part.json', manifestText), fileEntry('model.lib', model)],
    });
  }
  files[`${SNAPSHOT}/index.json`] = JSON.stringify(index);
  return files;
}

async function serveLibrary(page: Page): Promise<void> {
  const files = snapshotFiles(PARTS);
  await page.route('**/e2e-sim-library/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, '');
    const body = files[path];
    if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: path.endsWith('.json') ? 'application/json' : 'text/plain', body });
  });
}

// --- the app -----------------------------------------------------------------

async function bootSchematic(page: Page): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/live-sim/heat.kicad_sch`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

const menuRow = (page: Page) => page.getByTestId('live-sim-toggle');
const layer = (page: Page) => page.getByTestId('live-layer');
const widget = (page: Page, kind: string, ref: string) => page.locator(`[data-testid="live-${kind}"][data-ref="${ref}"]`);

async function closeOverlayMenu(page: Page): Promise<void> {
  if (await page.getByTestId('overlay-menu-panel').count()) await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
}

/** A click on the Session menu's row, then the row says `state`. */
async function clickRow(page: Page, state: 'running' | 'idle'): Promise<void> {
  await openSimulationMenu(page);
  await menuRow(page).click();
  await openSimulationMenu(page);
  await expect(menuRow(page)).toHaveAttribute('data-live-state', state, { timeout: 60000 });
  await expect(menuRow(page)).toHaveText(state === 'running' ? STOP : PLAY);
  await closeOverlayMenu(page);
  await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
}

async function openPanel(page: Page): Promise<Locator> {
  await openSimulationMenu(page);
  await page.getByTestId('sim-parts-panel-toggle').click();
  const panel = page.getByTestId('sim-parts-panel');
  await expect(panel).toBeVisible();
  await closeOverlayMenu(page);
  return panel;
}

/** The line of a part's thermal pins in the Simulation parts list. */
const heatLine = (page: Page, ref: string) => page.locator(`[data-testid="sim-part-thermal"][data-ref="${ref}"]`);

/** The names of its heat wires as the symbol in the editor says them, or null. */
function thermalField(page: Page, ref: string): Promise<string | null> {
  return page.evaluate(([ref, field]) => {
    const mod = (window as unknown as { Module: { kicadSimSymbols(): string } }).Module;
    const symbols = (JSON.parse(mod.kicadSimSymbols()) as { symbols: { ref: string; fields: Record<string, string> }[] }).symbols;
    return symbols.find((s) => s.ref === ref)?.fields[field!] ?? null;
  }, [ref, FIELD]);
}

/** The number a meter shows, as the run gave it (NaN before its first value). */
const reading = async (meter: Locator): Promise<number> => Number((await meter.locator('span').last().getAttribute('data-value')) ?? 'NaN');
const level = async (glow: Locator): Promise<number> => Number(await glow.getAttribute('data-level'));

test.describe('live simulation: heat as a drawn circuit', () => {
  test('a heater warms the wire it names, a fan cools it, a sensor is as warm as it', async ({ page }) => {
    test.setTimeout(300000);
    await serveLibrary(page);
    await bootSchematic(page);

    // --- the parts list: a line for the thermal pins of every part that has some ---
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 30000 });
    await expect(page.getByTestId('sim-part-thermal'), 'the heater, the fan and the two sensors').toHaveCount(4);
    await expect(heatLine(page, 'H1')).toHaveAttribute('data-wires', 'BOX');
    await expect(heatLine(page, 'H1')).toContainText('Heats the wire');
    await expect(heatLine(page, 'F1')).toHaveAttribute('data-wires', 'BOX OUT');
    await expect(heatLine(page, 'F1')).toHaveText(/Air between.*and/);
    await expect(heatLine(page, 'F1').getByTestId('sim-part-thermal-input'), 'a fan takes the names of two wires').toHaveCount(2);
    await expect(heatLine(page, 'T1')).toHaveAttribute('data-wires', '');
    await expect(heatLine(page, 'T1')).toContainText('Feels the wire');
    await expect(heatLine(page, 'T2')).toHaveAttribute('data-wires', 'OVEN');
    // A name no wire has is said under its line. The others have nothing to say.
    await expect(page.getByTestId('sim-part-thermal-error')).toHaveCount(1);
    await expect(page.getByTestId('sim-part-thermal-error')).toHaveText(/^T2 is on no heat wire: no wire of the schematic is called "OVEN"/);

    // --- T1 gets onto the box by the wire's name, typed on its line ---------------
    expect(await thermalField(page, 'T1')).toBeNull();
    const name = heatLine(page, 'T1').getByTestId('sim-part-thermal-input');
    await name.fill('BOX');
    await name.press('Enter');
    await expect(heatLine(page, 'T1')).toHaveAttribute('data-wires', 'BOX', { timeout: 30000 });
    await expect(heatLine(page, 'T1')).toHaveAttribute('data-busy', 'no');
    expect(await thermalField(page, 'T1'), 'the name is a field of the symbol').toBe('BOX');
    await expect(page.getByTestId('sim-part-thermal-error'), 'only T2 has something to say').toHaveCount(1);
    await page.getByTestId('sim-parts-panel-close').click();
    await expect(panel).toHaveCount(0);

    // --- Play: the notice about T2, and every part with its widgets ---------------
    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-heat')).toContainText('T2 is on no heat wire: no wire of the schematic is called "OVEN"');
    const heater = widget(page, 'glow', 'H1');
    const fan = widget(page, 'spin', 'F1');
    const heat = widget(page, 'toggle', 'S1');
    const blow = widget(page, 'toggle', 'S2');
    const box = widget(page, 'meter', 'T1').filter({ hasText: '°C' });
    const current = widget(page, 'meter', 'T1').filter({ hasNotText: '°C' });
    for (const w of [heater, fan, heat, blow, box, current]) await expect(w).toHaveCount(1);
    // On its wire the sensor has no slider: its temperature is the wire's, shown under it.
    await expect(widget(page, 'slider', 'T1'), 'on a wire the temperature is not set by hand').toHaveCount(0);
    // T2 is on no wire: it runs as it would without a name, with its slider.
    await expect(widget(page, 'slider', 'T2')).toHaveCount(1);
    await expect(widget(page, 'slider', 'T2')).toHaveAttribute('data-text', '25 °C');
    await expect(widget(page, 'meter', 'T2'), 'only its current: there is no wire to show').toHaveCount(1);

    // The box starts as warm as the outside that is drawn: nothing heats it yet.
    await expect(box.locator('span').last()).toHaveText('25.0 °C', { timeout: 15000 });
    await expect(current.locator('span').last()).toHaveText('2.50 mA', { timeout: 15000 });
    expect(await level(heater)).toBeLessThan(0.05);

    // --- the heater: 2.45 W into the box, which 4 ohm lead out ---------------------
    await heat.click();
    await expect(heat).toHaveAttribute('data-on', 'true');
    await expect.poll(() => level(heater), { message: 'the heater glows with the power it takes', timeout: 15000 }).toBeGreaterThan(0.9);
    await expect.poll(() => reading(box), { message: 'the box settles 9.8 degrees over the outside', timeout: 30000 }).toBeGreaterThan(34.6);
    expect(await reading(box)).toBeLessThan(35.0);
    await expect(box.locator('span').last()).toHaveText(/^3[45]\.\d °C$/);
    // The sensor is as warm as the box: its resistance went up with it.
    await expect.poll(() => reading(current), { message: 'the warm sensor takes less current', timeout: 15000 }).toBeLessThan(2.29e-3);
    expect(await reading(current)).toBeGreaterThan(2.26e-3);
    // The sensor that is on no wire did not feel it.
    expect(await reading(widget(page, 'meter', 'T2'))).toBeCloseTo(2.5e-3, 5);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-heat.png'), scale: 'css' });

    // --- the fan: its air carries heat from the box to the outside -----------------
    await blow.click();
    await expect(blow).toHaveAttribute('data-on', 'true');
    await expect(fan).toHaveAttribute('data-turning', 'forward', { timeout: 15000 });
    await expect.poll(() => reading(box), { message: 'with the fan the box is 4.9 degrees over the outside', timeout: 30000 }).toBeLessThan(30.1);
    expect(await reading(box)).toBeGreaterThan(29.7);

    // --- heater off: the fan and the 4 ohm bring the box back to the outside --------
    await heat.click();
    await expect(heat).toHaveAttribute('data-on', 'false');
    await expect.poll(() => reading(box), { message: 'the box cools to the outside', timeout: 30000 }).toBeLessThan(25.1);
    expect(await reading(box)).toBeGreaterThan(24.9);
    await expect.poll(() => reading(current), { timeout: 15000 }).toBeGreaterThan(2.49e-3);

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);

    // --- the typed name is one step of the schematic's history ---------------------
    expect(await page.evaluate(() => (window as unknown as { Module: { kicadCollabTestUndo(): boolean } }).Module.kicadCollabTestUndo())).toBe(true);
    await expect.poll(() => thermalField(page, 'T1'), { message: 'undo did not take the name back' }).toBeNull();
  });
});
