import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { clickByLabel } from '../e2e/utils/element-tracker';
import { openSimulationMenu } from './overlay-menu';

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
 * A third schematic, chips.kicad_sch, has a chip with three units, the way
 * KiCad draws a dual op-amp: two amplifiers and a unit with the supply pins.
 * It is placed twice, each time with one amplifier that feeds a lamp. U1 has
 * its supply unit too. Its second amplifier is not placed, so the editor
 * reads no pins for it: the part says a symbol may lack them, and they are
 * left open. The part's line for the symbol says a setting (the output stays
 * 2 V under the supply), and the lamp shows the 3 V that gives. U2 has no
 * supply unit: its lamp stays dark and the notice names the chip and its two
 * supply pins. The part asks for Gear's method, so this run is computed
 * with it.
 *
 * A fourth schematic, regulators.kicad_sch, has a regulator placed twice,
 * each with a lamp on the wire at its output. The part says it passes on the
 * power it takes in at its input. U1's input is on the wire +5V, which is
 * powered by its name: U1 is the source of the wire at its output, and the
 * lamp shows the 2 V the part gives, not the 3.3 V of that wire's name
 * (+3V3). U2's input is on VCC, a name that states no voltage. No source
 * reaches U2: the notice names it with its input pin, and the wire at its
 * output (+6V) keeps the power of its name.
 *
 * The second schematic runs once more with another part on its lamp symbol: one
 * with seven currents, shown as a 7-segment digit and as one light that mixes
 * two of them. Three of the currents flow, so the digit shows a 7 and the
 * light is yellow (red and green). The part's line for the symbol says where
 * on the symbol its overlay sits, and both widgets are there.
 *
 * The first schematic runs once more with its two lamp symbols as relay coils.
 * A relay moves its contact by itself: the coil's current pulls it in, and the
 * app draws the contact where it is now. Holding the key pulls L1 in and
 * letting go lets it fall back; the switch pulls L2 in and it stays.
 *
 * And once with its dial as a sensor that is set by hand: a resistor that
 * follows a temperature. Its slider says the degrees it is set to, not a
 * percentage, and the meter shows what that temperature does to the circuit.
 *
 * And once with its lamps as parts that turn and sound (a motor, a buzzer): a
 * mark goes round on the symbol while the part has current, a number says
 * its turns a minute as a whole number, and rings spread from it. Without
 * current the mark stands still and there are no rings.
 *
 * The part that sounds has a tone of its own, 2000 Hz, so it is also heard:
 * the page plays it while the part sounds (wasm/live-sound.ts). One test
 * reads the sound itself, in Chromium: a tap on what goes to the speakers
 * says how loud it is and at which pitch. The Session menu has a row that
 * mutes it, only while a circuit runs that has such a part.
 *
 * The slider and the meter's number are tags: they hang under their symbols
 * and can cover what is drawn there. A tag is dragged off it with the mouse
 * (the meter anywhere, the slider by its words: its knob is dragged along
 * the track). It then stays that far from its symbol on the sheet, through a
 * zoom and into the next run, with a thin line to where it belongs. The
 * editor does not hear the drag. A double-click puts the tag back. Zoomed
 * out, the tags are drawn smaller; zoomed in close, they grow with the
 * sheet. Where they were put is kept in the browser, nothing of it in the
 * schematic.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the
 * test answers it with small parts of its own. The reference backend has
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
      // the contact that moves: tilted while the switch is open, on the symbol's middle line while it is closed
      overlay: [{
        widget: 'toggle-zone', place: { over: 'bbox', margin: [1.5, 1.5] }, input: 'closed',
        lines: [{ off: [0, -1.5, 1.2, 1.2], on: [0, -1.5, 0, 1.5] }],
      }],
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

// The lamp symbol as a part with seven currents. Behind R1's 330 ohm, the bars a, b and c are
// 1 k each and carry 2.5 mA; d to g are 100 Meg and carry nothing. `full` is 2 mA.
const BARS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const DIGIT_PARTS: TestPart[] = [
  part('e2e-digit', 'Test:LAMP', 'E2E_DIGIT',
    `.subckt E2E_DIGIT 1 2\n${BARS.map((s) => `V${s} 1 n${s} dc 0\nR${s} n${s} 2 ${'abc'.includes(s) ? '1k' : '100meg'}`).join('\n')}\n.ends E2E_DIGIT\n`, {
      // the overlay is measured from a point 2 mm above the symbol's origin
      fits: [{ symbol: 'Test:LAMP', origin: [0, 2] }],
      signals: BARS.map((s) => ({ name: s, current: `V${s}` })),
      overlay: [
        { widget: 'seven-segment', place: { rect: [-3, -4, 3, 4] }, signals: BARS, full: 0.002, color: 'green' },
        { widget: 'glow-mix', place: { at: 'origin', size: [10, 10] }, signals: ['a', 'b', 'd'], full: 0.002, colors: ['red', 'green', 'blue'] },
      ],
    }),
];

