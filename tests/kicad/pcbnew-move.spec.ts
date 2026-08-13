import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickByTooltip, findByTooltip, waitForEditorReady, shotPath } from '../e2e/utils/element-tracker';
import { hideCursor } from './utils/screenshot-compare';

/**
 * PCBnew "m" move regression — GitHub issue #9.
 *
 * On desktop you select an item, press `m`, then nudge it with the arrow keys.
 * In the WASM build the arrow keys did nothing and the item snapped to the
 * cursor on grab, because wxWindowWasm::WarpPointer() was a no-op: KiCad's
 * arrow-key cursor nudge warps the pointer and reads it back via
 * wxGetMousePosition(), so a dead warp left the move loop reading a stale
 * position. The fix makes WarpPointer update the cached mouse position.
 *
 * This drives the real path — draw a graphic line, select it, press `m`, then
 * ArrowRight, and COMMIT WITH ENTER (a click would drop the item at the cursor
 * and hide the arrow nudges) — and asserts via the embind position hooks that
 * the item actually moved right.
 *
 *   RED  (bug present): the line does not move; delta == 0.
 *   GREEN (fixed):      the line moves right; delta_x > 0.
 */

type SnapItem = { id: string; type: string; x: number; y: number };
type CollabModule = {
    kicadCollabSnapshot(): Promise<string>;
    kicadCollabGetPos(id: string): Promise<string>;
};

async function waitForCollabModule(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const m = (window as unknown as { Module?: Partial<CollabModule> }).Module;
            return typeof m?.kicadCollabSnapshot === 'function'
                && typeof m?.kicadCollabGetPos === 'function';
        },
        null,
        { timeout: 30000 },
    );
}

async function snapshotItems(page: Page): Promise<SnapItem[]> {
    return page.evaluate(async () => {
        const m = (window as unknown as { Module: CollabModule }).Module;
        const snap = JSON.parse(await m.kicadCollabSnapshot()) as { added: SnapItem[] };
        return snap.added;
    });
}

async function getPos(page: Page, id: string): Promise<{ x: number; y: number }> {
    const raw = await page.evaluate(
        (i) => (window as unknown as { Module: CollabModule }).Module.kicadCollabGetPos(i),
        id,
    );
    const [x, y] = raw.split(',').map(Number);
    return { x, y };
}

async function visibleGlCanvasBox(page: Page) {
    const glCanvasId = await page.evaluate(() => {
        const glCanvas =
            Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
                .map((c) => c as HTMLCanvasElement)
                .find((c) => {
                    const rect = c.getBoundingClientRect();
                    const style = window.getComputedStyle(c);
                    return style.display !== 'none' && rect.width > 0 && rect.height > 0;
                }) ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null);
        return glCanvas?.id ?? null;
    });
    expect(glCanvasId, 'visible GL canvas').not.toBeNull();
    const box = await page.locator(`#${glCanvasId}`).boundingBox();
    expect(box, 'GL canvas bounding box').not.toBeNull();
    return box!;
}

