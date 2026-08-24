import { test, expect } from './fixtures';
import { shotPath } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { DEMO, loadBoard, countGlCanvases, logThreeDDiag, openThreeDViewer, waitForThreeDRender }
    from './utils/threed-viewer';

/**
 * Regression: close the 3D viewer, reopen it — it must render again, in the same place.
 *
 * Closing the viewer Destroy()s the frame; ~wxGLCanvas destroys the WebGL context and its
 * DOM canvas (wxwidgets/src/wasm/glcanvas.cpp). Reopening creates a fresh frame + canvas +
 * context. Two independent bugs surfaced on that path:
 *
 * 1. BLANK CANVAS — the wasm/gl1 FFP shim cached GL object names (FFP program, stream and
 *    scratch VBOs) in file-scope statics guarded by `if (!handle)`, so in the new context it
 *    kept using names owned by the destroyed context: every draw died with INVALID_OPERATION
 *    and the reopened viewer showed only the clear color ("Reload time 0.031 s" — the scene
 *    rebuild itself is fine, warm model caches make it fast). The shim now detects the
 *    context change and rebuilds its GL objects.
 *
 * 2. LOST POSITION — wxWindowWasm::GetHandle() returns NULL, so wxDisplay::GetFromWindow()
 *    was wxNOT_FOUND (-1); EDA_BASE_FRAME::SaveWindowSettings stored display = (unsigned)-1,
 *    and LoadWindowState's "previous display not found" branch re-centred the frame on every
 *    reopen instead of restoring the saved position. The wasm display factory now reports
 *    display 0 for any created window.
 *
 * ISOLATED in its own spec file (own Playwright worker → own browser process) like the
 * deadlock spec: one heavy pcbnew load per process keeps the emscripten Worker pool and the
 * shared GPU-process context budget predictable on CI.
 */

// Sample the NEWEST glcanvas backing store: distinct colours on a 16x16 grid. One
// drawImage readback per call (CPU-backed 2D canvas) — same technique as
// waitForThreeDRender, kept SwiftShader-safe (no per-pixel GPU round-trips).
function sampleNewestGlCanvasColors(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(() => {
        const list = document.querySelectorAll('canvas[id^="glcanvas-"]');
        const el = list[list.length - 1] as HTMLCanvasElement | undefined;
        if (!el || !el.width || !el.height) return 0;
        const tmp = document.createElement('canvas');
        tmp.width = el.width; tmp.height = el.height;
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
        return colors.size;
    });
}

// The viewer's top-level window div position, from its inline style (the wasm DOM port
// positions windows via style.left/top).
function windowPos(page: import('@playwright/test').Page, winId: string) {
    return page.evaluate((id) => {
        const el = document.getElementById(id) as HTMLElement | null;
        if (!el) return null;
        return {
            left: parseInt(el.style.left || '0', 10) || 0,
            top: parseInt(el.style.top || '0', 10) || 0,
        };
    }, winId);
}

// Newest window-N div beyond a recorded set (same detection as 3d-viewer.spec.ts).
async function newestWindowId(page: import('@playwright/test').Page,
                              before: string[]): Promise<string> {
    await expect.poll(async () => page.evaluate((prev: string[]) => {
        const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]'))
            .map((e) => e.id);
        return all.find((id) => !prev.includes(id)) ?? null;
    }, before), { timeout: 60000, intervals: [300] }).not.toBeNull();
    const winId = await page.evaluate((prev: string[]) => {
        const all = Array.from(document.querySelectorAll('#window-container [id^="window-"]'))
            .map((e) => e.id);
        return all.find((id) => !prev.includes(id)) ?? all[all.length - 1] ?? null;
    }, before);
    expect(winId, 'the 3D viewer should open a new top-level window').toBeTruthy();
    return winId as string;
}

