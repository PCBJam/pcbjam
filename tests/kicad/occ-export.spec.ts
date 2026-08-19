import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from './fixtures';
import { clickMenuBarItem, clickMenuItem, waitForEditorReady, waitForRenderedByLabel, waitUntil, stableShot, settledShot } from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';
import { openBoardProgrammatically } from './utils/board-ready';

/** Wait for a rendered popup menu to have its items (replaces a fixed post-menu-click sleep). */
async function waitForMenuItems(page: Page): Promise<void> {
    await waitUntil(
        page,
        () => {
            const r = window.wxElementRegistry;
            if (!r?.findAllRendered) return false;
            return r.findAllRendered({ elementType: 'menuitem' }).length > 3;
        },
        'popup menu items rendered',
    );
}

/**
 * STEP export through the occ_service worker (docs/features/occ-split/):
 * pcbnew.wasm carries no OCC — DIALOG_EXPORT_STEP's browser branch runs
 * EXPORTER_STEP, whose WASM shadow suspends via EM_ASYNC_JS and hands the
 * job to `globalThis.occService` (worker with its own OCC-linked module).
 *
 * Asserted end to end:
 *   1. occ_service.{js,wasm} is NOT fetched at boot or board load — only the
 *      export click triggers it (the lazy-load boundary).
 *   2. The (unchanged) export dialog drives the whole chain: menu → dialog →
 *      Export button → worker → STEP bytes.
 *   3. The result is a real STEP file (ISO-10303-21 magic, non-trivial size),
 *      captured by the provider stub where the app would download it.
 */

const KICAD_VERSION_DIR = '10.0';
const PROJECT_DIR_MEMFS = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

const DEMO = { name: 'pic_programmer', dir: 'pic_programmer', stem: 'pic_programmer' } as const;

