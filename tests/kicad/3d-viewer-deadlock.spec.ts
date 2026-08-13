import { test, expect } from './fixtures';
import { clickByTooltip, clickToolbarTool, shotPath } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { countGlCanvases, loadBoard, logThreeDDiag, openThreeDViewer } from './utils/threed-viewer';

/**
 * Regression for the camera-move-on-canvas raytrace DEADLOCK.
 *
 * Since the 3D-webgl port the wasm viewer DEFAULTS to the real OpenGL renderer, which never
 * had this deadlock — so this spec explicitly flips the viewer to the raytracer engine (its
 * toolbar toggle) before driving it; the raytracer remains user-reachable via that same
 * toggle, so the regression it guards is still live product surface.
 *
 * The 3D viewer's EDA_3D_CANVAS is a wxGLCanvas whose paint (on the raytracer engine) runs
 * the multi-threaded CPU raytracer. Moving the camera makes the raytracer spawn raw std::thread workers; with no
 * PROXY_TO_PTHREAD its join runs on the browser main thread, and KiCad's own thread pool has
 * already drained emscripten's pre-warmed Worker pool — so those threads fall back to on-demand
 * `new Worker()`, whose boot handshake needs the main thread back in the JS event loop, which it
 * can't reach while blocked in the render's busy-wait join. That circular wait is the freeze the
 * user hit ("move the model → tab freezes"). The fix pre-warms PTHREAD_POOL_SIZE =
 * hardwareConcurrency*2+8 for 3D-viewer builds (scripts/kicad/build-kicad-target.sh) so on-demand
 * creation never happens; a wxwidgets wasm-layer change (src/wasm/app.cpp) additionally defers the
 * 3D viewer's synchronous mouse-button Paint to the yielding pump (jank + defense, mirroring the
 * resize-deadlock fix).
 *
 * Drives the REAL viewer with two camera-rotate drags (mirroring "move the model … move it
 * again"), each followed by a settle for the raytrace to converge, asserting after every step that
 * (a) the wasm main thread stays responsive (a deadlock hangs it) and (b) nothing aborted. Pre-fix
 * a camera drag freezes or aborts; post-fix both stay live and the board keeps rendering. Frame
 * drag/resize of the viewer are covered by 3d-viewer.spec.ts.
 *
 * ISOLATED in its own spec file (own Playwright worker → own browser process → a SINGLE heavy
 * pcbnew load). The pre-warmed pool is ~2x hardwareConcurrency Workers PER load; running several
 * 3D-viewer loads in one process (a serial describe) accumulates enough Workers that a later
 * load's pool is short and the raytracer deadlocks anyway — so this test must not share a worker
 * with the other 3D-viewer tests.
 *
 * Notes: the glcanvas client area is pointer-events:none, so a page.mouse drag over it falls
 * through to the main #canvas whose Emscripten mousedown/up callback dispatches into
 * wxApp::HandleMouseEvent — the deadlock path. WebGL pixels are read via drawImage→2D→getImageData
 * (preserveDrawingBuffer=true), since a CDP screenshot of a WebGL canvas is blank on swiftshader.
 */
