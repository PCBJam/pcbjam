import { test, expect } from './fixtures';
import { PNG } from 'pngjs';
import { stableShot, waitForEditorReady } from '../e2e/utils/element-tracker';
import { loadRectifier, openSimulator, runSimulation } from './utils/sim-harness';

/**
 * eeschema simulator end-to-end (docs/features/ngspice-split/): the historic
 * kill-point was SIMULATOR_FRAME never opening (no dlopen for libngspice);
 * now NGSPICE binds the sharedspice client stub and the engine runs in the
 * lazy ngspice_service worker. These specs drive the REAL UI path:
 * project open → Inspect → Simulator → Run → plot, asserting the RPC/event
 * plumbing (window.__ngspiceEvents / __ngspiceLog from the harness provider,
 * tests/kicad/utils/ngspice-service.ts) and the rendered result.
 *
 * Fixture: the complete kicad demo rectifier project — its 1N4148 lives in a
 * sibling diode.mod pulled in via `.include`, so a passing transient also
 * proves the client stub's netlist file shipping (a missing model fails the
 * run with "unable to find definition of model").
 */

function distinctColors(png: PNG): number {
    const colors = new Set<number>();
    // 8x8 grid sampling, same spirit as the 3d-viewer render check.
    const stepX = Math.max(1, Math.floor(png.width / 8));
    const stepY = Math.max(1, Math.floor(png.height / 8));

    for (let y = 0; y < png.height; y += stepY) {
        for (let x = 0; x < png.width; x += stepX) {
            const i = (png.width * y + x) << 2;
            colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
        }
    }
    return colors.size;
}

test.describe('eeschema simulator', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(300000);

    test('Inspect → Simulator opens the frame; service fetches lazily', async ({ page, testLogger }) => {
        const ngspiceFetches: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('ngspice_service')) ngspiceFetches.push(r.url());
        });

        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);

        expect(ngspiceFetches,
            'ngspice_service must NOT be fetched before the simulator opens')
            .toHaveLength(0);

        await openSimulator(page);
        await stableShot(page, 'eeschema-sim-frame.png');

        // NGSPICE::init_dll ran inside the frame ctor → the client stub's init
        // RPC booted the worker.
        expect(ngspiceFetches.length,
            'ngspice_service fetched lazily by the simulator open')
            .toBeGreaterThan(0);

        const all = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(all.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
    });

    test('transient run: live console stream, vectors reach the plot, plot renders', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        const simWin = await openSimulator(page);

        await runSimulation(page);

        const evts = await page.evaluate(() => (window as any).__ngspiceEvents as Array<{
            kind: string; lines?: string[]; finished?: boolean; t: number }>);

        // Live streaming: console/status output must precede the finish event.
        const finishT = evts.filter((e) => e.kind === 'bg' && e.finished).map((e) => e.t)[0];
        const streamed = evts.filter(
            (e) => (e.kind === 'char' || e.kind === 'stat') && e.t <= finishT);
        expect(streamed.length, 'ngspice output streamed during the run')
            .toBeGreaterThan(3);

        // The model shipped via .include resolved (a miss fails the run with
        // "unable to find definition" and produces no transient).
        const charText = evts.flatMap((e) => e.lines ?? []).join('\n');
        expect(charText, 'no missing-model errors').not.toMatch(/unable to find definition/i);

        // The exact final-refresh receipt and drained-waits check above prove
        // this log entry belongs to a vector which reached the plot, not
        // merely a worker response still waiting to copy into native memory.
        const vecPulls = await page.evaluate(() =>
            ((window as any).__ngspiceLog as Array<{ kind: string; length?: number }>)
                .filter((l) => l.kind === 'get_vec_info' && (l.length ?? 0) > 100).length);
        expect(vecPulls, 'plot fetched transient vectors').toBeGreaterThan(0);

        // The plot area rendered something beyond a flat background.
        const shot = await page.locator(`#${simWin}`).screenshot({
            scale: 'css', animations: 'disabled' });
        const png = PNG.sync.read(shot);
        expect(distinctColors(png), 'plot window shows structure (axes/trace)')
            .toBeGreaterThan(6);

        await stableShot(page, 'eeschema-sim-plot.png');

        const all = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(all.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
        const corruption = all.filter((l) =>
            l.includes('index out of bounds') || l.includes('indirect call to null')
            || l.includes('uncaught exception: unwind'));
        expect(corruption, 'no wasm trap').toHaveLength(0);
    });

    test('a second run after the first succeeds (engine reset path)', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        await openSimulator(page);

        const firstGeneration = await runSimulation(page);
        const secondGeneration = await runSimulation(page);
        expect(secondGeneration, 'the second run has its own exact generation')
            .toBeGreaterThan(firstGeneration);

        const finishCount = await page.evaluate(() =>
            ((window as any).__ngspiceEvents as Array<{ kind: string; finished?: boolean }>)
                .filter((e) => e.kind === 'bg' && e.finished === true).length);
        expect(finishCount, 'two completed runs').toBeGreaterThanOrEqual(2);

        const all = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(all.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
    });
});