async function loadBoard(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }): Promise<void> {
    const pcbFilename = `${DEMO.stem}.kicad_pcb`;
    const proFilename = `${DEMO.stem}.kicad_pro`;

    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pcbFilename}`,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${proFilename}`,
        `${PROJECT_DIR_MEMFS}/${proFilename}`);

    const result = await openBoardProgrammatically(
        page,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`,
        DEMO.stem,
        testLogger,
        60000,
    );
    console.log(`[TEST] ${DEMO.name} board-ready result: ${result}`);
}

type WxButtonTarget = { x: number; y: number; domId: number | null };

/** Resolve one visible wx button to its stable DOM identity and fallback point. */
async function findWxButton(page: Page, label: string): Promise<WxButtonTarget | null> {
    return page.evaluate((wanted: string) => {
        const registry = window.wxElementRegistry;
        if (!registry) return null;
        const el = registry.findAll({ visible: true })
            .find((e) => (e.label === wanted || e.label === `&${wanted}`)
                && (e.typeName ?? '').includes('Button'));
        // domId is present only for DOM-backed controls on lines that expose
        // it; this line's registry may omit it — the coordinate fallback in
        // clickWxButtonTarget is the supported path then.
        const domId = (el as { domId?: number } | undefined)?.domId;
        return el
            ? { x: el.centerX, y: el.centerY, domId: domId && domId > 0 ? domId : null }
            : null;
    }, label);
}

async function clickWxButtonTarget(page: Page, target: WxButtonTarget): Promise<void> {
    if (target.domId) {
        await page.locator(`[data-wx-dom-id="${target.domId}"]`).click();
        return;
    }

    await page.mouse.click(target.x, target.y);
}

/** Click a visible wx button by label; returns whether it was found. */
async function clickWxButton(page: Page, label: string): Promise<boolean> {
    const target = await findWxButton(page, label);
    if (!target) return false;
    await clickWxButtonTarget(page, target);
    return true;
}

async function openStepExportDialog(page: Page): Promise<void> {
    expect(await clickMenuBarItem(page, 'File'), 'File menu').toBe(true);
    await waitForMenuItems(page);
    await waitForRenderedByLabel(page, 'Export', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Export'), 'Export submenu').toBe(true);
    await waitForRenderedByLabel(page, 'STEP/GLB/BREP/XAO/PLY/STL...', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'STEP/GLB/BREP/XAO/PLY/STL...'),
        'STEP export menu item').toBe(true);
    await page.waitForFunction(() => {
        const registry = window.wxElementRegistry;
        return !!registry && registry.findAll({ visible: true })
            .some((el) => (el.label === 'Export' || el.label === '&Export')
                && (el.typeName ?? '').includes('Button'));
    }, null, { timeout: 20000 });
}

test.describe('OCC export via occ_service worker', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('export dialog produces a valid STEP; occ_service fetches lazily', async ({ page, testLogger }) => {
        // Track occ_service fetches from the very start — the lazy boundary is
        // the core assertion.
        const occFetches: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('occ_service')) occFetches.push(r.url());
        });

        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);
        await loadBoard(page, testLogger);
        // Board-loaded ≠ board-painted: once the export dialog's modal pump takes
        // over, the GAL may never repaint behind it — whichever paint state the
        // canvas had at menu-open time is what the dialog screenshots freeze.
        // Settle the pixels first so occ-export-{dialog,done}.png always capture
        // the painted board (this bistability flagged occ-export-done between two
        // identical-code CI runs).
        await settledShot(page.locator('#canvas'), expect);

        expect(occFetches, 'occ_service must NOT be fetched before the export').toHaveLength(0);

        // File → Export → STEP/GLB/… and the unchanged export dialog.
        await openStepExportDialog(page);
        await stableShot(page, 'occ-export-dialog.png');

        expect(await clickWxButton(page, 'Export'), 'Export button click').toBe(true);

        // The provider stub captures the bytes where the app would download.
        await page.waitForFunction(
            () => ((window as any).__occExports?.length ?? 0) > 0,
            null, { timeout: 180000 });

        const exports = await page.evaluate(() => (window as any).__occExports as Array<{
            name: string; size: number; magic: string;
        }>);
        console.log(`[TEST] captured exports: ${JSON.stringify(exports)}`);

        expect(exports).toHaveLength(1);
        expect(exports[0].name, 'download name comes from the dialog')
            .toMatch(/\.step$/i);
        expect(exports[0].magic.startsWith('ISO-10303-21'), 'STEP magic').toBe(true);
        expect(exports[0].size, 'non-trivial STEP body').toBeGreaterThan(10_000);

        expect(occFetches.length, 'occ_service was fetched lazily by the export')
            .toBeGreaterThan(0);

        // Dismiss the "Export complete" report dialog if present. Its appearance after
        // the worker returns has no distinct registry signal to poll — a short documented
        // dwell, then click OK if present.
        await page.waitForTimeout(1000); // eslint-disable-line -- documented interaction dwell
        await clickWxButton(page, 'OK');

        await stableShot(page, 'occ-export-done.png');
    });

    test('worker decode fault settles concurrent native wait and the next export recovers', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);
        await loadBoard(page, testLogger);
        // The exact open Promise and title/paint helper have completed. Keep a
        // byte-stable baseline before opening a nested submenu.
        await settledShot(page.locator('#canvas'), expect);
        await openStepExportDialog(page);

        const probeBoard = fs.readFileSync(
            path.resolve(__dirname, '..', 'fixtures', 'demo', 'demo.kicad_pcb'),
            'utf8',
        );

        // Start one direct service request before the dialog's native request.
        // Both wait on the same lazy worker boot, then both post without a host
        // mutex. The harness injects a messageerror only when both are in the
        // generation's pending map, and the real worker is then terminated.
        await page.evaluate((boardText: string) => {
            const runtime = globalThis as any;
            runtime.__occServiceTestHooks.messageErrorWhenPendingAtLeast(2);
            runtime.__occParallelResult = null;
            void runtime.occService.request({
                kind: 'export',
                board: new TextEncoder().encode(boardText),
                jobJson: JSON.stringify({ format: 'step', export_components: false }),
                fileName: 'parallel-probe.step',
            }).then((res: unknown) => { runtime.__occParallelResult = res; });
        }, probeBoard);

        expect(await clickWxButton(page, 'Export'), 'first native Export button click').toBe(true);

        await page.waitForFunction(
            () => (globalThis as any).__occParallelResult !== null,
            null,
            { timeout: 30000 },
        );
        const parallelResult = await page.evaluate(
            () => (globalThis as any).__occParallelResult as { ok: boolean; report?: string },
        );
        expect(parallelResult.ok, 'the parallel request must settle on generation failure').toBe(false);
        expect(parallelResult.report, 'the exact messageerror reason reaches the caller')
            .toContain('message decode failed');

        // The C++ Export() request was the second request in the same failed
        // generation. Its exact wx wait must close and show the native failure
        // dialog instead of leaving the export handler parked.
        await page.waitForFunction(() => {
            const registry = window.wxElementRegistry;
            if (!registry) return false;
            const dialogs = registry.findAll({ visible: true })
                .filter((el) => /Dialog/.test(el.typeName ?? ''));
            return dialogs.length >= 2;
        }, null, { timeout: 30000 });
        await expect.poll(
            () => page.evaluate(() => {
                const scheduler = (globalThis as any).__wxScheduler;
                return scheduler?.pendingWaits?.('occ') ?? -1;
            }),
            { message: 'the native OCC wait must be completed by fail-all', timeout: 10000 },
        ).toBe(0);

        const failed = await page.evaluate(() => {
            const runtime = globalThis as any;
            const rendered = runtime.wxElementRegistry?.findAllRendered?.({}) ?? [];
            return {
                labels: rendered.map((el: any) => el.label ?? el.text ?? '').filter(Boolean),
                service: runtime.__occServiceTestHooks.snapshot(),
            };
        });
        expect(failed.service.maxPending,
            'two requests must coexist in one generation; worker requests are not serialized')
            .toBeGreaterThanOrEqual(2);
        expect(failed.service.requestsStarted,
            'the direct probe and one native export must be the only provider entries').toBe(2);
        expect(failed.service.requestsPosted,
            'both failed-generation requests must reach the real worker transport').toBe(2);
        expect(failed.service.workerGenerationsStarted,
            'the two parallel requests must share one worker generation').toEqual([1]);
        expect(failed.service.pending, 'fail-all must drain the failed generation').toBe(0);
        expect(failed.service.retiredGenerations, 'generation 1 must be retired').toEqual([1]);
        expect(failed.service.activeGeneration, 'the failed slot must be cleared').toBeNull();
        expect(failed.service.armed, 'the one-shot fault must be consumed').toBe(false);
        console.log(`[TEST-OCC] native fault dialog labels: ${JSON.stringify(failed.labels)}`);

        // Resolve the parent action before dismissing the child, then reuse its
        // exact DOM identity. This prevents a label/geometry re-query from
        // turning the handback race into a click on some replacement control.
        const retryExport = await findWxButton(page, 'Export');
        expect(retryExport, 'the original parent Export button must remain registered').not.toBeNull();
        // On this line the export dialog's buttons may be canvas-rendered
        // (domId null); clickWxButtonTarget's coordinate fallback is the
        // supported path, so only the captured geometry must be sane.
        expect(retryExport!.x, 'the retry target has stable geometry').toBeGreaterThan(0);
        expect(retryExport!.y, 'the retry target has stable geometry').toBeGreaterThan(0);

        expect(await clickWxButton(page, 'OK'), 'dismiss native export failure').toBe(true);

        // page.mouse.click() completes when the browser has delivered the OK
        // input, not when the nested native modal has unwound.  The parent
        // export dialog is intentionally non-interactive until that exact
        // child lease closes.  Wait for the scheduler's observable modal
        // count to return from {export + failure} to {export} before clicking
        // through to the parent.
        await expect.poll(
            () => page.evaluate(() => {
                const scheduler = (globalThis as any).__wxScheduler;
                return scheduler?.pendingWaits?.('modal') ?? -1;
            }),
            { message: 'the failure child must retire before retrying its parent', timeout: 10000 },
        ).toBe(1);

        // The export dialog remains open. Its next request must create a fresh
        // generation and complete through the actual OCC module.
        if (!retryExport) throw new Error('parent Export button disappeared before retry');
        await clickWxButtonTarget(page, retryExport);
        await expect.poll(
            () => page.evaluate(() => (globalThis as any)
                .__occServiceTestHooks.snapshot().requestsStarted),
            {
                message: 'the exact parent retry must enter the OCC provider once',
                timeout: 10000,
            },
        ).toBe(failed.service.requestsStarted + 1);
        await expect.poll(
            () => page.evaluate(() => (globalThis as any)
                .__occServiceTestHooks.snapshot().activeGeneration),
            { message: 'the retry must boot a replacement worker generation', timeout: 30000 },
        ).toBe(2);
        await page.waitForFunction(
            () => ((window as any).__occExports?.length ?? 0) === 1,
            null,
            { timeout: 180000 },
        );

        const recovered = await page.evaluate(() => {
            const runtime = globalThis as any;
            return {
                exports: runtime.__occExports,
                service: runtime.__occServiceTestHooks.snapshot(),
                schedulerDead: runtime.__wxScheduler?.dead === true,
                occWaits: runtime.__wxScheduler?.pendingWaits?.('occ') ?? -1,
            };
        });
        expect(recovered.exports).toHaveLength(1);
        expect(recovered.exports[0].magic.startsWith('ISO-10303-21'), 'retry returns real STEP bytes')
            .toBe(true);
        expect(recovered.exports[0].size, 'retry returns a non-trivial STEP file')
            .toBeGreaterThan(10_000);
        expect(recovered.service.activeGeneration, 'retry must own a replacement generation').toBe(2);
        expect(recovered.service.requestsStarted,
            'the parent retry must add exactly one provider entry').toBe(3);
        expect(recovered.service.requestsPosted,
            'the parent retry must post exactly once to the replacement worker').toBe(3);
        expect(recovered.service.workerGenerationsStarted,
            'the retry must create exactly one replacement generation').toEqual([1, 2]);
        expect(recovered.service.pending, 'replacement generation must quiesce').toBe(0);
        expect(recovered.schedulerDead, 'the worker failure must not terminalize the editor').toBe(false);
        expect(recovered.occWaits, 'the replacement native OCC wait must quiesce').toBe(0);

        await page.waitForTimeout(1000); // eslint-disable-line -- documented interaction dwell
        await clickWxButton(page, 'OK');
    });
});
