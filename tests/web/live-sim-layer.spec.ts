import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { clickByLabel } from '../e2e/utils/element-tracker';
import { openOverlayMenu } from './overlay-menu';

/**
 * Live simulation, the live layer (web/standalone/src/components/LiveLayer.tsx):
 * while a circuit runs, the parts' widgets on the open sheet, in the real app.
 *
 * The schematic is tests/fixtures/demo/live-sim/widgets.kicad_sch: a 5 V
 * source and three branches, one symbol for each kind of widget.
 *
 *   K1 a key to hold    then lamp L1                  press-zone, glow
 *   S1 a switch         then lamp L2, on its side     toggle-zone, glow
 *   RV1 a dial          over R2, meter M1 across R2   slider, meter
 *
 * L2 is rotated by 90 degrees and M1 is mirrored, so the editor's read of
 * where a symbol is (Module.kicadSimPlaces, wasm/bindings/sim_places.h) is
 * checked for a turned and a flipped symbol too.
 *
 * What is asserted, against the real editor and the real engine:
 *   - nothing is on the sheet before Play; with Play every part has its
 *     widget, on its symbol;
 *   - holding the key lights its lamp and letting go puts it out; the switch
 *     stays on after a click; the dial moves the meter's number;
 *   - the widgets stay on their symbols through a zoom and a pan, also when
 *     the wheel turns or the middle button is pressed over a zone;
 *   - a symbol that is being moved takes its widget along (the move is
 *     cancelled: the test changes nothing in the schematic);
 *   - while a KiCad dialog is open the widgets are not drawn;
 *   - Stop takes them away.
 *
 * A second schematic, named-supply.kicad_sch, draws no source at all: a wire
 * named +5V by its power symbol feeds a resistor and a lamp, and a wire named
 * VCC a resistor. The wire +5V is powered by its name, so the lamp lights at
 * the level 5 V gives it, and a notice says which wire was powered and which
 * was not (VCC: its name states no voltage).
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with five small parts of its own. The reference backend has
 * no /api/me; the test answers that too.
 *
 * Needs a wasm build with kicadSimPlaces, kicadSimNetlist and an
 * ngspice_service with the live engine: rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';
const PLAY = 'Run live simulation';
const STOP = 'Stop live simulation';
const MM = 10000; // the schematic editor's units per millimetre
/** Millimetres of the schematic file as the editor's whole units. */
const iu = (mm: number) => Math.round(mm * MM);

// --- the test's own library --------------------------------------------------

interface TestPart {
  manifest: Record<string, unknown>;
  model: string;
}

const part = (id: string, symbol: string, subckt: string, model: string, more: Record<string, unknown>): TestPart => ({
  manifest: {
    schema: 1, id, version: 1, title: id, description: '',
    fits: [{ symbol }], pins: ['1', '2'],
    analog: { file: 'model.lib', subckt },
    ...more,
  },
  model,
});

