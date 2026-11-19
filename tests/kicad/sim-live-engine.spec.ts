import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The live-simulation engine, without the editor: the ngspice_service module's
 * live entry points (wasm/ngspice-service/ngspice_live.cpp) behind the
 * production worker script (web/standalone/src/wasm/ngspice-live-worker.js),
 * driven from the page over the worker's own protocol.
 *
 * The circuit: 5 V, two push buttons, two LEDs and one code part
 * (tests/fixtures/sim-live/test-part.c). Button 1 lights LED 1 through a
 * resistor and is input 0 of the part. The part blinks LED 2 every 100 ms of
 * simulated time and holds it on while input 0 is high. Button 2 is input 1
 * of the part: when it goes high the part traps, on purpose.
 *
 * Time is never waited for: every wait is a poll for a state of the
 * simulation (a simulated time reached, a current flowing).
 */

const REPO = path.resolve(__dirname, '..', '..');
const WORKER_SRC = fs.readFileSync(
    path.join(REPO, 'web', 'standalone', 'src', 'wasm', 'ngspice-live-worker.js'), 'utf8');
const PART_BASE64 = fs.readFileSync(
    path.join(REPO, 'tests', 'fixtures', 'sim-live', 'test-part.wasm')).toString('base64');

// A packaged part's adapter, as the page would put it in front of the worker script (the
// app's own is web/standalone/src/wasm/esp-emu-adapter.js, for a chip emulator). This one
// does the least: its output is its input 0, it says what it was given, and it counts how
// often a part of its kind was made and let go.
const TEST_ADAPTER = `(globalThis.__pjAdapters = globalThis.__pjAdapters || {})["test-adapter"] = function (env) {
  const g = globalThis;
  g.__made = (g.__made || 0) + 1;
  env.log("made " + g.__made + ", let go " + (g.__letGo || 0) + ", file: " + new TextDecoder().decode(env.blobs["hello.txt"]) + ", word: " + env.config.word);
  let want = 0, sent = -1;
  return {
    pj_setup() { return 2 | (1 << 8); },
    pj_step(target) { if (want !== sent) { sent = want; env.out(target, 0, want, 0); } return target; },
    pj_input(time, bit, state) { if (bit === 0 && (state === 0 || state === 1)) want = state; },
    pj_unload() { g.__letGo = (g.__letGo || 0) + 1; },
  };
};
`;

// A packaged part that measures. Every 0.1 s of simulated time it says what the engine
// gives it for the two inputs of its voltage tap, for an input the tap does not have, and
// whether a wish for a time point in the past is taken. With the word "wish" it also asks,
// at every step, for a time point at the next whole millisecond.
const TAP_ADAPTER = `(globalThis.__pjAdapters = globalThis.__pjAdapters || {})["tap-adapter"] = function (env) {
  const wishes = env.config.word === "wish";
  let next = 0.1, took = null;
  return {
    pj_setup() { return 1 | (1 << 8); },
    pj_step(target) {
      if (wishes) {
        const got = env.sampleAt(Math.floor(target * 1000 + 1.5) / 1000);
        if (took === null) { took = got; env.log("the first wish: " + got); }
      }
      while (next <= target) {
        env.log("t=" + next.toFixed(1) + " mid=" + env.volt(0, next).toFixed(2) + " sw=" + env.volt(1, next).toFixed(2)
          + " other=" + env.volt(2, next) + " past=" + env.sampleAt(next - 1));
        next += 0.1;
      }
      return target;
    },
    pj_input() {},
    pj_unload() {},
  };
};
`;

// A packaged part with a serial line. It says "ready" and a prompt without a line end. A
// typed line "on" or "off" switches its output; "zero" is answered with a text that has a
// zero byte in it, "flood" with more than one batch holds; every other line comes back.
// With the word "deaf" it has no ear for typed text at all.
const SERIAL_ADAPTER = `(globalThis.__pjAdapters = globalThis.__pjAdapters || {})["serial-adapter"] = function (env) {
  let want = 0, sent = -1, said = false, line = "";
  const utf8 = new TextDecoder();
  const part = {
    pj_setup() { return 2 | (1 << 8); },
    pj_step(target) {
      if (!said) { said = true; env.serial("ready\\r\\n> "); }
      if (want !== sent) { sent = want; env.out(target, 0, want, 0); }
      return target;
    },
    pj_input() {},
    pj_unload() {},
  };
  if (env.config.word !== "deaf") part.pj_serial = (bytes) => {
    line += utf8.decode(bytes, { stream: true });
    for (;;) {
      const cut = line.indexOf("\\n");
      if (cut < 0) break;
      const got = line.slice(0, cut);
      line = line.slice(cut + 1);
      if (got === "on") want = 1;
      else if (got === "off") want = 0;
      if (got === "zero") env.serial("a" + String.fromCharCode(0) + "b\\r\\n> ");
      else if (got === "flood") env.serial("x".repeat(40000));
      else env.serial("got: " + got + "\\r\\n> ");
    }
  };
  return part;
};
`;

const BUTTON1 = 'v.xsw1.vctl';
const BUTTON2 = 'v.xsw2.vctl';
const LED1 = 'v.xd1.vs#branch';
const LED2 = 'v.xd2.vs#branch';
const LIT = 5e-3; // amperes; a lit LED carries about 9 mA here, a dark one nanoamperes

