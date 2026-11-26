import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { openSimulationMenu } from './overlay-menu';

/**
 * Live simulation with a bare microcontroller, in the real app and with the real emulator:
 * a chip that is drawn by itself, with no board around it that feeds it and clocks it
 * (the ATmega328P of the simulation library, round "Next 1").
 *
 * atmega.kicad_sch: KiCad's own symbol ATmega328P-P, its supply behind a switch (SW3, from
 * +5V), a 16 MHz crystal with its two capacitors on the clock pins, a button on PD2 (SW1),
 * a reset button (SW2), an LED on PB0 (D1) and one on PB5 (D2). These are the Arduino's
 * pins D2, D8 and D13, so the chip runs the sketch of the Arduino test
 * (tests/fixtures/sim-live/uno-demo, built for 16 MHz).
 *
 * atmega-two.kicad_sch: two such chips on +5V with an LED on PB5 each. U2 has the crystal,
 * U1 has none and runs at the chip's own 8 MHz, assumed: the same sketch beats half as
 * fast on it.
 *
 * atmega-levels.kicad_sch: two ATmega328P-A (the package with 32 pins, which has the analog
 * inputs ADC6 and ADC7), U1 on +5V and U2 on +3V3, both with their speed as a setting on
 * the symbol. A voltmeter on PB5 of each; one button that puts 2.5 V on PD2 of both; 1.1 V,
 * 1.65 V and 2.2 V on their analog inputs; 3.3 V on the AREF pin of U1.
 *
 * atmega-board.kicad_sch: a board as people draw one, with no source on it. A barrel jack
 * (J1), a 7805 behind it (U2) with its two capacitors, an ATmega328P-A on the regulator's
 * +5V with its crystal, a pull-up and a button on reset, a button on PD2, LEDs on PB0 and
 * PB5, and an LED on +5V. atmega-usb-board.kicad_sch: an ATmega328P-P fed through a micro
 * USB socket (J1) and a 3.3 V regulator whose output wire is called VDD, a name that says
 * no voltage; a USB A socket (J2) passes the 5 V on. Its LEDs are red ones behind 150 ohm:
 * a green one needs about 3 V and stays dim on 3.3 V. Two voltmeters on each, which a real
 * board does not have: the voltage before and behind the regulator.
 *
 * What is new for a chip without a board, and checked here:
 *   - it runs only while its supply pin has a voltage, and starts from reset when the
 *     voltage comes back
 *   - its reset pin has the chip's own pull-up: left open the sketch runs
 *   - its clock is the crystal's Value, else 8 MHz; Play says an assumed speed; the chip's
 *     line in the Simulation parts list shows the speed and takes one by hand
 *   - a crystal that clocks a chip is not said to be left out
 *   - its outputs are as high as its supply, its inputs are read against its supply, and
 *     analogRead measures against the voltage on its AVCC pin or on its AREF pin
 *
 * And for a board that takes its power through a socket:
 *   - a barrel jack and a USB socket that takes power in are sources: the regulator behind
 *     one has its input, so the wire on its output has its power from it, whatever its name
 *   - Play says of each socket whether it feeds the board, and with what
 *   - a USB A socket gives power out: it is no source, Play says so, and it disturbs nothing
 *
 * The library is answered by the test with parts of its own, like the Arduino test: a chip
 * for each of the two KiCad symbols with the pads these boards use, a button, a switch, an
 * LED, a voltmeter, a barrel jack, a USB socket and a regulator. With
 * PCBJAM_SIM_SNAPSHOT=<a folder written by the library's publish:snapshot --to> the same
 * boards run with the simulation library's own parts.
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

// A pad's number is 8 * port + bit, port B = 1, C = 2 and D = 3. PB6 and PB7 are the clock pins.
const PAD: Record<string, number> = { PB0: 8, PB5: 13, PB6: 14, PB7: 15, PC0: 16, PD2: 26 };

interface Package {
  id: string;
  symbol: string;
  /** The part's pins and the symbol's pin numbers; the pads among them are known by their names. */
  pins: Record<string, string>;
  /** Analog inputs by the names the chip's converter has for them: the pin each one is. */
  taps?: Record<string, string>;
}

/**
 * The chip's model. Nothing in it is a source: the chip has what the schematic puts on VCC.
 * It runs from 1.8 V up (the supply's own input of the chip's line, after the pads and the
 * reset pin) and takes about 5 mA. A pad is read as a share of the supply, through a
 * threshold; what the chip does on it are three signals (the level it drives, whether it
 * drives, its pull-up), each a control voltage of 0 or 1 V: a driver of 25 ohm that is as
 * high as the supply and connected only while the chip drives the pad, and a pull-up of
 * 35 k to the supply. The reset pin has the chip's own pull-up. The voltages the chip's
 * converter measures leave through a voltage tap, with those of AVCC and AREF.
 */
