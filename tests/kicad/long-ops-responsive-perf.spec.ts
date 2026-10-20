import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from './fixtures';
import { waitForEditorReady, waitUntil } from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';
import { openAndWait } from './utils/perf-utils';
import { clickWxButton, findWxButton } from './utils/wx-dialogs';

/**
 * Long editor operations keep the tab responsive
 * (docs/features/editor-responsiveness/0001).
 *
 * Fill-all (`B`), DRC and ERC run their work on pthread Workers, but the main
 * thread joined them in emscripten's busy-spin futex wait, and the refresh
 * points between joins never suspended to the browser: the tab froze for the
 * whole run. A page-realm heartbeat (setInterval + rAF) measures the longest
 * main-thread stall while the operation runs; the end is a JS event
 * (test-action-done for the synchronous fill, checkFinished for DRC/ERC), so
 * nothing calls into wasm mid-run.
 *
 * A timing spec, so it lives in the serial Chromium 'perf' project (one worker,
 * non-gating): under the parallel e2e run the same fill took 3x longer and
 * stalled 3 s. Chromium on this board, before the fix: DRC 690 ms, ERC 324 ms,
 * fill 208 ms; after: about 250 ms each. Fill is fast here either way, so that
 * case guards rather than reproduces. Firefox runs the work 3–6x slower; its
 * numbers, and the one ERC phase that still stalls there, are in the doc.
 */

/** Longest stall allowed while an operation runs. The joins between yields
 *  still spin for up to 250 ms, so this is "responsive", not "smooth". */
const MAX_STALL_MS = 600;

type Beat = { maxGap: number; longGaps: number; ticks: number; frames: number };

async function armHeartbeat(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __hb?: Beat & { last: number; timer: number; stop: boolean } };
        const hb = { maxGap: 0, longGaps: 0, ticks: 0, frames: 0, last: performance.now(), timer: 0, stop: false };
        hb.timer = window.setInterval(() => {
            const now = performance.now();
            const gap = now - hb.last;
            hb.last = now;
            hb.ticks++;
            if (gap > hb.maxGap) hb.maxGap = gap;
            if (gap > 200) hb.longGaps++;
        }, 10);
        const frame = () => {
            if (hb.stop) return;
            hb.frames++;
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        w.__hb = hb;
    });
}

async function readHeartbeat(page: Page): Promise<Beat> {
    return page.evaluate(() => {
        const hb = (window as unknown as { __hb: Beat & { timer: number; stop: boolean } }).__hb;
        window.clearInterval(hb.timer);
        hb.stop = true;
        return { maxGap: Math.round(hb.maxGap), longGaps: hb.longGaps, ticks: hb.ticks, frames: hb.frames };
    });
}

/** Resolves (in the page) when `type` arrives on window; arm BEFORE triggering. */
async function armEvent(page: Page, type: string, match: Record<string, string>): Promise<void> {
    await page.evaluate(({ type, match }) => {
        const w = window as unknown as { __done?: number };
        w.__done = 0;
        window.addEventListener(type, (e) => {
            const d = (e as CustomEvent).detail ?? {};
            if (Object.entries(match).every(([k, v]) => d[k] === v)) w.__done = performance.now();
        });
    }, { type, match });
}

async function waitForArmedEvent(page: Page, what: string, timeout: number): Promise<void> {
    await waitUntil(page, () => !!(window as unknown as { __done?: number }).__done, what, { timeout });
}

function report(label: string, beat: Beat, ms: number): void {
    // eslint-disable-next-line no-console
    console.log(`[long-ops] ${label}: ran ${ms} ms, longest stall ${beat.maxGap} ms, `
        + `${beat.longGaps} stalls >200 ms, ${beat.frames} frames`);
}

const PCB_DIR = '/home/kicad/documents/long-ops';
const BOARD = { dir: 'kicad/demos/royalblue54L_feather', stem: 'RoyalBlue54L-Feather' };

async function openBoard(page: Page, logger: { consoleLogs: string[]; errors: string[] }): Promise<void> {
    await page.goto('/kicad/pcbnew.html');
    await waitForEditorReady(page);
    for (const ext of ['kicad_pcb', 'kicad_pro']) {
        await injectFromSubmodule(page, `${BOARD.dir}/${BOARD.stem}.${ext}`, `${PCB_DIR}/${BOARD.stem}.${ext}`);
    }
    await openAndWait(page, `${PCB_DIR}/${BOARD.stem}.kicad_pcb`, 'board', logger, 180000);
}

