import { test, expect } from './fixtures';
import { shotPath } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { DEMO, loadBoard, countGlCanvases, logThreeDDiag, openThreeDViewer, waitForThreeDRender }
    from './utils/threed-viewer';

/**
 * 3D viewer e2e: load a real board in pcbnew, open the native 3D viewer
 * (View → 3D Viewer / Alt+3), and verify a second top-level frame with its own
 * WebGL canvas appears and renders the board.
 *
 * The 3D viewer (EDA_3D_VIEWER_FRAME) is a separate modeless KIWAY_PLAYER frame.
 * In the wasm DOM port that surfaces as a new `#window-1` div in
 * `#window-container` plus a dedicated `<canvas id="glcanvas-N">` (the main
 * pcbnew board view is itself a wxGLCanvas, so we detect the viewer by the
 * GL-canvas COUNT increasing, not by mere presence).
 *
 * Enabled by the WASM 3D-viewer build (BUILD_3D_VIEWER=ON →
 * KICAD_BUILD_3D_VIEWER_WASM). With the bare board (no component STEP/WRL
 * models — deferred), the viewer shows copper/silk/mask/edge geometry in 3D.
 */

test.describe('3D viewer from pcbnew', () => {
    // One 187 MB wasm runtime is already heavy; keep this serial and generous.
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('opens the 3D viewer over a loaded board and renders it', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);

        await loadBoard(page, testLogger);
        await page.screenshot({ path: shotPath(page, `3d-viewer-00-board-loaded.png`), scale: 'css' });

        const glBefore = await countGlCanvases(page);
        console.log(`[TEST] glcanvas count before opening 3D viewer: ${glBefore}`);

        await openThreeDViewer(page, glBefore);

        // Gate on the scene actually being ON the canvas, not a fixed sleep: the first frame
        // can lag the canvas creation (CI software WebGL under parallel load), and sampling
        // too early reads an all-black backbuffer — main's live 3D flake (see
        // waitForThreeDRender).
        await waitForThreeDRender(page);

        await page.screenshot({ path: shotPath(page, `3d-viewer-${DEMO.name}.png`), scale: 'css' });

        // Read the 3D viewer canvas (the newest glcanvas) directly from its backing
        // store: copy it onto a 2D canvas with drawImage and sample pixels. This is
        // reliable thanks to preserveDrawingBuffer=true, whereas Playwright's CDP
        // screenshot of a WebGL canvas on swiftshader comes back blank. We save the
        // copy as a PNG (the real visual artifact) and assert the board rendered by
        // checking the canvas is not a single uniform colour.
        const render = await page.evaluate(() => {
            const list = document.querySelectorAll('canvas[id^="glcanvas-"]');
            const el = list[list.length - 1] as HTMLCanvasElement;
            const tmp = document.createElement('canvas');
            tmp.width = el.width;
            tmp.height = el.height;
            // willReadFrequently → CPU-backed 2D canvas: drawImage is the single GPU readback;
            // the sampling below never touches the GPU process again. (The previous 16×16 loop
            // of 1×1 getImageData calls = 256 GPU syncs per sample — the "GPU stall due to
            // ReadPixels" storm that got SwiftShader's GPU process watchdog-killed on CI.)
            const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(el, 0, 0);
            const img = ctx.getImageData(0, 0, el.width, el.height).data;

            const colors = new Set<string>();
            for (let i = 0; i < 16; i++) {
                for (let j = 0; j < 16; j++) {
                    const p = (Math.floor(el.height * j / 16) * el.width
                             + Math.floor(el.width * i / 16)) * 4;
                    colors.add(`${img[p]},${img[p + 1]},${img[p + 2]}`);
                }
            }
            return { id: el.id, w: el.width, h: el.height, distinctColors: colors.size,
                     dataUrl: tmp.toDataURL('image/png') };
        });
        console.log(`[TEST] 3D canvas ${render.id} ${render.w}x${render.h}, distinct colours: ${render.distinctColors}`);

        const b64 = render.dataUrl.replace(/^data:image\/png;base64,/, '');
        require('fs').writeFileSync(shotPath(page, `3d-viewer-${DEMO.name}-render.png`),
                                    Buffer.from(b64, 'base64'));

        // A blank/uniform canvas yields ~1 colour; the rendered board has many.
        expect(render.distinctColors,
            'the 3D viewer canvas should render the board (many colours), not a blank fill')
            .toBeGreaterThan(8);

        // ── Console-clean gates (same signatures load-pcb.spec.ts guards). ──
        const allLines = [...testLogger.consoleLogs, ...testLogger.errors];
        const aborts = allLines.filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted while opening the 3D viewer:\n${aborts.join('\n\n')}`).toEqual([]);

        const wasmTrapSignatures = [
            'index out of bounds', 'indirect call to null', 'uncaught exception: unwind',
            'invalid state', 'is not a function',
        ];
        const wasmTrapErrors = allLines.filter((l) =>
            wasmTrapSignatures.some((sig) => l.toLowerCase().includes(sig)));
        expect(wasmTrapErrors,
            `wasm trap surfaced opening the 3D viewer:\n${wasmTrapErrors.join('\n\n')}`)
            .toEqual([]);

        // The 3D viewer stub logs this when the real viewer is NOT compiled in —
        // its presence means BUILD_3D_VIEWER=ON didn't take effect.
        const stubbed = allLines.filter((l) => l.includes('3D Viewer is not available'));
        expect(stubbed,
            `3D viewer is still stubbed (build not enabled?):\n${stubbed.join('\n')}`).toEqual([]);
    });

    /**
     * Regression for the "two canvases over each other" bug.
     *
     * The wasm DOM port draws each window's chrome onto 2D canvases and reveals a
     * wxGLCanvas through it. The CPU raytracer rendered the board correctly into the
     * 3D viewer's own `glcanvas-*`, but on screen the user saw grey: the 3D viewer is
     * a SECONDARY top-level frame, and when it is shown wx.js `raiseWindow()` lifts its
     * opaque `#window-N` chrome div to z-index 101 (= the main GAL canvas's 100, + 1).
     * Every `glcanvas-*` was hard-coded to z-index 100, so the frame's own window
     * background painted OVER the GL canvas behind it — two canvases stacked, the
     * opaque one on top. (The main editor escapes this because its window keeps
     * `#canvas` transparent over the GAL region; a secondary frame's region is opaque.)
     *
     * The fix (wx.js `createGLCanvas`): a GL canvas created while another GL canvas is
     * already visible belongs to a secondary window → lift it to z-index 2147483647 so
     * it stacks above the chrome.
     *
     * This asserts the stacking straight from the DOM/computed-style — no pixels or
     * screenshots — so it is independent of the slow raytrace and CI-safe on swiftshader
     * (where WebGL-canvas screenshots come back blank). Note `glcanvas-*`, `#window-N`
     * and `.window-canvas` all have `pointer-events:none`, so `elementsFromPoint` can't
     * see them; computed z-index is the right tool.
     *
     * Before the fix: every `glcanvas-*` is z-index 100, so the viewer canvas is not
     * strictly above the main GAL canvas (100 > 100 is false) → FAILS.
     * After the fix: the viewer canvas is 2147483647 → PASSES.
     */
    test('reveals the 3D viewer GL canvas above the window chrome (regression: occluded board)',
        async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);

        await loadBoard(page, testLogger);

        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);

        // The z-index is assigned synchronously when the canvas is created, but wait
        // until the newest glcanvas is actually on-screen (setGLCanvasRect ran →
        // display:block, non-zero box) so its secondary frame's window-N div has been
        // raised by raiseWindow() and the DOM stacking has settled.
        await page.waitForFunction((before: number) => {
            const list = document.querySelectorAll<HTMLCanvasElement>('canvas[id^="glcanvas-"]');
            if (list.length <= before) return false;
            const viewer = list[list.length - 1];
            return getComputedStyle(viewer).display !== 'none'
                && viewer.getBoundingClientRect().width > 0;
        }, glBefore, { timeout: 60000 });

        // Stacking order inside #window-container (a single z-index:1 stacking context).
        // The 3D viewer canvas is the newest glcanvas-*; it must out-stack every other
        // GL canvas and every secondary window-N chrome div, or the opaque chrome occludes it.
        const stacking = await page.evaluate(() => {
            const z = (el: Element) => parseInt(getComputedStyle(el).zIndex, 10) || 0;
            const gls = Array.from(document.querySelectorAll('#window-container canvas[id^="glcanvas-"]'));
            const windows = Array.from(document.querySelectorAll('#window-container [id^="window-"]'));
            const viewer = gls[gls.length - 1];
            return {
                glCount: gls.length,
                viewerId: viewer ? viewer.id : null,
                viewerZ: viewer ? z(viewer) : 0,
                maxOtherGlZ: Math.max(0, ...gls.slice(0, -1).map(z)),
                maxWindowZ: Math.max(0, ...windows.map(z)),
                glZ: gls.map((c) => ({ id: c.id, z: z(c) })),
                windowZ: windows.map((w) => ({ id: w.id, z: z(w) })),
            };
        });
        console.log(`[TEST] stacking: ${JSON.stringify(stacking)}`);

        // Precondition: the viewer actually opened (main GAL canvas + viewer canvas).
        expect(stacking.glCount,
            'the 3D viewer should add a second WebGL canvas').toBeGreaterThanOrEqual(2);

        // THE regression assertion. Pre-fix every glcanvas-* shares z-index 100, so the
        // viewer canvas is not strictly above the main GAL canvas and the chrome occludes it.
        expect(stacking.viewerZ,
            `3D viewer canvas ${stacking.viewerId} (z=${stacking.viewerZ}) must stack strictly above `
            + `the other GL canvases (max z=${stacking.maxOtherGlZ}); an equal z-index means the `
            + `window chrome can occlude it. all=${JSON.stringify(stacking.glZ)}`)
            .toBeGreaterThan(stacking.maxOtherGlZ);

        // The user-visible symptom: the GL canvas must paint at or above every secondary
        // window's opaque 2D chrome. (>= not > to tolerate a window clamped to the same
        // 2147483647 CSS z-index ceiling by raiseWindow.)
        expect(stacking.viewerZ,
            `3D viewer canvas (z=${stacking.viewerZ}) must not sit below any window chrome `
            + `(max window z=${stacking.maxWindowZ}). windows=${JSON.stringify(stacking.windowZ)}`)
            .toBeGreaterThanOrEqual(stacking.maxWindowZ);

        // Sanity: opening the viewer didn't blow up the runtime.
        const aborts = [...testLogger.consoleLogs, ...testLogger.errors]
            .filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted while opening the 3D viewer:\n${aborts.join('\n\n')}`).toEqual([]);
    });

    /**
     * Regression gate for "the 3D viewer can't be dragged / can't be X-closed".
     *
     * The viewer is a non-main wxFrame; it now gets a real DOM `.window-titlebar`
     * (drag + `.window-titlebar-close`) instead of a canvas-painted, pointer-
     * events:none bar whose clicks an overlapping main-frame DOM control stole.
     * This drives the REAL viewer: it must have a DOM title bar, that bar must be
     * the top hit-test element at its own location (even with the main editor's
     * pointer-events:auto controls present), dragging it must move the frame, and
     * the × must close it.
     */
    test('real 3D viewer has a draggable, X-closable DOM title bar', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        const winsBefore = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id));
        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);

        // Wait for the new top-level window div to appear (replaces a fixed 1500ms).
        await expect.poll(async () => page.evaluate((before: string[]) => {
            const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id);
            return all.find((id) => !before.includes(id)) ?? null;
        }, winsBefore), { timeout: 60000, intervals: [300] }).not.toBeNull();
        const winId = await page.evaluate((before: string[]) => {
            const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id);
            return all.find((id) => !before.includes(id)) ?? all[all.length - 1] ?? null;
        }, winsBefore);
        expect(winId, 'the 3D viewer should open a new top-level window').toBeTruthy();
        await page.screenshot({ path: shotPath(page, '3d-viewer-titlebar.png'), scale: 'css' });

        // It must have a real DOM title bar (the frames-only fix covers the viewer).
        const bar = page.locator(`#${winId} .window-titlebar`);
        expect(await bar.count(), 'the 3D viewer (a wxFrame) should have a DOM title bar').toBe(1);

        // Root-cause check: the title bar is the top hit-test element at its own
        // location, despite the main pcbnew frame's pointer-events:auto controls
        // (which used to intercept and break drag/close).
        const box = await bar.boundingBox();
        expect(box, 'the title bar should have a layout box').not.toBeNull();
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;
        const topEl = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            return el ? el.className.toString() : 'null';
        }, [cx, cy]);
        expect(topEl, `the top element at the title bar must be the title bar (was "${topEl}")`)
            .toContain('window-titlebar');

        // Drag the title bar → the frame moves (wx_window_move → wxWindow::Move).
        const styleTop = (wid: string) =>
            page.evaluate((id) => {
                const el = document.getElementById(id) as HTMLElement | null;
                return el ? (parseInt(el.style.top || '0', 10) || 0) : null;
            }, wid);
        const beforeTop = await styleTop(winId as string);
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx, cy + 80, { steps: 10 });
        await page.mouse.up();
        // Let the frame-move op (wx_window_move → wxWindow::Move) fully settle before the
        // next interaction: the DOM style.top updates before the wx-side op completes, so
        // polling the outcome races the following close click (documented interaction dwell).
        await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: frame-move op settle; polling races the close click
        const afterTop = await styleTop(winId as string);
        expect(afterTop, 'dragging the title bar should move the 3D viewer frame').not.toBe(beforeTop);

        // Close via the × (wx_window_close → wx Close() → OnCloseWindow).
        await page.locator(`#${winId} .window-titlebar-close`).click();
        await page.waitForTimeout(600); // eslint-disable-line -- documented interaction dwell: wx Close() commit before checking the frame is gone
        const gone = await page.evaluate((wid) => {
            const el = document.getElementById(wid);
            return !el || getComputedStyle(el).display === 'none';
        }, winId);
        expect(gone, 'the × should close the 3D viewer').toBe(true);

        // Opening/dragging/closing didn't blow up the runtime.
        const aborts = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted during the title-bar test:\n${aborts.join('\n\n')}`).toEqual([]);
    });

    /*
     * Edge-resize gate for the real 3D viewer.
     *
     * The viewer (a wxFrame with wxRESIZE_BORDER) now gets DOM edge-resize handles.
     * Dragging an edge calls wx_window_resize → wxWindow::SetSize, whose wxSizeEvent
     * relays out the frame and resizes the embedded EDA_3D_CANVAS (wxGLCanvas →
     * setGLCanvasRect). We drag the RIGHT edge (full-screen frame: its se corner sits
     * at/over the viewport edge and is unreliable to grab; the right edge is not).
     * Assert the frame AND its GL canvas both shrink in width.
     */
    test('real 3D viewer can be edge-resized (frame + GL canvas track)', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        const winsBefore = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id));
        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);

        // Wait for the new top-level window div to appear (replaces a fixed 1500ms).
        await expect.poll(async () => page.evaluate((before: string[]) => {
            const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id);
            return all.find((id) => !before.includes(id)) ?? null;
        }, winsBefore), { timeout: 60000, intervals: [300] }).not.toBeNull();
        const winId = await page.evaluate((before: string[]) => {
            const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id);
            return all.find((id) => !before.includes(id)) ?? all[all.length - 1] ?? null;
        }, winsBefore);
        expect(winId, 'the 3D viewer should open a new top-level window').toBeTruthy();

        // It is wxRESIZE_BORDER → exactly the 5 edge/corner handles.
        const handles = await page.locator(`#${winId} .window-resize-handle`).count();
        expect(handles, 'the 3D viewer (wxRESIZE_BORDER) should have edge-resize handles').toBe(5);

        // Frame width from its style; GL canvas width from the newest glcanvas-*.
        const frameWidth = (wid: string) =>
            page.evaluate((id) => {
                const el = document.getElementById(id) as HTMLElement | null;
                return el ? (parseInt(el.style.width || '0', 10) || 0) : 0;
            }, wid);
        const glWidth = () =>
            page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('canvas[id^="glcanvas-"]')) as HTMLCanvasElement[];
                const c = all[all.length - 1];
                return c ? (parseInt(c.style.width || '0', 10) || 0) : 0;
            });

        const beforeFrame = await frameWidth(winId as string);
        const beforeGl = await glWidth();
        expect(beforeFrame, 'frame should have a width').toBeGreaterThan(0);
        await logThreeDDiag(page, 'resize: before edge drag');

        // Drag the right edge inward (left) to shrink the frame width.
        const edge = page.locator(`#${winId} .window-resize-e`);
        const box = await edge.boundingBox();
        expect(box, 'the 3D viewer should have a right-edge resize handle with a layout box').not.toBeNull();
        const sx = box!.x + box!.width / 2;
        const sy = box!.y + box!.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx - 220, sy, { steps: 12 });
        await page.mouse.up();
        // Let the resize op (wx_window_resize → SetSize → relayout + GL canvas resize)
        // settle before reading widths (documented interaction dwell).
        await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: resize + GL canvas relayout settle before reading widths

        const afterFrame = await frameWidth(winId as string);
        const afterGl = await glWidth();
        expect(afterFrame, `frame width should shrink (was ${beforeFrame}, now ${afterFrame})`)
            .toBeLessThan(beforeFrame - 100);
        expect(afterGl, `3D viewer GL canvas should shrink with the frame (was ${beforeGl}, now ${afterGl})`)
            .toBeLessThan(beforeGl);

        const aborts = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted during the resize test:\n${aborts.join('\n\n')}`).toEqual([]);
    });
});
