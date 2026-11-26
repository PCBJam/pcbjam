import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * An ESP32 that runs firmware, in the live-simulation engine: the chip's part of the
 * simulation library (its SPICE model), the emulator esp32sim behind the app's own adapter
 * (web/standalone/src/wasm/esp32sim-adapter.js), ngspice, and a real firmware image, in the
 * browser. Without the editor: the page drives the production worker script over its own
 * protocol, as sim-live-engine.spec.ts does.
 *
 * None of the emulator, the part and the firmware is in this repository (the library is
 * kept elsewhere, an image is a sketch's build), so the tests run only where they are on
 * the machine:
 *
 *   PCBJAM_ESP32SIM            the folder with esp32sim.wasm, jit.mjs and the chips' ROM files
 *   PCBJAM_ESP_PART            the folder of the library's part esp32-c3-wroom-02
 *   PCBJAM_ESP_FIRMWARE        a merged image for an ESP32-C3: prints "ready", toggles GPIO10
 *                              every 250 ms, holds GPIO8 high while GPIO9 (a button to ground
 *                              with the chip's pull-up) is low
 *   PCBJAM_ESP_ANALOG_FIRMWARE reads GPIO2 with analogReadMilliVolts every 100 ms, prints
 *                              "A: raw <n> mv <n>" and holds GPIO8 high above 1650 mV
 *   PCBJAM_ESP_BUSY_FIRMWARE   an image that never sleeps (for the speed that is printed)
 *   PCBJAM_ESP_S3_PART         the folder of the library's part esp32-s3-wroom-1
 *   PCBJAM_ESP_S3_FIRMWARE     for an ESP32-S3 (two cores): a 1 kHz timer wave on GPIO4, and
 *                              GPIO5 follows the button on GPIO0; one core never sleeps
 *
 * The ESP32-C3 board: 3.3 V, the module, an LED with its resistor on IO8, a button from IO9
 * to ground, a voltage the test sets on IO2, and a resistor on IO10, IO5 and IO6. The
 * ESP32-S3 board: an LED on IO5, a button on IO0, a resistor on IO2, IO4 and IO42. (The
 * resistors are where the proof's timing sketches put their waves, so that a speed that is
 * printed is the speed with every wave in the circuit.)
 *
 * Time is never waited for: every wait is a poll for a state of the simulation.
 */

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE = (name: string): string => fs.readFileSync(path.join(REPO, 'web', 'standalone', 'src', 'wasm', name), 'utf8');
const here = (p: string | undefined): string => (p && fs.existsSync(p) ? p : '');
const EMU = here(process.env.PCBJAM_ESP32SIM);
const PART = here(process.env.PCBJAM_ESP_PART);
const FIRMWARE = here(process.env.PCBJAM_ESP_FIRMWARE);
const ANALOG = here(process.env.PCBJAM_ESP_ANALOG_FIRMWARE);
const BUSY = here(process.env.PCBJAM_ESP_BUSY_FIRMWARE);
const S3_PART = here(process.env.PCBJAM_ESP_S3_PART);
const S3_FIRMWARE = here(process.env.PCBJAM_ESP_S3_FIRMWARE);
const ready = !!EMU && !!PART && ['esp32sim.wasm', 'jit.mjs'].every((f) => fs.existsSync(path.join(EMU, f)));

/** A board: the library's part, the chip's ROM among the emulator's files, and what is on which pin. */
interface Board {
    part: string;
    rom: string;
    /** part pin -> the board's node */
    wires: Record<string, string>;
    /** the rest of the netlist */
    lines: string[];
}

const BUTTON = 'v.xsw1.vctl';
const POT = 'vpot';
const LED = 'v.xd1.vs#branch';
const LIT = 2e-3; // amperes; the lit LED carries about 4 mA here, a dark one nanoamperes

interface Frame {
    t: number; load: number; achieved: number; lagging: boolean; running: boolean; problem?: string; wall: number;
    latest: Record<string, number>; avg: Record<string, number>;
}

const C3 = (): Board => ({
    part: PART, rom: 'esp32c3_rev3_rom.elf',
    wires: { '3V3': 'vcc', VSS: '0', EN: 'vcc', IO2: 'io2', IO5: 'io5', IO6: 'io6', IO8: 'io8', IO9: 'io9', IO10: 'io10' },
    lines: [
        // the test's own voltage on the converter pad (an external source adds to its dc value: 0 here)
        `${POT} io2 0 dc 0 external`,
        'R1 io8 n1 330',
        'XD1 n1 0 PJ_LED',
        'XSW1 io9 0 PJ_BUTTON',
        'R2 io10 0 100k',
        'R3 io5 0 100k',
        'R4 io6 0 100k',
    ],
});
const S3 = (): Board => ({
    part: S3_PART, rom: 'esp32s3_rev0_rom.elf',
    wires: { '3V3': 'vcc', VSS: '0', EN: 'vcc', IO0: 'io0', IO2: 'io2', IO4: 'io4', IO5: 'io5', IO42: 'io42' },
    lines: ['R1 io5 n1 330', 'XD1 n1 0 PJ_LED', 'XSW1 io0 0 PJ_BUTTON', 'R2 io4 0 100k', 'R3 io2 0 100k', 'R4 io42 0 100k'],
});

const manifest = (b: Board): any => JSON.parse(fs.readFileSync(path.join(b.part, 'part.json'), 'utf8'));

/** The board's netlist around the library's own model of the module. */
function deck(b: Board): string[] {
    const part = manifest(b);
    const model = fs.readFileSync(path.join(b.part, 'model.lib'), 'utf8').split('\n').filter((l) => l.trim());
    // the module's pins in the order of its subcircuit; what the board does not use is left open
    const nodes = (part.pins as string[]).map((pin) => b.wires[pin] ?? `nc_${pin.toLowerCase()}`);
    return [
        '* an ESP32 module with an LED, a button and what else the board has',
        '.subckt PJ_BUTTON 1 2',
        'Vctl ctl 0 dc 0 external',
        "R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'",
        '.ends',
        '.subckt PJ_LED A K',
        'Vs A a1 dc 0',
        'D1 a1 K PJLED',
        '.model PJLED D(IS=1e-18 N=2 RS=10)',
        '.ends',
        ...model,
        'V1 vcc 0 dc 3.3',
        `XU1 ${nodes.join(' ')} ${part.analog.subckt} IRR=1`,
        ...b.lines,
        '.tran 1m 100000 0 1m',
        '.end',
    ];
}

/** Open a harness page (for its cross-origin-isolated context), serve it the emulator's files, and put the host's maker into it. */
async function open(page: Page, firmware: string, b: Board = C3()): Promise<void> {
    const files: Record<string, string> = { 'esp32sim.wasm': path.join(EMU, 'esp32sim.wasm'), 'rom.elf': path.join(EMU, b.rom), 'firmware.bin': firmware };
    await page.route('**/__esp32/*', (route) => {
        const file = files[new URL(route.request().url()).pathname.split('/').pop() ?? ''];
        return file ? route.fulfill({ path: file, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
    });
    await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });
    const part = manifest(b);
    // the pads with something on them, as the netlist step tells the app
    const wired = Object.keys(b.wires).flatMap((pin) => (part.digital.pads[pin] === undefined ? [] : [part.digital.pads[pin] as number]));
    await page.evaluate(async ({ workerSrc, adapter, jit, part, wired }) => {
        const w = window as any;
        const glue = new URL('ngspice_service.js', window.location.href).href;
        // the emulator's own script, as the app hands it to the simulation thread (chip-parts.ts, jitHostScript)
        const KEY = 'esp32sim@e2e';
        const body = jit.replace(/^export function createJitHost\b/m, 'function createJitHost');
        const script = `(function () {\n${body}\n(globalThis.__pjGlue = globalThis.__pjGlue || {})[${JSON.stringify(KEY)}] = { createJitHost: createJitHost };\n})();\n`;
        const glueUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
        const blobs: Record<string, Uint8Array> = {};
        for (const [as, name] of [['emulator.wasm', 'esp32sim.wasm'], ['rom.elf', 'rom.elf'], ['firmware.bin', 'firmware.bin']])
            blobs[as!] = new Uint8Array(await (await fetch(`/__esp32/${name}`)).arrayBuffer());
        // The chip's package, as chip-parts.ts makes it: "PJPK" | u32 header length | header JSON | the files.
        const d = part.digital;
        const config = {
            chip: d.chip, cores: d.cores, pads: Object.values(d.pads), enable: true, wired,
            taps: d.taps, tapPads: d.taps.map((name: string) => d.pads[name] ?? -1), emulatorKey: KEY, glueUrl, stats: 0.5,
        };
        const table: Record<string, [number, number]> = {};
        let at = 0;
        for (const [name, bytes] of Object.entries(blobs)) { table[name] = [at, bytes.length]; at += bytes.length; }
        const head = new TextEncoder().encode(JSON.stringify({ adapter: 'esp32sim', config, blobs: table }));
        const pack = new Uint8Array(8 + head.length + at);
        pack.set([80, 74, 80, 75]);
        new DataView(pack.buffer).setUint32(4, head.length, true);
        pack.set(head, 8);
        let pos = 8 + head.length;
        for (const bytes of Object.values(blobs)) { pack.set(bytes, pos); pos += bytes.length; }
        w.__chip = { name: part.id, bytes: pack };

        const url = URL.createObjectURL(new Blob([`self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\n`, adapter, '\n', workerSrc], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const host: any = { worker, log: [], serial: [], fatal: null, errors: [], names: [], nextId: 1, pending: new Map() };
        host.ready = new Promise<void>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent) => {
                const m = e.data ?? {};
                if (m.ready) return resolve();
                if (m.bootError !== undefined) return reject(new Error(String(m.bootError)));
                if (m.fatal !== undefined) { host.fatal = String(m.fatal); return; }
                if (m.log) { host.log.push(...m.log); if (m.serial) host.serial.push(...m.serial); return; }
                const done = host.pending.get(m.id);
                if (done) { host.pending.delete(m.id); done(m.res); }
            };
        });
        worker.onerror = (e: ErrorEvent) => { host.errors.push(e.message); };
        host.call = (cmd: string, args: object = {}) => new Promise((resolve) => {
            const id = host.nextId++;
            host.pending.set(id, resolve);
            worker.postMessage({ id, cmd, ...args });
        });
        w.__host = host;
        await host.ready;
    }, { workerSrc: SOURCE('ngspice-live-worker.js'), adapter: SOURCE('esp32sim-adapter.js'), jit: fs.readFileSync(path.join(EMU, 'jit.mjs'), 'utf8'), part, wired });
}

const call = (page: Page, cmd: string, args: object = {}): Promise<any> =>
    page.evaluate(({ cmd, args }) => (window as any).__host.call(cmd, args), { cmd, args });

const start = (page: Page, inputs: Record<string, number>, b: Board = C3()): Promise<any> =>
    page.evaluate(({ deck, inputs }) => {
        const w = window as any;
        return w.__host.call('start', { deck, files: [], inputs, speed: 1, parts: [w.__chip] });
    }, { deck: deck(b), inputs });

async function frame(page: Page): Promise<Frame> {
    return page.evaluate(async () => {
        const h = (window as any).__host;
        const res = await h.call('frame');
        if (res.error) throw new Error(res.error);
        if (res.names) h.names = res.names;
        const byName = (values: Float64Array) => Object.fromEntries(h.names.map((name: string, i: number) => [name, values[i]]));
        return { ...res, names: undefined, wall: performance.now(), latest: byName(res.latest), avg: byName(res.avg) };
    });
}

async function frameWhen(page: Page, what: string, until: (f: Frame) => boolean, timeout = 60000): Promise<Frame> {
    let last!: Frame;
    await expect.poll(async () => {
        last = await frame(page);
        return until(last);
    }, { message: what, timeout, intervals: [30] }).toBe(true);
    return last;
}

/** What the part said: its own words (the part's log), and what its firmware printed. */
const said = (page: Page): Promise<{ words: string[]; text: string; fatal: string | null; errors: string[] }> =>
    page.evaluate(() => {
        const h = (window as any).__host;
        return {
            words: (h.log as [string, string][]).filter(([kind]) => kind === 'part').map(([, text]) => text),
            text: (h.serial as [string, string, number][]).map(([, text]) => text).join(''),
            fatal: h.fatal, errors: h.errors,
        };
    });

/** The adapter's own count, from its last report. */
function report(words: string[]): Record<string, any> | null {
    const line = [...words].reverse().find((l) => l.includes('@stat '));
    return line ? JSON.parse(line.slice(line.indexOf('@stat ') + 6)) : null;
}

test.describe('live simulation: an ESP32 running firmware', () => {
    test.setTimeout(240000);
    test.skip(!ready, 'needs the emulator and the part on this machine (PCBJAM_ESP32SIM, PCBJAM_ESP_PART)');

    test('the chip boots, blinks, answers its button and prints on its serial line', async ({ page }) => {
        test.skip(!FIRMWARE, 'needs PCBJAM_ESP_FIRMWARE');
        await open(page, FIRMWARE);
        expect(await start(page, { [BUTTON]: 0, [POT]: 0.5 })).toEqual({ ok: true });

        // It comes up and says so; the engine has no word of trouble.
        await expect.poll(async () => (await said(page)).text, { message: 'the firmware says ready', timeout: 60000, intervals: [50] }).toMatch(/ready/);
        const up = await said(page);
        expect(up.fatal).toBeNull();
        expect(up.errors).toEqual([]);
        expect(up.words.filter((l) => l.includes('! '))).toEqual([]);
        // the ROM's start-up lines come on both of the chip's consoles and are shown once
        expect(up.text.split('ESP-ROM:').length - 1).toBe(1);

        // The heartbeat on IO10: the pin is driven high and low, as a voltage on the board.
        await frameWhen(page, 'IO10 is high', (f) => f.latest.io10! > 3.2);
        await frameWhen(page, 'IO10 is low', (f) => f.latest.io10! < 0.1);
        // The button is released: its pin is held high by the chip's own pull-up, and the LED is dark.
        const idle = await frame(page);
        expect(idle.latest.io9!).toBeGreaterThan(3.2);
        expect(Math.abs(idle.latest[LED]!)).toBeLessThan(1e-6);

        // Pressed: the pin goes to ground, the firmware sees it and lights the LED.
        expect(await call(page, 'input', { name: BUTTON, value: 1 })).toEqual({ ok: true });
        const lit = await frameWhen(page, 'the LED is lit', (f) => f.latest[LED]! > LIT);
        expect(lit.latest.io9!).toBeLessThan(0.1);
        expect(lit.latest.io8!).toBeGreaterThan(3.0);
        // Released: dark again (the sketch holds it for 200 ms).
        await call(page, 'input', { name: BUTTON, value: 0 });
        await frameWhen(page, 'the LED is dark', (f) => Math.abs(f.latest[LED]!) < 1e-6);

        // Held to the clock, with room to spare: a sleeping chip costs little.
        const a = await frame(page);
        const b = await frameWhen(page, 'two more simulated seconds', (f) => f.t >= a.t + 2);
        const stat = report((await said(page)).words);
        console.log(`[esp32sim] C3 demo: ${(b.t - a.t).toFixed(2)} s simulated in ${((b.wall - a.wall) / 1000).toFixed(2)} s, load ${b.load.toFixed(2)}, lagging ${b.lagging}; ${JSON.stringify(stat)}`);
        expect(b.lagging).toBe(false);
        expect(stat?.drives).toEqual(expect.arrayContaining([8, 10]));
        expect(stat?.pullUp).toContain(9);

        expect(await call(page, 'stop')).toEqual({ ok: true });
    });

    test('a pad with a converter measures the voltage on the board', async ({ page }) => {
        test.skip(!ANALOG, 'needs PCBJAM_ESP_ANALOG_FIRMWARE');
        await open(page, ANALOG);
        expect(await start(page, { [BUTTON]: 0, [POT]: 0.5 })).toEqual({ ok: true });
        const reads = async (): Promise<number[]> => [...(await said(page)).text.matchAll(/A: raw \d+ mv (\d+)/g)].map((m) => Number(m[1]));
        const near = (mv: number) => (v: number): boolean => Math.abs(v - mv) <= 20;

        await expect.poll(async () => (await reads()).some(near(500)), { message: 'the sketch reads 0.5 V', timeout: 60000, intervals: [50] }).toBe(true);
        expect(Math.abs((await frame(page)).latest[LED]!)).toBeLessThan(1e-6);

        // 2.5 V on the pad: the sketch reads it and lights its LED (its threshold is 1650 mV).
        await call(page, 'input', { name: POT, value: 2.5 });
        await expect.poll(async () => near(2500)((await reads()).slice(-1)[0] ?? 0), { message: 'the sketch reads 2.5 V', timeout: 30000, intervals: [50] }).toBe(true);
        await frameWhen(page, 'the LED is lit', (f) => f.latest[LED]! > LIT);
        expect((await frame(page)).latest.io2!).toBeCloseTo(2.5, 3);

        await call(page, 'input', { name: POT, value: 1.0 });
        await expect.poll(async () => near(1000)((await reads()).slice(-1)[0] ?? 0), { message: 'the sketch reads 1.0 V', timeout: 30000, intervals: [50] }).toBe(true);
        await frameWhen(page, 'the LED is dark', (f) => Math.abs(f.latest[LED]!) < 1e-6);

        const end = await said(page);
        expect(end.fatal).toBeNull();
        expect(end.words.filter((l) => l.includes('! '))).toEqual([]);
        console.log(`[esp32sim] C3 analog: readings ${(await reads()).slice(-6).join(' ')}; ${JSON.stringify(report(end.words))}`);
        expect(await call(page, 'stop')).toEqual({ ok: true });
    });

    test('a chip that never sleeps: the speed is what it is, and the engine says so', async ({ page }) => {
        test.skip(!BUSY, 'needs PCBJAM_ESP_BUSY_FIRMWARE');
        await open(page, BUSY);
        expect(await start(page, { [BUTTON]: 0, [POT]: 0.5 })).toEqual({ ok: true });
        const a = await frameWhen(page, 'the run is under way', (f) => f.t >= 0.3, 120000);
        const b = await frameWhen(page, 'one more simulated second', (f) => f.t >= a.t + 1, 180000);
        const end = await said(page);
        console.log(`[esp32sim] C3 busy: ${(b.t - a.t).toFixed(2)} s simulated in ${((b.wall - a.wall) / 1000).toFixed(2)} s = ${((b.t - a.t) / ((b.wall - a.wall) / 1000)).toFixed(2)}x, load ${b.load.toFixed(2)}, lagging ${b.lagging}; ${JSON.stringify(report(end.words))}`);
        expect(end.fatal).toBeNull();
        expect(await call(page, 'stop')).toEqual({ ok: true });
    });

    test('the two-core ESP32-S3: its timer wave is on the board, and its button is answered', async ({ page }) => {
        test.skip(!S3_PART || !S3_FIRMWARE, 'needs PCBJAM_ESP_S3_PART and PCBJAM_ESP_S3_FIRMWARE');
        await open(page, S3_FIRMWARE, S3());
        expect(await start(page, { [BUTTON]: 0 }, S3())).toEqual({ ok: true });
        await expect.poll(async () => (await said(page)).text, { message: 'the firmware says ready', timeout: 120000, intervals: [50] }).toMatch(/ready/);
        // the 1 kHz wave on IO4: high for half of the time, as the average over a frame says
        await frameWhen(page, 'IO4 swings', (f) => f.avg.io4! > 1.2 && f.avg.io4! < 2.1, 120000);
        expect(Math.abs((await frame(page)).latest[LED]!)).toBeLessThan(1e-6);
        await call(page, 'input', { name: BUTTON, value: 1 });
        await frameWhen(page, 'the LED is lit', (f) => f.latest[LED]! > LIT, 120000);
        await call(page, 'input', { name: BUTTON, value: 0 });
        await frameWhen(page, 'the LED is dark', (f) => Math.abs(f.latest[LED]!) < 1e-6, 120000);
        const a = await frame(page);
        const b = await frameWhen(page, 'half a simulated second more', (f) => f.t >= a.t + 0.5, 180000);
        const end = await said(page);
        console.log(`[esp32sim] S3 timing: ${(b.t - a.t).toFixed(2)} s simulated in ${((b.wall - a.wall) / 1000).toFixed(2)} s = ${((b.t - a.t) / ((b.wall - a.wall) / 1000)).toFixed(2)}x, load ${b.load.toFixed(2)}, lagging ${b.lagging}; ${JSON.stringify(report(end.words))}`);
        expect(end.fatal).toBeNull();
        expect(end.words.filter((l) => l.includes('! '))).toEqual([]);
        expect(await call(page, 'stop')).toEqual({ ok: true });
    });
});