test.describe('3D viewer close and reopen', () => {
    // Two full viewer opens over one heavy pcbnew load: serial + generous.
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(480000);

    test('re-renders the board and keeps its window position after close + reopen',
        async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        // ── First open: must render (precondition, same gate as 3d-viewer.spec.ts). ──
        const winsBefore = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#window-container [id^="window-"]'))
                .map((e) => e.id));
        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);
        const winId = await newestWindowId(page, winsBefore);
        await waitForThreeDRender(page);
        await logThreeDDiag(page, 'first open rendered');

        // Drag the viewer by its DOM title bar to a distinctive position: with pristine
        // settings the frame opens display-sized at (0,0), where "restored" and
        // "re-centred" coincide and a position regression is invisible. The drag makes
        // the two outcomes distinguishable. (Same machinery as the titlebar spec.)
        const posInitial = await windowPos(page, winId);
        expect(posInitial, 'the 3D viewer window should have a position').not.toBeNull();
        const bar = page.locator(`#${winId} .window-titlebar`);
        const barBox = await bar.boundingBox();
        expect(barBox, 'the 3D viewer should have a DOM title bar to drag').not.toBeNull();
        const cx = barBox!.x + barBox!.width / 2;
        const cy = barBox!.y + barBox!.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 40, cy + 90, { steps: 10 });
        await page.mouse.up();
        // DOM style updates first; poll it as the observable...
        await expect.poll(async () => (await windowPos(page, winId))?.top,
            { timeout: 15000, intervals: [200] }).not.toBe(posInitial!.top);
        // ...then let the wx-side op (wx_window_move → wxWindow::Move) fully land before
        // close saves the frame position from the wx side (documented interaction dwell —
        // the DOM moves before the wx op completes; see 3d-viewer.spec.ts titlebar test).
        await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell

        const posBefore = await windowPos(page, winId);
        expect(posBefore, 'the 3D viewer window should have a position').not.toBeNull();
        await page.screenshot({ path: shotPath(page, `3d-reopen-01-first-${DEMO.name}.png`),
                                scale: 'css' });

        // ── Close via the titlebar ×; wait for the frame AND its GL canvas to go away
        //    (the canvas removal is the observable for wxGLCanvas/WebGL-context teardown). ──
        await page.locator(`#${winId} .window-titlebar-close`).click();
        await expect.poll(async () => page.evaluate((wid) => {
            const el = document.getElementById(wid);
            return !el || getComputedStyle(el).display === 'none';
        }, winId), { timeout: 30000, intervals: [200] }).toBe(true);
        await expect.poll(() => countGlCanvases(page), { timeout: 30000, intervals: [200] })
            .toBe(glBefore);
        await logThreeDDiag(page, 'viewer closed');

        // ── Reopen. ──
        const winsBeforeReopen = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#window-container [id^="window-"]'))
                .map((e) => e.id));
        await openThreeDViewer(page, glBefore);
        const winId2 = await newestWindowId(page, winsBeforeReopen);

        // Position must be restored, not re-centred. Read once the frame exists (position is
        // applied during frame construction, which precedes the GL canvas the open-wait saw).
        // Soft: a position regression must not mask the render assertion below (and vice
        // versa) — both defects come from one user action and should report together.
        const posAfter = await windowPos(page, winId2);
        expect.soft(posAfter, 'the reopened 3D viewer window should have a position')
            .not.toBeNull();
        if (posBefore && posAfter) {
            expect.soft(Math.abs(posAfter.left - posBefore.left),
                `reopened 3D viewer should keep its window position (closed at `
                + `${posBefore.left},${posBefore.top}; reopened at ${posAfter.left},${posAfter.top}`
                + ` — re-centring means the saved display index was invalid)`)
                .toBeLessThanOrEqual(2);
            expect.soft(Math.abs(posAfter.top - posBefore.top),
                `reopened 3D viewer should keep its window position (closed at `
                + `${posBefore.left},${posBefore.top}; reopened at ${posAfter.left},${posAfter.top}`
                + ` — re-centring means the saved display index was invalid)`)
                .toBeLessThanOrEqual(2);
        }

        // THE render regression assertion: the reopened viewer must show the board again.
        // A blank canvas (stale gl1 GL handles in the new WebGL context) stays at ~1 colour.
        await expect.poll(() => sampleNewestGlCanvasColors(page), {
            message: 'reopened 3D viewer canvas should render the board again '
                   + '(a blank/uniform canvas means the gl1 shim is drawing with GL object '
                   + 'names from the destroyed WebGL context)',
            timeout: 90000,
            intervals: [1000],
        }).toBeGreaterThan(8);

        await page.screenshot({ path: shotPath(page, `3d-reopen-02-reopened-${DEMO.name}.png`),
                                scale: 'css' });

        // ── Console-clean gates (same signatures as 3d-viewer.spec.ts). ──
        const allLines = [...testLogger.consoleLogs, ...testLogger.errors];
        const aborts = allLines.filter((l) => l.includes('Aborted('));
        expect(aborts, `WASM aborted during close/reopen:\n${aborts.join('\n\n')}`).toEqual([]);

        const wasmTrapSignatures = [
            'index out of bounds', 'indirect call to null', 'uncaught exception: unwind',
            'invalid state', 'is not a function',
        ];
        const wasmTrapErrors = allLines.filter((l) =>
            wasmTrapSignatures.some((sig) => l.toLowerCase().includes(sig)));
        expect(wasmTrapErrors,
            `wasm trap surfaced during close/reopen:\n${wasmTrapErrors.join('\n\n')}`)
            .toEqual([]);
    });
});
