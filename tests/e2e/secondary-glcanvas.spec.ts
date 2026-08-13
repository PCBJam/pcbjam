import { test, expect, waitForApp } from './utils/fixtures';
import { clickByLabel, waitForRegistry } from './utils/element-tracker';

/**
 * Regression for the "two canvases over each other" bug — at the wxWidgets layer.
 *
 * The wasm DOM port draws each top-level window's chrome onto 2D canvases and
 * reveals a wxGLCanvas through it. A wxGLCanvas in a SECONDARY top-level window
 * was hidden behind that window's own opaque chrome: every `glcanvas-*` was
 * hard-coded to z-index 100, but showing the secondary frame raises its
 * `#window-N` chrome div to z-index 101 (`raiseWindow` → maxZ+1 over the visible
 * main canvas at 100), so the chrome painted over the GL canvas. The fix
 * passes the owning top-level window's role from `wxGLCanvas::Create` to
 * `wx.js` `createGLCanvas`: main-frame surfaces remain at z-index 100 and
 * secondary-frame surfaces use z-index 2147483647, above the chrome.
 *
 * This drives the minimal pure-wx repro app (a main frame with a wxGLCanvas + a
 * button that opens a second top-level frame with its own wxGLCanvas) and asserts
 * the stacking from computed styles — no pixels/screenshots, so it doesn't depend
 * on actual GL rendering. Note `glcanvas-*`, `#window-N` and `.window-canvas` all
 * have `pointer-events:none`, so `elementsFromPoint` can't see them; computed
 * z-index is the right tool.
 *
 * Before the fix every `glcanvas-*` is z-index 100, so the secondary canvas is
 * not strictly above the main one → FAILS. After the fix it is 2147483647 → PASSES.
 */
test.describe('secondary-window wxGLCanvas compositing', () => {
    test('a wxGLCanvas in a secondary frame is z-lifted above the window chrome', async ({ page }) => {
        await page.goto('/standalone/secondary-glcanvas/secondary-glcanvas_test.html');
        await waitForApp(page);
        await waitForRegistry(page);

        // The main frame's GL canvas must be present and on-screen before we open
        // the second window.  Its exact z-index is the main-frame role contract.
        await page.waitForFunction(() => {
            const c = document.querySelector('#window-container canvas[id^="glcanvas-"]');
            return !!c && getComputedStyle(c).display !== 'none'
                && (c as HTMLElement).getBoundingClientRect().width > 0;
        }, undefined, { timeout: 30000 });

        const main = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '#window-container canvas[id^="glcanvas-"]');
            return canvas
                ? { id: canvas.id, z: Number.parseInt(getComputedStyle(canvas).zIndex, 10) }
                : null;
        });
        expect(main, 'the main frame should own a GL canvas').not.toBeNull();
        expect(main!.z, 'the main-frame GL role is the stable z-index 100').toBe(100);

        const before = await page.evaluate(
            () => document.querySelectorAll('canvas[id^="glcanvas-"]').length);

        // Open the secondary frame (mirrors opening KiCad's 3D viewer).
        expect(await clickByLabel(page, 'Open Second Window'),
            'the "Open Second Window" button should be clickable').toBe(true);

        // Wait for the secondary frame's NEW GL canvas to appear and be on-screen.
        await page.waitForFunction((b: number) => {
            const list = document.querySelectorAll<HTMLCanvasElement>('canvas[id^="glcanvas-"]');
            if (list.length <= b) return false;
            const viewer = list[list.length - 1];
            return getComputedStyle(viewer).display !== 'none'
                && viewer.getBoundingClientRect().width > 0;
        }, before, { timeout: 30000 });

        // Stacking order inside #window-container (a single z-index:1 stacking
        // context). The secondary canvas is the newest glcanvas-*; it must
        // out-stack every other GL canvas and every secondary window-N chrome div.
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

        // Precondition: the secondary window actually opened (main + secondary canvas).
        expect(stacking.glCount,
            'opening the second window should add a second WebGL canvas').toBeGreaterThanOrEqual(2);

        // The role assignment is exact, not inferred from creation/visibility order.
        expect(stacking.viewerZ,
            'a secondary-frame GL canvas uses the stable raised role')
            .toBe(2147483647);

        // The compositing regression assertion. Pre-fix every glcanvas-* shares
        // z-index 100, so the secondary canvas is not strictly above the main one
        // and the chrome occludes it.
        expect(stacking.viewerZ,
            `secondary GL canvas ${stacking.viewerId} (z=${stacking.viewerZ}) must stack strictly above `
            + `the other GL canvases (max z=${stacking.maxOtherGlZ}); an equal z-index means the window `
            + `chrome can occlude it. all=${JSON.stringify(stacking.glZ)}`)
            .toBeGreaterThan(stacking.maxOtherGlZ);

        // The user-visible symptom: the GL canvas must paint at or above every secondary
        // window's opaque 2D chrome. (>= not > to tolerate a window clamped to the same
        // 2147483647 CSS z-index ceiling by raiseWindow.)
        expect(stacking.viewerZ,
            `secondary GL canvas (z=${stacking.viewerZ}) must not sit below any window chrome `
            + `(max window z=${stacking.maxWindowZ}). windows=${JSON.stringify(stacking.windowZ)}`)
            .toBeGreaterThanOrEqual(stacking.maxWindowZ);
    });
});
