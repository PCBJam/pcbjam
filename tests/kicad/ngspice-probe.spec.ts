import { test, expect } from './fixtures';

/**
 * Minimal ngspice_service probe (no eeschema boot): drive the sharedspice RPC
 * surface directly from the page. Isolates worker/module behavior from the
 * editor entirely — when the simulator breaks, this answers "service module
 * or editor-side bridge?" in seconds. The provider arrives via the fixtures'
 * ambient init script (tests/kicad/utils/ngspice-service.ts), which also
 * captures every event frame into window.__ngspiceEvents.
 *
 * Covers Gate 2 of docs/features/ngspice-split/: browser-side parity of the
 * Gate-1 node smoke — foreground transient numerics, XSPICE via the static
 * code-model registry, CIDER, live event streaming during bg_run, mid-run
 * bg_halt, and the lazy-load boundary.
 */

type SvcRes = {
    ret?: number; error?: string; found?: boolean; length?: number;
    real?: number[] | Float64Array | null; name?: string; names?: string[];
    running?: boolean;
};

async function svcRequest(page: import('@playwright/test').Page, req: unknown): Promise<SvcRes> {
    return await page.evaluate(async (r: any) => {
        const res = await (globalThis as any).ngspiceService.request(r);
        // Float64Array doesn't survive evaluate serialization on all engines —
        // flatten to a plain array (probe vectors are small).
        if (res && res.real) res.real = Array.from(res.real);
        if (res && res.comp) res.comp = Array.from(res.comp);
        return res;
    }, req as any);
}