test.describe('3D viewer camera-move deadlock', () => {
    // CI-skip: this test asserts the wasm main thread stays responsive within ~15s DURING a
    // raytrace. That premise only holds on a real GPU (fast render); on CI's software WebGL
    // (headless SwiftShader, GPU-less contended VM) a legitimately-slow raytrace is
    // indistinguishable from a deadlock, so the test can't run meaningfully there. The
    // pthread-Worker-boot deadlock MECHANISM it guards is already covered on CI by the
    // standalone wx harnesses (coroutine-pthread-ondemand, raytrace-threads). Runs locally
    // on a real GPU.
    test.skip(!!process.env.CI, 'raytracer liveness assertions require a real GPU; deadlock '
        + 'mechanism is covered on CI by the standalone coroutine-pthread-ondemand/raytrace-threads harnesses');
    // KNOWN ISSUE (2026-07-04, webgl-era wasm build): the "Use raytracing" toolbar toggle is
    // INERT — the click lands and a scene reload fires ("Reload time" status updates), but the
    // canvas pixels never change (sampled for 20s; this spec's engine-engagement guard below
    // caught it). Suspects: EDA_3D_CANVAS::DoRePaint's silent catch(runtime_error) freezing
    // the canvas after a raytracer Redraw throw, or the engine toggle writing
    // m_boardAdapter.m_Cfg while RenderEngineChanged() reads GetAppSettings<…>() — possibly
    // different instances in the merged kicad_editor bundle. Unskip once the toggle works:
    // the engagement guard below then validates the engine flip loudly.
    test.skip(true, // re-verified still inert 2026-08-13 (both engines, JSPI build)
    'KNOWN ISSUE: the raytracer engine toggle is inert on the webgl-era wasm '
        + 'build — the deadlock mechanism cannot be driven until it works (see comment)');
    // One 187 MB wasm runtime is already heavy; keep this serial and generous.
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('camera-move drag on the 3D canvas does not deadlock the raytracer (regression)',
        async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        const winsBefore = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id));
        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);

        const winId = await page.evaluate((before: string[]) => {
            const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id);
            return all.find((id) => !before.includes(id)) ?? all[all.length - 1] ?? null;
        }, winsBefore);
        expect(winId, 'the 3D viewer should open a new top-level window').toBeTruthy();

        // Let the INITIAL render settle through the safe per-frame pump (Workers boot here).
        await page.waitForTimeout(5000);  // eslint-disable-line -- skipped known-issue spec (never runs)
        await logThreeDDiag(page, 'deadlock: after open+settle');

        // Read the newest glcanvas-* (the 3D viewer) client rect in viewport coords.
        const canvasRect = () => page.evaluate(() => {
            const list = document.querySelectorAll('canvas[id^="glcanvas-"]');
            const el = list[list.length - 1] as HTMLCanvasElement;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });

        // Sample the viewer canvas backing store: distinct colours (board rendered?) plus a
        // coarse pixel signature (did the render change after the camera moved?).
        const sampleCanvas = () => page.evaluate(() => {
            const list = document.querySelectorAll('canvas[id^="glcanvas-"]');
            const el = list[list.length - 1] as HTMLCanvasElement;
            const tmp = document.createElement('canvas');
            tmp.width = el.width; tmp.height = el.height;
            // One full-frame read on a CPU-backed canvas, then sample in JS. This sampler is
            // POLLED every 1.5s during an active raytrace (settleRender) — as 256 per-pixel
            // getImageData GPU round-trips per poll it was the worst "GPU stall due to
            // ReadPixels" offender on software WebGL (see 3d-viewer.spec.ts).
            const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(el, 0, 0);
            const img = ctx.getImageData(0, 0, el.width, el.height).data;
            const colors = new Set<string>();
            let sig = '';
            for (let i = 0; i < 16; i++) {
                for (let j = 0; j < 16; j++) {
                    const p = (Math.floor(el.height * j / 16) * el.width
                             + Math.floor(el.width * i / 16)) * 4;
                    colors.add(`${img[p]},${img[p + 1]},${img[p + 2]}`);
                    sig += `${img[p]}.${img[p + 1]}.${img[p + 2]}|`;
                }
            }
            return { distinctColors: colors.size, sig };
        });

        // Main-thread liveness probe. A pthread-join deadlock hangs the wasm main thread → the
        // browser main JS thread is blocked → in-page polling can't run → this times out.
        // Returns false on a freeze rather than throwing.
        const mainThreadAlive = () => page.waitForFunction(() => {
            const r = (window as unknown as { wxElementRegistry?: { findAll: (o: unknown) => unknown[] } })
                .wxElementRegistry;
            return !!r && r.findAll({ visible: true }).length > 0;
        }, null, { timeout: 15000 }).then(() => true).catch(() => false);

        const abortLines = () => [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
            l.includes('Aborted(')
            || l.toLowerCase().includes('invalid state')
            || l.toLowerCase().includes('uncaught exception: unwind')
            || l.toLowerCase().includes('indirect call to null'));

        // Run an interaction with a hard wall-clock bound: a hard freeze can also hang the CDP
        // input dispatch, so this fails fast instead of at the 240s test timeout.
        const bounded = async (fn: () => Promise<void>, ms: number): Promise<boolean> => {
            let froze = false;
            await Promise.race([
                fn().catch(() => { /* an in-wasm abort surfaces via abortLines(), not here */ }),
                new Promise<void>((r) => setTimeout(() => { froze = true; r(); }, ms)),
            ]);
            return froze;
        };

        // Rotate the camera: left-drag inside the GL region (below the ~28px titlebar).
        const rotate = async () => {
            const c = await canvasRect();
            const cx = c.x + c.w / 2;
            const cy = c.y + c.h / 2 + 40;
            await page.mouse.move(cx, cy);
            await page.mouse.down();
            await page.mouse.move(cx + 140, cy + 70, { steps: 14 });
            await page.mouse.move(cx - 90, cy + 20, { steps: 10 });
            await page.mouse.up();
        };
        // Wait for the raytrace kicked by a camera move to CONVERGE (canvas signature stable
        // across two samples) before the next move, so successive renders don't overlap and
        // momentarily demand more pthread Workers than the pool holds. On the fixed build this
        // returns in a few polls; a mid-render deadlock is caught by the assertLive that follows.
        const settleRender = async (maxMs: number) => {
            let prev = '';
            const start = Date.now();
            while (Date.now() - start < maxMs) {
                await page.waitForTimeout(1500);  // eslint-disable-line -- skipped known-issue spec (never runs)
                const s = (await sampleCanvas()).sig;
                if (s === prev) return;
                prev = s;
            }
        };

        // After each step: nothing aborted, main thread still live.
        const assertLive = async (step: string) => {
            expect(abortLines(), `raytrace aborted during "${step}":\n${abortLines().join('\n\n')}`)
                .toEqual([]);
            expect(await mainThreadAlive(),
                `wasm main thread unresponsive after "${step}" → deadlock`).toBe(true);
        };

        // Since the 3D-webgl port (kicad eb13ff3bdc) the wasm viewer defaults to the REAL
        // OpenGL renderer; the deadlock mechanism this spec guards is raytracer-specific, so
        // flip the viewer to the raytracer via its toolbar toggle. Loud failure if the
        // toggle moved — a silent no-op would leave the fast GL renderer making every
        // liveness assertion below vacuously green.
        const sigOnGl = (await sampleCanvas()).sig;
        const toggled = (await clickToolbarTool(page, 'Use raytracing'))
            || (await clickByTooltip(page, 'Render current view using Raytracing'));
        expect(toggled, 'the "Use raytracing" toolbar toggle must exist in the 3D viewer').toBe(true);

        // Engine cross-check (guards the same false green): with NO input between the two
        // samples, only an engine change repaints the canvas differently — the raytraced
        // frame is lit/shadowed differently from the GL frame it replaces, a GL re-render
        // reproduces the identical pixels, and a no-op leaves the canvas untouched. (Heap
        // growth is NOT a usable signal here: mimalloc satisfies the raytracer's buffers
        // from already-freed arena pages, so HEAPU8.length stays flat.)
        let raytracerEngaged = false;
        for (let i = 0; i < 20 && !raytracerEngaged; i++) {
            await page.waitForTimeout(1000);  // eslint-disable-line -- skipped known-issue spec (never runs)
            raytracerEngaged = (await sampleCanvas()).sig !== sigOnGl;
        }
        expect(raytracerEngaged,
            'the canvas did not change after the engine toggle — the raytracer did not engage')
            .toBe(true);
        // Let the first full raytrace converge before taking the interaction baseline.
        await settleRender(25000);

        const before = await sampleCanvas();
        console.log(`[TEST] 3D render before interaction: ${before.distinctColors} distinct colours`);

        // THE deadlock path: a left-drag on the 3D canvas rotates the model; the terminating
        // mouse button events drive wxApp::HandleMouseEvent's synchronous Paint() of the
        // wxGLCanvas, running the multi-threaded CPU raytracer. Pre-fix its on-demand pthread
        // Worker boot deadlocks the main thread; post-fix the pre-warmed pool covers it and each
        // move stays live. Two moves with a settle between mirror the user's "move the model …
        // move it again".
        let froze = await bounded(rotate, 30000);
        expect(froze, 'the first camera-rotate drag froze the wasm main thread (deadlock)').toBe(false);
        await assertLive('camera rotate');
        await settleRender(25000);
        await assertLive('camera rotate settle');

        // Validity: the render changed → the synthetic mouse actually reached the 3D canvas
        // (guards against a false green where the drag missed the canvas entirely).
        const mid = await sampleCanvas();
        expect(mid.sig,
            'the 3D render did not change after the first camera move — the synthetic mouse '
            + 'likely never reached the 3D canvas (invalid repro), or the render stalled')
            .not.toBe(before.sig);

        froze = await bounded(rotate, 30000);
        expect(froze, 'the second camera-rotate drag froze the main thread').toBe(false);
        await assertLive('camera rotate again');
        await settleRender(25000);
        await assertLive('camera rotate again settle');

        await page.screenshot({ path: shotPath(page, '3d-viewer-deadlock.png'), scale: 'device' });

        // Sanity: the board still renders (not blank / crashed) after both moves.
        await logThreeDDiag(page, 'deadlock: after moves');
        const after = await sampleCanvas();
        console.log(`[TEST] 3D render after interaction: ${after.distinctColors} distinct colours`);
        expect(after.distinctColors,
            'the 3D viewer should still render the board (many colours) after the camera moves')
            .toBeGreaterThan(8);
    });
});
