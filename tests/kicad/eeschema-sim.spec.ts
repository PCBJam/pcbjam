import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PNG } from 'pngjs';
import {
    clickByLabel, findAllByLabel, findAllGridCells, findByTooltip, findGridCellByLabel, stableShot,
    waitForEditorReady,
} from '../e2e/utils/element-tracker';
import { loadRectifier, openSimulator, runSimulation, waitForRunToolEnabled } from './utils/sim-harness';

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

/** A signal's Plot tick in the simulator's signals grid (clicking it shows/hides the trace). */
async function plotTick(page: Page, signal: string) {
    const name = await findGridCellByLabel(page, signal);
    expect(name, `${signal} in the signals grid`).not.toBeNull();
    const row = /^Row (\d+),/.exec(name!.tooltip)![1];
    const cells = await findAllGridCells(page);
    const tick = cells.find((c) => c.parentId === name!.parentId && c.tooltip === `Row ${row}, Col 1`);
    expect(tick, `${signal}'s Plot cell`).toBeTruthy();
    return tick!;
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

    // The guide overlay's view of the simulator (docs/features/overlay-system/0006 M1): the frame
    // reports itself like a modeless dialog (E1), first opens as a band across the bottom with its
    // whole toolbar drawn (E4), a finished run reports its analysis, size and traces (E2), and a
    // changed plot reports its traces (E3) — what a tour's simFinished / simTraces wait for.
    test('reports itself, its finished run and its plotted traces to the guide overlay', async ({ page, testLogger }) => {
        type EditorEvent = { type: string; cls?: string; modal?: boolean; kind?: string; ok?: boolean;
            points?: number; traces?: string[] };
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        await page.evaluate(() => {
            const w = window as any;
            w.__editorEvents = [];
            window.addEventListener('pcbjam:editor-event', (e) => w.__editorEvents.push((e as CustomEvent).detail));
        });
        const events = (type: string) => page.evaluate((t) =>
            ((window as any).__editorEvents as EditorEvent[]).filter((e) => e.type === t), type);

        const simWin = await openSimulator(page);
        await expect.poll(() => events('dialogShown'), { message: 'the simulator reports it opened' })
            .toEqual([expect.objectContaining({ cls: 'SIMULATOR_FRAME', modal: false })]);

        // E4: a band across the bottom of the page, every tool of its toolbar drawn inside it.
        await waitForRunToolEnabled(page);
        const frame = (await page.locator(`#${simWin}`).boundingBox())!;
        const view = page.viewportSize()!;
        expect(frame.x, 'left margin').toBeLessThanOrEqual(16);
        expect(view.width - (frame.x + frame.width), 'right margin').toBeLessThanOrEqual(16);
        expect(view.height - (frame.y + frame.height), 'bottom margin').toBeLessThanOrEqual(16);
        expect(frame.y, 'the sheet stays visible above it').toBeGreaterThan(view.height * 0.25);
        for (const tooltip of ['Run Simulation', 'Probe Schematic', 'Add Tuned Value']) {
            const tool = await findByTooltip(page, tooltip, { elementType: 'tool' });
            expect(tool, `${tooltip} drawn`).not.toBeNull();
            expect(tool!.centerX > frame.x && tool!.centerX < frame.x + frame.width
                && tool!.centerY > frame.y && tool!.centerY < frame.y + frame.height,
                `${tooltip} inside the simulator`).toBe(true);
        }

        // E2: the workbook's transient run, with its two plotted signals.
        await runSimulation(page);
        const finished = await events('simFinished');
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ kind: 'tran', ok: true });
        expect(finished[0].points, 'a real transient').toBeGreaterThan(100);
        expect([...finished[0].traces!].sort()).toEqual(['V(/rect_out)', 'V(/signal_in)']);

        // E3: hiding a signal (its Plot tick in the signals grid) reports the plot's new traces.
        const lastPlot = async () => (await events('simPlotChanged')).at(-1)?.traces ?? null;
        let tick = await plotTick(page, 'V(/signal_in)');
        await page.mouse.click(tick.centerX, tick.centerY);
        await expect.poll(lastPlot, { message: 'hiding V(/signal_in) is reported' }).toEqual(['V(/rect_out)']);
        tick = await plotTick(page, 'V(/signal_in)');
        await page.mouse.click(tick.centerX, tick.centerY);
        await expect.poll(async () => [...((await lastPlot()) ?? [])].sort(), { message: 'showing it again is reported' })
            .toEqual(['V(/rect_out)', 'V(/signal_in)']);
        await stableShot(page, 'eeschema-sim-overlay-events.png');

        // Closing reports it once (the changed workbook asks first: discard).
        await page.locator(`#${simWin} .window-titlebar-close`).click();
        await expect.poll(async () => {
            await page.mouse.move(4, 4);
            await page.mouse.move(8, 8);
            if ((await events('dialogClosed')).length > 0) return true;
            await clickByLabel(page, 'Discard Changes');
            return false;
        }, { message: 'the simulator reports it closed', timeout: 60000 }).toBe(true);
        expect(await events('dialogClosed')).toEqual([expect.objectContaining({ cls: 'SIMULATOR_FRAME', modal: false })]);
        expect(await events('dialogShown')).toHaveLength(1);

        const all = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(all.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
    });

    // The workbook (.wbk: analysis tabs, plotted traces, cursors) is written straight to MEMFS by
    // KiCad, so without the save hook the web app never persists it and a reload loses it while
    // the project still points at it. Both save paths must fire window.kicadCollab.onSave AFTER
    // the bytes hit MEMFS: the toolbar's Save Workbook and Save in the close prompt.
    test('saving the workbook hands the .wbk to the save hook', async ({ page, testLogger }) => {
        type Saved = { path: string; text: string };
        const wbk = '/home/kicad/documents/rectifier/rectifier.wbk';
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        // The collector reads the file back the moment the hook fires, as the save router does.
        await page.evaluate(() => {
            const w = window as any;
            w.__saved = [];
            w.kicadCollab = { ...w.kicadCollab, onSave: (p: string) =>
                w.__saved.push({ path: p, text: w.FS.readFile(p, { encoding: 'utf8' }) }) };
        });
        const saved = () => page.evaluate(() => (window as any).__saved as Saved[]);
        const tracesOf = (s: Saved) => (JSON.parse(s.text).tabs[0].traces as Array<{ signal: string }>)
            .map((t) => t.signal).sort();

        const simWin = await openSimulator(page);
        await waitForRunToolEnabled(page);
        // The simulator has read the fixture's workbook; clobber it so only a real save can
        // leave a parseable workbook behind.
        await page.evaluate((p) => (window as any).FS.writeFile(p, 'stale'), wbk);

        // Toolbar Save Workbook: the project already names rectifier.wbk, so no file dialog.
        const saveTool = await findByTooltip(page, 'Save Workbook', { elementType: 'tool' });
        expect(saveTool, 'Save Workbook drawn').not.toBeNull();
        await page.mouse.click(saveTool!.centerX, saveTool!.centerY);
        await expect.poll(async () => (await saved()).map((s) => s.path),
            { message: 'the toolbar save reports the workbook' }).toEqual([wbk]);
        expect(tracesOf((await saved())[0])).toEqual(['V(/rect_out)', 'V(/signal_in)']);

        // Hide a trace (marks the workbook modified), then close: the prompt's Save writes it.
        await runSimulation(page);
        const tick = await plotTick(page, 'V(/signal_in)');
        await page.mouse.click(tick.centerX, tick.centerY);
        await page.locator(`#${simWin} .window-titlebar-close`).click();
        await expect.poll(async () => {
            await page.mouse.move(4, 4);
            await page.mouse.move(8, 8);
            if (await page.locator(`#${simWin}`).count() === 0) return true;
            const save = (await findAllByLabel(page, 'Save')).find((e) => /^&?Save$/.test(e.label));
            if (save) await page.mouse.click(save.centerX, save.centerY);
            return false;
        }, { message: 'the simulator closes through the Save prompt', timeout: 60000 }).toBe(true);

        const all = await saved();
        expect(all.map((s) => s.path), 'the close prompt reports the workbook').toEqual([wbk, wbk]);
        expect(tracesOf(all[1]), 'the closing save wrote the current plot').toEqual(['V(/rect_out)']);

        const logs = [...testLogger.consoleLogs, ...testLogger.errors];
        expect(logs.filter((l) => l.includes('Aborted(')), 'no aborts').toHaveLength(0);
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