test.describe('ngspice_service probe', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('lazy boundary + RC transient + vector readback', async ({ page }) => {
        const ngspiceFetches: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('ngspice_service')) ngspiceFetches.push(r.url());
        });

        // Any harness page gives the COI (COOP/COEP) context; don't wait for wasm.
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });

        expect(ngspiceFetches, 'ngspice_service must NOT be fetched before first use')
            .toHaveLength(0);

        const init = await svcRequest(page, { kind: 'init' });
        expect(init.error, 'init error').toBeUndefined();
        expect(init.ret, 'ngSpice_Init').toBe(0);

        expect(ngspiceFetches.length, 'ngspice_service was fetched lazily by init')
            .toBeGreaterThan(0);

        const circ = await svcRequest(page, {
            kind: 'circ',
            lines: ['rc probe', 'V1 in 0 1', 'R1 in out 1k', 'C1 out 0 1u',
                    '.tran 10u 5m', '.end'],
        });
        expect(circ.ret, 'ngSpice_Circ').toBe(0);

        const run = await svcRequest(page, { kind: 'command', cmd: 'run' });
        expect(run.ret, 'run command').toBe(0);

        const plot = await svcRequest(page, { kind: 'cur_plot' });
        expect(plot.name, 'a tran plot exists').toMatch(/^tran/);

        const vecs = await svcRequest(page, { kind: 'all_vecs', plot: plot.name! });
        expect(vecs.names, 'tran vectors').toContain('out');

        const vi = await svcRequest(page, { kind: 'get_vec_info', name: 'out' });
        expect(vi.found, 'v(out) found').toBe(true);
        expect(vi.length ?? 0, 'plausible point count').toBeGreaterThan(100);
        const last = (vi.real as number[])[(vi.length ?? 1) - 1];
        // DC operating point seeds the transient at the steady state: flat 1V.
        expect(last, 'v(out) end value').toBeGreaterThan(0.98);
        expect(last, 'v(out) end value').toBeLessThanOrEqual(1.0);
    });

    test('request receipts scan atomically and reject pre-checkpoint responses', async ({ page }) => {
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });
        expect((await svcRequest(page, { kind: 'init' })).ret).toBe(0);

        const evidence = await page.evaluate(async () => {
            const runtime = globalThis as any;
            const hooks = runtime.__ngspiceServiceTestHooks;
            if (!hooks?.requestCheckpoint || !hooks?.waitForRequestAfter)
                throw new Error('exact request receipt hooks are missing');

            // Scan path: the response already exists before the waiter starts.
            const scanCheckpoint = hooks.requestCheckpoint();
            await runtime.ngspiceService.request({ kind: 'cur_plot' });
            const scanned = await hooks.waitForRequestAfter(scanCheckpoint, {
                kind: 'cur_plot',
            });

            // Subscribe path and issue-sequence rule: `old` owns a sequence
            // before the checkpoint even though its response can arrive later.
            // It must not satisfy the waiter; only the fresh request may do so.
            const old = runtime.ngspiceService.request({ kind: 'running' });
            const freshCheckpoint = hooks.requestCheckpoint();
            let waiterSettled = false;
            const waited = hooks.waitForRequestAfter(freshCheckpoint, {
                kind: 'running',
            }).then((entry: any) => {
                waiterSettled = true;
                return entry;
            });
            await old;
            await Promise.resolve();
            const ignoredOld = !waiterSettled;
            const fresh = runtime.ngspiceService.request({ kind: 'running' });
            const [subscribed] = await Promise.all([waited, fresh]);

            return {
                scanCheckpoint,
                scanned,
                freshCheckpoint,
                subscribed,
                ignoredOld,
                state: hooks.snapshot(),
            };
        });

        expect(evidence.scanned.sequence).toBeGreaterThan(evidence.scanCheckpoint);
        expect(evidence.scanned.kind).toBe('cur_plot');
        expect(evidence.ignoredOld,
            'a late response issued before the checkpoint cannot satisfy the waiter').toBe(true);
        expect(evidence.subscribed.sequence).toBeGreaterThan(evidence.freshCheckpoint);
        expect(evidence.subscribed.kind).toBe('running');
        expect(evidence.state.requestReceiptWaiters, 'all exact waiters settled').toBe(0);
    });

    test('boot and runtime worker decode faults settle exactly and recover', async ({ page }) => {
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });

        await page.evaluate(() => {
            (globalThis as any).__ngspiceServiceTestHooks.messageErrorDuringNextBoot();
        });
        const bootFailure = await svcRequest(page, { kind: 'init' });
        expect(bootFailure.error, 'the first boot request must settle').toContain(
            'message decode failed',
        );
        let state = await page.evaluate(
            () => (globalThis as any).__ngspiceServiceTestHooks.snapshot(),
        );
        expect(state).toMatchObject({
            activeGeneration: null,
            pending: 0,
            retiredGenerations: [1],
            bootFaultArmed: false,
        });

        const recoveredBoot = await svcRequest(page, { kind: 'init' });
        expect(recoveredBoot.error, 'generation 2 must boot normally').toBeUndefined();
        expect(recoveredBoot.ret, 'generation 2 ngSpice_Init').toBe(0);

        // Two calls share one live worker generation. Fault only after both
        // real messages have been posted, proving the transport remains
        // concurrent and fail-all settles every exact request.
        const runtimeFailures = await page.evaluate(async () => {
            const runtime = globalThis as any;
            runtime.__ngspiceServiceTestHooks.messageErrorWhenPendingAtLeast(2);
            return await Promise.all([
                runtime.ngspiceService.request({ kind: 'running' }),
                runtime.ngspiceService.request({ kind: 'cur_plot' }),
            ]);
        });
        expect(runtimeFailures).toHaveLength(2);
        for (const result of runtimeFailures) {
            expect(result.error, 'every generation-2 request must settle').toContain(
                'message decode failed',
            );
        }

        state = await page.evaluate(
            () => (globalThis as any).__ngspiceServiceTestHooks.snapshot(),
        );
        expect(state.maxPending, 'requests are posted concurrently').toBeGreaterThanOrEqual(2);
        expect(state).toMatchObject({
            activeGeneration: null,
            pending: 0,
            retiredGenerations: [1, 2],
            runtimeFaultArmed: false,
        });

        const recoveredRuntime = await svcRequest(page, { kind: 'init' });
        expect(recoveredRuntime.error, 'generation 3 must recover').toBeUndefined();
        expect(recoveredRuntime.ret, 'generation 3 ngSpice_Init').toBe(0);
        state = await page.evaluate(
            () => (globalThis as any).__ngspiceServiceTestHooks.snapshot(),
        );
        expect(state).toMatchObject({ activeGeneration: 3, pending: 0 });
    });

    test('XSPICE code model resolves through the static registry', async ({ page }) => {
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });

        await svcRequest(page, { kind: 'init' });
        const circ = await svcRequest(page, {
            kind: 'circ',
            lines: ['xspice probe', 'V1 in 0 2', 'A1 in aout gainblk',
                    '.model gainblk gain(gain=3)', 'R1 aout 0 1k', '.op', '.end'],
        });
        expect(circ.ret, 'circ with a-device').toBe(0);
        expect((await svcRequest(page, { kind: 'command', cmd: 'run' })).ret).toBe(0);

        const vi = await svcRequest(page, { kind: 'get_vec_info', name: 'aout' });
        expect(vi.found, 'v(aout) found').toBe(true);
        expect((vi.real as number[])[0], 'gain block output 2*3').toBeCloseTo(6.0, 3);
    });

    test('CIDER numd device simulates', async ({ page }) => {
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });

        await svcRequest(page, { kind: 'init' });
        const circ = await svcRequest(page, {
            kind: 'circ',
            lines: ['cider probe - silicon resistor',
                    'VPP 1 0 2v', 'VNN 2 0 0.0v', 'D1 1 2 M_RES AREA=1',
                    '.MODEL M_RES numd level=1',
                    '+ options resistor defa=1p',
                    '+ x.mesh loc=0.0 num=1', '+ x.mesh loc=1.0 num=21',
                    '+ domain   num=1 material=1', '+ material num=1 silicon',
                    '+ doping unif n.type conc=2.5e16',
                    '+ models bgn srh conctau auger concmob fieldmob',
                    '.DC VPP 0.0v 2.01v 0.5v', '.END'],
        });
        expect(circ.ret, 'circ with numd model').toBe(0);
        expect((await svcRequest(page, { kind: 'command', cmd: 'run' })).ret).toBe(0);

        const vi = await svcRequest(page, { kind: 'get_vec_info', name: 'vpp#branch' });
        expect(vi.found, 'sweep current vector found').toBe(true);
        expect(vi.length ?? 0, 'DC sweep points').toBeGreaterThanOrEqual(4);
        const iLast = (vi.real as number[])[(vi.length ?? 1) - 1];
        expect(iLast, 'resistor draws current (negative through VPP)').toBeLessThan(0);
        expect(Math.abs(iLast), 'plausible magnitude').toBeLessThan(1.0);
    });

    test('bg_run streams events live and bg_halt stops mid-run', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html', { waitUntil: 'domcontentloaded' });

        await svcRequest(page, { kind: 'init' });

        // Heavy enough that the halt lands mid-run: 150-stage nonlinear
        // RC/diode ladder, 20s transient, storage bounded via .save.
        const deck = ['halt probe', 'V1 n0 0 SIN(0 5 10k)'];
        for (let i = 0; i < 150; i++) {
            deck.push(`R${i + 1} n${i} n${i + 1} 100`);
            deck.push(`C${i + 1} n${i + 1} 0 10n`);
            deck.push(`D${i + 1} n${i + 1} 0 dmod`);
        }
        deck.push('.model dmod d(is=1e-14)', '.save v(n150)', '.tran 100n 20', '.end');

        expect((await svcRequest(page, { kind: 'circ', lines: deck })).ret).toBe(0);

        const evtsBefore = await page.evaluate(
            () => (window as any).__ngspiceEvents.length as number);

        expect((await svcRequest(page, { kind: 'command', cmd: 'bg_run' })).ret,
            'bg_run accepted').toBe(0);

        // Live streaming: char/stat frames must arrive WHILE the background
        // thread simulates (not only after completion).
        await page.waitForFunction((n: number) => {
            const evts = (window as any).__ngspiceEvents as Array<{ kind: string }>;
            return evts.slice(n).filter((e) => e.kind === 'char' || e.kind === 'stat').length >= 3;
        }, evtsBefore, { timeout: 60000 });

        const midRunning = await svcRequest(page, { kind: 'running' });
        expect(midRunning.running,
            'still running while events streamed (deck heavy enough)').toBe(true);

        expect((await svcRequest(page, { kind: 'command', cmd: 'bg_halt' })).ret,
            'bg_halt accepted').toBe(0);

        // BGThreadRunning(finished) must arrive after the halt joins the thread.
        await page.waitForFunction((n: number) => {
            const evts = (window as any).__ngspiceEvents as Array<{ kind: string; finished?: boolean }>;
            return evts.slice(n).some((e) => e.kind === 'bg' && e.finished === true);
        }, evtsBefore, { timeout: 60000 });

        const after = await svcRequest(page, { kind: 'running' });
        expect(after.running, 'stopped after bg_halt').toBe(false);

        // Standard corruption gate.
        const all = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(all.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
    });
});
