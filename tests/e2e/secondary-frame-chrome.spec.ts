import { test, expect } from './utils/fixtures';
import { clickByLabel, waitForWxApp } from './utils/element-tracker';

/**
 * Validates the real-DOM title bar for secondary (non-main) wxFrames in the WASM
 * DOM port — the fix for the "3D-viewer can't be dragged / can't be X-closed" bug.
 *
 * Root cause (confirmed): a non-main window's title bar used to be canvas-painted
 * and pointer-events:none, so its clicks had to reach the central #canvas mouse
 * router; an overlapping pointer-events:auto DOM control from another frame stole
 * them. The fix gives ALL non-main top-level windows (secondary frames AND
 * dialogs) a real DOM `.window-titlebar` (drag + `.window-titlebar-close`) that
 * wins hit-testing via normal stacking.
 *
 * Drag dispatches real pointer events on the title bar (→ wx_window_move_stage →
 * wxWindow::Move); close clicks the × (→ wx_window_close_stage → wx Close(); for a
 * modal dialog this ends the modal loop via EndModal).
 */

const URL = '/standalone/secondary-frame-chrome/secondary-frame-chrome_test.html';

test.describe('secondary-frame DOM title bar (drag / close)', () => {
    test('frames and dialogs get a draggable, closable DOM title bar', async ({ page }) => {
        await page.goto(URL);
        await waitForWxApp(page);

        const listWindows = () =>
            page.evaluate(() =>
                Array.from(document.querySelectorAll('#window-container [id^="window-"]')).map((e) => e.id));

        const styleRect = (id: string) =>
            page.evaluate((wid) => {
                const el = document.getElementById(wid) as HTMLElement | null;
                if (!el) return null;
                const n = (v: string) => parseInt(v || '0', 10) || 0;
                return { left: n(el.style.left), top: n(el.style.top), width: n(el.style.width), height: n(el.style.height) };
            }, id);

        async function openWindow(buttonLabel: string): Promise<string> {
            const before = await listWindows();
            expect(await clickByLabel(page, buttonLabel), `"${buttonLabel}" should be clickable`).toBe(true);
            await page.waitForFunction(
                (b: string[]) => Array.from(document.querySelectorAll('#window-container [id^="window-"]')).some((e) => !b.includes(e.id)),
                before, { timeout: 15000 });
            const after = await listWindows();
            const id = after.find((w) => !before.includes(w));
            expect(id, `${buttonLabel} should open a new window`).toBeTruthy();
            await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell (new-window DOM population settle; no event/registry observable)
            return id as string;
        }

        // Returns true if the window moved after a title-bar drag.
        async function dragViaTitlebar(winId: string): Promise<boolean> {
            const bar = page.locator(`#${winId} .window-titlebar`);
            const box = await bar.boundingBox();
            expect(box, `#${winId} .window-titlebar should have a bounding box`).not.toBeNull();
            const before = await styleRect(winId);
            const sx = box!.x + box!.width / 2;
            const sy = box!.y + box!.height / 2;
            await page.mouse.move(sx, sy);
            await page.mouse.down();
            await page.mouse.move(sx, sy + 90, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(250); // eslint-disable-line -- documented interaction dwell (title-bar drag commit; no event/registry observable)
            const after = await styleRect(winId);
            return !!before && !!after && (Math.abs(after.top - before.top) > 5 || Math.abs(after.left - before.left) > 5);
        }

        async function closeViaTitlebar(winId: string): Promise<boolean> {
            await page.locator(`#${winId} .window-titlebar-close`).click();
            await page.waitForTimeout(400); // eslint-disable-line -- documented interaction dwell (× close / modal EndModal commit; no event/registry observable)
            return page.evaluate((wid) => {
                const el = document.getElementById(wid);
                return !el || getComputedStyle(el).display === 'none';
            }, winId);
        }

        // Returns true if dragging the bottom-right (se) resize handle grew the window.
        async function resizeViaCorner(winId: string): Promise<boolean> {
            const handle = page.locator(`#${winId} .window-resize-se`);
            const box = await handle.boundingBox();
            expect(box, `#${winId} .window-resize-se should have a bounding box`).not.toBeNull();
            const before = await styleRect(winId);
            const sx = box!.x + box!.width / 2;
            const sy = box!.y + box!.height / 2;
            await page.mouse.move(sx, sy);
            await page.mouse.down();
            await page.mouse.move(sx + 60, sy + 60, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(250); // eslint-disable-line -- documented interaction dwell (se-corner resize drag commit; no event/registry observable)
            const after = await styleRect(winId);
            return !!before && !!after
                && (after.width - before.width > 20) && (after.height - before.height > 20);
        }

        const countResizeHandles = (winId: string) =>
            page.locator(`#${winId} .window-resize-handle`).count();

        // Every non-main top-level window — frame or dialog — gets a DOM title bar
        // (drag + close ×). Edge-resize handles are added ONLY to windows whose wx
        // style carries wxRESIZE_BORDER: all wxFrames + dialogs that opt in (the
        // resizable dialog), but NOT the plain fixed dialog.
        //   resizable      — expects 5 resize handles (e/w/s/se/sw); fixed expects 0
        //   resizeDraggable — its se corner is on-screen, so assert a real resize drag
        const windows = [
            { label: 'Open Full GL Frame', resizable: true, resizeDraggable: false },
            { label: 'Open Rich GL Frame', resizable: true, resizeDraggable: false },
            { label: 'Open Small Frame', resizable: true, resizeDraggable: true },
            { label: 'Open Resizable Dialog', resizable: true, resizeDraggable: true },
            { label: 'Open Modeless Dialog', resizable: false, resizeDraggable: false },
        ];

        for (const { label, resizable, resizeDraggable } of windows) {
            const id = await openWindow(label);
            const hasBar = await page.locator(`#${id} .window-titlebar`).count();
            expect(hasBar, `${label} should have a DOM title bar`).toBe(1);

            // Resize-handle gate: present (5) iff the window is wxRESIZE_BORDER.
            const handles = await countResizeHandles(id);
            if (resizable) {
                expect(handles, `${label} should have edge-resize handles`).toBe(5);
                if (resizeDraggable) {
                    const resized = await resizeViaCorner(id);
                    expect(resized, `${label} should resize by dragging its se corner`).toBe(true);
                }
            } else {
                expect(handles, `${label} (no wxRESIZE_BORDER) must NOT be resizable`).toBe(0);
            }

            // Root-cause check: even with main-frame DOM controls present, the title
            // bar is the top hit-test element at its own location.
            const moved = await dragViaTitlebar(id);
            expect(moved, `${label} should be draggable by its DOM title bar`).toBe(true);

            const closed = await closeViaTitlebar(id);
            expect(closed, `${label} should close via its × button`).toBe(true);
        }
    });
});
