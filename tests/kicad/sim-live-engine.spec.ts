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
    await page.evaluate(({ workerSrc, partBase64 }) => {
        const glue = new URL('ngspice_service.js', window.location.href).href;
        const w = window as any;
        w.__livePart = Uint8Array.from(atob(partBase64), (c) => c.charCodeAt(0));
        w.__live = [];
        // One live session: the production worker script in front of the service's glue.
        w.__liveBoot = () => {
            const url = URL.createObjectURL(new Blob(
                [`self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\n`, workerSrc], { type: 'text/javascript' }));
            const worker = new Worker(url);
            const host: any = { worker, log: [], fatal: null, errors: [], names: [], nextId: 1, pending: new Map() };
            host.ready = new Promise<void>((resolve, reject) => {
                worker.onmessage = (e: MessageEvent) => {
                    const m = e.data ?? {};
                    if (m.ready) return resolve();
                    if (m.bootError !== undefined) return reject(new Error(String(m.bootError)));
                    if (m.fatal !== undefined) { host.fatal = String(m.fatal); return; }
                    if (m.log) { host.log.push(...m.log); return; }
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
    }, { workerSrc: WORKER_SRC, partBase64: PART_BASE64 });
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

    test('a new start replaces the run, from time zero, with the inputs it is given', async ({ page }) => {
        await open(page);
        const host = await boot(page);
        expect(await start(page, host)).toEqual({ ok: true });
        const before = await frameWhen(page, host, 'the first run reaches 0.5 s', (f) => f.t >= 0.5);
        expect(Math.abs(before.latest[LED1]!)).toBeLessThan(1e-6);

        // No stop in between: the worker halts the old run, drops its circuit and loads the next.
        expect(await start(page, host, { inputs: { [BUTTON1]: 1 } })).toEqual({ ok: true });
        const after = await frameWhen(page, host, 'the second run has its first values',
            (f) => f.running && f.points > 0 && f.latest[LED1] !== undefined);
        expect(after.t, 'simulated time began again').toBeLessThan(before.t);
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
