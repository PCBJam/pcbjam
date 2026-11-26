import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { openSimulationMenu } from './overlay-menu';

/**
 * Live simulation with an Arduino board, in the real app and with the real emulator:
 * avr8js runs a real sketch beside ngspice, behind the app's adapter
 * (web/standalone/src/wasm/avr8js-adapter.js).
 *
 * The schematic is tests/fixtures/demo/live-sim/uno.kicad_sch: KiCad's own symbol of an
 * Arduino Uno R3 with a button on D2 (SW1), an LED on D8 (D1), an LED on D13 (D2) and a
 * reset button (SW2). Each is joined to its pin by a label.
 *
 * The sketch is tests/fixtures/sim-live/uno-demo: its source, how it was built and the
 * .hex the build gave (README.md there). It prints "uno-demo: ready" once, toggles D13
 * every 250 ms, holds D8 high while the button is held and 200 ms longer, and prints
 * "uno-demo: presses <n>" after every press. The test hands it to the app as the
 * project's file firmware.hex, the name a board asks for when its symbol names none.
 *
 * The emulator is the npm package avr8js, a dependency of this folder at one exact
 * version: the lock file pins its archive by its checksum, so `npm ci` gives every
 * machine the same one. It is the archive the simulation library publishes its copy from.
 * The app loads an emulator as one script, so the test packs the package's modules into
 * one (esbuild) and serves that as the library's file.
 *
 * The library is a published snapshot of static files; the e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts) and the test
 * answers it with parts of its own: a board for KiCad's Uno symbol with the three pads
 * this circuit uses, a button and an LED.
 *
 * With PCBJAM_SIM_SNAPSHOT=<a folder written by the library's publish:snapshot --to> the
 * test answers the library's address with that folder instead: the same board then runs
 * with the simulation library's own Uno, button and LED parts and its own copy of avr8js.
 *
 * Needs a wasm build with kicadSimPlaces, kicadSimNetlist and an ngspice_service with
 * the live engine: rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';
const AVR8JS_VERSION = '0.21.1';
const HEX = path.join(__dirname, '..', 'fixtures', 'sim-live', 'uno-demo', 'firmware.hex');
/** A published library on this machine, to run with in place of the test's own parts. */
const LIBRARY = process.env.PCBJAM_SIM_SNAPSHOT ? path.resolve(process.env.PCBJAM_SIM_SNAPSHOT) : '';