test.describe('long operations keep the tab responsive', () => {
    test.setTimeout(420000);

    test('fill all zones (B)', async ({ page, testLogger }) => {
        await openBoard(page, testLogger);

        await armEvent(page, 'pcbjam:test-action-done', { name: 'pcbnew.ZoneFiller.zoneFillAll' });
        await armHeartbeat(page);
        const t0 = Date.now();
        await page.evaluate(() =>
            (window as unknown as { Module: { kicadTestRunAction(n: string): boolean } })
                .Module.kicadTestRunAction('pcbnew.ZoneFiller.zoneFillAll'));
        await waitForArmedEvent(page, 'zone fill finished', 300000);
        const ms = Date.now() - t0;
        const beat = await readHeartbeat(page);
        report('fill all', beat, ms);

        expect(beat.maxGap, 'the tab keeps running JS while zones fill').toBeLessThan(MAX_STALL_MS);
    });

    test('DRC', async ({ page, testLogger }) => {
        await openBoard(page, testLogger);

        await page.evaluate(() =>
            (window as unknown as { Module: { kicadTestRunAction(n: string): boolean } })
                .Module.kicadTestRunAction('pcbnew.DRCTool.runDRC'));
        await waitUntil(page, () => {
            const r = window.wxElementRegistry;
            return !!r && r.findAll({ visible: true })
                .some((e) => (e.label === 'Run DRC' || e.label === '&Run DRC') && (e.typeName ?? '').includes('Button'));
        }, 'DRC dialog with its Run DRC button', { timeout: 30000 });
        expect(await findWxButton(page, 'Run DRC')).not.toBeNull();

        await armEvent(page, 'pcbjam:editor-event', { type: 'checkFinished', kind: 'drc' });
        await armHeartbeat(page);
        const t0 = Date.now();
        expect(await clickWxButton(page, 'Run DRC')).toBe(true);
        await waitForArmedEvent(page, 'DRC finished', 300000);
        const ms = Date.now() - t0;
        const beat = await readHeartbeat(page);
        report('DRC', beat, ms);

        expect(beat.maxGap, 'the tab keeps running JS during DRC').toBeLessThan(MAX_STALL_MS);
    });

    test('ERC', async ({ page, testLogger }) => {
        const SCH_DIR = '/home/kicad/documents/long-ops-sch';
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        const projectRoot = path.resolve(__dirname, '..', '..');
        // the root sheet, its project and the sub-sheets under sch/
        const files = [`${BOARD.stem}.kicad_sch`, `${BOARD.stem}.kicad_pro`,
            ...fs.readdirSync(path.join(projectRoot, BOARD.dir, 'sch')).map((f) => `sch/${f}`)];
        for (const f of files) await injectFromSubmodule(page, `${BOARD.dir}/${f}`, `${SCH_DIR}/${f}`);
        await openAndWait(page, `${SCH_DIR}/${BOARD.stem}.kicad_sch`, 'schematic', testLogger, 180000);

        await page.evaluate(() =>
            (window as unknown as { Module: { kicadTestRunAction(n: string): boolean } })
                .Module.kicadTestRunAction('eeschema.InspectionTool.runERC'));
        await waitUntil(page, () => {
            const r = window.wxElementRegistry;
            return !!r && r.findAll({ visible: true })
                .some((e) => (e.label === 'Run ERC' || e.label === '&Run ERC') && (e.typeName ?? '').includes('Button'));
        }, 'ERC dialog with its Run ERC button', { timeout: 30000 });

        await armEvent(page, 'pcbjam:editor-event', { type: 'checkFinished', kind: 'erc' });
        await armHeartbeat(page);
        const t0 = Date.now();
        expect(await clickWxButton(page, 'Run ERC')).toBe(true);
        await waitForArmedEvent(page, 'ERC finished', 300000);
        const ms = Date.now() - t0;
        const beat = await readHeartbeat(page);
        report('ERC', beat, ms);

        expect(beat.maxGap, 'the tab keeps running JS during ERC').toBeLessThan(MAX_STALL_MS);
    });
});
