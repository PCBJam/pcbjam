// 3D viewer toolbar vs pcbnew's hidden DOM controls.
//
// The 3D viewer is a secondary frame: its window div is pointer-events:none so
// clicks fall through to #canvas for the C++ hit-test. pcbnew's toolbar combos
// (track width / via / grid / zoom) are real DOM <select>s with
// pointer-events:auto inside #main-window. Where the viewer's toolbar row
// overlaps one of those selects, the fall-through used to be intercepted by
// the hidden select — the browser popped "Track: use netclass width / Edit
// Pre-defined Sizes..." instead of pressing the viewer's button. The input
// barrier (recomputeModalBarrier in wx.js) must make the covered main-frame
// controls inert while the viewer overlaps them.
import { test, expect } from './fixtures';
import { waitUntil, findByTooltip } from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { loadBoard, countGlCanvases, openThreeDViewer } from './utils/threed-viewer';

test.describe('3D viewer toolbar over pcbnew DOM controls', () => {
    test.setTimeout(240000);

    test('viewer toolbar clicks are not hijacked by hidden pcbnew selects', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);

        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);

        // Drag the viewer to the top-left (the user-reported layout): its
        // toolbar row then overlaps pcbnew's track-width/via/grid/zoom selects.
        const bar = await page.evaluate(() => {
            const win = [...document.querySelectorAll<HTMLElement>('#window-container .window.toplevel')]
                .find((w) => getComputedStyle(w).display !== 'none' && w.getBoundingClientRect().width > 100)!;
            const r = win.querySelector('.window-titlebar')!.getBoundingClientRect();
            const wr = win.getBoundingClientRect();
            return { x: r.left + 60, y: r.top + r.height / 2, winLeft: wr.left, winTop: wr.top };
        });
        await page.mouse.move(bar.x, bar.y);
        await page.mouse.down();
        await page.mouse.move(bar.x - bar.winLeft, bar.y - bar.winTop + 2, { steps: 8 });
        await page.mouse.up();

        // The viewer's own AUI toolbar is registry-tracked; wait for it.
        await waitUntil(page, () => {
            const r = window.wxElementRegistry;
            return !!r?.findAllRendered
                && r.findAllRendered({ elementType: 'tool' })
                    .some((t) => t.tooltip?.includes('orthographic'));
        }, '3D viewer toolbar rendered');

        // Every centre of the VIEWER's own toolbar (the AUI toolbar that owns
        // toggleOrtho, selected via parentId — the registry holds every
        // frame's tools) must DOM-hit-test to #canvas: the buttons are
        // canvas-painted, so anything else there (a pcbnew <select>) would
        // swallow the click.
        const hits = await page.evaluate(() => {
            const reg = window.wxElementRegistry!;
            const all = reg.findAllRendered({ elementType: 'tool' });
            const ortho = all.find((t) => t.tooltip?.includes('orthographic'))!;
            return all
                .filter((t) => t.parentId === ortho.parentId)
                .map((t) => {
                    const el = document.elementFromPoint(t.centerX, t.centerY);
                    return {
                        tip: (t.tooltip ?? '').split('\n')[0],
                        x: t.centerX, y: t.centerY,
                        hit: el ? el.tagName : 'none',
                    };
                });
        });
        expect(hits.length, 'viewer toolbar tools must be tracked').toBeGreaterThan(5);
        const hijacked = hits.filter((h) => h.hit !== 'CANVAS');
        expect(hijacked, 'no viewer toolbar tool may be shadowed by a live main-frame DOM control')
            .toEqual([]);

        // The covered track-width select must carry the input barrier...
        const trackSelect = () => page.evaluate(() => {
            const sel = [...document.querySelectorAll<HTMLSelectElement>('#main-window select.wx-dom-control')]
                .find((s) => [...s.options].some((o) => o.text.includes('use netclass width')));
            return sel ? { inert: sel.classList.contains('wx-inert') } : null;
        });
        const covered = await trackSelect();
        expect(covered, 'pcbnew track-width select must exist').not.toBeNull();
        expect(covered!.inert, 'track-width select under the viewer must be input-inert').toBe(true);

        // ...and the click must reach the viewer's button: toggling ortho
        // appends " [checked]" to its registry label.
        const ortho = await findByTooltip(page, 'orthographic', { elementType: 'tool' });
        expect(ortho, 'toggleOrtho must be in the registry').not.toBeNull();
        expect((ortho!.label ?? '').includes('[checked]')).toBe(false);
        await page.mouse.click(ortho!.centerX, ortho!.centerY);
        await expect.poll(async () => {
            const t = await findByTooltip(page, 'orthographic', { elementType: 'tool' });
            return (t?.label ?? '').includes('[checked]');
        }, { message: 'clicking toggleOrtho must toggle IT, not a hidden select', timeout: 10000 })
            .toBe(true);

        // Closing the viewer must release the barrier.
        await page.evaluate(() => {
            const win = [...document.querySelectorAll<HTMLElement>('#window-container .window.toplevel')]
                .find((w) => getComputedStyle(w).display !== 'none' && w.getBoundingClientRect().width > 100)!;
            (win.querySelector('.window-titlebar-close') as HTMLElement).click();
        });
        await expect.poll(async () => (await trackSelect())!.inert,
            { message: 'track-width select must be interactive after the viewer closes', timeout: 10000 })
            .toBe(false);
    });
});