// The lamp symbols as relay coils, with the model of the library's relay parts: a coil with
// its inductance (69 ohm, 5 V), an armature that pulls in above two thirds of the coil's
// current and lets go under a quarter, and the position as a current (1 A is pulled in).
// The contact itself has no pins here: the symbol has two, and they are the coil's.
const RELAY_PARTS: TestPart[] = [
  ...PARTS.filter((p) => p.manifest.id !== 'e2e-lamp'),
  part('e2e-relay', 'Test:LAMP', 'E2E_RELAY', [
    '.subckt E2E_RELAY 1 2',
    'Rcoil 1 m1 69', 'Vsense m1 m2 dc 0', 'Lcoil m2 2 139m', 'Rkick 1 2 1.4k',
    'Bpull p 0 V = abs(I(Vsense)) * 13.9',
    'Vone one 0 dc 1', 'Sarm one s p 0 E2EARM', 'Rrest s 0 10', 'Rarm s st 1k', 'Carm st 0 1u',
    'Bstate b 0 V = V(st)', 'Rstate b l 1', 'Vstate l 0 dc 0',
    '.model E2EARM SW(VT=0.45 VH=0.2 RON=10m ROFF=1G)',
    '.ends E2E_RELAY', '',
  ].join('\n'), {
    signals: [{ name: 'pulled', current: 'Vstate' }],
    // the arm: from its foot up to the left at rest, up to the right when pulled in
    overlay: [{ widget: 'contact', place: { rect: [-3, -3, 3, 3] }, signal: 'pulled', lines: [{ off: [0, -2, -1.5, 2], on: [0, -2, 1.5, 2] }] }],
  }),
];

// The dial symbol as a temperature sensor: 1 k at 25 degrees, 1 % more for every degree.
// Over the 1 k of R2 the meter reads 2.50 V at 25 degrees, 1.67 V at 125 and 3.70 V at -40.
const SENSOR_PARTS: TestPart[] = [
  ...PARTS.filter((p) => p.manifest.id !== 'e2e-dial'),
  part('e2e-sensor', 'Test:DIAL', 'E2E_SENSOR',
    ".subckt E2E_SENSOR 1 2\nVtemp temp 0 dc 25\nR1 1 2 r = '1000 * (1 + 0.01 * (V(temp) - 25))'\n.ends E2E_SENSOR\n", {
      inputs: [{ name: 'temperature', type: 'range', source: 'Vtemp', min: -40, max: 125, default: 25 }],
      overlay: [{ widget: 'slider', place: { below: 'bbox', gap: 2 }, input: 'temperature', unit: '°C' }],
    }),
];

// A chip with two amplifiers behind one pair of supply pins. An amplifier puts its plus input
// on its output, at most HIGH volts under the supply, and nothing without the supply. Any of
// its pins may be missing (a unit that is not placed). The line for the symbol says HIGH is 2.
const CHIP_PINS = ['INP1', 'INN1', 'OUT1', 'INP2', 'INN2', 'OUT2', 'VP', 'VN'];
const CHIP_PARTS: TestPart[] = [
  ...PARTS,
  part('e2e-amp2', 'Test:AMP2', 'E2E_AMP2', [
    `.subckt E2E_AMP2 ${CHIP_PINS.join(' ')} HIGH=0`,
    ...CHIP_PINS.map((pin) => `R${pin} ${pin} 0 1G`),
    'Bpw pw 0 V = V(VP, VN) > 2 ? 1 : 0',
    'B1 g1 0 V = V(pw) * min(V(INP1), V(VP) - {HIGH})', 'Ro1 g1 OUT1 10',
    'B2 g2 0 V = V(pw) * min(V(INP2), V(VP) - {HIGH})', 'Ro2 g2 OUT2 10',
    '.ends E2E_AMP2', '',
  ].join('\n'), {
    fits: [{ symbol: 'Test:AMP2', pins: { INP1: '3', INN1: '2', OUT1: '1', INP2: '5', INN2: '6', OUT2: '7', VP: '8', VN: '4' }, set: { high: '2' } }],
    pins: CHIP_PINS,
    mayLack: CHIP_PINS,
    powered: ['VP', 'VN'],
    settings: [{ name: 'high', label: 'Under the supply', unit: 'V', default: '0', accept: '^[0-9]+$' }],
    analog: { file: 'model.lib', subckt: 'E2E_AMP2', params: { HIGH: '$high' }, method: 'gear' },
  }),
];

// A regulator: 2 V at its output while its input has more, and nothing flows back into it.
// It is a source for the wire at its output only when a source reaches its input.
const REG_PINS = ['IN', 'OUT', 'COM'];
const REG_PARTS: TestPart[] = [
  ...PARTS,
  part('e2e-reg', 'Test:REG', 'E2E_REG', [
    `.subckt E2E_REG ${REG_PINS.join(' ')}`,
    ...REG_PINS.map((pin) => `R${pin} ${pin} 0 1G`),
    'Bt t COM V = min(2, V(IN, COM))',
    'Bp t OUT I = max(0, V(t, OUT))',
    '.ends E2E_REG', '',
  ].join('\n'), {
    fits: [{ symbol: 'Test:REG', pins: { IN: '1', COM: '2', OUT: '3' } }],
    pins: REG_PINS,
    supplies: ['OUT'],
    suppliesFrom: ['IN'],
  }),
];