/** avr8js as one script that leaves the package's exports in `var avr8js`: what the app loads. */
function emulatorScript(): string {
  const entry = require.resolve('avr8js');
  const version = (JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  if (version !== AVR8JS_VERSION) throw new Error(`avr8js ${version} is installed; the test was written for ${AVR8JS_VERSION}`);
  const built = buildSync({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'avr8js', write: false, logLevel: 'silent' });
  return built.outputFiles[0]!.text;
}

// --- the test's own library --------------------------------------------------

interface TestPart {
  manifest: Record<string, unknown>;
  model: string;
}

// The pads of the chip this board has, by the pin they are on: a pad's number is
// 8 * port + bit, port B = 1 and D = 3 (PD2 is D2, PB0 is D8, PB5 is D13).
const PADS = { D2: 26, D8: 8, D13: 13 };
const pads = Object.keys(PADS).map((pin) => pin.toLowerCase());

/**
 * The board's model. It feeds itself with 5 V, as from its USB socket. A pad is read through
 * a threshold; what the chip does on it are three signals (the level it drives, whether it
 * drives, its pull-up), each a control voltage of 0 or 1 V: a driver of 25 ohm that is
 * connected only while the chip drives the pad, and a pull-up of 35 k the sketch switches.
 * The chip's line takes the pads in the order the part lists them, then the reset pin; it
 * gives the levels, then the drives, then the pull-ups (avr8js-adapter.js).
 */
const UNO_MODEL = [
  '.subckt E2E_UNO RESET P5V VSS D2 D8 D13 IRR=1',
  'Vusb usb VSS dc 5',
  'Rusb usb P5V 0.5',
  '* reset: the 10 k pull-up of the board; low holds the chip in reset',
  'Rreset P5V RESET 10k',
  'aadc_rst [%vd(RESET,VSS)] [i_rst] e2e_adc',
  `aemu [${pads.map((p) => `i_${p}`).join(' ')} i_rst] [${['v', 'e', 'u'].flatMap((s) => pads.map((p) => `${s}_${p}`)).join(' ')}] null e2e_emu`,
  ...Object.keys(PADS).flatMap((pin) => {
    const p = pin.toLowerCase();
    return [
      `aadc_${p} [%vd(${pin},VSS)] [i_${p}] e2e_adc`,
      `adac_${p} [v_${p} e_${p} u_${p}] [%vd(av_${p},VSS) %vd(ae_${p},VSS) %vd(au_${p},VSS)] e2e_dac`,
      `Bdrv_${p} drv_${p} VSS V = V(av_${p},VSS) * V(P5V,VSS)`,
      `aoe_${p} %vd(ae_${p},VSS) %gd(drv_${p},${pin}) e2e_drv`,
      `apu_${p} %vd(au_${p},VSS) %gd(P5V,${pin}) e2e_pull`,
    ];
  }),
  '.model e2e_adc adc_bridge(in_low=1.5 in_high=3.0)',
  '.model e2e_dac dac_bridge(out_low=0 out_high=1 out_undef=0 t_rise=1u t_fall=1u)',
  // a switch's end points are the two levels of its control signal: past them its resistance goes on changing
  '.model e2e_drv aswitch(cntl_off=0 cntl_on=1 r_off=1e9 r_on=25 log=TRUE)',
  '.model e2e_pull aswitch(cntl_off=0 cntl_on=1 r_off=1e9 r_on=35k log=TRUE)',
  '.model e2e_emu d_cosim(simulation="e2e-uno" delay=1u irreversible={IRR})',
  '.ends E2E_UNO',
  '',
].join('\n');

const PARTS: TestPart[] = [
  {
    manifest: {
      schema: 1, id: 'e2e-uno', version: 1, title: 'Test Uno', description: '',
      fits: [{ symbol: 'MCU_Module:Arduino_UNO_R3', pins: { RESET: '3', P5V: '5', VSS: '6', D2: '17', D8: '23', D13: '28' } }],
      pins: ['RESET', 'P5V', 'VSS', 'D2', 'D8', 'D13'],
      supplies: ['P5V'],
      powered: ['VSS'],
      settings: [{ name: 'firmware', label: 'Firmware file', default: 'firmware.hex', accept: '^[A-Za-z0-9_.+-]+\\.hex$' }],
      analog: { file: 'model.lib', subckt: 'E2E_UNO' },
      digital: { kind: 'emulator', emulator: 'avr8js', chip: 'atmega328p', clock: 16000000, orderParam: 'IRR', pads: PADS, enable: 'RESET' },
    },
    model: UNO_MODEL,
  },
  {
    manifest: {
      schema: 1, id: 'e2e-button', version: 1, title: 'Test button', description: '',
      fits: [{ symbol: 'Switch:SW_Push' }], pins: ['1', '2'],
      analog: { file: 'model.lib', subckt: 'E2E_BUTTON' },
      inputs: [{ name: 'pressed', type: 'momentary', source: 'Vctl', released: 0, held: 1 }],
      overlay: [{ widget: 'press-zone', place: { over: 'bbox', margin: [1.5, 1.5] }, input: 'pressed' }],
    },
    model: ".subckt E2E_BUTTON 1 2\nVctl ctl 0 dc 0\nR1 1 2 r = '100meg * exp(-20.7 * V(ctl))'\n.ends E2E_BUTTON\n",
  },
  {
    // KiCad's LED: pin 1 is the cathode, pin 2 the anode. About 9 mA behind 330 ohm at 5 V.
    manifest: {
      schema: 1, id: 'e2e-led', version: 1, title: 'Test LED', description: '',
      fits: [{ symbol: 'Device:LED' }], pins: ['1', '2'],
      analog: { file: 'model.lib', subckt: 'E2E_LED' },
      signals: [{ name: 'current', current: 'Vsense' }],
      overlay: [{ widget: 'glow', place: { at: 'origin', size: [10, 10] }, signal: 'current', full: 0.005, color: 'red' }],
    },
    model: '.subckt E2E_LED 1 2\nVsense 2 m dc 0\nD1 m 1 E2E_LED_D\n.model E2E_LED_D D(IS=1e-18 N=2 RS=10)\n.ends E2E_LED\n',
  },
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fileEntry = (name: string, text: string) => ({ name, sha256: sha256(text), bytes: Buffer.byteLength(text) });

/** The snapshot's files by path: what a publish of these parts and of the emulator writes. */
function snapshotFiles(script: string): Record<string, string> {
  const files: Record<string, string> = {
    'current.json': JSON.stringify({ schema: 1, version: SNAPSHOT }),
    [`emulators/avr8js/${AVR8JS_VERSION}/avr8js.js`]: script,
  };
  const index = {
    schema: 1, version: SNAPSHOT, parts: [] as unknown[],
    emulators: [{
      id: 'avr8js', version: AVR8JS_VERSION, title: 'avr8js', licence: 'MIT', origin: 'https://github.com/wokwi/avr8js',
      loader: 'avr8js.js', files: [fileEntry('avr8js.js', script)],
    }],
  };
  for (const { manifest, model } of PARTS) {
    const id = manifest.id as string;
    const digital = manifest.digital as { emulator: string } | undefined;
    const manifestText = JSON.stringify(manifest, null, 2);
    files[`${SNAPSHOT}/parts/${id}/part.json`] = manifestText;
    files[`${SNAPSHOT}/parts/${id}/model.lib`] = model;
    index.parts.push({
      id, version: 1, title: manifest.title, description: '', fits: manifest.fits, pins: manifest.pins,
      code: !!digital, ...(digital ? { emulator: digital.emulator } : {}),
      files: [fileEntry('part.json', manifestText), fileEntry('model.lib', model)],
    });
  }
  files[`${SNAPSHOT}/index.json`] = JSON.stringify(index);
  return files;
}

const contentType = (rel: string): string =>
  rel.endsWith('.json') ? 'application/json' : rel.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain';

/**
 * Answers the library's address: with the test's own parts and the packed avr8js, or with
 * the files of a published library (PCBJAM_SIM_SNAPSHOT). Returns the paths that were asked for.
 */
async function serveLibrary(page: Page): Promise<string[]> {
  const files = LIBRARY ? null : snapshotFiles(emulatorScript());
  const asked: string[] = [];
  await page.route('**/e2e-sim-library/**', (route: Route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, ''));
    asked.push(rel);
    if (files) {
      const body = files[rel];
      return body === undefined ? route.fulfill({ status: 404, body: 'not found' }) : route.fulfill({ status: 200, contentType: contentType(rel), body });
    }
    const file = path.join(LIBRARY, rel);
    const inside = file.startsWith(LIBRARY + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
    return inside ? route.fulfill({ status: 200, path: file, contentType: contentType(rel) }) : route.fulfill({ status: 404, body: 'not found' });
  });
  return asked;
}

/** Answers the project's read of one file with a file of this repository. Returns how often it was read. */
async function serveProjectFile(page: Page, name: string, file: string): Promise<{ reads: number }> {
  const count = { reads: 0 };
  await page.route(`**/projects/demo/files/${name}*`, (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() !== 'GET') return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    count.reads++;
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: fs.readFileSync(file) });
  });
  return count;
}