function chipModel(subckt: string, { id, pins, taps }: Package): string {
  const names = Object.keys(pins);
  const padPins = names.filter((pin) => pin in PAD);
  const pads = padPins.map((pin) => pin.toLowerCase());
  const extra = (first: string): string[] => names.filter((pin) => pin !== first && pin.startsWith(first)).map((pin) => `Rjoin_${pin.toLowerCase()} ${first} ${pin} 1m`);
  return [
    `.subckt ${subckt} ${names.join(' ')} IRR=1`,
    ...extra('VSS'),
    ...extra('VCC'),
    'Rsupply VCC VSS 1k',
    'Ravcc AVCC VSS 100meg',
    ...(names.includes('AREF') ? ['Raref AVCC AREF 32k'] : []),
    'aadc_vcc [%vd(VCC,VSS)] [i_vcc] e2e_fed',
    "* reset: the chip's own pull-up; low holds the chip in reset",
    'Rreset VCC RESET 45k',
    'Bsh_rst sh_rst VSS V = V(RESET,VSS) / max(V(VCC,VSS), 1.8)',
    'aadc_rst [%vd(sh_rst,VSS)] [i_rst] e2e_adc',
    `aemu [${pads.map((p) => `i_${p}`).join(' ')} i_rst i_vcc] [${['v', 'e', 'u'].flatMap((s) => pads.map((p) => `${s}_${p}`)).join(' ')}] null e2e_emu`,
    ...padPins.flatMap((pin) => {
      const p = pin.toLowerCase();
      return [
        `Bsh_${p} sh_${p} VSS V = V(${pin},VSS) / max(V(VCC,VSS), 1.8)`,
        `aadc_${p} [%vd(sh_${p},VSS)] [i_${p}] e2e_adc`,
        `adac_${p} [v_${p} e_${p} u_${p}] [%vd(av_${p},VSS) %vd(ae_${p},VSS) %vd(au_${p},VSS)] e2e_dac`,
        `Bdrv_${p} drv_${p} VSS V = V(av_${p},VSS) * V(VCC,VSS)`,
        `aoe_${p} %vd(ae_${p},VSS) %gd(drv_${p},${pin}) e2e_drv`,
        `apu_${p} %vd(au_${p},VSS) %gd(VCC,${pin}) e2e_pull`,
      ];
    }),
    ...(taps ? [
      `atap [${[...Object.values(taps), 'AVCC', 'AREF'].map((pin) => `%vd(${pin},VSS)`).join(' ')}] e2e_tap`,
      // the tap carries the placed chip's number: the engine knows by it whose voltages these are
      '.model e2e_tap pj_vtap(id={IRR})',
    ] : []),
    '.model e2e_adc adc_bridge(in_low=0.3 in_high=0.6)',
    '.model e2e_fed adc_bridge(in_low=1.7 in_high=1.8)',
    '.model e2e_dac dac_bridge(out_low=0 out_high=1 out_undef=0 t_rise=1u t_fall=1u)',
    // a switch's end points are the two levels of its control signal: past them its resistance goes on changing
    '.model e2e_drv aswitch(cntl_off=0 cntl_on=1 r_off=1e9 r_on=25 log=TRUE)',
    '.model e2e_pull aswitch(cntl_off=0 cntl_on=1 r_off=1e9 r_on=35k log=TRUE)',
    // the chip's code is told the placed chip's number, as the tap is
    `.model e2e_emu d_cosim(simulation="${id}" delay=1u irreversible={IRR} sim_args=["{IRR}"])`,
    `.ends ${subckt}`,
    '',
  ].join('\n');
}

const CLOCK = { name: 'clock', label: 'Clock', default: 'auto', accept: '^(auto|[0-9]{1,2}(\\.[0-9]{1,6})?MHz|[0-9]{3,5}(\\.[0-9]{1,3})?kHz)$' };

