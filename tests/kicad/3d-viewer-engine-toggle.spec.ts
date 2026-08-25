import { test, expect } from './fixtures';
import { clickByTooltip, clickToolbarTool, shotPath } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { DEMO, countGlCanvases, loadBoard, logThreeDDiag, openThreeDViewer, waitForThreeDRender }
    from './utils/threed-viewer';

/**
 * Engine round-trip smoke: OpenGL → raytracing → OpenGL must render and stay
 * console-clean.
 *
 * The user-visible regression: after the round-trip the viewer showed only the
 * background gradient, with `[gl1] WebGL context changed` firing mid-session and
 * INVALID_OPERATION storms on BOTH WebGL contexts. Root cause: the wasm/gl1 shim's
 * FFP draw routing keyed on a single process-global client-array flag — an
 * interrupted fixed-function window (MODEL_3D::BeginDrawMulti) left it set, after
 * which the raytracer blit's and the 2D GAL's glDrawArrays were routed through the
 * FFP pipeline, scribbling their own VAOs (the persistent blank). Fixed by
 * owner-context routing gates + VAO isolation in the shim, client-state teardown in
 * contextSync, and client-array disables in the blit preamble; the deterministic
 * mechanism-level reproductions live in tests/e2e/3d-webgl.spec.ts (T1-T3).
 *
 * This spec drives the REAL viewer round-trip. The exact race needs interaction
 * timing no harness forces reliably, so this is the happy-path gate: with the fixes
 * the round-trip must ALWAYS render and never emit a context-change or
 * INVALID_OPERATION line.
 *
 * CI-skip mirrors 3d-viewer-deadlock.spec.ts: the raytrace pass must converge in
 * seconds, which needs a real GPU-adjacent machine, not CI's contended software GL.
 * ISOLATED in its own spec file (own worker) like the other heavy 3D specs.
 */
test.describe('3D viewer engine toggle', () => {
    test.skip(!!process.env.CI, 'raytrace-convergence timing needs a real GPU; the '
        + 'mechanism-level coverage runs everywhere in e2e/3d-webgl.spec.ts');

    test.describe.configure({ mode: 'serial' });
    test.setTimeout(480000);

    test('raytracing round-trip re-renders and stays console-clean', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);
        await waitForThreeDRender(page);
        await logThreeDDiag(page, 'engine-toggle: first OpenGL render');

        // Content snapshot of the newest glcanvas: sampled colour count + hash.
        const snap = () => page.evaluate(() => {
            const list = document.querySelectorAll('canvas[id^="glcanvas-"]');
            const el = list[list.length - 1] as HTMLCanvasElement;
            const tmp = document.createElement('canvas');
            tmp.width = el.width; tmp.height = el.height;
            const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(el, 0, 0);
            const img = ctx.getImageData(0, 0, el.width, el.height).data;
            const colors = new Set<string>();
            let hash = 0;
            for (let i = 0; i < 24; i++) {
                for (let j = 0; j < 24; j++) {
                    const p = (Math.floor(el.height * j / 24) * el.width
                             + Math.floor(el.width * i / 24)) * 4;
                    colors.add(`${img[p]},${img[p + 1]},${img[p + 2]}`);
                    hash = (hash * 31 + img[p] + img[p + 1] * 7 + img[p + 2] * 13) | 0;
                }
            }
            return { colors: colors.size, hash };
        });

        const before = await snap();
        console.log(`[TEST] OpenGL frame: ${JSON.stringify(before)}`);

        // ── Toggle to raytracing. KNOWN ISSUE (3d-viewer-deadlock.spec.ts, 2026-07-04,
        //    re-verified 2026-08-13): the raytraced image never displays on the wasm
        //    build — but the ENGINE does switch and the reload machinery does run, and
        //    that switch-back reload (display-list re-record with the GL context lock
        //    released) is exactly the poisoning path this spec guards. So no
        //    blitted-frame expectation here; the round-trip itself is the test. ──
        const toggled = (await clickToolbarTool(page, 'Use raytracing'))
            || (await clickByTooltip(page, 'Render current view using Raytracing'));
        expect(toggled, 'the raytracer toolbar toggle should be clickable').toBe(true);

        // Give the raytracer engine a bounded window to run repaints: poll the canvas
        // until two consecutive samples agree (content is allowed to stay identical —
        // the known-issue inert blit — or to change and settle).
        let rtSettle = await snap();
        await expect.poll(async () => {
            const next = await snap();
            const stable = next.hash === rtSettle.hash;
            rtSettle = next;
            return stable;
        }, { timeout: 60000, intervals: [2000] }).toBe(true);
        await logThreeDDiag(page, 'engine-toggle: raytracer engine window elapsed');
        await page.screenshot({ path: shotPath(page, `3d-engine-toggle-rt-${DEMO.name}.png`),
                                scale: 'css' });

        // ── Toggle back to the OpenGL engine. ──
        const toggledBack = (await clickToolbarTool(page, 'Use raytracing'))
            || (await clickByTooltip(page, 'Render current view using Raytracing'));
        expect(toggledBack, 'the raytracer toggle should toggle back').toBe(true);

        // THE regression assertion: the OpenGL engine must render the board again.
        await expect.poll(async () => (await snap()).colors, {
            message: 'the OpenGL engine must re-render the board after the round-trip '
                   + '(a near-uniform canvas means FFP draws were misrouted/corrupted)',
            timeout: 90000,
            intervals: [1000],
        }).toBeGreaterThan(8);
        await page.screenshot({ path: shotPath(page, `3d-engine-toggle-back-${DEMO.name}.png`),
                                scale: 'css' });

        // ── Console gates. ──
        const allLines = [...testLogger.consoleLogs, ...testLogger.errors];
        const ctxChanges = allLines.filter((l) => l.includes('[gl1] WebGL context changed'));
        expect(ctxChanges,
            'the gl1 context guard must never fire during an engine toggle '
            + '(the context does not change) — firing means draws ran under a foreign context')
            .toEqual([]);
        const glErrors = allLines.filter((l) => l.includes('INVALID_OPERATION'));
        expect(glErrors,
            `no INVALID_OPERATION storms during the round-trip:\n${glErrors.slice(0, 5).join('\n')}`)
            .toEqual([]);
        const aborts = allLines.filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted during the engine toggle:\n${aborts.join('\n\n')}`).toEqual([]);
    });
});