// The lamp symbols as parts that turn and sound. 500 ohm: 10 mA from 5 V, which is the full
// speed and the full loudness; the part follows its current within 20 ms. Its speed leaves
// it as a current (1 A is the full speed), and so do its turns a minute (1200 at the most).
const MOVER_PARTS: TestPart[] = [
  ...PARTS.filter((p) => p.manifest.id !== 'e2e-lamp'),
  part('e2e-mover', 'Test:LAMP', 'E2E_MOVER', [
    '.subckt E2E_MOVER 1 2',
    'Vsense 1 m dc 0', 'R1 m 2 500',
    'Bgo g 0 V = I(Vsense) * 100', 'Rw g w 1k', 'Cw w 0 20u',
    'Bspeed sv 0 V = V(w)', 'Rspeed sv si 1', 'Vspeed si 0 dc 0',
    'Brpm rv 0 V = V(w) * 1200', 'Rrpm rv ri 1', 'Vrpm ri 0 dc 0',
    '.ends E2E_MOVER', '',
  ].join('\n'), {
    signals: [{ name: 'speed', current: 'Vspeed' }, { name: 'rpm', current: 'Vrpm' }],
    overlay: [
      { widget: 'spin', place: { rect: [-3, -3, 3, 3] }, signal: 'speed' },
      { widget: 'meter', place: { below: 'bbox', gap: 2 }, signal: 'rpm', unit: 'rpm', prefix: false },
      { widget: 'sound', place: { at: 'origin', size: [14, 14] }, signal: 'speed', tone: 2000 },
    ],
  }),
];

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
      ...(manifest.mayLack ? { mayLack: manifest.mayLack } : {}),
      files: [fileEntry('part.json', manifestText), fileEntry('model.lib', model)],
    });
  }
  files[`${SNAPSHOT}/index.json`] = JSON.stringify(index);
  return files;
}