function chipPart(pkg: Package): TestPart {
  const names = Object.keys(pkg.pins);
  const subckt = pkg.id.toUpperCase().replace(/-/g, '_');
  const group = (first: string): string[][] => {
    const all = names.filter((pin) => pin.startsWith(first));
    return all.length > 1 ? [all] : [];
  };
  return {
    manifest: {
      schema: 1, id: pkg.id, version: 1, title: `Test ${pkg.symbol.split(':')[1]}`, description: '',
      fits: [{ symbol: pkg.symbol, pins: pkg.pins }],
      pins: names,
      powered: ['VCC', 'VSS'],
      joined: [...group('VSS'), ...group('VCC')],
      settings: [{ name: 'firmware', label: 'Firmware file', default: 'firmware.hex', accept: '^[A-Za-z0-9_.+-]+\\.hex$' }, CLOCK],
      analog: { file: 'model.lib', subckt },
      digital: {
        kind: 'emulator', emulator: 'avr8js', chip: 'atmega328p', clock: 8000000, orderParam: 'IRR',
        pads: Object.fromEntries(names.filter((pin) => pin in PAD).map((pin) => [pin, PAD[pin]])),
        enable: 'RESET', supply: 'VCC', crystal: { pins: ['PB6', 'PB7'], setting: 'clock' },
        ...(pkg.taps ? { taps: [...Object.keys(pkg.taps), 'AVCC', 'AREF'] } : {}),
      },
    },
    model: chipModel(subckt, pkg),
  };
}

// The package with 28 pins in a row (the first two boards), and the one with 32 pins.
const DIP: Package = {
  id: 'e2e-atmega', symbol: 'MCU_Microchip_ATmega:ATmega328P-P',
  pins: { RESET: '1', PD2: '4', VCC: '7', VSS: '8', PB6: '9', PB7: '10', PB0: '14', PB5: '19', AVCC: '20', VSS2: '22' },
};
const TQFP: Package = {
  id: 'e2e-atmega-a', symbol: 'MCU_Microchip_ATmega:ATmega328P-A',
  pins: { VSS: '3', VCC: '4', VSS2: '5', VCC2: '6', PB6: '7', PB7: '8', PB0: '12', PB5: '17', AVCC: '18', ADC6: '19', AREF: '20', VSS3: '21', ADC7: '22', PC0: '23', RESET: '29', PD2: '32' },
  taps: { A0: 'PC0', A6: 'ADC6', A7: 'ADC7' },
};

/**
 * A socket the board is fed through, with what is plugged into it: a voltage behind 0.2 ohm
 * between its power pin and its ground pin while it counts as plugged in (the setting
 * "plugged", which the run hands to the model as ON), and open pins otherwise.
 */
function socketPart(id: string, title: string, subckt: string, pins: [string, string], fits: unknown[], voltage: Record<string, unknown>): TestPart {
  return {
    manifest: {
      schema: 1, id, version: 1, title, description: '', fits, pins, supplies: pins,
      suppliesWhen: { setting: 'plugged', on: 'yes', param: 'ON' },
      settings: [{ name: 'plugged', label: 'Plugged in', default: 'yes', options: ['yes', 'no'] }, { name: 'voltage', unit: 'V', ...voltage }],
      analog: { file: 'model.lib', subckt, params: { VOLTS: '$voltage' } },
    },
    model: `.subckt ${subckt} ${pins.join(' ')} VOLTS=5 ON=1\nV1 i ${pins[1]} dc {VOLTS}\nR1 ${pins[0]} i {0.2 + (1 - ON) * 1e12}\n.ends ${subckt}\n`,
  };
}

