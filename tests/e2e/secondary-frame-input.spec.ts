// Secondary-frame input barrier — clicks on a secondary frame must reach that
// frame, not the main frame's native DOM controls underneath it.
//
// The wasm port renders wxChoice as a real DOM <select> (pointer-events:auto)
// while a secondary frame's window div is pointer-events:none, so clicks over
// the frame are meant to fall through to #canvas for the C++ hit-test. Without
// a barrier for the main window's controls, the fall-through is intercepted by
// the hidden <select> and the browser pops its native dropdown instead of
// activating the frame's toolbar button (pcbjam: the 3D viewer's toolbar over
// pcbnew's track-width selector).
//
// Registry coords are wx-screen coords, i.e. #canvas-relative CSS px; the wx
// template host does not put the canvas at the page origin, so every page
// interaction adds the canvas's page offset.
import type { Page } from '@playwright/test';
import { test, expect, waitForWxApp } from './utils/fixtures';
import { findByTooltip, waitUntil } from './utils/element-tracker';

const APP = '/standalone/secondary-frame/secondary-frame_test.html';

// The app: main frame with a wxChoice at wx-screen (10,40)–(190,64); secondary
// frame at (0,10) 420x220 with an AUI toolbar of two check tools, covering the
// choice.

function canvasOffset(page: Page) {
    return page.evaluate(() => {
        const r = document.getElementById('canvas')!.getBoundingClientRect();
        return { x: r.left, y: r.top };
    });
}

function hitAtPage(page: Page, x: number, y: number) {
    return page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return el ? { tag: el.tagName, cls: String(el.className) } : null;
    }, [x, y]);
}

async function bootApp(page: Page) {
    await page.goto(APP);
    await waitForWxApp(page);
    await waitUntil(page, () => {
        const r = window.wxElementRegistry;
        return !!r?.findAllRendered
            && r.findAllRendered({ elementType: 'tool' })
                .some((t) => t.tooltip?.includes('orthographic'));
    }, 'secondary frame AUI toolbar rendered');
}

test.describe('secondary frame over main-frame DOM controls', () => {

    test('toolbar clicks reach the secondary frame, covered select is inert', async ({ page, testLogger }) => {
        await bootApp(page);
        const off = await canvasOffset(page);

        const ortho = await findByTooltip(page, 'orthographic', { elementType: 'tool' });
        expect(ortho, 'Ortho check tool must be in the registry').not.toBeNull();
        const toolPage = { x: off.x + ortho!.centerX, y: off.y + ortho!.centerY };

        // The tool sits inside the secondary frame, over the main frame's
        // <select>. DOM hit-testing at its centre must NOT surface the select.
        const hit = await hitAtPage(page, toolPage.x, toolPage.y);
        expect(hit, 'something must be hit-testable at the tool centre').not.toBeNull();
        expect(hit!.tag, `hit at tool centre page(${toolPage.x},${toolPage.y}) must fall through to #canvas, not the main frame's <select>`)
            .toBe('CANVAS');

        // Clicking the tool must toggle IT — not pop the hidden select.
        await page.mouse.click(toolPage.x, toolPage.y);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[SECFRAME] tool Ortho toggled on')),
            { message: 'the Ortho check tool should receive the click', timeout: 5000 },
        ).toBe(true);

        // The covered select carries the barrier class.
        const selectState = await page.evaluate(() => {
            const sel = document.querySelector('#main-window select.wx-dom-control');
            return sel ? { inert: sel.classList.contains('wx-inert') } : null;
        });
        expect(selectState, 'the wxChoice must be rendered as a DOM select').not.toBeNull();
        expect(selectState!.inert, 'the covered select must be input-inert').toBe(true);
    });

    test('barrier follows the frame: dragging it away frees the select, back re-blocks it', async ({ page }) => {
        await bootApp(page);
        const off = await canvasOffset(page);

        const titlebarGrab = () => page.evaluate(() => {
            const el = document.querySelector('#window-container .window.toplevel .window-titlebar')!;
            const r = el.getBoundingClientRect();
            return { x: r.left + 60, y: r.top + r.height / 2 };
        });

        // Drag the secondary frame far right so it no longer covers the select.
        const bar = await titlebarGrab();
        await page.mouse.move(bar.x, bar.y);
        await page.mouse.down();
        await page.mouse.move(bar.x + 460, bar.y + 60, { steps: 6 });
        await page.mouse.up();

        await expect.poll(async () => page.evaluate(() => {
            const sel = document.querySelector('#main-window select.wx-dom-control')!;
            return sel.classList.contains('wx-inert');
        }), { message: 'uncovered select must become interactive again', timeout: 5000 }).toBe(false);
        const freeHit = await hitAtPage(page, off.x + 100, off.y + 52);
        expect(freeHit!.tag, 'hit-test over the uncovered select must reach it').toBe('SELECT');

        // Drag back over the select — the barrier must re-engage.
        const bar2 = await titlebarGrab();
        await page.mouse.move(bar2.x, bar2.y);
        await page.mouse.down();
        await page.mouse.move(bar2.x - 460, bar2.y - 60, { steps: 6 });
        await page.mouse.up();

        await expect.poll(async () => page.evaluate(() => {
            const sel = document.querySelector('#main-window select.wx-dom-control')!;
            return sel.classList.contains('wx-inert');
        }), { message: 're-covered select must be input-inert again', timeout: 5000 }).toBe(true);
    });
});