// --- the app -----------------------------------------------------------------

async function bootSchematic(page: Page): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/live-sim/uno.kicad_sch`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

const menuRow = (page: Page) => page.getByTestId('live-sim-toggle');
const widget = (page: Page, kind: string, ref: string) => page.locator(`[data-testid="live-${kind}"][data-ref="${ref}"]`);
const level = async (glow: Locator): Promise<number> => Number(await glow.getAttribute('data-level'));

async function closeOverlayMenu(page: Page): Promise<void> {
  if (await page.getByTestId('overlay-menu-panel').count()) await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
}

/** A click on the Session menu's row, then the row says `state`. */
async function clickRow(page: Page, state: 'running' | 'idle'): Promise<void> {
  await openSimulationMenu(page);
  await expect(menuRow(page)).toHaveAttribute('data-live-state', state === 'running' ? 'idle' : 'running', { timeout: 60000 });
  await menuRow(page).click();
  await openSimulationMenu(page);
  await expect(menuRow(page)).toHaveAttribute('data-live-state', state, { timeout: 180000 });
  await closeOverlayMenu(page);
  await expect(page.getByTestId('live-sim-error')).toHaveCount(0);
}

/** Holds the mouse down on a button's zone until `held` is done, then lets go. */
async function hold(page: Page, key: Locator, held: () => Promise<void>): Promise<void> {
  const k = (await key.boundingBox())!;
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await page.mouse.down();
  await expect(key).toHaveAttribute('data-held', 'true');
  await held();
  await page.mouse.up();
  await expect(key).toHaveAttribute('data-held', 'false');
}

/** How often the console's text has `words`. */
const said = async (text: Locator, words: string): Promise<number> => ((await text.textContent()) ?? '').split(words).length - 1;

test.describe('live simulation: an Arduino Uno runs the sketch of the project', () => {
  test('Play starts the sketch: it prints, its LED blinks, its button and its reset are answered', async ({ page }) => {
    test.setTimeout(300000);
    const asked = await serveLibrary(page);
    const firmware = await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page);

    // The serial console first, so that nothing the sketch prints is missed.
    await openSimulationMenu(page);
    await page.getByTestId('sim-console-panel-toggle').click();
    await expect(page.getByTestId('sim-console-panel')).toBeVisible();

    await clickRow(page, 'running');

    // What was fetched for the board: the emulator's one script, and the project's sketch.
    expect(asked.filter((p) => p.startsWith('emulators/'))).toEqual([`emulators/avr8js/${AVR8JS_VERSION}/avr8js.js`]);
    expect(firmware.reads).toBeGreaterThan(0);

    // The sketch starts and says so, once.
    const text = page.getByTestId('sim-console-text');
    await expect(text).toContainText('uno-demo: ready', { timeout: 60000 });
    expect(await said(text, 'uno-demo: ready')).toBe(1);
    await expect(page.getByTestId('sim-console-panel')).toHaveAttribute('data-can-send', 'yes');

    // The heartbeat: the LED on D13 goes on and off.
    const beat = widget(page, 'glow', 'D2');
    const led = widget(page, 'glow', 'D1');
    const key = widget(page, 'press', 'SW1');
    const reset = widget(page, 'press', 'SW2');
    for (const w of [beat, led, key, reset]) await expect(w).toHaveCount(1);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is on', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is off', timeout: 30000, intervals: [20] }).toBeLessThan(0.05);

    // The button: held, the sketch's interrupt lights the LED on D8 and the press is printed;
    // let go, the LED goes out 200 ms later.
    expect(await level(led), 'the LED on D8 is dark').toBeLessThan(0.05);
    await hold(page, key, async () => {
      await expect.poll(() => level(led), { message: 'holding the button lights the LED on D8', timeout: 30000 }).toBeGreaterThan(0.5);
      await expect(text).toContainText('uno-demo: presses 1', { timeout: 30000 });
    });
    await expect.poll(() => level(led), { message: 'letting go puts it out', timeout: 30000 }).toBeLessThan(0.05);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-arduino.png'), scale: 'css' });

    // The reset button: held, the chip stands still and its pins are let go, so the heartbeat
    // LED is dark; let go, the sketch starts from the top and says so again.
    await hold(page, reset, async () => {
      await expect.poll(() => level(beat), { message: 'a chip in reset drives nothing', timeout: 30000 }).toBeLessThan(0.05);
      expect(await said(text, 'uno-demo: ready'), 'nothing is printed in reset').toBe(1);
    });
    await expect.poll(() => said(text, 'uno-demo: ready'), { message: 'after the reset the sketch starts again', timeout: 30000 }).toBe(2);
    await expect.poll(() => level(beat), { message: 'the heartbeat is back', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    // The count of presses started again with the sketch.
    await hold(page, key, async () => {
      await expect.poll(() => said(text, 'uno-demo: presses 1'), { message: 'the first press after the reset', timeout: 30000 }).toBe(2);
    });

    await clickRow(page, 'idle');
    await expect(page.getByTestId('live-layer')).toHaveCount(0);
  });
});