const PARTS: TestPart[] = [
  part('e2e-key', 'Test:KEY', 'E2E_KEY',
    ".subckt E2E_KEY 1 2\nVctl ctl 0 dc 0\nR1 1 2 r = '100meg * exp(-20.7 * V(ctl))'\n.ends E2E_KEY\n", {
      inputs: [{ name: 'pressed', type: 'momentary', source: 'Vctl', released: 0, held: 1 }],
      overlay: [{ widget: 'press-zone', place: { over: 'bbox', margin: [1.5, 1.5] }, input: 'pressed' }],
    }),
  part('e2e-toggle', 'Test:TOGGLE', 'E2E_TOGGLE',
    ".subckt E2E_TOGGLE 1 2\nVctl ctl 0 dc 0\nR1 1 2 r = '100meg * exp(-20.7 * V(ctl))'\n.ends E2E_TOGGLE\n", {
      inputs: [{ name: 'closed', type: 'toggle', source: 'Vctl', off: 0, on: 1, default: 'off' }],
      overlay: [{ widget: 'toggle-zone', place: { over: 'bbox', margin: [1.5, 1.5] }, input: 'closed' }],
    }),
  // 330 ohm: 15 mA from 5 V. `full` is 10 mA, so a lit lamp is at full level.
  part('e2e-lamp', 'Test:LAMP', 'E2E_LAMP',
    '.subckt E2E_LAMP 1 2\nVsense 1 m dc 0\nR1 m 2 330\n.ends E2E_LAMP\n', {
      settings: [{ name: 'color', label: 'Colour', default: 'red', options: ['red', 'green', 'blue'], fromValue: true }],
      signals: [{ name: 'current', current: 'Vsense' }],
      overlay: [{ widget: 'glow', place: { at: 'origin', size: [12, 12] }, signal: 'current', full: 0.01, color: '$color' }],
    }),
  // 10 k at 0 %, 1 k at 100 %: over the 1 k of R2 that is 0.4545 V and 2.5 V.
  part('e2e-dial', 'Test:DIAL', 'E2E_DIAL',
    ".subckt E2E_DIAL 1 2\nVpos pos 0 dc 0.5\nR1 1 2 r = '9000 * (1 - V(pos)) + 1000'\n.ends E2E_DIAL\n", {
      inputs: [{ name: 'position', type: 'range', source: 'Vpos', min: 0, max: 1, default: 0.5 }],
      overlay: [{ widget: 'slider', place: { below: 'bbox', gap: 2 }, input: 'position' }],
    }),
  // The fixture's meter is mirrored: its pin 2 is the upper one.
  part('e2e-meter', 'Test:METER', 'E2E_METER',
    '.subckt E2E_METER 1 2\nRin 1 2 10meg\nBm m 0 V = V(2,1)\nRm m r 1\nVread r 0 dc 0\n.ends E2E_METER\n', {
      signals: [{ name: 'volts', current: 'Vread' }],
      overlay: [{ widget: 'meter', place: { below: 'bbox', gap: 2 }, signal: 'volts', unit: 'V' }],
    }),
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fileEntry = (name: string, text: string) => ({ name, sha256: sha256(text), bytes: Buffer.byteLength(text) });

/** The snapshot's files by path: what a publish of these five parts writes. */
function snapshotFiles(): Record<string, string> {
  const files: Record<string, string> = { 'current.json': JSON.stringify({ schema: 1, version: SNAPSHOT }) };
  const index = { schema: 1, version: SNAPSHOT, parts: [] as unknown[], emulators: [] };
  for (const { manifest, model } of PARTS) {
    const id = manifest.id as string;
    const manifestText = JSON.stringify(manifest, null, 2);
    files[`${SNAPSHOT}/parts/${id}/part.json`] = manifestText;
    files[`${SNAPSHOT}/parts/${id}/model.lib`] = model;
    index.parts.push({
      id, version: 1, title: manifest.title, description: '', fits: manifest.fits, pins: manifest.pins, code: false,
      files: [fileEntry('part.json', manifestText), fileEntry('model.lib', model)],
    });
  }
  files[`${SNAPSHOT}/index.json`] = JSON.stringify(index);
  return files;
}

async function serveLibrary(page: Page): Promise<void> {
  const files = snapshotFiles();
  await page.route('**/e2e-sim-library/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, '');
    const body = files[path];
    if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: path.endsWith('.json') ? 'application/json' : 'text/plain', body });
  });
}