async function serveLibrary(page: Page, parts: TestPart[] = PARTS): Promise<void> {
  const files = snapshotFiles(parts);
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
  await openSimulationMenu(page);
  await menuRow(page).click();
  await openSimulationMenu(page);
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
    // no part of this circuit has a tone of its own: nothing is played, and the menu has no row for it
    await expect(page.getByTestId('live-sound-out')).toHaveCount(0);
    await openSimulationMenu(page);
    await expect(page.getByTestId('live-sim-sound')).toHaveCount(0);
    await closeOverlayMenu(page);
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
    const contact = toggle.getByTestId('live-zone-lines');
    await expect(toggle).toHaveAttribute('data-on', 'false');
    await expect(contact).toHaveAttribute('data-position', 'off');
    await expect(key.getByTestId('live-zone-lines'), 'a zone whose part draws no contact has none').toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'true');
    await expect(contact).toHaveAttribute('data-position', 'on');
    await expect
      .poll(async () => {
        const sym = await symbolOf(page, 'S1');
        const want = await onScreen(page, [sym.x, sym.y - 1.5 * MM, sym.x, sym.y + 1.5 * MM]);
        const got = await contact.locator('line').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y, h: r.height };
        });
        return Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.h - want.h));
      }, { message: 'closed, the contact is drawn on the middle line of S1, 3 mm long', timeout: 15000 })
      .toBeLessThanOrEqual(1.5);
    await expect.poll(() => level(lamp2), { message: 'the switch lights its lamp, and it stays lit', timeout: 15000 }).toBeGreaterThan(0.9);
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'false');
    await expect(contact).toHaveAttribute('data-position', 'off');
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

  test('a chip with several units: a unit that is not placed is left open, a chip without its supply is named', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, CHIP_PARTS);
    await bootSchematic(page, 'chips');

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    const notice = page.getByTestId('live-sim-power');
    await expect(notice, 'the chip without its supply unit is named, with its supply pins').toContainText('U2 has no power: nothing is connected to its supply pins 4 and 8.');
    await expect(notice, 'the chip that has its supply is not').not.toContainText('U1');

    // U1 puts its 5 V input on its output, 2 V under the supply as its line says: 3 V over
    // 10 + 330 + 330 ohm is 4.5 mA of the 10 mA that is full level. (With the part's own 0 V
    // it would be 7.5 mA.) Its other amplifier is not placed and stops nothing.
    await expect(layer(page)).toHaveAttribute('data-widgets', '2', { timeout: 30000 });
    const lit = widget(page, 'glow', 'L1');
    await expect.poll(() => level(lit), { message: 'L1 is lit by the 3 V of U1', timeout: 30000 }).toBeGreaterThan(0.43);
    expect(await level(lit)).toBeLessThan(0.47);
    expect(await level(widget(page, 'glow', 'L2')), 'U2 has no power: its lamp is dark').toBeLessThan(0.01);

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a regulator is the source of its output wire when a source reaches it; one that none reaches is named', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, REG_PARTS);
    await bootSchematic(page, 'regulators');

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    const notice = page.getByTestId('live-sim-power');
    await expect(notice, 'the regulator that no source reaches is named, with its input pin').toContainText('U2 gives no power: no source reaches its input (pin 1).');
    await expect(notice, 'the wire at its output keeps the power of its name').toContainText('Powered by their names: +5V with 5 V, +6V with 6 V.');
    await expect(notice, 'the wire at the output of U1 has its power from U1').not.toContainText('+3V3');
    await expect(notice, 'the regulator that a source reaches is not named').not.toContainText('U1');
    await expect(notice, 'the supply wire that got nothing is').toContainText('VCC is not powered: its name does not say a voltage.');

    // U1 gives 2 V: over 330 + 330 ohm that is 3 mA of the 10 mA that is full level. The
    // 3.3 V of the wire's name would be 5 mA. U2 gives nothing, and the 6 V of its wire's
    // name are 9.1 mA.
    await expect(layer(page)).toHaveAttribute('data-widgets', '2', { timeout: 30000 });
    const fed = widget(page, 'glow', 'L1');
    await expect.poll(() => level(fed), { message: 'L1 is lit by the 2 V of U1', timeout: 30000 }).toBeGreaterThan(0.28);
    expect(await level(fed)).toBeLessThan(0.32);
    const named = widget(page, 'glow', 'L2');
    await expect.poll(() => level(named), { message: 'L2 is lit by the 6 V of its wire', timeout: 30000 }).toBeGreaterThan(0.89);
    expect(await level(named)).toBeLessThan(0.93);

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a part with several currents: a digit lights its bars, a light mixes its colours', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, DIGIT_PARTS);
    await bootSchematic(page, 'named-supply');

    await clickRow(page, 'running');
    await expect(layer(page)).toHaveAttribute('data-widgets', '2', { timeout: 30000 });

    // the bars a, b and c carry a current: the digit shows a 7
    const digit = widget(page, 'seven-segment', 'L1');
    await expect(digit, 'the bars that carry a current are lit').toHaveAttribute('data-lit', 'abc', { timeout: 30000 });
    const shown = (bar: string) => digit.locator(`[data-segment="${bar}"]`).evaluate((el) => Number((el as SVGElement).style.opacity));
    await expect.poll(() => shown('a'), { message: 'a lit bar is drawn at full strength' }).toBeGreaterThan(0.95);
    expect(await shown('d'), 'an unlit bar stays a faint shape on the dark face').toBeCloseTo(0.1, 2);
    await expect(digit.locator('[data-segment]'), 'seven bars and no point: the part has seven currents').toHaveCount(7);

    // red and green lit, blue dark: one yellow light
    const light = widget(page, 'glow', 'L1');
    await expect(light, 'the light has the level of each of its currents').toHaveAttribute('data-levels', '1.00 1.00 0.00', { timeout: 30000 });
    await expect(light, 'and the colour red and green mix to').toHaveAttribute('data-color', '255 228 109');
    await expect.poll(() => level(light), { message: 'the strongest current says how bright it is' }).toBeGreaterThan(0.95);

    // Both sit where the part's line for this symbol says: 2 mm above the symbol's origin.
    // The digit's face is 6 by 8 mm around that point, the light is centred on it.
    await expect
      .poll(async () => {
        const sym = await symbolOf(page, 'L1');
        const want = await onScreen(page, [sym.x - iu(3), sym.y - iu(6), sym.x + iu(3), sym.y + iu(2)]);
        const face = await rectOf(digit);
        const glow = await rectOf(light);
        return Math.max(
          Math.abs(face.x - want.x), Math.abs(face.y - want.y), Math.abs(face.w - want.w), Math.abs(face.h - want.h),
          Math.abs(glow.x + glow.w / 2 - (want.x + want.w / 2)), Math.abs(glow.y + glow.h / 2 - (want.y + want.h / 2)),
        );
      }, { message: 'the digit and the light are at the place the part names on this symbol', timeout: 15000 })
      .toBeLessThanOrEqual(1.5);

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a relay moves its contact by itself: pulled in while its coil has current', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, RELAY_PARTS);
    await bootSchematic(page);

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-widgets', '6', { timeout: 30000 });
    const relay1 = widget(page, 'contact', 'L1');
    const relay2 = widget(page, 'contact', 'L2');
    const arm = relay1.getByTestId('live-zone-lines');
    await expect(relay1, 'at rest while the key is open').toHaveAttribute('data-position', 'off');
    await expect(arm, 'and its arm is drawn at rest').toHaveAttribute('data-position', 'off');

    // The contact is nothing to click: it is drawn in the box the part names, 6 by 6 mm
    // around the symbol's origin, and at rest the arm leans to the left in it.
    const armIn = async (): Promise<{ box: number; left: number; right: number }> => {
      const sym = await symbolOf(page, 'L1');
      const want = await onScreen(page, [sym.x - iu(3), sym.y - iu(3), sym.x + iu(3), sym.y + iu(3)]);
      const got = await rectOf(relay1);
      const line = await arm.locator('line').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, w: r.width };
      });
      const mid = want.x + want.w / 2;
      return {
        box: Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.w - want.w), Math.abs(got.h - want.h)),
        left: mid - line.x,
        right: line.x + line.w - mid,
      };
    };
    // 1.5 mm to one side of the middle, the other end on the middle; the stroke adds a little
    const reach = (await onScreen(page, [0, 0, iu(1.5), 0])).w;
    await expect.poll(async () => (await armIn()).box, { message: "the relay's widget is at the place its part names", timeout: 15000 }).toBeLessThanOrEqual(1.5);
    const rest = await armIn();
    expect(Math.abs(rest.left - reach), 'at rest the arm reaches 1.5 mm to the left').toBeLessThanOrEqual(3);
    expect(rest.right, 'and not to the right').toBeLessThanOrEqual(3);
    expect(await relay1.evaluate((el) => getComputedStyle(el).pointerEvents), 'a click on it is the editor\'s').toBe('none');

    // --- the key feeds the coil of L1 ---------------------------------------
    const key = widget(page, 'press', 'K1');
    const k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.down();
    await expect(key).toHaveAttribute('data-held', 'true');
    await expect(relay1, 'the coil has its current: pulled in').toHaveAttribute('data-position', 'on', { timeout: 15000 });
    await expect(arm).toHaveAttribute('data-position', 'on');
    const pulled = await armIn();
    expect(Math.abs(pulled.right - reach), 'pulled in, the arm reaches 1.5 mm to the right').toBeLessThanOrEqual(3);
    expect(pulled.left, 'and not to the left').toBeLessThanOrEqual(3);
    await expect(relay2, 'each relay goes by its own coil').toHaveAttribute('data-position', 'off');
    await page.mouse.up();
    await expect(key).toHaveAttribute('data-held', 'false');
    await expect(relay1, 'without current it falls back').toHaveAttribute('data-position', 'off', { timeout: 15000 });

    // --- the switch feeds the coil of L2, which lies on its side -------------
    const toggle = widget(page, 'toggle', 'S1');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'true');
    await expect(relay2, 'pulled in, and it stays').toHaveAttribute('data-position', 'on', { timeout: 15000 });
    await expect(relay1).toHaveAttribute('data-position', 'off');
    await toggle.click();
    await expect(relay2, 'the next click lets it fall back').toHaveAttribute('data-position', 'off', { timeout: 15000 });

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a sensor set by hand: its slider says the value it is set to', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, SENSOR_PARTS);
    await bootSchematic(page);

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    await expect(layer(page)).toHaveAttribute('data-widgets', '6', { timeout: 30000 });
    const slider = widget(page, 'slider', 'RV1');
    const number = widget(page, 'meter', 'M1').locator('span').last();

    // It starts at the part's own start, 25 degrees, which is not the middle of its range.
    await expect(slider, 'the slider says degrees').toHaveAttribute('data-text', '25 °C');
    await expect(slider).toContainText('RV1 25 °C');
    await expect(slider).toHaveAttribute('data-percent', '39');
    await expect(number, '1 k at 25 degrees: half of 5 V').toHaveText('2.50 V', { timeout: 15000 });

    const thumb = slider.getByRole('slider');
    await expect(thumb, 'the knob is named after what it sets').toHaveAttribute('aria-label', 'RV1: temperature');
    await thumb.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('data-text', '125 °C');
    await expect(number, '2 k at 125 degrees: a third of 5 V').toHaveText('1.67 V', { timeout: 15000 });
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('data-text', '-40 °C');
    await expect(number, '350 ohm at -40 degrees').toHaveText('3.70 V', { timeout: 15000 });

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a part that turns and sounds: a mark goes round, rings spread, a number counts the turns', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page, MOVER_PARTS);
    await bootSchematic(page);

    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
    // the key, the switch, the dial and the meter, and three widgets on each of the two movers
    await expect(layer(page)).toHaveAttribute('data-widgets', '10', { timeout: 30000 });
    const spin1 = widget(page, 'spin', 'L1');
    const spin2 = widget(page, 'spin', 'L2');
    const sound1 = widget(page, 'sound', 'L1');
    const sound2 = widget(page, 'sound', 'L2');
    const turns1 = widget(page, 'meter', 'L1').locator('span').last();
    const turns2 = widget(page, 'meter', 'L2').locator('span').last();
    const mark1 = spin1.locator('g');
    const played = page.getByTestId('live-sound-out');

    // At rest: the mark is there, pale and still, and nothing sounds.
    await expect(spin1, 'it stands while the key is open').toHaveAttribute('data-turning', 'no');
    await expect(sound1, 'and is silent').toHaveAttribute('data-rings', '0');
    await expect(sound1, 'the part has a tone of its own').toHaveAttribute('data-tone', '2000');
    await expect(played, 'two parts of this circuit can be heard').toHaveAttribute('data-tones', '2');
    await expect(played, 'none is played').toHaveAttribute('data-heard', '');
    await expect(sound1.locator('span')).toHaveCount(0);
    await expect(turns1, 'a count has no prefix and no decimals').toHaveText('0 rpm', { timeout: 15000 });
    expect(await spin1.evaluate((el) => getComputedStyle(el).pointerEvents), 'a click on it is the editor\'s').toBe('none');

    // The mark is drawn in the box the part names: 6 by 6 mm around the symbol's origin,
    // also for L2, which lies on its side.
    for (const [ref, spin] of [['L1', spin1], ['L2', spin2]] as const) {
      await expect.poll(async () => {
        const sym = await symbolOf(page, ref);
        const want = await onScreen(page, [sym.x - iu(3), sym.y - iu(3), sym.x + iu(3), sym.y + iu(3)]);
        const got = await rectOf(spin);
        return Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.w - want.w), Math.abs(got.h - want.h));
      }, { message: `the mark of ${ref} is at the place its part names`, timeout: 15000 }).toBeLessThanOrEqual(1.5);
    }

    // --- the key feeds L1 ----------------------------------------------------
    const key = widget(page, 'press', 'K1');
    const k = await rectOf(key);
    await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
    await page.mouse.down();
    await expect(key).toHaveAttribute('data-held', 'true');
    await expect(spin1, 'with current it turns').toHaveAttribute('data-turning', 'forward', { timeout: 15000 });
    await expect(turns1, 'at its full speed').toHaveText('1200 rpm', { timeout: 15000 });
    await expect(sound1, 'and sounds at its full loudness').toHaveAttribute('data-rings', '3');
    await expect(sound1.locator('span')).toHaveCount(3);
    await expect(played, 'its tone is played, and only its').toHaveAttribute('data-heard', 'L1');
    // the mark goes round: it is somewhere else at the next look
    const before = await mark1.getAttribute('transform');
    await expect.poll(() => mark1.getAttribute('transform'), { message: 'the mark moves on while the part turns', timeout: 15000 }).not.toBe(before);
    await expect(spin2, 'each part goes by its own current').toHaveAttribute('data-turning', 'no');
    await expect(sound2).toHaveAttribute('data-rings', '0');
    await page.mouse.up();
    await expect(key).toHaveAttribute('data-held', 'false');
    await expect(spin1, 'without current it stops').toHaveAttribute('data-turning', 'no', { timeout: 15000 });
    await expect(sound1).toHaveAttribute('data-rings', '0');
    await expect(played, 'and is silent').toHaveAttribute('data-heard', '');
    await expect(turns1).toHaveText('0 rpm', { timeout: 15000 });

    // --- the switch feeds L2 -------------------------------------------------
    const toggle = widget(page, 'toggle', 'S1');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-on', 'true');
    await expect(spin2, 'it turns, and goes on turning').toHaveAttribute('data-turning', 'forward', { timeout: 15000 });
    await expect(turns2).toHaveText('1200 rpm', { timeout: 15000 });
    await expect(sound2).toHaveAttribute('data-rings', '3');
    await expect(spin1).toHaveAttribute('data-turning', 'no');
    await toggle.click();
    await expect(spin2, 'the next click stops it').toHaveAttribute('data-turning', 'no', { timeout: 15000 });
    await expect(sound2).toHaveAttribute('data-rings', '0');

    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
  });

  test('a part with a tone of its own is heard: the sound has its pitch, and the Session menu mutes it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'reads the sound itself from a tap on the audio; checked in Chromium, which plays into it without a sound card');
    test.setTimeout(300000);
    // Whatever the page sends to the speakers also goes into an analyser the test can read.
    await page.addInitScript(() => {
      const taps: AnalyserNode[] = [];
      (window as unknown as { __soundTaps: AnalyserNode[] }).__soundTaps = taps;
      const connect = AudioNode.prototype.connect as (this: AudioNode, to: AudioNode | AudioParam, ...rest: number[]) => AudioNode | void;
      AudioNode.prototype.connect = function (this: AudioNode, to: AudioNode | AudioParam, ...rest: number[]) {
        if (to instanceof AudioDestinationNode) {
          const tap = (this.context as AudioContext).createAnalyser();
          tap.fftSize = 8192;
          tap.smoothingTimeConstant = 0;
          taps.push(tap);
          connect.call(this, tap);
        }
        return connect.call(this, to, ...rest);
      } as typeof AudioNode.prototype.connect;
    });
    await turnFeatureOn(page);
    await serveLibrary(page, MOVER_PARTS);
    await bootSchematic(page);
    await clickRow(page, 'running');

    /** What goes to the speakers right now: how loud (0 is silence) and the pitch of its strongest tone, in Hz. */
    const sound = (): Promise<{ loud: number; hz: number }> =>
      page.evaluate(() => {
        const tap = (window as unknown as { __soundTaps: AnalyserNode[] }).__soundTaps.at(-1);
        if (!tap) return { loud: 0, hz: 0 };
        const wave = new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(wave);
        const loud = Math.sqrt(wave.reduce((sum, v) => sum + v * v, 0) / wave.length);
        const bins = new Float32Array(tap.frequencyBinCount);
        tap.getFloatFrequencyData(bins);
        let top = 0;
        for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[top]!) top = i;
        return { loud, hz: (top * tap.context.sampleRate) / tap.fftSize };
      });
    const loud = async (): Promise<number> => (await sound()).loud;
    const played = page.getByTestId('live-sound-out');
    const rings = widget(page, 'sound', 'L1');
    const key = widget(page, 'press', 'K1');
    const row = page.getByTestId('live-sim-sound');
    const hold = async (): Promise<void> => {
      const k = await rectOf(key);
      await page.mouse.move(k.x + k.w / 2, k.y + k.h / 2);
      await page.mouse.down();
      await expect(key).toHaveAttribute('data-held', 'true');
      await expect(rings, 'the part sounds at its full loudness').toHaveAttribute('data-rings', '3', { timeout: 15000 });
    };
    const letGo = async (): Promise<void> => {
      await page.mouse.up();
      await expect(key).toHaveAttribute('data-held', 'false');
      await expect(rings).toHaveAttribute('data-rings', '0', { timeout: 15000 });
    };

    await expect(played).toHaveAttribute('data-tones', '2', { timeout: 30000 });
    await expect(played).toHaveAttribute('data-muted', 'false');
    expect(await loud(), 'nothing sounds: silence').toBe(0);

    // --- the key feeds L1: its tone is heard, at its pitch --------------------
    await hold();
    await expect(played).toHaveAttribute('data-heard', 'L1');
    await expect(played, "the browser's audio runs").toHaveAttribute('data-state', 'running');
    await expect.poll(loud, { message: 'there is sound', timeout: 15000 }).toBeGreaterThan(0.05);
    await expect.poll(async () => Math.abs((await sound()).hz - 2000), { message: 'at the pitch the part says, 2000 Hz', timeout: 15000 }).toBeLessThan(15);
    expect(await loud(), 'a beep, far from as loud as the speakers go').toBeLessThan(0.3);
    await letGo();
    await expect(played).toHaveAttribute('data-heard', '');
    await expect.poll(loud, { message: 'let go: silence again', timeout: 15000 }).toBeLessThan(0.002);

    // --- the Session menu mutes it --------------------------------------------
    await openSimulationMenu(page);
    await expect(row, 'the menu has the row while such a circuit runs').toHaveText('Mute simulation sound');
    await row.click();
    await expect(row).toHaveAttribute('data-muted', 'true');
    await expect(row).toHaveText('Unmute simulation sound');
    await closeOverlayMenu(page);
    await expect(played).toHaveAttribute('data-muted', 'true');
    await hold(); // the part sounds in the circuit, and its rings show
    await expect(played, 'muted: nothing is played').toHaveAttribute('data-heard', '');
    expect(await loud(), 'and nothing reaches the speakers').toBeLessThan(0.002);
    await letGo();
    await openSimulationMenu(page);
    await row.click();
    await expect(row).toHaveAttribute('data-muted', 'false');
    await closeOverlayMenu(page);
    await hold();
    await expect(played).toHaveAttribute('data-heard', 'L1');
    await expect.poll(loud, { message: 'heard again', timeout: 15000 }).toBeGreaterThan(0.05);
    await letGo();
    await expect.poll(loud, { message: 'and silent when it stops', timeout: 15000 }).toBeLessThan(0.002);

    // --- Stop ends it ----------------------------------------------------------
    await clickRow(page, 'idle');
    await expect(played).toHaveCount(0);
    await openSimulationMenu(page);
    await expect(row, 'nothing runs: the menu has no sound row').toHaveCount(0);
    await closeOverlayMenu(page);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
  });

  test('a tag is dragged off what it covers: it stays there through a zoom and the next run, a double-click puts it back', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    await serveLibrary(page);
    await bootSchematic(page);
    await clickRow(page, 'running');
    const meter = widget(page, 'meter', 'M1');
    const slider = widget(page, 'slider', 'RV1');
    const words = slider.getByTestId('live-tag-handle');
    const number = meter.locator('span').last();
    const line = (ref: string) => page.locator(`[data-testid="live-tag-line"][data-ref="${ref}"]`);
    const scale = () => page.evaluate(() => JSON.parse((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()).scale as number);
    const pxPerMm = async (): Promise<number> => (await onScreen(page, [0, 0, MM, 0])).w;
    const remembered = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pcbjam:live-tags:')).map((k) => Object.keys(JSON.parse(localStorage.getItem(k)!) as object).length));
    /** How far a tag hangs from its own place, 2 mm under its symbol: to the right and down, in mm of the sheet. */
    const shiftOf = async (tag: Locator, ref: string): Promise<[number, number]> => {
      const sym = await symbolOf(page, ref);
      const cx = (sym.bbox[0]! + sym.bbox[2]!) / 2;
      const own = await onScreen(page, [cx, sym.bbox[3]! + 2 * MM, cx + MM, 0]); // its width: the px of 1 mm
      const got = await rectOf(tag);
      return [(got.x + got.w / 2 - own.x) / own.w, (got.y - own.y) / own.w];
    };
    const farFrom = async (tag: Locator, ref: string, want: [number, number]): Promise<number> => {
      const [dx, dy] = await shiftOf(tag, ref);
      return Math.max(Math.abs(dx - want[0]), Math.abs(dy - want[1]));
    };
    /** How many times its full size the tag is drawn at. */
    const drawnAt = (tag: Locator): Promise<number> => tag.evaluate((el) => el.getBoundingClientRect().height / (el as HTMLElement).offsetHeight);
    /** The size that goes with a zoom: full from 5 to 8 px a mm, smaller with the sheet below, larger with it above. */
    const sizeFor = (px: number): number => (px < 5 ? Math.max(0.7, px / 5) : Math.min(8, Math.max(1, px / 8)));
    const wheelIn = async (message: string): Promise<void> => {
      const was = await scale();
      await page.mouse.wheel(0, -120);
      await expect.poll(scale, { message, timeout: 15000 }).toBeGreaterThan(was * 1.1);
    };
    const wheelOut = async (message: string): Promise<void> => {
      const was = await scale();
      await page.mouse.wheel(0, 120);
      await expect.poll(scale, { message, timeout: 15000 }).toBeLessThan(was * 0.95);
    };

    await expect(meter).toHaveCount(1, { timeout: 30000 });
    await expect(number).toHaveText('769 mV', { timeout: 15000 });
    await expect(meter, 'the tag is at its own place').toHaveAttribute('data-moved', 'false');
    await expect(slider).toHaveAttribute('data-moved', 'false');
    await expect(line('M1'), 'and has no line').toHaveCount(0);
    expect(await remembered(), 'nothing is remembered yet').toEqual([]);
    const symbol = await symbolOf(page, 'M1');

    // --- the meter's number: dragged anywhere on it ---------------------------
    const m0 = await rectOf(meter);
    const px0 = await pxPerMm();
    await page.mouse.move(m0.x + m0.w / 2, m0.y + m0.h / 2);
    await page.mouse.down();
    await page.mouse.move(m0.x + m0.w / 2 + 90, m0.y + m0.h / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await expect(meter).toHaveAttribute('data-moved', 'true');
    await expect
      .poll(async () => {
        const now = await rectOf(meter);
        return [Math.round(now.x - m0.x), Math.round(now.y - m0.y)];
      }, { message: 'the tag went with the mouse', timeout: 15000 })
      .toEqual([90, 60]);
    const put: [number, number] = [90 / px0, 60 / px0];
    expect(await farFrom(meter, 'M1', put), 'that far from its own place on the sheet, in mm').toBeLessThan(0.3);
    await expect(line('M1'), 'a line leads to where it belongs').toHaveCount(1);
    await expect(number, 'it still shows its number').toHaveText('769 mV');
    expect(await remembered(), 'the browser remembers one tag of this project').toEqual([1]);
    const after = await symbolOf(page, 'M1');
    expect([after.x, after.y], 'the editor did not hear the drag: the symbol is where it was').toEqual([symbol.x, symbol.y]);

    // --- the wheel over a tag is the editor's; the tag keeps its place on the sheet
    const m1 = await rectOf(meter);
    await page.mouse.move(m1.x + m1.w / 2, m1.y + m1.h / 2);
    await wheelIn('the wheel over the tag zooms the schematic in');
    await expect.poll(() => farFrom(meter, 'M1', put), { message: 'zoomed in: as far from its symbol on the sheet as before', timeout: 15000 }).toBeLessThan(0.3);
    expect(await farFrom(slider, 'RV1', [0, 0]), 'a tag that was not moved is under its symbol').toBeLessThan(0.3);
    const near = await pxPerMm();
    expect(Math.abs((await drawnAt(meter)) - sizeFor(near)), `at ${near.toFixed(1)} px a mm the tag has the size that goes with it`).toBeLessThan(0.03);

    // --- zoomed in close, the tags grow with the sheet ------------------------
    for (const message of ['closer', 'and closer', 'and closer still']) await wheelIn(message);
    const close = await pxPerMm();
    expect(close, 'close enough for the tags to grow').toBeGreaterThan(10);
    await expect.poll(async () => Math.abs((await drawnAt(meter)) - sizeFor(close)), { message: 'the tag grew with the sheet', timeout: 15000 }).toBeLessThan(0.05);
    expect(await drawnAt(meter), 'it is larger than its full size').toBeGreaterThan(1.2);
    await expect.poll(() => farFrom(meter, 'M1', put), { message: 'and is still as far from its symbol on the sheet', timeout: 15000 }).toBeLessThan(0.3);

    // --- zoomed out, the tags are drawn smaller -------------------------------
    for (const message of ['out again', 'and out', 'and out', 'and out once more']) await wheelOut(message);
    const far = await pxPerMm();
    expect(far, 'far enough for the tags to shrink').toBeLessThan(4.5);
    await expect.poll(async () => Math.abs((await drawnAt(meter)) - sizeFor(far)), { message: 'the tag is drawn smaller', timeout: 15000 }).toBeLessThan(0.03);
    expect(await drawnAt(slider), 'and so is the slider').toBeLessThan(0.95);
    await expect.poll(() => farFrom(meter, 'M1', put), { message: 'zoomed out: still as far from its symbol on the sheet', timeout: 15000 }).toBeLessThan(0.5);

    // --- the slider: moved by its words, and its knob still works -------------
    const w0 = await rectOf(words);
    const s0 = await rectOf(slider);
    await page.mouse.move(w0.x + w0.w / 2, w0.y + w0.h / 2);
    await page.mouse.down();
    await page.mouse.move(w0.x + w0.w / 2 - 70, w0.y + w0.h / 2 + 50, { steps: 6 });
    await page.mouse.up();
    await expect(slider).toHaveAttribute('data-moved', 'true');
    await expect
      .poll(async () => {
        const now = await rectOf(slider);
        return [Math.round(now.x - s0.x), Math.round(now.y - s0.y)];
      }, { message: 'the slider went with the mouse', timeout: 15000 })
      .toEqual([-70, 50]);
    await expect(slider, 'the drag did not turn the dial').toHaveAttribute('data-percent', '50');
    await slider.getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('data-percent', '100');
    await expect(number, 'the moved slider sets its part').toHaveText('2.50 V', { timeout: 15000 });
    expect(await remembered()).toEqual([2]);
    await expect(layer(page), 'no dialog opened, nothing else happened in the editor').toHaveCount(1);

    // --- the next run finds the tags where they were put ----------------------
    await clickRow(page, 'idle');
    await expect(layer(page)).toHaveCount(0);
    await clickRow(page, 'running');
    await expect(meter).toHaveAttribute('data-moved', 'true', { timeout: 30000 });
    await expect(slider).toHaveAttribute('data-moved', 'true');
    await expect.poll(() => farFrom(meter, 'M1', put), { message: 'the meter is where it was put', timeout: 15000 }).toBeLessThan(0.5);
    await expect(line('M1')).toHaveCount(1);
    await expect(line('RV1')).toHaveCount(1);

    // --- a double-click puts a tag back ---------------------------------------
    await meter.dblclick();
    await expect(meter).toHaveAttribute('data-moved', 'false');
    await expect(line('M1')).toHaveCount(0);
    await expect.poll(() => farFrom(meter, 'M1', [0, 0]), { message: 'the meter is under its symbol again', timeout: 15000 }).toBeLessThan(0.5);
    expect(await remembered()).toEqual([1]);
    await words.dblclick();
    await expect(slider).toHaveAttribute('data-moved', 'false');
    await expect.poll(() => farFrom(slider, 'RV1', [0, 0]), { message: 'and the slider under its', timeout: 15000 }).toBeLessThan(0.5);
    expect(await remembered(), 'every tag is back: nothing is remembered').toEqual([]);
    await expect(layer(page), 'the double-clicks were the tags\': no dialog of the editor').toHaveCount(1);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
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
