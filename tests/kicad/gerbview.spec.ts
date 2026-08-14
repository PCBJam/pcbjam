import { test, expect } from './fixtures';
import { waitForEditorReady, stableShot } from '../e2e/utils/element-tracker';

/**
 * Gerber Viewer (gerbview) WASM E2E Tests
 *
 * gerbview is its own standalone kiface (FRAME_GERBER), launched via single_top
 * like pcbnew/pl_editor. gerbview.html seeds a default KiCad config in preRun, so
 * the shared first-run setup wizard never opens — the viewer comes straight up.
 * Scope is launch-only: the viewer must start, paint a canvas + toolbars (incl. the
 * layers manager), populate the element registry, and produce no WASM abort.
 * Loading actual Gerber files is out of scope here.
 *
 * Determinism: no waitForTimeout, no wizard click-through loop, screenshots via
 * stableShot (stabilizes before comparing).
 *
 * The embind file-open surface (wasm/bindings/gerbview_embind.cpp) IS in scope:
 * the project page deep-links a gerber here, and the shell opens the whole
 * fabrication set through `kicadOpenFiles`.
 */

/** Minimal valid RS-274X gerber drawing one trace, so a layer really loads. */
function gerber(xEndMm: number): string {
    return [
        '%FSLAX46Y46*%',
        '%MOMM*%',
        '%ADD10C,0.200000*%',
        'D10*',
        'X10000000Y10000000D02*',
        `X${xEndMm * 1_000_000}Y10000000D01*`,
        'M02*',
        '',
    ].join('\n');
}

/** Minimal Excellon drill file — GerbView routes .drl to its own loader. */
const DRILL = ['M48', 'FMAT,2', 'METRIC', 'T1C0.800', '%', 'G90', 'G05', 'T1',
    'X20.0Y20.0', 'T0', 'M30', ''].join('\n');

function hasAbort(testLogger: { consoleLogs: string[]; errors: string[] }): boolean {
    return [...testLogger.consoleLogs, ...testLogger.errors].some(line => line.includes('Aborted('));
}

test.describe('gerbview WASM', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/gerbview.html');
    });

    test('app loads, canvas visible, no WASM abort', async ({ page, testLogger }) => {
        await waitForEditorReady(page);
        await stableShot(page, 'gerbview-01-loaded.png');

        expect(hasAbort(testLogger), 'no WASM abort during load').toBe(false);

        const canvasCount = await page.locator('canvas').count();
        expect(canvasCount).toBeGreaterThan(0);
    });

    test('canvas + toolbar metrics look sane', async ({ page, testLogger }) => {
        await waitForEditorReady(page);

        const metrics = await page.evaluate(() => {
            const registry = window.wxElementRegistry!;
            const all = registry.findAll({ visible: true });
            const toolbars = all.filter((el) => /ToolBar/.test(el.typeName));
            const glCanvas = document.querySelector('canvas[id^="glcanvas-"]') as HTMLCanvasElement | null;

            return {
                registryTotal: all.length,
                toolbarCount: toolbars.length,
                mainCanvasOk: (() => {
                    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
                    return !!c && c.width > 0 && c.height > 0;
                })(),
                glCanvasOk: !!glCanvas && glCanvas.width > 0 && glCanvas.height > 0,
            };
        });

        await stableShot(page, 'gerbview-02-metrics.png');

        expect(metrics.registryTotal, 'registry should be populated').toBeGreaterThan(10);
        expect(metrics.toolbarCount, 'at least one toolbar should be visible').toBeGreaterThanOrEqual(1);
        expect(metrics.mainCanvasOk, 'main canvas has nonzero dimensions').toBe(true);
        expect(metrics.glCanvasOk, 'GL canvas has nonzero dimensions').toBe(true);
        expect(hasAbort(testLogger)).toBe(false);
    });

    /**
     * kicadOpenFiles: the whole-set entry the project page's gerber links use.
     * A fabrication set is a stack, so opening one layer alone is not the job —
     * this asserts a multi-file open lands every layer (and the drill file) in
     * one call, which is what GERBVIEW_FRAME::OpenProjectFiles gives us.
     */
    test('kicadOpenFiles opens a whole fabrication set in one call', async ({ page, testLogger }) => {
        await waitForEditorReady(page);

        const opened = await page.evaluate(({ gerbers, drill }) => {
            const w = window as unknown as {
                FS: { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
                Module: { kicadOpenFiles?: (json: string) => boolean };
            };
            const dir = '/home/kicad/documents/fab';
            w.FS.mkdirTree(dir);
            const paths: string[] = [];
            for (const [name, content] of Object.entries(gerbers)) {
                const p = `${dir}/${name}`;
                w.FS.writeFile(p, content as string);
                paths.push(p);
            }
            const drillPath = `${dir}/board-PTH.drl`;
            w.FS.writeFile(drillPath, drill);
            paths.push(drillPath);
            const registryBefore = window.wxElementRegistry!.findAll({ visible: true }).length;
            if (typeof w.Module.kicadOpenFiles !== 'function') return { hook: false, registryBefore };
            w.Module.kicadOpenFiles(JSON.stringify(paths));
            return { hook: true, registryBefore };
        }, {
            gerbers: {
                'board-F_Cu.gbr': gerber(30),
                'board-B_Cu.gbr': gerber(40),
                'board-Edge_Cuts.gbr': gerber(50),
            },
            drill: DRILL,
        });

        expect(opened.hook, 'gerbview exposes kicadOpenFiles (gerbview_embind.cpp)').toBe(true);
        // NOT the return value: OpenProjectFiles suspends via JSPI, so the
        // embind call hands back a Promise long before the load finishes
        // (same reason open-flow.ts ignores kicadOpenFile's return).
        // The truthful completion signal is the open-gate probe.
        await expect.poll(
            async () => page.evaluate(() => {
                const w = window as unknown as { Module: { kicadOpenFileBusy?: () => boolean } };
                return w.Module.kicadOpenFileBusy?.() ?? true;
            }),
            { timeout: 30000, intervals: [250] },
        ).toBe(false);

        // Each file became its own draw layer, so the UI gained rows/entries.
        expect(
            await page.evaluate(() => window.wxElementRegistry!.findAll({ visible: true }).length),
            'the layers UI grew once the set loaded',
        ).toBeGreaterThan(opened.registryBefore);

        expect(hasAbort(testLogger), 'no WASM abort during the multi-file open').toBe(false);
    });
});