test.describe('PCBnew move with "m" (#9)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/pcbnew.html');
    });

    test('selected item moves with the arrow keys after pressing m', async ({ page, testLogger }) => {
        await waitForEditorReady(page);
        await hideCursor(page);
        await waitForCollabModule(page);

        // Wait until the Draw Lines tool is registered, then select it.
        await page.waitForFunction(() => {
            const registry = window.wxElementRegistry;
            return !!registry?.findAllRendered
                && registry.findAllRendered({ elementType: 'tool' })
                    .some((t) => t.tooltip?.includes('Draw Lines'));
        }, null, { timeout: 15000 });

        const isToolChecked = (t: { label?: string } | null | undefined) =>
            (t?.label ?? '').includes('[checked]');

        const idsBeforeDraw = new Set((await snapshotItems(page)).map((i) => i.id));

        expect(await clickByTooltip(page, 'Draw Lines', { elementType: 'tool' })).toBe(true);
        await expect.poll(async () =>
            isToolChecked(await findByTooltip(page, 'Draw Lines', { elementType: 'tool' })), {
            message: 'Draw Lines tool should stay selected',
            timeout: 5000,
        }).toBe(true);

        // Draw a horizontal segment at known canvas pixels. Settle after each
        // move so the asyncified pointer-move handler updates the world cursor
        // before the click lands (see pcbnew.spec.ts draw-lines test).
        const glBox = await visibleGlCanvasBox(page);
        const startPoint = { x: Math.round(glBox.x + glBox.width * 0.35), y: Math.round(glBox.y + glBox.height * 0.45) };
        const endPoint = { x: Math.round(glBox.x + glBox.width * 0.55), y: Math.round(glBox.y + glBox.height * 0.45) };
        const midPoint = { x: Math.round((startPoint.x + endPoint.x) / 2), y: startPoint.y };

        // Draw a line segment. These per-vertex dwells are documented irreducible
        // interaction waits (see pcbnew.spec.ts draw-lines): a line-vertex commit has no
        // JS-observable signal, and the asyncified pointer-move handler needs wall-clock
        // time to update the world cursor before each button press.
        await page.mouse.move(startPoint.x, startPoint.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
        await page.mouse.move(endPoint.x, endPoint.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell
        // Finish the segment, then wait for the new board item to register
        // (deterministic — replaces two fixed 250ms sleeps).
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect.poll(async () =>
            (await snapshotItems(page)).filter((i) => !idsBeforeDraw.has(i.id)).length,
            { timeout: 8000, intervals: [200] },
        ).toBe(1);

        // Identify the drawn item and its starting position.
        const newItems = (await snapshotItems(page)).filter((i) => !idsBeforeDraw.has(i.id));
        expect(newItems.length, `exactly one new board item was drawn (got ${JSON.stringify(newItems)})`).toBe(1);
        const drawnId = newItems[0].id;
        const pos0 = await getPos(page, drawnId);

        const beforeMove = await page.screenshot({ path: shotPath(page, 'pcbnew-move-00-before.png'), scale: 'css' });

        // Hover onto the line, select it, press m, nudge right, commit with Enter. These
        // are documented interaction dwells: selection, move-mode entry, and per-arrow
        // nudges have no JS-observable per-step signal, and each keystroke needs the
        // asyncified event loop to process before the next. The outcome (the item moved
        // right) is asserted below via the embind position hook.
        await page.mouse.move(midPoint.x, midPoint.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell

        const NUDGES = 10;
        await page.keyboard.press('m');
        await page.waitForTimeout(400); // eslint-disable-line -- documented interaction dwell
        for (let i = 0; i < NUDGES; i++) {
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell
        }
        // Commit at the nudged position WITHOUT moving the cursor (Enter, not click).
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell

        const afterMove = await page.screenshot({ path: shotPath(page, 'pcbnew-move-01-after.png'), scale: 'css' });

        const pos1 = await getPos(page, drawnId);
        const dx = pos1.x - pos0.x;
        const dy = pos1.y - pos0.y;
        testLogger; // logs captured by fixture
        console.log(`[TEST] pcbnew move dx=${dx} dy=${dy} pos0=${JSON.stringify(pos0)} pos1=${JSON.stringify(pos1)}`);

        // Core regression: ArrowRight after `m` must move the item to the right.
        // RED (no-op warp): dx == 0. GREEN (fixed): dx > 0, predominantly horizontal.
        expect(dx, 'item should move right by the arrow keys (issue #9)').toBeGreaterThan(0);
        expect(Math.abs(dy), 'ArrowRight move should be horizontal').toBeLessThanOrEqual(Math.abs(dx));

        expect(beforeMove.length).toBeGreaterThan(0);
        expect(afterMove.length).toBeGreaterThan(0);
    });
});
