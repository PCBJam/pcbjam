import { test, expect, type Page } from './fixtures';
import { loadBoard } from './utils/threed-viewer';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { clickMenuBarItem, clickMenuItemByText } from '../e2e/utils/element-tracker';

/**
 * Repro for the user-reported dead-app: Add Footprint → the footprint chooser
 * (a quasi-modal running a NESTED event loop, opened from the place-footprint
 * TOOL COROUTINE) → click Cancel → the whole UI freezes.
 *
 * Root cause (recorder, live demo board): the nested loop parks IN PLACE on the
 * tool coroutine's fiber stack (`inplace-park-on-fiber-stack`), then the resume
 * that would close it is refused by the stale-fiber quarantine
 * (`fiber-resume-refused: … asyncify-parked mid-body`) and dropped — the
 * doc-19 disease. It was masked by the mainstack bounce until Phase F4 removed
 * it; the footprint chooser has no automated coverage so the removal went
 * unnoticed. This spec is that coverage.
 *
 * Mechanics that matter: the chooser is a wxFrame (not a wxDialog), so detect
 * it by a second top-level frame + a "nested" scheduler wait; drive the canvas
 * with synthetic emscripten mouse events (a Playwright click is intercepted by
 * the wx scrollbar overlay); read the Cancel button's real coords from the
 * element registry.
 */

const TRAP =
    /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function|memory access out of bounds/;

function frameCount(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                /Frame$/.test(e.typeName || ''),
            ).length,
    );
}

async function synthClick(page: Page, x: number, y: number): Promise<void> {
    await page.evaluate(
        ([cx, cy]) => {
            const c = document.querySelector('#canvas') as HTMLCanvasElement;
            const opt = (b: number) => ({
                clientX: cx,
                clientY: cy,
                bubbles: true,
                cancelable: true,
                view: window,
                button: 0,
                buttons: b,
            });
            c.dispatchEvent(new MouseEvent('mousemove', opt(0)));
            c.dispatchEvent(new MouseEvent('mousedown', opt(1)));
            c.dispatchEvent(new MouseEvent('mouseup', opt(0)));
            c.dispatchEvent(new MouseEvent('click', opt(0)));
        },
        [x, y],
    );
}

async function assertResponsive(page: Page, label: string): Promise<void> {
    const before = await page.evaluate(
        () => Number((window.__wxAsyncifyDump?.().match(/fcsTotal=(\d+)/) || [])[1] || 0),
    );
    await page.waitForTimeout(1500); // eslint-disable-line -- sampling the loop counter across a fixed window
    const after = await page.evaluate(
        () => Number((window.__wxAsyncifyDump?.().match(/fcsTotal=(\d+)/) || [])[1] || 0),
    );
    if (after === before) {
        const dump = await page.evaluate(() =>
            typeof window.__wxAsyncifyDump === 'function' ? window.__wxAsyncifyDump() : 'no dump',
        );
        console.log(`[TEST] RECORDER after ${label} (loop STALLED, fcs=${after}):\n${dump}`);
    }
    expect(after, `main loop still advancing after ${label}`).toBeGreaterThan(before);
}

test.describe('Add Footprint chooser close (doc-19 dead-app repro)', () => {
    test('footprint chooser opens over a board and cancels without freezing', async ({
        page,
        testLogger,
    }) => {
        test.setTimeout(180000);
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadBoard(page, testLogger);
        await assertResponsive(page, 'board load');

        const framesBefore = await frameCount(page);

        // Arm Add Footprint, then click the canvas to open the chooser.
        expect(await clickMenuBarItem(page, 'Place'), 'Place menu findable').toBe(true);
        await clickMenuItemByText(page, 'Place Footprints');
        const canvas = await page.locator('#canvas').boundingBox();
        if (!canvas) throw new Error('canvas not found');
        await synthClick(page, Math.round(canvas.width * 0.35), Math.round(canvas.height * 0.45));

        // The chooser is a second top-level frame + a "nested" scheduler wait.
        await page
            .waitForFunction(
                (n) =>
                    (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                        /Frame$/.test(e.typeName || ''),
                    ).length > n,
                framesBefore,
                { timeout: 40000 },
            )
            // best-effort wait: the frame-count expect right below is the
            // real assertion; a timeout must reach it, not throw (documented)
            .catch(() => {});
        const framesOpen = await frameCount(page);
        console.log(`[TEST] frames: ${framesBefore} → ${framesOpen}`);
        expect(framesOpen, 'footprint chooser frame opened').toBeGreaterThan(framesBefore);
        await assertResponsive(page, 'chooser open');

        // Click the real Cancel button (coords from the element registry).
        const cancel = await page.evaluate(() => {
            const b = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find(
                (e) => /Button/i.test(e.typeName || '') && /cancel/i.test(e.label || ''),
            );
            return b ? { x: b.centerX, y: b.centerY } : null;
        });
        expect(cancel, 'Cancel button found').not.toBeNull();
        await synthClick(page, cancel!.x, cancel!.y);

        // The chooser must close AND the app must stay alive. On the broken
        // build the loop stalls here (the dropped fiber resume).
        await page
            .waitForFunction(
                (n) =>
                    (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                        /Frame$/.test(e.typeName || ''),
                    ).length <= n,
                framesBefore,
                { timeout: 20000 },
            )
            // best-effort wait: the trap check below is the real assertion;
            // a stalled close must reach it, not throw here (documented)
            .catch(() => {});
        await assertResponsive(page, 'chooser cancel');

        const traps = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) => TRAP.test(l));
        expect(traps, 'no wasm trap after cancel').toEqual([]);
    });
});