const deck = (partName = 'test-part'): string[] => `* live engine test
.subckt PJ_BUTTON 1 2
Vctl ctl 0 dc 0 external
R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'
.ends
.subckt PJ_LED A K
Vs A a1 dc 0
D1 a1 K PJLED
.model PJLED D(IS=1e-18 N=2 RS=10)
.ends
V1 vcc 0 dc 5
XSW1 vcc btn PJ_BUTTON
R1 btn 0 10k
R2 btn n1 330
XD1 n1 0 PJ_LED
XSW2 vcc crash PJ_BUTTON
R4 crash 0 10k
aadc [btn crash] [btn_d crash_d] adc1
adut [btn_d crash_d] [led_d] null dut
adac [led_d] [led_a] dac1
R3 led_a n2 330
XD2 n2 0 PJ_LED
.model adc1 adc_bridge(in_low=1.5 in_high=3.5)
.model dac1 dac_bridge(out_low=0 out_high=5)
.model dut d_cosim(simulation="${partName}")
.tran 1m 100000 0 1m
.end`.split('\n');

// A circuit for a part that measures: a divider (2 V) and a button's node (0 V, 5 V while
// held) on the two inputs of a voltage tap. The tap and the part's code carry the same
// number; "args" is what the part's model says about that. Nothing moves in this circuit, so
// the solver takes the longest step it may (10 ms) unless somebody asks for a time point.
const tapDeck = (args = ' sim_args=["7"]'): string[] => `* voltage tap test
.subckt PJ_BUTTON 1 2
Vctl ctl 0 dc 0 external
R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'
.ends
V1 vcc 0 dc 5
Ra vcc mid 30k
Rb mid 0 20k
XSW1 vcc sw PJ_BUTTON
R1 sw 0 10k
aadc [sw] [sw_d] adc1
adut [sw_d] [o_d] null dut
adac [o_d] [o_a] dac1
R3 o_a 0 10k
atap [%vd(mid,0) %vd(sw,0)] tap1
.model adc1 adc_bridge(in_low=1.5 in_high=3.5)
.model dac1 dac_bridge(out_low=0 out_high=5)
.model tap1 pj_vtap(id=7)
.model dut d_cosim(simulation="test-part"${args})
.tran 10m 100000 0 10m
.end`.split('\n');

interface Frame {
    t: number;
    points: number;
    load: number;
    achieved: number;
    lagging: boolean;
    running: boolean;
    problem?: string;
    /** The page's clock when the frame came back, in ms. */
    wall: number;
    latest: Record<string, number>;
    avg: Record<string, number>;
}

/** Open a harness page (for its cross-origin-isolated context) and put the hosts' maker into it. */
async function open(page: Page): Promise<void> {
    await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ workerSrc, partBase64, adapter }) => {
        const glue = new URL('ngspice_service.js', window.location.href).href;
        const w = window as any;
        w.__livePart = Uint8Array.from(atob(partBase64), (c) => c.charCodeAt(0));
        // A packaged part: "PJPK" | u32 header length | header JSON | the files.
        w.__livePackage = (adapterName: string, word: string): Uint8Array => {
            const file = new TextEncoder().encode('hello');
            const head = new TextEncoder().encode(JSON.stringify(
                { adapter: adapterName, config: { word }, blobs: { 'hello.txt': [0, file.length] } }));
            const out = new Uint8Array(8 + head.length + file.length);
            out.set([80, 74, 80, 75]);
            new DataView(out.buffer).setUint32(4, head.length, true);
            out.set(head, 8);
            out.set(file, 8 + head.length);
            return out;
        };
        w.__live = [];
        // One live session: the production worker script in front of the service's glue,
        // with the adapters of packaged parts before it, where the app puts its own.
        w.__liveBoot = () => {
            const url = URL.createObjectURL(new Blob(
                [`self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\n`, adapter, workerSrc], { type: 'text/javascript' }));
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
            w.__live.push(host);
            return host.ready.then(() => w.__live.length - 1);
        };
    }, { workerSrc: WORKER_SRC, partBase64: PART_BASE64, adapter: TEST_ADAPTER + TAP_ADAPTER + SERIAL_ADAPTER });
}

/** Start the test circuit (or `lines`) with a packaged part in the place of the WebAssembly one. */
async function startPackaged(page: Page, host: number, adapterName: string, word: string, lines = deck()): Promise<any> {
    return page.evaluate(({ host, deck, adapterName, word }) => {
        const w = window as any;
        return w.__live[host].call('start', {
            deck, files: [], inputs: {}, speed: 1,
            parts: [{ name: 'test-part', bytes: w.__livePackage(adapterName, word) }],
        });
    }, { host, deck: lines, adapterName, word });
}

/** Boot one live worker; the number names it in the calls below. */
const boot = (page: Page): Promise<number> => page.evaluate(() => (window as any).__liveBoot());

async function call(page: Page, host: number, cmd: string, args: object = {}): Promise<any> {
    return page.evaluate(({ host, cmd, args }) => (window as any).__live[host].call(cmd, args), { host, cmd, args });
}

/** Start the test circuit with both buttons released (or as given). */
async function start(page: Page, host: number, options: { inputs?: Record<string, number>; speed?: number;
        part?: boolean; partName?: string } = {}): Promise<any> {
    return page.evaluate(({ host, deck, inputs, speed, part }) => {
        const w = window as any;
        return w.__live[host].call('start', {
            deck, files: [], inputs, speed,
            parts: part ? [{ name: 'test-part', bytes: w.__livePart }] : [],
        });
    }, {
        host, deck: deck(options.partName), speed: options.speed ?? 1, part: options.part ?? true,
        inputs: { [BUTTON1]: 0, [BUTTON2]: 0, ...options.inputs },
    });
}