const PARTS: TestPart[] = [
  chipPart(DIP),
  chipPart(TQFP),
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
    // an on-off switch: it stays where it was put, and starts open
    manifest: {
      schema: 1, id: 'e2e-switch', version: 1, title: 'Test switch', description: '',
      fits: [{ symbol: 'Switch:SW_SPST' }], pins: ['1', '2'],
      analog: { file: 'model.lib', subckt: 'E2E_SWITCH' },
      inputs: [{ name: 'closed', type: 'toggle', source: 'Vctl', off: 0, on: 1, default: 'off' }],
      overlay: [{ widget: 'toggle-zone', place: { over: 'bbox', margin: [1.5, 2.5] }, input: 'closed' }],
    },
    model: ".subckt E2E_SWITCH 1 2\nVctl ctl 0 dc 0\nR1 1 2 r = '100meg * exp(-20.7 * V(ctl))'\n.ends E2E_SWITCH\n",
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
  {
    // KiCad's voltmeter: pin 1 is its minus. The reading leaves as a current, 1 A for 1 V.
    manifest: {
      schema: 1, id: 'e2e-voltmeter', version: 1, title: 'Test voltmeter', description: '',
      fits: [{ symbol: 'Device:Voltmeter_DC', pins: { N: '1', P: '2' } }], pins: ['P', 'N'],
      analog: { file: 'model.lib', subckt: 'E2E_VOLTMETER' },
      signals: [{ name: 'volts', current: 'Vread' }],
      overlay: [{ widget: 'meter', place: { below: 'bbox', gap: 4 }, signal: 'volts', unit: 'V' }],
    },
    model: '.subckt E2E_VOLTMETER P N\nRin P N 10meg\nBm m 0 V = V(P,N)\nRm m r 1\nVread r 0 dc 0\n.ends E2E_VOLTMETER\n',
  },
  // The two sockets have the titles of the real library's parts: Play names a socket by it.
  socketPart('e2e-jack', 'Barrel jack', 'E2E_JACK', ['TIP', 'SLEEVE'], [{ symbol: 'Connector:Barrel_Jack_Switch', pins: { TIP: '1', SLEEVE: '2' } }], {
    label: 'Voltage on the centre pin', default: '9', accept: '^-?[0-9]{1,2}(\\.[0-9]+)?$', fromValue: true, valueForms: [{ match: '^([0-9]{1,2}) ?[Vv]$', value: '$1' }],
  }),
  socketPart('e2e-usb', 'USB socket', 'E2E_USB', ['VBUS', 'VSS'], [
    { symbol: 'Connector:USB_B_Micro', pins: { VBUS: '1', VSS: '5' } },
    // an A socket gives power out: it is not plugged in unless its symbol says so
    { symbol: 'Connector:USB_A', pins: { VBUS: '1', VSS: '4' }, set: { plugged: 'no' } },
  ], { label: 'Voltage', default: '5', accept: '^[0-9]{1,2}(\\.[0-9]+)?$' }),
  {
    // A regulator: its voltage at the output while the input has that and its dropout more.
    // Nothing flows back into it, and what leaves at the output comes in at the input. It is
    // a source for the wire at its output only when a source reaches its input.
    manifest: {
      schema: 1, id: 'e2e-regulator', version: 1, title: 'Test regulator', description: '',
      fits: [
        { symbol: 'Regulator_Linear:L7805', pins: { IN: '1', COM: '2', OUT: '3' }, set: { voltage: '5', dropout: '2' } },
        { symbol: 'Regulator_Linear:AMS1117-3.3', pins: { COM: '1', OUT: '2', IN: '3' }, set: { voltage: '3.3', dropout: '1.2' } },
      ],
      pins: ['IN', 'OUT', 'COM'], supplies: ['OUT'], suppliesFrom: ['IN'],
      settings: [
        { name: 'voltage', label: 'Output voltage', unit: 'V', default: '5', accept: '^[0-9]{1,2}(\\.[0-9]+)?$' },
        { name: 'dropout', label: 'Dropout', unit: 'V', default: '2', accept: '^[0-9](\\.[0-9]+)?$' },
      ],
      analog: { file: 'model.lib', subckt: 'E2E_REG', params: { VOLTS: '$voltage', DROP: '$dropout' } },
    },
    model: [
      '.subckt E2E_REG IN OUT COM VOLTS=5 DROP=2',
      'Rin IN 0 1G', 'Rout OUT 0 1G', 'Rcom COM 0 1G',
      'Bt t COM V = min({VOLTS}, max(0, V(IN, COM) - {DROP}))',
      'Vs t a 0',
      'Bp a OUT I = max(0, 100 * V(a, OUT))',
      'Fin IN COM Vs 1',
      '.ends E2E_REG', '',
    ].join('\n'),
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

// --- the app -----------------------------------------------------------------

async function bootSchematic(page: Page, name: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/live-sim/${name}.kicad_sch`);
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

async function openConsole(page: Page): Promise<Locator> {
  await openSimulationMenu(page);
  await page.getByTestId('sim-console-panel-toggle').click();
  const panel = page.getByTestId('sim-console-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function openPartsList(page: Page): Promise<Locator> {
  await openSimulationMenu(page);
  await page.getByTestId('sim-parts-panel-toggle').click();
  const panel = page.getByTestId('sim-parts-panel');
  await expect(panel).toBeVisible();
  await closeOverlayMenu(page);
  await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
  return panel;
}

const clockLine = (panel: Locator, ref: string) => panel.locator(`[data-testid="sim-part-clock"][data-ref="${ref}"]`);
const row = (panel: Locator, ref: string) => panel.locator(`[data-testid="sim-part-row"][data-ref="${ref}"]`);

/** Clicks an on-off switch's zone; it then says `on`. */
async function flip(page: Page, key: Locator, on: boolean): Promise<void> {
  const k = (await key.boundingBox())!;
  await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
  await expect(key).toHaveAttribute('data-on', String(on));
}

/**
 * Counts in the page how often each of these LEDs goes on, from now: a level above a half
 * after one below a tenth. Read with `beats`.
 */
async function countBeats(page: Page, refs: string[]): Promise<void> {
  await page.evaluate((leds) => {
    const w = window as unknown as { __beats?: Record<string, number>; __beatWatch?: MutationObserver[] };
    for (const o of w.__beatWatch ?? []) o.disconnect();
    w.__beats = {};
    w.__beatWatch = leds.map((ref) => {
      const el = document.querySelector(`[data-testid="live-glow"][data-ref="${ref}"]`)!;
      let lit = Number(el.getAttribute('data-level')) > 0.5;
      w.__beats![ref] = 0;
      const o = new MutationObserver(() => {
        const level = Number(el.getAttribute('data-level'));
        const now = level > 0.5 ? true : level < 0.1 ? false : lit;
        if (now && !lit) w.__beats![ref]!++;
        lit = now;
      });
      o.observe(el, { attributes: true, attributeFilter: ['data-level'] });
      return o;
    });
  }, refs);
}
/** The number a meter shows, as the run gave it (NaN before its first value). */
const reading = async (meter: Locator): Promise<number> => Number((await meter.locator('span').last().getAttribute('data-value')) ?? 'NaN');

/** The console's page of one chip, when the run has several. */
async function showChip(serial: Locator, ref: string): Promise<void> {
  const tab = serial.locator(`[data-testid="sim-console-chip-tab"][data-ref="${ref}"]`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

/** Types a line to the chip whose page is shown. */
async function type(serial: Locator, line: string): Promise<void> {
  const input = serial.getByTestId('sim-console-input');
  await input.fill(line);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const beats = (page: Page): Promise<Record<string, number>> => page.evaluate(() => ({ ...(window as unknown as { __beats: Record<string, number> }).__beats }));

test.describe('live simulation: a bare ATmega328P runs the sketch of the project', () => {
  test('the chip runs only with its supply, at its crystal\'s speed; its button, its reset and its list line work', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page, 'atmega');

    // Before any Play the list knows the chip's clock: the Value of the crystal on its clock
    // pins. The crystal has no part and no model, and is not said to be left out.
    const list = await openPartsList(page);
    await expect(row(list, 'U1')).toHaveAttribute('data-state', 'live');
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-hz', '16000000');
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-from', 'crystal');
    await expect(clockLine(list, 'U1').getByTestId('sim-part-clock-now')).toHaveText('16 MHz, from its crystal Y1');
    await expect(row(list, 'Y1')).toContainText('clocks U1');
    await expect(row(list, 'Y1')).toHaveAttribute('data-reason', '');
    await expect(list.getByTestId('sim-parts-report'), 'nothing of this board is left out').toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-list.png'), scale: 'css' });
    await list.getByTestId('sim-parts-panel-close').click();

    // The serial console first, so that nothing the sketch prints is missed.
    const serial = await openConsole(page);
    await clickRow(page, 'running');

    const beat = widget(page, 'glow', 'D2');
    const led = widget(page, 'glow', 'D1');
    const key = widget(page, 'press', 'SW1');
    const reset = widget(page, 'press', 'SW2');
    const power = widget(page, 'toggle', 'SW3');
    for (const w of [beat, led, key, reset, power]) await expect(w).toHaveCount(1);

    // The supply switch is open: the chip has nothing on VCC, says so, and prints nothing.
    await expect(power).toHaveAttribute('data-on', 'false');
    await expect(page.getByTestId('live-sim-chip')).toContainText('U1: the chip has no supply: its VCC pin has less than 1.8 V, so its sketch does not run', { timeout: 60000 });
    expect(await said(serial, 'uno-demo: ready'), 'a chip without supply prints nothing').toBe(0);
    // its speed is the crystal's: nothing is assumed, so nothing is said about it; and nothing was left out
    await expect(page.getByTestId('live-sim-clock')).toHaveCount(0);
    await expect(page.getByTestId('live-sim-note')).toHaveCount(0);

    // The supply comes: the sketch starts from the top, and its heartbeat LED goes on and off.
    await flip(page, power, true);
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'with its supply the sketch starts', timeout: 60000 }).toBe(1);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is on', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is off', timeout: 30000, intervals: [20] }).toBeLessThan(0.05);

    // The button: the chip's own pull-up holds PD2 high, the button pulls it to ground.
    expect(await level(led), 'the LED on PB0 is dark').toBeLessThan(0.05);
    await hold(page, key, async () => {
      await expect.poll(() => level(led), { message: 'holding the button lights the LED on PB0', timeout: 30000 }).toBeGreaterThan(0.5);
      await expect(serial).toContainText('uno-demo: presses 1', { timeout: 30000 });
    });
    await expect.poll(() => level(led), { message: 'letting go puts it out', timeout: 30000 }).toBeLessThan(0.05);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega.png'), scale: 'css' });

    // The reset pin has the chip's own pull-up: left open the sketch ran. Pulled to ground
    // the chip stands still; let go, the sketch starts again.
    await hold(page, reset, async () => {
      await expect.poll(() => level(beat), { message: 'a chip in reset drives nothing', timeout: 30000 }).toBeLessThan(0.05);
      expect(await said(serial, 'uno-demo: ready'), 'nothing is printed in reset').toBe(1);
    });
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'after the reset the sketch starts again', timeout: 30000 }).toBe(2);

    // The supply goes: the chip stops. It comes back: the sketch starts from the top once
    // more, which a chip that had kept running would not do.
    await flip(page, power, false);
    await expect.poll(() => level(beat), { message: 'a chip without supply drives nothing', timeout: 30000 }).toBeLessThan(0.05);
    await flip(page, power, true);
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'with its supply back the sketch starts again', timeout: 30000 }).toBe(3);
    await expect.poll(() => level(beat), { message: 'the heartbeat is back', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);

    await clickRow(page, 'idle');
    await expect(page.getByTestId('live-layer')).toHaveCount(0);
  });

  test('two chips on one sheet: the one without a crystal runs at 8 MHz, Play says so, and the list sets its speed', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page, 'atmega-two');

    await clickRow(page, 'running');
    // Play says the speed it had to assume, for the chip it assumed it for
    const note = page.getByTestId('live-sim-clock');
    await expect(note).toContainText("U1 runs at 8 MHz: no crystal is on its clock pins, so the chip's own oscillator is assumed.", { timeout: 60000 });
    await expect(note).toContainText('the setting "Clock" on the chip\'s line in the Simulation parts list says the speed');
    await expect(note).not.toContainText('U2');

    // The same sketch on both: built for 16 MHz, it beats twice as fast on U2 (its crystal)
    // as on U1 (8 MHz).
    const [slow, fast] = [widget(page, 'glow', 'D1'), widget(page, 'glow', 'D2')];
    for (const w of [slow, fast]) await expect(w).toHaveCount(1);
    await countBeats(page, ['D1', 'D2']);
    await expect.poll(async () => (await beats(page)).D1, { message: 'U1 beats', timeout: 120000 }).toBeGreaterThanOrEqual(5);
    let got = await beats(page);
    expect(got.D2, `U2 beats twice as fast as U1 (${JSON.stringify(got)})`).toBeGreaterThanOrEqual(2 * got.D1! - 2);
    expect(got.D2).toBeLessThanOrEqual(2 * got.D1! + 2);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-two.png'), scale: 'css' });
    await clickRow(page, 'idle');

    // The chip's line in the list: its speed and where it comes from, and a field for the
    // speed by hand. What is typed is written onto the symbol.
    const list = await openPartsList(page);
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-from', 'assumed');
    await expect(clockLine(list, 'U1').getByTestId('sim-part-clock-now')).toHaveText('8 MHz, its own oscillator (assumed)');
    await expect(clockLine(list, 'U2').getByTestId('sim-part-clock-now')).toHaveText('16 MHz, from its crystal Y1');
    const field = clockLine(list, 'U1').getByTestId('sim-part-clock-input');
    await field.fill('fast');
    await field.press('Enter');
    await expect(list.getByTestId('sim-part-clock-error')).toHaveText('"fast" is not a speed: write it like 16MHz, 8MHz or 500kHz, or leave the field empty.');
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-setting', 'auto');
    await field.fill('16 mhz');
    await field.press('Enter');
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-setting', '16MHz', { timeout: 30000 });
    await expect(clockLine(list, 'U1')).toHaveAttribute('data-from', 'setting');
    await expect(clockLine(list, 'U1').getByTestId('sim-part-clock-now')).toHaveText('16 MHz, by its setting');
    await expect(list.getByTestId('sim-part-clock-error')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-clock.png'), scale: 'css' });
    await list.getByTestId('sim-parts-panel-close').click();

    // With the setting both chips run at 16 MHz: the two LEDs beat at the same pace.
    await clickRow(page, 'running');
    await countBeats(page, ['D1', 'D2']);
    await expect.poll(async () => (await beats(page)).D1, { message: 'U1 beats at its set speed', timeout: 120000 }).toBeGreaterThanOrEqual(8);
    got = await beats(page);
    expect(Math.abs(got.D2! - got.D1!), `the two beat at the same pace (${JSON.stringify(got)})`).toBeLessThanOrEqual(2);
    await clickRow(page, 'idle');
  });

  test('a chip on 5 V and one on 3.3 V: each drives, reads and measures against its own supply', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page, 'atmega-levels');

    const serial = await openConsole(page);
    await clickRow(page, 'running');
    const text = serial.getByTestId('sim-console-text');
    for (const ref of ['U1', 'U2']) {
      await showChip(serial, ref);
      await expect(text, `${ref} runs`).toContainText('uno-demo: ready', { timeout: 60000 });
    }
    // both have their speed as a setting on the symbol: nothing is assumed, nothing is said
    await expect(page.getByTestId('live-sim-clock')).toHaveCount(0);
    await expect(page.getByTestId('live-sim-chip')).toHaveCount(0);

    // An output that is high is as high as the chip's supply: the heartbeat pin of each,
    // with nothing on it but a voltmeter.
    const [high1, high2, key] = ['VM1', 'VM2', 'VM3'].map((ref) => widget(page, 'meter', ref));
    for (const m of [high1, high2, key]) await expect(m).toHaveCount(1);
    await expect.poll(() => reading(high1), { message: 'the chip on 5 V drives 5 V', timeout: 30000, intervals: [20] }).toBeCloseTo(5, 1);
    await expect.poll(() => reading(high2), { message: 'the chip on 3.3 V drives 3.3 V', timeout: 30000, intervals: [20] }).toBeCloseTo(3.3, 1);

    // An input is read against the chip's supply. The button puts 2.5 V on PD2 of both:
    // that is high for the chip on 3.3 V, and not for the chip on 5 V. The sketch counts a
    // press when its input goes low again, so only U2 counts one.
    // Idle, the two chips' pull-ups (35 k each, to 5 V and to 3.3 V) stand against 1 k to
    // ground: 0.22 V. A pull-up of another size shows here.
    await expect.poll(() => reading(key), { message: 'the pull-ups are 35 k', timeout: 30000 }).toBeCloseTo(0.22, 1);
    await hold(page, widget(page, 'press', 'SW1'), async () => {
      await expect.poll(() => reading(key), { message: 'the button puts 2.5 V on the input', timeout: 30000 }).toBeCloseTo(2.5, 1);
    });
    await expect.poll(() => reading(key), { message: 'let go, the input is low again', timeout: 30000 }).toBeCloseTo(0.22, 1);
    await showChip(serial, 'U2');
    await expect(text, 'the chip on 3.3 V saw the 2.5 V as high').toContainText('uno-demo: presses 1', { timeout: 30000 });

    // analogRead on U2 measures against AVCC, its 3.3 V: 1.65 V on A0 is the half (512 of
    // 1024), 1.1 V on A6 a third, 2.2 V on A7 two thirds. A6 and A7 are the two inputs that
    // only the packages with 32 pins have. The half sits on the edge between two steps, so
    // the least load on the pin makes it 511.
    await type(serial, 'a');
    await expect(text).toContainText(/uno-demo: analog avcc A0=51[12] A6=341 A7=682/, { timeout: 30000 });

    // U1 measures against its AREF pin, which has 3.3 V: 1.1 V on A0, 2.2 V on A6, 1.65 V on
    // A7. Against its supply of 5 V they would be 225, 450 and 337.
    await showChip(serial, 'U1');
    await type(serial, 'e');
    await expect(text).toContainText(/uno-demo: analog aref A0=341 A6=682 A7=51[12]/, { timeout: 30000 });
    // and by now U1 would have said a press, had it seen one: 2.5 V is no high level at 5 V
    await expect(text).not.toContainText('presses');
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-levels.png'), scale: 'css' });

    await clickRow(page, 'idle');
    await expect(page.getByTestId('live-layer')).toHaveCount(0);
  });
});

test.describe('live simulation: a board with no source drawn takes its power through a socket', () => {
  test('a barrel jack feeds the regulator and the regulator the chip: the board runs as it is drawn', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page, 'atmega-board');

    // Every part of the board has a model: the jack and the regulator are parts of the library.
    const list = await openPartsList(page);
    for (const ref of ['J1', 'U2', 'U1']) await expect(row(list, ref), `${ref} runs as a library part`).toHaveAttribute('data-state', 'live');
    await expect(row(list, 'Y1')).toContainText('clocks U1');
    await expect(list.getByTestId('sim-parts-report'), 'nothing of this board is left out').toHaveCount(0);
    await list.getByTestId('sim-parts-panel-close').click();

    const serial = await openConsole(page);
    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    // Play says where the power comes from. The jack's value does not say a voltage, so it
    // is the part's own 9 V, and that is said too. No wire is powered by its name.
    const notice = page.getByTestId('live-sim-power');
    await expect(notice).toContainText('J1 (barrel jack) feeds the board with 9 V on the centre pin; its value does not say a voltage.');
    const words = (await notice.textContent()) ?? '';
    expect(words, 'the +5V wire has its power from the regulator').not.toContain('by its name');
    expect(words, 'the regulator has its source').not.toContain('gives no power');
    await expect(page.getByTestId('live-sim-note'), 'nothing was left out').toHaveCount(0);
    await expect(page.getByTestId('live-sim-clock'), 'the chip has its crystal').toHaveCount(0);

    // 9 V before the regulator, 5 V behind it.
    await expect.poll(() => reading(widget(page, 'meter', 'VM1')), { message: 'the jack puts 9 V on the regulator\'s input', timeout: 60000 }).toBeCloseTo(9, 1);
    await expect.poll(() => reading(widget(page, 'meter', 'VM2')), { message: 'the regulator makes 5 V of them', timeout: 30000 }).toBeCloseTo(5, 1);
    await expect.poll(() => level(widget(page, 'glow', 'D3')), { message: 'the LED on +5V is lit', timeout: 30000 }).toBeGreaterThan(0.5);

    // The chip runs on that 5 V: its sketch starts, its heartbeat LED goes on and off.
    const beat = widget(page, 'glow', 'D2');
    const led = widget(page, 'glow', 'D1');
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'the sketch starts', timeout: 60000 }).toBe(1);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is on', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is off', timeout: 30000, intervals: [20] }).toBeLessThan(0.05);

    // Its button and its LED, and the reset button with the pull-up that is drawn.
    expect(await level(led), 'the LED on PB0 is dark').toBeLessThan(0.05);
    await hold(page, widget(page, 'press', 'SW1'), async () => {
      await expect.poll(() => level(led), { message: 'holding the button lights the LED on PB0', timeout: 30000 }).toBeGreaterThan(0.5);
      await expect(serial).toContainText('uno-demo: presses 1', { timeout: 30000 });
    });
    await expect.poll(() => level(led), { message: 'letting go puts it out', timeout: 30000 }).toBeLessThan(0.05);
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-board.png'), scale: 'css' });
    await hold(page, widget(page, 'press', 'SW2'), async () => {
      await expect.poll(() => level(beat), { message: 'a chip in reset drives nothing', timeout: 30000 }).toBeLessThan(0.05);
    });
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'after the reset the sketch starts again', timeout: 30000 }).toBe(2);

    await clickRow(page, 'idle');
    await expect(page.getByTestId('live-layer')).toHaveCount(0);
  });

  test('a USB socket feeds a regulator whose wire has no voltage in its name; a socket that gives power out is no source', async ({ page }) => {
    test.setTimeout(300000);
    await answerSession(page);
    await serveLibrary(page);
    await serveProjectFile(page, 'firmware.hex', HEX);
    await bootSchematic(page, 'atmega-usb-board');

    const serial = await openConsole(page);
    await clickRow(page, 'running');
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    // J1 takes power in. J2 is an A socket, which gives power out: it is no source, and Play
    // says how its symbol can say otherwise.
    const notice = page.getByTestId('live-sim-power');
    await expect(notice).toContainText('J1 (USB socket) feeds the board with 5 V.');
    const words = (await notice.textContent()) ?? '';
    expect(words).toContain('J2 (USB socket) gives no power: it does not count as plugged in (plugged=yes in the symbol\'s field PCBJam.SimSettings changes that).');
    // VBUS and VDD are names that say no voltage: the socket holds the one, the regulator the other
    expect(words, 'no wire is left without power').not.toContain('not powered');
    expect(words, 'and none is powered by its name').not.toContain('by its name');
    expect(words, 'the regulator has its source').not.toContain('no source reaches');

    // 5 V before the regulator, 3.3 V behind it, and the chip runs on them.
    await expect.poll(() => reading(widget(page, 'meter', 'VM1')), { message: 'the socket puts 5 V on VBUS', timeout: 60000 }).toBeCloseTo(5, 1);
    await expect.poll(() => reading(widget(page, 'meter', 'VM2')), { message: 'the regulator makes 3.3 V of them', timeout: 30000 }).toBeCloseTo(3.3, 1);
    await expect.poll(() => said(serial, 'uno-demo: ready'), { message: 'the sketch starts', timeout: 60000 }).toBe(1);
    const beat = widget(page, 'glow', 'D2');
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is on', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is off', timeout: 30000, intervals: [20] }).toBeLessThan(0.05);
    await hold(page, widget(page, 'press', 'SW1'), async () => {
      await expect(serial).toContainText('uno-demo: presses 1', { timeout: 30000 });
    });
    await page.screenshot({ path: test.info().outputPath('web-live-sim-atmega-usb-board.png'), scale: 'css' });

    await clickRow(page, 'idle');
    await expect(page.getByTestId('live-layer')).toHaveCount(0);
  });
});
