import { test, expect } from './fixtures';
import * as path from 'path';
import { PNG } from 'pngjs';
import {
    clickByTooltip,
    clickMenuBarItem,
    clickMenuItemByText,
    findByTooltip,
    stableShot,
    waitForEditorReady,
} from '../e2e/utils/element-tracker';
import { injectFileIntoMemfs } from './utils/fs-inject';

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

const RECTIFIER_DIR = path.resolve(__dirname, '..', '..',
    'kicad', 'demos', 'simulation', 'rectifier');
const MEMFS_DIR = '/home/kicad/documents/rectifier';
const PROJECT_FILES = ['rectifier.kicad_sch', 'rectifier.kicad_pro', 'diode.mod',
                       'rectifier_schlib.kicad_sym', 'sym-lib-table', 'rectifier.wbk'];

async function loadRectifier(page: import('@playwright/test').Page): Promise<void> {
    for (const f of PROJECT_FILES)
        await injectFileIntoMemfs(page, path.join(RECTIFIER_DIR, f), `${MEMFS_DIR}/${f}`);

    await page.evaluate(async (sch: string) => {
        await (window as any).Module.kicadOpenFile(sch);
    }, `${MEMFS_DIR}/rectifier.kicad_sch`);

    await expect
        .poll(async () => page.title(), { timeout: 120000 })
        .toMatch(/rectifier/i);
}

// Open Inspect → Simulator and return the new top-level window's DOM id.
async function openSimulator(page: import('@playwright/test').Page): Promise<string> {
    const idsBefore = await page.$$eval('#window-container [id^="window-"]',
        (els) => els.map((e) => e.id));

    expect(await clickMenuBarItem(page, 'Inspect'), 'Inspect menu').toBe(true);
    await clickMenuItemByText(page, 'Simulator');

    await page.waitForFunction((before: string[]) => {
        const ids = Array.from(
            document.querySelectorAll('#window-container [id^="window-"]'),
            (e) => e.id);
        return ids.some((id) => !before.includes(id));
    }, idsBefore, { timeout: 60000 });

    const idsAfter = await page.$$eval('#window-container [id^="window-"]',
        (els) => els.map((e) => e.id));
    const simWin = idsAfter.find((id) => !idsBefore.includes(id));
    expect(simWin, 'simulator window appeared').toBeTruthy();
    return simWin!;
}

// Run the loaded workbook's analysis and await the exact native run generation
// only after its final plot, operating-point, and canvas refresh calls return.
async function runSimulation(page: import('@playwright/test').Page): Promise<number> {
    // The simulator window div appears while the frame ctor is still
    // suspended in the init RPC; the toolbar registers its tools only after
    // init completes and the frame first paints. The Run tool's
    // ENABLE(!simRunning) condition is a wxUpdateUIEvent check, and the WASM
    // port only reliably re-evaluates those when input events pump the loop —
    // after a run finishes, the last input was the click that started it, so
    // nudge the mouse each poll or the toolbar can hold its stale
    // "running" state forever.
    await expect
        .poll(async () => {
            await page.mouse.move(4, 4);
            await page.mouse.move(8, 8);
            const el = await findByTooltip(page, 'Run Simulation', { elementType: 'tool' });
            return !!el && el.enabled;
        }, { timeout: 60000 })
        .toBe(true);

    const generationCheckpoint = await page.evaluate(() => {
        const hooks = (globalThis as any).__ngspiceServiceTestHooks;
        if (!hooks || typeof hooks.appliedGenerationCheckpoint !== 'function'
            || typeof hooks.waitForAppliedGenerationAfter !== 'function') {
            throw new Error('exact ngspice applied-generation hooks are missing');
        }
        return hooks.appliedGenerationCheckpoint() as number;
    });

    expect(await clickByTooltip(page, 'Run Simulation', { elementType: 'tool' }),
        'Run tool').toBe(true);

    const appliedReceipt = await page.evaluate(async (after: number) => {
        const hooks = (globalThis as any).__ngspiceServiceTestHooks;
        return await hooks.waitForAppliedGenerationAfter(after, 120000);
    }, generationCheckpoint);
    expect(appliedReceipt.generation, 'the clicked run published a newer applied generation')
        .toBeGreaterThan(generationCheckpoint);

    // The native receipt fires after the final refreshes. Additionally
    // require the scheduler to hold no parked ngspice wait — a stale
    // suspended frame here means the finish path leaked a wait. (The codex
    // line awaited the execution owner's barrier; that machinery does not
    // exist on the JSPI line, and wait drainage is its observable
    // equivalent.)
    await expect.poll(
        () => page.evaluate(() => {
            const scheduler = (globalThis as any).__wxScheduler;
            return scheduler?.pendingWaits?.('ngspice') ?? -1;
        }),
        { message: 'no ngspice wait may stay parked after the applied receipt', timeout: 30000 },
    ).toBe(0);

    // Vector traffic is result validation only. It is deliberately not used as
    // completion evidence because periodic OnSimRefresh(false) pulls can look
    // identical to the final pull at the worker boundary.
    const vectorReceipt = await page.evaluate(() =>
        ((window as any).__ngspiceLog as Array<{
            sequence: number; kind: string; error?: string; length?: number;
        }>).find((entry) => entry.kind === 'get_vec_info'
            && entry.error === undefined
            && (entry.length ?? -1) >= 101) ?? null,
    );
    expect(vectorReceipt, 'the applied run returned a non-trivial successful vector')
        .not.toBeNull();

    return appliedReceipt.generation;
}

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