async function turnFeatureOn(page: Page): Promise<void> {
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

// --- the app -----------------------------------------------------------------

async function bootSchematic(page: Page, file = 'widgets'): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/live-sim/${file}.kicad_sch`);
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
  await openOverlayMenu(page);
  await menuRow(page).click();
  await openOverlayMenu(page);
  await expect(menuRow(page)).toHaveAttribute('data-live-state', state, { timeout: 60000 });
  await expect(menuRow(page)).toHaveText(state === 'running' ? STOP : PLAY);
  await closeOverlayMenu(page);
  await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
}

interface Place { ref: string; x: number; y: number; m: number[]; bbox: number[]; body: number[] }
interface Box { x: number; y: number; w: number; h: number }

/** Where the editor says the open sheet's symbols are, in sheet units. */
const places = (page: Page): Promise<Place[]> =>
  page.evaluate(() => JSON.parse((window as unknown as { Module: { kicadSimPlaces(): string } }).Module.kicadSimPlaces()).symbols);

/**
 * A box of the sheet (left, top, right, bottom in sheet units) as the page px
 * it is drawn at right now, from the editor's own pan and zoom.
 */
const onScreen = (page: Page, box: number[]): Promise<Box> =>
  page.evaluate(([x0, y0, x1, y1]) => {
    const vp = JSON.parse((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport());
    const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c.getBoundingClientRect())
      .find((r) => r.width > 0)!;
    const ratio = gl.width / vp.w;
    const px = (x: number, y: number) => [gl.x + ((x - vp.cx) * vp.scale + vp.w / 2) * ratio, gl.y + ((y - vp.cy) * vp.scale + vp.h / 2) * ratio];
    const [ax, ay] = px(x0!, y0!);
    const [bx, by] = px(x1!, y1!);
    return { x: ax!, y: ay!, w: bx! - ax!, h: by! - ay! };
  }, box);

const rectOf = async (locator: Locator): Promise<Box> => {
  const b = (await locator.boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};

const symbolOf = async (page: Page, ref: string): Promise<Place> => {
  const found = (await places(page)).find((s) => s.ref === ref);
  expect(found, `the editor lists ${ref}`).toBeTruthy();
  return found!;
};

/** The zone lies over its symbol's box, `margin` mm wider on every side. */
async function expectZoneOnSymbol(page: Page, zone: Locator, ref: string, margin: number, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const sym = await symbolOf(page, ref);
      const want = await onScreen(page, [sym.bbox[0]! - margin * MM, sym.bbox[1]! - margin * MM, sym.bbox[2]! + margin * MM, sym.bbox[3]! + margin * MM]);
      const got = await rectOf(zone);
      return Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.w - want.w), Math.abs(got.h - want.h));
    }, { message, timeout: 15000 })
    .toBeLessThanOrEqual(1.5);
}

/** The glow is centred on its symbol's origin. */
async function expectGlowOnSymbol(page: Page, glow: Locator, ref: string, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const sym = await symbolOf(page, ref);
      const want = await onScreen(page, [sym.x, sym.y, sym.x, sym.y]);
      const got = await rectOf(glow);
      return Math.max(Math.abs(got.x + got.w / 2 - want.x), Math.abs(got.y + got.h / 2 - want.y));
    }, { message, timeout: 15000 })
    .toBeLessThanOrEqual(1.5);
}

const level = async (glow: Locator): Promise<number> => Number(await glow.getAttribute('data-level'));

test.describe('live simulation: the widgets on the sheet', () => {
  test('every part has its widget on its symbol; key, switch and dial work', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page);
    await bootSchematic(page);

    // --- the editor's read of where the symbols are, against the file -------
    await page.waitForFunction(() => typeof (window as unknown as { Module?: { kicadSimPlaces?: unknown } }).Module?.kicadSimPlaces === 'function', null, { timeout: 60000 });
    const k1 = await symbolOf(page, 'K1');
    expect([k1.x, k1.y, k1.m], 'K1: as placed, not turned').toEqual([iu(76.2), iu(58.42), [1, 0, 0, -1]]);
    const l2 = await symbolOf(page, 'L2');
    expect([l2.x, l2.y, l2.m], 'L2: turned by 90 degrees').toEqual([iu(109.22), iu(66.04), [0, -1, -1, 0]]);
    const m1 = await symbolOf(page, 'M1');
    expect([m1.x, m1.y, m1.m], 'M1: mirrored top to bottom').toEqual([iu(139.7), iu(69.85), [1, 0, 0, 1]]);
    // K1 stands upright: its pins end 3.81 mm above and below its origin, and its box holds them.
    expect(k1.bbox[1]!, "K1's box reaches its upper pin").toBeLessThanOrEqual(iu(54.61));
    expect(k1.bbox[3]!, "K1's box reaches its lower pin").toBeGreaterThanOrEqual(iu(62.23));
    expect(k1.bbox[3]! - k1.bbox[1]!, 'and not much more').toBeLessThan(9 * MM);
    expect(k1.bbox[2]! - k1.bbox[0]!, 'K1 is narrow').toBeLessThan(3.5 * MM);
    // L2 lies on its side: its box is wide, with the pins left and right.
    expect(l2.bbox[0]!, "L2's box reaches its left pin").toBeLessThanOrEqual(iu(105.41));
    expect(l2.bbox[2]!, "L2's box reaches its right pin").toBeGreaterThanOrEqual(iu(113.03));
    expect(l2.bbox[3]! - l2.bbox[1]!, 'L2 is flat').toBeLessThan(6 * MM);
    // The body is the drawing without the pins: inside the box.
    expect(k1.body[1]! > k1.bbox[1]! && k1.body[3]! < k1.bbox[3]!, "K1's body is shorter than its box").toBe(true);

    await expect(layer(page), 'nothing is on the sheet before Play').toHaveCount(0);

    // --- Play: every part has its widget, on its symbol ----------------------
    await clickRow(page, 'running');
    await expect(layer(page)).toHaveAttribute('data-sheet', '/', { timeout: 30000 });
    await expect(layer(page)).toHaveAttribute('data-widgets', '6');
    const key = widget(page, 'press', 'K1');
    const toggle = widget(page, 'toggle', 'S1');
    const lamp1 = widget(page, 'glow', 'L1');
    const lamp2 = widget(page, 'glow', 'L2');
    const slider = widget(page, 'slider', 'RV1');
    const meter = widget(page, 'meter', 'M1');
    for (const w of [key, toggle, lamp1, lamp2, slider, meter]) await expect(w).toHaveCount(1);
    await expectZoneOnSymbol(page, key, 'K1', 1.5, "the key's zone is on K1");
    await expectZoneOnSymbol(page, toggle, 'S1', 1.5, "the switch's zone is on S1");
    await expectGlowOnSymbol(page, lamp1, 'L1', "the lamp's glow is on L1");
    await expectGlowOnSymbol(page, lamp2, 'L2', 'and on L2, which lies on its side');
    // the slider and the meter hang under their symbols, centred
    for (const [w, ref] of [[slider, 'RV1'], [meter, 'M1']] as const) {
      const sym = await symbolOf(page, ref);
      const under = await onScreen(page, [(sym.bbox[0]! + sym.bbox[2]!) / 2, sym.bbox[3]! + 2 * MM, 0, 0]);
      const got = await rectOf(w);
      expect(Math.abs(got.x + got.w / 2 - under.x), `${ref}: centred under its symbol`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(got.y - under.y), `${ref}: 2 mm under its symbol`).toBeLessThanOrEqual(1.5);
    }

    // --- the key: held lights the lamp, let go puts it out -------------------
    expect(await level(lamp1), 'the lamp is dark').toBeLessThan(0.05);
    const k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.down();
    await expect(key).toHaveAttribute('data-held', 'true');
    await expect.poll(() => level(lamp1), { message: 'holding the key lights its lamp', timeout: 15000 }).toBeGreaterThan(0.9);
    expect(await level(lamp2), "the other branch's lamp stays dark").toBeLessThan(0.05);
    await page.mouse.up();
    await expect(key).toHaveAttribute('data-held', 'false');
    await expect.poll(() => level(lamp1), { message: 'letting go puts it out', timeout: 15000 }).toBeLessThan(0.05);

    // --- the switch: on after a click, off after the next --------------------
    await expect(toggle).toHaveAttribute('data-on', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'true');
    await expect.poll(() => level(lamp2), { message: 'the switch lights its lamp, and it stays lit', timeout: 15000 }).toBeGreaterThan(0.9);
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'false');
    await expect.poll(() => level(lamp2), { message: 'the next click puts it out', timeout: 15000 }).toBeLessThan(0.05);

    // --- the dial: the meter follows ----------------------------------------
    const number = meter.locator('span').last();
    await expect(slider).toHaveAttribute('data-percent', '50');
    await expect(number, 'the dial at 50 %: 5 V over 5.5 k and 1 k').toHaveText('769 mV', { timeout: 15000 });
    // With the keyboard: End and Home are the slider's own keys. The editor does not hear them
    // (End is KiCad's "double-click at the cursor": it would open a dialog, and the widgets would go).
    const thumb = slider.getByRole('slider');
    await thumb.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('data-percent', '100');
    await expect(number, 'the dial at 100 %: half of 5 V').toHaveText('2.50 V', { timeout: 15000 });
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('data-percent', '0');
    await expect(number, 'the dial at 0 %: 5 V over 10 k and 1 k').toHaveText('455 mV', { timeout: 15000 });
    await expect(layer(page), 'the keys did not reach the editor: no dialog, the widgets are there').toHaveCount(1);
    // With the mouse: a drag of the knob to the right end, and the keyboard is the editor's again.
    const knob = (await thumb.boundingBox())!;
    const track = (await slider.boundingBox())!;
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width, knob.y + knob.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(slider).toHaveAttribute('data-percent', '100');
    await expect(number).toHaveText('2.50 V', { timeout: 15000 });
    expect(await thumb.evaluate((el) => el === document.activeElement), 'the knob does not keep the keyboard').toBe(false);

    // --- Stop takes the widgets away -----------------------------------------
    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a schematic that draws no source runs: a wire named +5V is powered by its name', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page);
    await bootSchematic(page, 'named-supply');

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    const notice = page.getByTestId('live-sim-power');
    await expect(notice, 'the notice names the wire and its voltage').toContainText('+5V is powered with 5 V, by its name.');
    await expect(notice, 'and the supply wire that got nothing').toContainText('VCC is not powered: its name does not say a voltage.');

    // The lamp is 330 ohm behind R1's 330 ohm: 5 V drives 7.6 mA through it, of the 10 mA
    // that is full level. Only 5 V on the wire gives that level.
    const lamp = widget(page, 'glow', 'L1');
    await expect(layer(page)).toHaveAttribute('data-widgets', '1', { timeout: 30000 });
    await expect.poll(() => level(lamp), { message: 'L1 is lit by the 5 V of its wire', timeout: 30000 }).toBeGreaterThan(0.74);
    expect(await level(lamp)).toBeLessThan(0.78);

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('the widgets stay on their symbols; pan, zoom and dialogs are the editor\'s', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page);
    await bootSchematic(page);
    await clickRow(page, 'running');
    const key = widget(page, 'press', 'K1');
    const lamp1 = widget(page, 'glow', 'L1');
    const lamp2 = widget(page, 'glow', 'L2');
    await expect(key).toHaveCount(1, { timeout: 30000 });
    await expectZoneOnSymbol(page, key, 'K1', 1.5, "the key's zone is on K1");

    const scale = () => page.evaluate(() => JSON.parse((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()).scale as number);

    // --- the wheel over a zone zooms the editor, and the widgets follow ------
    const before = await scale();
    let k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.wheel(0, -120);
    await expect.poll(scale, { message: 'the wheel over the zone zooms the schematic', timeout: 15000 }).toBeGreaterThan(before * 1.1);
    await expectZoneOnSymbol(page, key, 'K1', 1.5, 'zoomed in: the zone is still on K1');
    await expectGlowOnSymbol(page, lamp1, 'L1', 'and the glow on L1');
    await expectGlowOnSymbol(page, lamp2, 'L2', 'and on L2');
    expect((await rectOf(key)).w, 'the zone grew with the symbol').toBeGreaterThan(k.w * 1.1);

    // --- the middle button on a zone pans the editor; the key is not pressed -
    k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(k.x + k.w / 2 + 60, k.y + k.h / 2 + 40, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    await expect
      .poll(async () => {
        const now = await rectOf(key);
        return [Math.round(now.x - k.x), Math.round(now.y - k.y)];
      }, { message: 'the schematic moved with the drag, and the zone with it', timeout: 15000 })
      .toEqual([60, 40]);
    await expect(key).toHaveAttribute('data-held', 'false');
    await expectZoneOnSymbol(page, key, 'K1', 1.5, 'panned: the zone is still on K1');
    await expectGlowOnSymbol(page, lamp1, 'L1', 'and the glow on L1');

    // --- a symbol that is being moved takes its widget along ------------------
    // The glow lets clicks through: a click on the lamp picks it, M moves it.
    // Escape cancels the move, so the schematic is as it was.
    const home = await symbolOf(page, 'L1');
    const g = await rectOf(lamp1);
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    await page.mouse.click(cx, cy);
    await page.keyboard.press('m');
    await page.mouse.move(cx + 90, cy + 50, { steps: 8 });
    await expect
      .poll(async () => (await symbolOf(page, 'L1')).x, { message: 'the lamp is on the move', timeout: 15000 })
      .toBeGreaterThan(home.x);
    await expectGlowOnSymbol(page, lamp1, 'L1', 'the glow moves with the lamp');
    expect((await rectOf(lamp1)).x, 'and is not where it was').toBeGreaterThan(g.x + 40);
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => { const now = await symbolOf(page, 'L1'); return [now.x, now.y]; }, { message: 'the move is cancelled: the lamp is back', timeout: 15000 })
      .toEqual([home.x, home.y]);
    await expectGlowOnSymbol(page, lamp1, 'L1', 'and so is its glow');
    await page.keyboard.press('Escape'); // nothing stays picked

    // --- a KiCad dialog is drawn under the layer: the widgets go away --------
    await page.mouse.dblclick(cx, cy); // the lamp's properties
    await expect(layer(page), 'no widget is drawn over a dialog').toHaveCount(0, { timeout: 30000 });
    await expect.poll(() => clickByLabel(page, 'Cancel'), { message: "the dialog's Cancel", timeout: 15000 }).toBe(true);
    await expect(layer(page), 'the dialog is closed: the widgets are back').toHaveCount(1, { timeout: 30000 });
    await expectZoneOnSymbol(page, key, 'K1', 1.5, 'where they were');

    // --- and the circuit ran through all of it --------------------------------
    k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.down();
    await expect.poll(() => level(lamp1), { message: 'the key still lights its lamp', timeout: 15000 }).toBeGreaterThan(0.9);
    await page.mouse.up();
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });
});