async function frame(page: Page, host: number): Promise<Frame> {
    return page.evaluate(async (host) => {
        const h = (window as any).__live[host];
        const res = await h.call('frame');
        if (res.error) throw new Error(res.error);
        if (res.names) h.names = res.names;
        const byName = (values: Float64Array) =>
            Object.fromEntries(h.names.map((name: string, i: number) => [name, values[i]]));
        return { ...res, names: undefined, wall: performance.now(), latest: byName(res.latest), avg: byName(res.avg) };
    }, host);
}

/** Poll frames until `until` holds; the frame that satisfied it. */
async function frameWhen(page: Page, host: number, what: string, until: (f: Frame) => boolean): Promise<Frame> {
    let last!: Frame;
    await expect.poll(async () => {
        last = await frame(page, host);
        return until(last);
    }, { message: what, timeout: 30000, intervals: [30] }).toBe(true);
    return last;
}

const hostState = (page: Page, host: number): Promise<{ fatal: string | null; errors: string[]; log: [string, string][] }> =>
    page.evaluate((host) => {
        const h = (window as any).__live[host];
        return { fatal: h.fatal, errors: h.errors, log: h.log };
    }, host);

test.describe('live simulation engine', () => {
    test.setTimeout(180000);

    test('a run is held to the clock, and a button lights its LED', async ({ page }) => {
        const fetched: string[] = [];
        page.on('request', (r) => { if (r.url().includes('ngspice_service')) fetched.push(r.url()); });
        await open(page);
        expect(fetched, 'nothing of the engine is fetched before a session is booted').toHaveLength(0);

        const host = await boot(page);
        expect(fetched.length, 'the live worker loads the simulator service module').toBeGreaterThan(0);
        expect(await start(page, host)).toEqual({ ok: true });

        // Released: LED 1 is dark. The circuit reports its values under the simulator's names.
        const first = await frameWhen(page, host, 'the run reaches 0.2 s', (f) => f.t >= 0.2);
        expect(first.running).toBe(true);
        expect(Object.keys(first.latest)).toEqual(expect.arrayContaining([LED1, LED2, 'btn', 'vcc', 'time']));
        expect(first.latest.vcc).toBeCloseTo(5, 6);
        expect(Math.abs(first.latest[LED1]!)).toBeLessThan(1e-6);
        expect(first.latest.btn).toBeLessThan(0.01);

        // Held to the clock: simulated time never runs ahead of the page's clock. (Unpaced,
        // this circuit runs many times faster than real time.)
        const later = await frameWhen(page, host, 'one more simulated second', (f) => f.t >= first.t + 1);
        const simulated = later.t - first.t;
        const elapsed = (later.wall - first.wall) / 1000;
        expect(simulated).toBeLessThanOrEqual(elapsed * 1.05 + 0.05);

        // Pressed: the LED lights with the current the circuit gives it, and the average
        // over a frame says the same once it has been on for a whole frame.
        expect(await call(page, host, 'input', { name: BUTTON1, value: 1 })).toEqual({ ok: true });
        await frameWhen(page, host, 'LED 1 is lit', (f) => f.latest[LED1]! > LIT);
        const lit = await frameWhen(page, host, 'LED 1 was lit for a whole frame', (f) => f.avg[LED1]! > LIT);
        expect(lit.latest[LED1]!).toBeCloseTo(9.11e-3, 4);
        expect(lit.latest.btn).toBeGreaterThan(4.9);

        // Released again: dark.
        await call(page, host, 'input', { name: BUTTON1, value: 0 });
        await frameWhen(page, host, 'LED 1 is dark again', (f) => Math.abs(f.latest[LED1]!) < 1e-6);

        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        expect((await frame(page, host)).running).toBe(false);
        expect((await hostState(page, host)).fatal).toBeNull();
    });

    test('pause holds simulated time, speed changes its pace', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        expect(await start(page, host)).toEqual({ ok: true });
        await frameWhen(page, host, 'the run reaches 0.2 s', (f) => f.t >= 0.2);

        expect(await call(page, host, 'pause', { paused: true })).toEqual({ ok: true });
        // The step that was being solved ends, then time stands still: the same time in
        // six frames in a row.
        let still = 0, lastT = -1;
        const held = await frameWhen(page, host, 'simulated time stands still', (f) => {
            still = f.t === lastT ? still + 1 : 0;
            lastT = f.t;
            return still >= 5;
        });
        expect(held.running).toBe(true);

        expect(await call(page, host, 'pause', { paused: false })).toEqual({ ok: true });
        const resumed = await frameWhen(page, host, 'time goes on', (f) => f.t >= held.t + 0.2);

        // Four times real time: faster than the clock, and not faster than four times it.
        expect(await call(page, host, 'speed', { speed: 4 })).toEqual({ ok: true });
        const a = await frameWhen(page, host, 'a little later', (f) => f.t >= resumed.t + 0.2);
        const b = await frameWhen(page, host, 'two simulated seconds at speed 4', (f) => f.t >= a.t + 2);
        const pace = (b.t - a.t) / ((b.wall - a.wall) / 1000);
        expect(pace).toBeGreaterThan(1.5);
        expect(b.t - a.t).toBeLessThanOrEqual(((b.wall - a.wall) / 1000) * 4 * 1.05 + 0.2);

        expect(await call(page, host, 'stop')).toEqual({ ok: true });
    });

    test('a code part runs next to ngspice and reads the circuit', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        expect(await start(page, host)).toEqual({ ok: true });

        // The part switches LED 2 every 100 ms of simulated time: on at 0.1 s, off at 0.2 s.
        const on = await frameWhen(page, host, 'the part switched LED 2 on', (f) => f.latest[LED2]! > LIT);
        expect(on.t).toBeGreaterThanOrEqual(0.1);
        const off = await frameWhen(page, host, 'the part switched LED 2 off', (f) => f.t > on.t && f.latest[LED2]! < 1e-6);
        expect(off.t).toBeGreaterThanOrEqual(0.2);
        expect(on.latest[LED2]!).toBeCloseTo(9.11e-3, 4);

        // Button 1 is the part's input: while it is held the part keeps LED 2 on.
        await call(page, host, 'input', { name: BUTTON1, value: 1 });
        const held = await frameWhen(page, host, 'LED 2 is on with the button held',
            (f) => f.latest.btn! > 4.9 && f.latest[LED2]! > LIT);
        // The average over each frame sees every moment in between: no dark moment in the
        // next 0.35 simulated seconds, where the part would have switched it off three times.
        let dimmest = Infinity;
        await frameWhen(page, host, 'the next 0.35 s', (f) => {
            if (f.t > held.t) dimmest = Math.min(dimmest, f.avg[LED2]!);
            return f.t >= held.t + 0.35;
        });
        expect(dimmest).toBeGreaterThan(8e-3);

        // Released: it blinks again.
        await call(page, host, 'input', { name: BUTTON1, value: 0 });
        await frameWhen(page, host, 'LED 2 goes dark again', (f) => f.latest[LED2]! < 1e-6);

        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        expect((await hostState(page, host)).fatal).toBeNull();
    });

    test('a packaged part is run by an adapter of the page, with its files, and is let go with its circuit', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        const partLines = async () => (await hostState(page, host)).log.filter((l) => l[0] === 'part').map((l) => l[1]);
        expect(await startPackaged(page, host, 'test-adapter', 'one')).toEqual({ ok: true });

        // The adapter got the package's file and its settings.
        await expect.poll(partLines, { message: 'the adapter says what it was given', timeout: 10000, intervals: [50] })
            .toEqual(['test-part: made 1, let go 0, file: hello, word: one']);

        // It is the circuit's part like a WebAssembly one: its output follows button 1.
        const dark = await frameWhen(page, host, 'the run reaches 0.2 s', (f) => f.t >= 0.2);
        expect(dark.latest[LED2]!).toBeLessThan(1e-6);
        await call(page, host, 'input', { name: BUTTON1, value: 1 });
        const lit = await frameWhen(page, host, 'LED 2 is on with the button held', (f) => f.latest[LED2]! > LIT);
        expect(lit.latest[LED2]!).toBeCloseTo(9.11e-3, 4);
        await call(page, host, 'input', { name: BUTTON1, value: 0 });
        await frameWhen(page, host, 'LED 2 is dark again', (f) => f.latest[LED2]! < 1e-6);

        // A new start makes the part anew; the one of the circuit that is gone was let go first.
        expect(await startPackaged(page, host, 'test-adapter', 'two')).toEqual({ ok: true });
        await expect.poll(partLines, { message: 'the second part', timeout: 10000, intervals: [50] })
            .toEqual(['test-part: made 1, let go 0, file: hello, word: one', 'test-part: made 2, let go 1, file: hello, word: two']);

        // A package for an adapter this page does not have is refused, in words.
        expect(await startPackaged(page, host, 'no-such-adapter', 'x')).toEqual(
            { error: "code part 'test-part' could not be started (its own lines say why)" });
        await expect.poll(async () => (await partLines()).at(-1), { message: 'why', timeout: 10000, intervals: [50] })
            .toBe('test-part: load failed: Error: this page has nothing that runs a part of the kind no-such-adapter');
        expect((await frame(page, host)).running).toBe(false);

        // The WebAssembly part still runs in the same session.
        expect(await start(page, host)).toEqual({ ok: true });
        await frameWhen(page, host, 'the part switched LED 2 on', (f) => f.latest[LED2]! > LIT);
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        expect((await hostState(page, host)).fatal).toBeNull();
    });

    test('a part reads the voltages of its voltage tap, and gets a time point where it asks for one', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        const partLines = async () => (await hostState(page, host)).log.filter((l) => l[0] === 'part').map((l) => l[1]);
        const said = async (line: string) => (await partLines()).includes(`test-part: ${line}`);

        // The part gets what the circuit has on its tap's two inputs; an input the tap does
        // not have is "not a number", and a time point in the past is not to be had.
        expect(await startPackaged(page, host, 'tap-adapter', 'plain', tapDeck())).toEqual({ ok: true });
        await expect.poll(() => said('t=0.1 mid=2.00 sw=0.00 other=NaN past=false'),
            { message: 'the divider and the released button', timeout: 15000, intervals: [50] }).toBe(true);
        await call(page, host, 'input', { name: BUTTON1, value: 1 });
        const held = await frameWhen(page, host, 'the button is held for 0.2 s', (f) => f.t >= 0.5);
        await expect.poll(async () => (await partLines()).at(-1),
            { message: 'the held button', timeout: 15000, intervals: [50] }).toMatch(/^test-part: t=\d\.\d mid=2\.00 sw=5\.00 other=NaN past=false$/);
        expect(held.problem ?? '').toBe('');

        // Nobody asked for a time point: the quiet circuit is solved every 10 ms.
        const plain = await frameWhen(page, host, 'the plain run reaches 1 s', (f) => f.t >= 1);
        const plainRate = plain.points / plain.t;

        // The same part asking for a time point at every millisecond: it is given them.
        expect(await startPackaged(page, host, 'tap-adapter', 'wish', tapDeck())).toEqual({ ok: true });
        await expect.poll(() => said('the first wish: true'), { message: 'a wish is taken', timeout: 15000, intervals: [50] }).toBe(true);
        const wished = await frameWhen(page, host, 'the run with wishes reaches 1 s', (f) => f.t >= 1);
        expect(wished.points / wished.t).toBeGreaterThan(800);
        expect(wished.points / wished.t).toBeGreaterThan(3 * plainRate);

        // A part whose model does not say its number has no tap: no voltage, no time point.
        expect(await startPackaged(page, host, 'tap-adapter', 'wish', tapDeck(''))).toEqual({ ok: true });
        await expect.poll(() => said('t=0.1 mid=NaN sw=NaN other=NaN past=false'),
            { message: 'a part without a number', timeout: 15000, intervals: [50] }).toBe(true);
        expect(await said('the first wish: false')).toBe(true);

        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        expect((await hostState(page, host)).fatal).toBeNull();
    });

    test('what a part sends on its serial line reaches the page as it was sent, and typed text reaches the part', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        const partLines = async () => (await hostState(page, host)).log.filter((l) => l[0] === 'part').map((l) => l[1]);
        /** What the page got from the part's serial line since `from` batches, and how much was left out. */
        const serial = (from = 0) => page.evaluate(({ host, from }) => {
            const all = (window as any).__live[host].serial.slice(from) as [string, string, number][];
            return {
                batches: (window as any).__live[host].serial.length as number,
                parts: [...new Set(all.map((c) => c[0]))],
                text: all.map((c) => c[1]).join(''),
                dropped: all.reduce((n, c) => n + c[2], 0),
                longest: Math.max(0, ...all.map((c) => c[1].length)),
            };
        }, { host, from });
        /** Typed text for a part, as the bytes the page sends. */
        const type = (name: string, text: string) => page.evaluate(({ host, name, text }) =>
            (window as any).__live[host].call('serial', { name, bytes: new TextEncoder().encode(text) }), { host, name, text });

        // The text arrives as the part sent it: a prompt has no line end.
        expect(await startPackaged(page, host, 'serial-adapter', 'talk')).toEqual({ ok: true });
        await expect.poll(async () => (await serial()).text, { message: 'the first words', timeout: 15000, intervals: [50] })
            .toBe('ready\r\n> ');
        expect((await serial()).parts).toEqual(['test-part']);
        // it is not one of the part's own lines as well
        expect(await partLines()).toEqual([]);

        // A typed line reaches the part at its next step: it answers, and switches its output.
        const dark = await frameWhen(page, host, 'the run reaches 0.2 s', (f) => f.t >= 0.2);
        expect(dark.latest[LED2]!).toBeLessThan(1e-6);
        expect(await type('test-part', 'on\n')).toEqual({ ok: true });
        await frameWhen(page, host, 'LED 2 is on by the typed line', (f) => f.latest[LED2]! > LIT);
        await expect.poll(async () => (await serial()).text, { message: 'the answer', timeout: 15000, intervals: [50] })
            .toBe('ready\r\n> got: on\r\n> ');

        // Bytes, not characters: a letter of two bytes, and two lines in one go. A zero byte in
        // what the part sends is left out.
        expect(await type('test-part', 'h\u00e9\nzero\n')).toEqual({ ok: true });
        await expect.poll(async () => (await serial()).text, { message: 'the next answers', timeout: 15000, intervals: [50] })
            .toBe('ready\r\n> got: on\r\n> got: h\u00e9\r\n> ab\r\n> ');

        // Text for a part the circuit does not have is refused, in words.
        expect(await type('no-such-part', 'x\n')).toEqual({ error: 'the circuit has no part no-such-part' });

        // A part that sends more than a batch holds: the page gets a batch's worth, and how much was left out.
        const before = (await serial()).batches;
        expect(await type('test-part', 'flood\n')).toEqual({ ok: true });
        await expect.poll(async () => (await serial(before)).dropped, { message: 'the flood', timeout: 15000, intervals: [50] })
            .toBeGreaterThan(0);
        const flood = await serial(before);
        expect(flood.text.length + flood.dropped).toBe(40000);
        expect(flood.longest).toBeLessThanOrEqual(16384);

        // What is typed while the run is paused waits for the part; more than may wait is dropped, and said.
        expect(await call(page, host, 'pause', { paused: true })).toEqual({ ok: true });
        const paused = (await serial()).batches;
        expect(await type('test-part', 'off\n')).toEqual({ ok: true });
        expect(await type('test-part', 'y'.repeat(5000))).toEqual({ ok: true });
        await expect.poll(partLines, { message: 'too much waits', timeout: 15000, intervals: [50] })
            .toEqual(['test-part: typed text was dropped: too much is waiting for the chip']);
        expect((await frame(page, host)).latest[LED2]!).toBeGreaterThan(LIT);
        expect((await serial(paused)).text).toBe('');
        // It goes on: the part gets what waited.
        expect(await call(page, host, 'pause', { paused: false })).toEqual({ ok: true });
        await frameWhen(page, host, 'LED 2 is dark by the line that waited', (f) => f.latest[LED2]! < 1e-6);
        await expect.poll(async () => (await serial(paused)).text, { message: 'the answer to the line that waited', timeout: 15000, intervals: [50] })
            .toBe('got: off\r\n> ');

        // What is typed when nothing runs is for nobody: the chip of the next circuit does not get it.
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        const stopped = (await serial()).batches;
        expect(await type('test-part', 'on\n')).toEqual({ ok: true });
        expect(await startPackaged(page, host, 'serial-adapter', 'talk')).toEqual({ ok: true });
        const fresh = await frameWhen(page, host, 'the new run reaches 0.3 s', (f) => f.t >= 0.3);
        expect(fresh.latest[LED2]!).toBeLessThan(1e-6);
        await expect.poll(async () => (await serial(stopped)).text, { message: 'the new part says ready', timeout: 15000, intervals: [50] })
            .toBe('ready\r\n> ');
        expect(await type('test-part', 'on\n')).toEqual({ ok: true });
        await expect.poll(async () => (await serial(stopped)).text, { message: 'only the new line is answered', timeout: 15000, intervals: [50] })
            .toBe('ready\r\n> got: on\r\n> ');

        // A part without an ear for typed text: the engine says so, once.
        expect(await startPackaged(page, host, 'serial-adapter', 'deaf')).toEqual({ ok: true });
        const linesBefore = (await partLines()).length;
        expect(await type('test-part', 'on\n')).toEqual({ ok: true });
        await expect.poll(async () => (await partLines()).slice(linesBefore), { message: 'the deaf part', timeout: 15000, intervals: [50] })
            .toEqual(['test-part: this part takes no typed text']);
        const at = (await frame(page, host)).t;
        expect(await type('test-part', 'off\n')).toEqual({ ok: true });
        await frameWhen(page, host, 'the run goes on', (f) => f.t >= at + 0.2);
        expect((await partLines()).slice(linesBefore)).toEqual(['test-part: this part takes no typed text']);

        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        // Nothing runs: the last circuit's part is still known by its name, and the text waits for nobody.
        expect((await hostState(page, host)).fatal).toBeNull();
        expect((await hostState(page, host)).errors).toEqual([]);
    });

    test('two placed chips of one part each run code of their own, under their own names', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        const partLines = async () => (await hostState(page, host)).log.filter((l) => l[0] === 'part').map((l) => l[1]);
        // As the netlist step writes two chips of one part: the model once per chip, each
        // asking for its code under the part's name and the chip's number.
        const chip = (n: number): string => `.subckt PJ_CHIP_${n} A B Y IRR=1
aadc [A B] [a_d b_d] adc1
adut [a_d b_d] [y_d] null dut
adac [y_d] [Y] dac1
.model adc1 adc_bridge(in_low=1.5 in_high=3.5)
.model dac1 dac_bridge(out_low=0 out_high=5)
.model dut d_cosim(simulation="test-chip_${n}" irreversible={IRR})
.ends PJ_CHIP_${n}`;
        const two = `* two chips of one part
.subckt PJ_BUTTON 1 2
Vctl ctl 0 dc 0 external
R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'
.ends
.subckt PJ_LED A K
Vs A a1 dc 0
D1 a1 K PJLED
.model PJLED D(IS=1e-18 N=2 RS=10)
.ends
${chip(1)}
${chip(2)}
V1 vcc 0 dc 5
XSW1 vcc b1 PJ_BUTTON
R1 b1 0 10k
XSW2 vcc b2 PJ_BUTTON
R2 b2 0 10k
XU1 b1 0 y1 PJ_CHIP_1 IRR=1
XU2 b2 0 y2 PJ_CHIP_2 IRR=2
R3 y1 n1 330
XD1 n1 0 PJ_LED
R4 y2 n2 330
XD2 n2 0 PJ_LED
.tran 1m 100000 0 1m
.end`.split('\n');
        const started = await page.evaluate(({ host, deck, inputs }) => {
            const w = window as any;
            return w.__live[host].call('start', {
                deck, files: [], inputs, speed: 1,
                parts: [
                    { name: 'test-chip_1', bytes: w.__livePackage('test-adapter', 'one') },
                    { name: 'test-chip_2', bytes: w.__livePackage('test-adapter', 'two') },
                ],
            });
        }, { host, deck: two, inputs: { [BUTTON1]: 0, [BUTTON2]: 0 } });
        expect(started).toEqual({ ok: true });

        // Each chip was made from its own package: the word in it is its own.
        await expect.poll(async () => (await partLines()).map((l) => l.replace(/made \d+, let go \d+, /, '')).sort(),
            { message: 'each chip says what it was given', timeout: 10000, intervals: [50] })
            .toEqual(['test-chip_1: file: hello, word: one', 'test-chip_2: file: hello, word: two']);

        // And each is its own part of the circuit: LED 1 follows button 1, LED 2 button 2.
        const dark = await frameWhen(page, host, 'the run reaches 0.2 s', (f) => f.t >= 0.2);
        expect(dark.latest[LED1]!).toBeLessThan(1e-6);
        expect(dark.latest[LED2]!).toBeLessThan(1e-6);
        await call(page, host, 'input', { name: BUTTON1, value: 1 });
        const first = await frameWhen(page, host, 'LED 1 is on with button 1 held', (f) => f.latest[LED1]! > LIT);
        expect(first.latest[LED2]!, 'LED 2 stays dark').toBeLessThan(1e-6);
        await call(page, host, 'input', { name: BUTTON1, value: 0 });
        await call(page, host, 'input', { name: BUTTON2, value: 1 });
        const second = await frameWhen(page, host, 'LED 2 is on with button 2 held',
            (f) => f.latest[LED2]! > LIT && f.latest[LED1]! < 1e-6);
        expect(second.latest[LED2]!).toBeCloseTo(9.11e-3, 4);
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        expect((await hostState(page, host)).fatal).toBeNull();
    });

    test('a new start replaces the run, from time zero, with the inputs it is given', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        expect(await start(page, host)).toEqual({ ok: true });
        const before = await frameWhen(page, host, 'the first run reaches 0.5 s', (f) => f.t >= 0.5);
        expect(Math.abs(before.latest[LED1]!)).toBeLessThan(1e-6);

        // No stop in between: the worker halts the old run, drops its circuit and loads the next.
        const startedAt = await page.evaluate(() => performance.now());
        expect(await start(page, host, { inputs: { [BUTTON1]: 1 } })).toEqual({ ok: true });
        const after = await frameWhen(page, host, 'the second run has its first values',
            (f) => f.running && f.points > 0 && f.latest[LED1] !== undefined);
        // A run is held to the clock: one that began after `startedAt` is no further than
        // the time since then. The first run, had it gone on, would be half a second further.
        // (Not "less than before.t": on a busy machine the first frame of the new run can
        // come back more than half a second after its start.)
        const sinceStart = (after.wall - startedAt) / 1000;
        expect(after.t, 'simulated time began again').toBeLessThanOrEqual(sinceStart * 1.05 + 0.05);
        expect(after.latest[LED1]!, 'the button is held from the first moment').toBeGreaterThan(LIT);

        // Start and stop in quick succession, several times over: a run is always halted,
        // also one whose thread has not come up yet.
        for (let i = 0; i < 5; i++) {
            expect(await start(page, host)).toEqual({ ok: true });
            expect(await call(page, host, 'stop')).toEqual({ ok: true });
            expect((await frame(page, host)).running).toBe(false);
        }

        expect(await start(page, host)).toEqual({ ok: true });
        await frameWhen(page, host, 'it still runs after that', (f) => f.t >= 0.2);
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
        const state = await hostState(page, host);
        expect(state.fatal).toBeNull();
        expect(state.errors).toEqual([]);
    });

    test('a circuit ngspice does not take is an answer in words', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        const res = await page.evaluate((host) => (window as any).__live[host].call('start', {
            deck: ['* broken', 'R1 a 0 1k', 'X1 a 0 NOSUCHPART', '.tran 1m 100000 0 1m', '.end'],
            files: [], inputs: {}, parts: [], speed: 1,
        }), host);
        // ngspice itself says "fine" to this circuit and to its start; the run then ends before
        // its first time point. The answer carries ngspice's own words.
        expect(res).toEqual({
            error: 'ngspice did not run the circuit: Error: unknown subckt: x1 a 0 nosuchpart'
                + ' / in line no. 3 from file circbyline / Error: no circuit loaded',
        });
        expect((await frame(page, host)).running).toBe(false);

        // A model nobody defines: what KiCad writes for a stock transistor.
        const noModel = await page.evaluate((host) => (window as any).__live[host].call('start', {
            deck: ['* no model', 'V1 vcc 0 5', 'R1 vcc c 1k', 'Q1 c b 0 NPN', 'R2 vcc b 100k',
                '.tran 1m 100000 0 1m', '.end'],
            files: [], inputs: {}, parts: [], speed: 1,
        }), host);
        expect(noModel).toEqual({
            error: 'ngspice did not run the circuit: Error on line 4 or its substitute:'
                + ' / q1 c b 0 npn / could not find a valid modelname',
        });

        // The session is still good for the next circuit.
        expect(await start(page, host)).toEqual({ ok: true });
        await frameWhen(page, host, 'a good circuit runs afterwards', (f) => f.t >= 0.2);
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
    });

    test('a run whose code part is missing does not start, with the reason', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        // the circuit asks for a part that nobody handed in
        expect(await start(page, host, { part: false, partName: 'not-there' })).toEqual(
            { error: "no code part named 'not-there' is loaded" });
        expect((await frame(page, host)).running, 'ngspice would go on without the part').toBe(false);
        // the log comes in batches, a moment after the answer
        await expect.poll(async () => (await hostState(page, host)).log.filter((l) => l[0] === 'problem'),
            { message: 'said once, however often ngspice asked', timeout: 10000, intervals: [50] }).toEqual(
            [['problem', "no code part named 'not-there' is loaded"]]);

        // With the part, the same session runs.
        expect(await start(page, host)).toEqual({ ok: true });
        const on = await frameWhen(page, host, 'the part switched LED 2 on', (f) => f.latest[LED2]! > LIT);
        expect(on.problem).toBeUndefined();
        expect(await call(page, host, 'stop')).toEqual({ ok: true });
    });

    test('a code part that traps ends the session; a new worker runs the circuit again', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        expect(await start(page, host)).toEqual({ ok: true });
        await frameWhen(page, host, 'the run reaches 0.3 s', (f) => f.t >= 0.3);

        // Button 2 makes the part trap inside the simulation thread.
        await call(page, host, 'input', { name: BUTTON2, value: 1 });
        await expect.poll(async () => (await hostState(page, host)).fatal,
            { message: 'the worker says it cannot go on', timeout: 30000, intervals: [50] }).toMatch(/unreachable/);
        // After that it answers every command with the same news.
        expect(await call(page, host, 'frame')).toEqual({ error: 'the engine has stopped working' });
        await page.evaluate((host) => (window as any).__live[host].worker.terminate(), host);

        // A fresh worker: the same circuit runs, and the part works again.
        const fresh = await boot(page);
        expect(fresh).not.toBe(host);
        expect(await start(page, fresh, { inputs: { [BUTTON1]: 1 } })).toEqual({ ok: true });
        const again = await frameWhen(page, fresh, 'the circuit runs on the new worker',
            (f) => f.t >= 0.3 && f.latest[LED1]! > LIT && f.latest[LED2]! > LIT);
        expect(again.running).toBe(true);
        expect(await call(page, fresh, 'stop')).toEqual({ ok: true });
        expect((await hostState(page, fresh)).fatal).toBeNull();
    });

    test('a code part whose bytes changed in memory is refused, at the start and when it is swapped in', async ({ page }) => {
        await open(page);
        // Straight at the module, without the worker script: the test has to reach into the
        // engine's memory, which the worker's protocol rightly has no command for.
        const result = await page.evaluate(async ({ deck }) => {
            const glue = new URL('ngspice_service.js', window.location.href).href;
            const body = async () => {
                // first of all: the page's message must find somebody listening
                const input = new Promise<any>((resolve) => { self.onmessage = (e) => resolve(e.data); });
                const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
                const lines: [number, string | null, number][] = [];
                const mod = await (self as any).NgspiceService({
                    locateFile: (f: string) => new URL(f, (self as any).NGSPICE_GLUE_URL).href,
                    ngspiceEmit: (kind: number, text: string | null, a: number) => { lines.push([kind, text, a]); },
                });
                const { deck, part } = await input;
                const halt = async () => {
                    for (let i = 0; i < 1000 && mod.liveRunState() !== 0; i++) {
                        if (i % 20 === 0) mod.liveStop();
                        await sleep(10);
                    }
                    return mod.liveRunState();
                };
                const problemAfterStart = async () => {
                    mod.liveCirc(deck, []);
                    mod.liveStart();
                    for (let i = 0; i < 1000; i++) {
                        const s = mod.liveSnapshot();
                        if (s.problem || s.t >= 0.15) return { problem: s.problem as string, t: s.t as number };
                        await sleep(10);
                    }
                    return { problem: 'nothing happened', t: -1 };
                };
                mod.liveInit();
                mod.liveRegisterPart('test-part', part);
                const at = mod.livePartAt('test-part');
                const heap = () => new Uint8Array(mod.liveSnapshot().latest.buffer);
                const good = await problemAfterStart();
                const halted1 = await halt();
                heap()[at + 40] ^= 0xff;                       // one byte of the part's code changes
                const damaged = await problemAfterStart();
                const halted2 = await halt();
                heap()[at + 40] ^= 0xff;                       // and back
                const repaired = await problemAfterStart();

                // The same rule for new code that arrives while the circuit runs. The run is
                // held while the new bytes are put in and changed, so the engine takes them
                // only after that. The same module with an empty custom section at its end
                // is different bytes and the same code.
                const withTail = (letter: number) => {
                    const bytes = new Uint8Array(part.length + 4);
                    bytes.set(part);
                    bytes.set([0, 2, 1, letter], part.length);
                    return bytes;
                };
                mod.liveSetPaused(true);
                for (let last = -1, t = mod.liveSnapshot().t; t !== last;) {
                    await sleep(30);
                    last = t;
                    t = mod.liveSnapshot().t;
                }
                mod.liveRegisterPart('test-part', withTail(0x78));
                heap()[mod.livePartAt('test-part') + 40] ^= 0xff;
                mod.liveSetPaused(false);
                let swapRefused = 'nothing happened';
                for (let i = 0; i < 1000; i++) {
                    const s = mod.liveSnapshot();
                    if (s.problem) { swapRefused = s.problem; break; }
                    await sleep(10);
                }
                // new code that is whole is taken
                const swapsBefore = lines.filter((l) => l[0] === 4 && l[2] === 1).length;
                mod.liveRegisterPart('test-part', withTail(0x79));
                let swapped: string | null = null;
                for (let i = 0; i < 1000 && swapped === null; i++) {
                    const swaps = lines.filter((l) => l[0] === 4 && l[2] === 1);
                    if (swaps.length > swapsBefore) swapped = swaps[swaps.length - 1]![1];
                    else await sleep(10);
                }

                const halted3 = await halt();
                (self as any).postMessage({
                    at, good, damaged, repaired, swapRefused, swapsBefore, swapped, halted: [halted1, halted2, halted3],
                    problems: lines.filter((l) => l[0] === 4 && l[2] === 2).map((l) => l[1]),
                });
            };
            // The glue starts its threads from this same script: there, only the glue runs.
            const src = `self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\nimportScripts(self.NGSPICE_GLUE_URL);\n`
                + `if (globalThis.name !== "em-pthread") (${body.toString()})().catch((e) => postMessage({ failed: String(e) }));\n`;
            const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            const answer = new Promise<any>((resolve, reject) => {
                worker.onmessage = (e) => resolve(e.data);
                worker.onerror = (e) => reject(new Error(e.message));
            });
            worker.postMessage({ deck, part: (window as any).__livePart });
            const data = await answer;
            worker.terminate();
            return data;
        }, { deck: deck() });

        expect(result.failed).toBeUndefined();
        expect(result.at).toBeGreaterThan(0);
        expect(result.good.problem, 'the part as it came in runs').toBe('');
        expect(result.damaged.problem).toBe("code part 'test-part' is not what was loaded: its bytes changed in memory");
        expect(result.repaired.problem, 'with its bytes back it runs again').toBe('');
        expect(result.swapRefused, 'new code that changed in memory is not swapped in')
            .toBe("code part 'test-part' is not what was loaded: its bytes changed in memory");
        expect(result.swapsBefore, 'and the old code stayed').toBe(0);
        expect(result.swapped, 'new code that is whole is swapped in').toMatch(/^test-part: new code loaded at t=/);
        expect(result.halted).toEqual([0, 0, 0]);
        // said once per run it happened in: at the start of the second run, at the swap in the third
        expect(result.problems).toEqual([
            "code part 'test-part' is not what was loaded: its bytes changed in memory",
            "code part 'test-part' is not what was loaded: its bytes changed in memory",
        ]);
    });
});
