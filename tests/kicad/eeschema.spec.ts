import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    clickByTooltip,
    findByTooltip,
    waitForCanvasStable,
    waitForEditorReady,
    waitUntil, stableShot, shotPath } from '../e2e/utils/element-tracker';

/**
 * Eeschema (schematic editor) WASM E2E Tests
 *
 * eeschema.html seeds a default KiCad config in preRun, so the shared first-run
 * setup wizard never opens — the editor comes straight up and we wait
 * deterministically for its canvas + toolbars.
 *
 * Determinism: no waitForTimeout. The launch screenshot uses stableShot
 * (stabilizes before comparing). The wire-drawing test proves a wire actually
 * rendered via a functional before/after pixel diff (compareScreenshots) — that is
 * NOT a visual-regression baseline, so it captures to a Buffer and gates on
 * waitForCanvasStable (the canvas stops changing) instead of a fixed sleep.
 */

type CanvasMetrics = {
    dpr: number;
    mainCanvas: null | { width: number; height: number; rectWidth: number; rectHeight: number };
    glCanvas: null | { id: string; width: number; height: number; rectWidth: number; rectHeight: number; viewport: number[] | null };
};

type DiffRegion = { x: number; y: number; width: number; height: number };

type ScreenshotDifference = {
    actualWidth: number;
    actualHeight: number;
    diffPixels: number;
    diffRatio: number;
    meanChannelDiff: number;
};

async function compareScreenshots(
    page: Page,
    beforePng: Buffer,
    afterPng: Buffer,
    region: DiffRegion
): Promise<ScreenshotDifference> {
    return page.evaluate(async ({ beforeBase64, afterBase64, crop }) => {
        const loadImage = async (base64: string): Promise<HTMLImageElement> => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            return image;
        };

        const [before, after] = await Promise.all([loadImage(beforeBase64), loadImage(afterBase64)]);

        if (before.width !== after.width || before.height !== after.height) {
            return {
                actualWidth: after.width,
                actualHeight: after.height,
                diffPixels: Number.POSITIVE_INFINITY,
                diffRatio: Number.POSITIVE_INFINITY,
                meanChannelDiff: Number.POSITIVE_INFINITY,
            };
        }

        const canvas = document.createElement('canvas');
        canvas.width = crop.width;
        canvas.height = crop.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('2D canvas context unavailable for screenshot comparison');

        context.drawImage(before, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        const beforeData = context.getImageData(0, 0, canvas.width, canvas.height).data;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(after, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        const afterData = context.getImageData(0, 0, canvas.width, canvas.height).data;

        let diffPixels = 0;
        let totalChannelDiff = 0;
        for (let i = 0; i < beforeData.length; i += 4) {
            const dr = Math.abs(beforeData[i] - afterData[i]);
            const dg = Math.abs(beforeData[i + 1] - afterData[i + 1]);
            const db = Math.abs(beforeData[i + 2] - afterData[i + 2]);
            const da = Math.abs(beforeData[i + 3] - afterData[i + 3]);
            totalChannelDiff += dr + dg + db + da;
            if (Math.max(dr, dg, db, da) > 16) diffPixels += 1;
        }

        return {
            actualWidth: after.width,
            actualHeight: after.height,
            diffPixels,
            diffRatio: diffPixels / (canvas.width * canvas.height),
            meanChannelDiff: totalChannelDiff / beforeData.length,
        };
    }, { beforeBase64: beforePng.toString('base64'), afterBase64: afterPng.toString('base64'), crop: region });
}

async function getCanvasMetrics(page: Page): Promise<CanvasMetrics> {
    return page.evaluate(() => {
        const dpr = window.devicePixelRatio || 1;
        const mainCanvas = document.querySelector('#canvas') as HTMLCanvasElement | null;
        const glCanvas =
            Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
                .map((canvas) => canvas as HTMLCanvasElement)
                .find((canvas) => {
                    const rect = canvas.getBoundingClientRect();
                    const style = window.getComputedStyle(canvas);
                    return style.display !== 'none' && rect.width > 0 && rect.height > 0;
                }) ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null);

        const mainRect = mainCanvas?.getBoundingClientRect();
        const glRect = glCanvas?.getBoundingClientRect();
        const gl = glCanvas?.getContext('webgl2') || glCanvas?.getContext('webgl');
        const viewport = gl ? Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array | number[]) : null;

        return {
            dpr,
            mainCanvas: mainCanvas && mainRect ? {
                width: mainCanvas.width, height: mainCanvas.height,
                rectWidth: mainRect.width, rectHeight: mainRect.height,
            } : null,
            glCanvas: glCanvas && glRect ? {
                id: glCanvas.id, width: glCanvas.width, height: glCanvas.height,
                rectWidth: glRect.width, rectHeight: glRect.height, viewport,
            } : null,
        };
    });
}

async function hideCursor(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.documentElement.style.cursor = 'none';
        document.body.style.cursor = 'none';
    });
}

test.describe('Eeschema WASM', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/eeschema.html');
    });

    test('loads Eeschema with sane canvas + toolbar metrics', async ({ page }) => {
        await waitForEditorReady(page);
        const metrics = await getCanvasMetrics(page);

        const toolbarCount = await page.evaluate(() => {
            const r = window.wxElementRegistry!;
            return r.findAll({ visible: true }).filter((el) => /ToolBar/.test(el.typeName)).length;
        });

        expect(metrics.dpr).toBeGreaterThanOrEqual(1);
        expect(metrics.mainCanvas).not.toBeNull();
        expect(metrics.glCanvas).not.toBeNull();
        expect(toolbarCount).toBeGreaterThanOrEqual(2);

        const mainCanvas = metrics.mainCanvas!;
        const glCanvas = metrics.glCanvas!;

        expect(Math.round(mainCanvas.rectWidth * metrics.dpr)).toBe(mainCanvas.width);
        expect(Math.round(mainCanvas.rectHeight * metrics.dpr)).toBe(mainCanvas.height);
        expect(glCanvas.rectWidth).toBeGreaterThan(800);
        expect(glCanvas.rectHeight).toBeGreaterThan(500);
        expect(Math.round(glCanvas.rectWidth * metrics.dpr)).toBe(glCanvas.width);
        expect(Math.round(glCanvas.rectHeight * metrics.dpr)).toBe(glCanvas.height);

        const viewport = glCanvas.viewport;
        expect(viewport).not.toBeNull();
        expect(viewport![2]).toBe(glCanvas.width);
        expect(viewport![3]).toBe(glCanvas.height);

        await hideCursor(page);
        await stableShot(page, 'eeschema-loaded-css.png');
        await stableShot(page, 'eeschema-loaded.png');

        const canvasCount = await page.locator('canvas').count();
        expect(canvasCount).toBeGreaterThan(0);
    });

    test('select draw wires and draw on the schematic', async ({ page, testLogger }) => {
        await waitForEditorReady(page);
        await hideCursor(page);

        // Wait for the Draw Wires tool to render into the toolbar registry.
        await waitUntil(
            page,
            () => {
                const r = window.wxElementRegistry;
                if (!r?.findAllRendered) return false;
                return r.findAllRendered({ elementType: 'tool' })
                    .some((tool) => tool.tooltip?.includes('Draw Wires'));
            },
            'Draw Wires tool rendered',
        );

        const drawWiresTool = await findByTooltip(page, 'Draw Wires', { elementType: 'tool' });
        expect(drawWiresTool, 'Draw Wires tool present in rendered registry').not.toBeNull();

        // The registry carries checked state via a " [checked]" label suffix appended
        // by wxAuiToolBar::OnPaint on Emscripten — no schema change.
        const isToolChecked = (t: { label?: string } | null | undefined) => (t?.label ?? '').includes('[checked]');

        expect(drawWiresTool!.enabled).toBe(true);
        expect(isToolChecked(drawWiresTool)).toBe(false);
        const baselineErrorCount = testLogger.errors.length;

        await stableShot(page, 'eeschema-draw-wires-00-before-tool-click.png');

        // Select the tool and confirm it latches checked.
        expect(await clickByTooltip(page, 'Draw Wires', { elementType: 'tool' })).toBe(true);
        await expect.poll(async () => isToolChecked(await findByTooltip(page, 'Draw Wires', { elementType: 'tool' })), {
            message: 'Draw Wires tool should stay selected after the click',
            timeout: 5000,
        }).toBe(true);

        // Resolve the visible GL canvas.
        const glCanvasId = await page.evaluate(() => {
            const glCanvas =
                Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
                    .map((canvas) => canvas as HTMLCanvasElement)
                    .find((canvas) => {
                        const rect = canvas.getBoundingClientRect();
                        const style = window.getComputedStyle(canvas);
                        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
                    }) ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null);
            return glCanvas?.id ?? null;
        });
        expect(glCanvasId, 'a visible GL canvas exists').not.toBeNull();
        const glSel = `#${glCanvasId}`;

        const glCanvasBox = await page.locator(glSel).boundingBox();
        expect(glCanvasBox, 'GL canvas bounding box available').not.toBeNull();
        const box = glCanvasBox!;

        const startPoint = {
            x: Math.round(box.x + box.width * 0.28),
            y: Math.round(box.y + box.height * 0.36),
        };
        const endPoint = {
            x: Math.round(box.x + box.width * 0.48),
            y: Math.round(box.y + box.height * 0.47),
        };

        // Move the crosshair onto the canvas so the GAL takes hover focus. Moving the
        // crosshair IS a visible change, so this settle is deterministic.
        await page.mouse.move(640, 360);
        await waitForCanvasStable(page, glSel);
        const afterToolClick = await page.screenshot({ path: shotPath(page, 'eeschema-draw-wires-01-after-click.png'), scale: 'css' });

        // Draw a wire: click a start vertex, then an end vertex. These two waits are the
        // ONE place in the converted suite that still uses a fixed delay: a wire vertex
        // commit produces no JS-observable signal (no registry entry, and click(start)
        // makes no pixel change to settle on), so we cannot poll a real condition — and
        // the suspending WASM event loop needs wall-clock time to process each click as a
        // discrete mouse event (proven: replacing these with canvas-stability waits, which
        // return in ~3 frames, leaves the wire uncommitted). Making this deterministic
        // needs a KiCad-side "tool operation idle" hook (see the render-idle plan);
        // tracked as the canonical hard-interaction follow-up.
        await page.mouse.click(startPoint.x, startPoint.y);
        await page.waitForTimeout(250); // eslint-disable-line -- see comment above
        await page.mouse.click(endPoint.x, endPoint.y);
        await page.waitForTimeout(750); // eslint-disable-line -- see comment above

        const afterDrawing = await page.screenshot({ path: shotPath(page, 'eeschema-draw-wires-02-after-drawing.png'), scale: 'css' });

        const diffRegion: DiffRegion = {
            x: Math.max(0, Math.min(startPoint.x, endPoint.x) - 24),
            y: Math.max(0, Math.min(startPoint.y, endPoint.y) - 24),
            width: Math.abs(endPoint.x - startPoint.x) + 48,
            height: Math.abs(endPoint.y - startPoint.y) + 48,
        };
        const drawingDiff = await compareScreenshots(page, afterToolClick, afterDrawing, diffRegion);

        // A drawn wire produces ~340 changed pixels / ~0.0095 ratio here (measured,
        // deterministic across runs). diffPixels is the primary witness; the ratio/mean
        // thresholds are set below the measured signal with margin for CI's software render.
        expect(drawingDiff.diffPixels).toBeGreaterThan(120);
        expect(drawingDiff.diffRatio).toBeGreaterThan(0.005);
        expect(drawingDiff.meanChannelDiff).toBeGreaterThan(0.4);

        const realErrors = testLogger.errors.slice(baselineErrorCount).filter((error) => !error.includes('favicon'));
        expect(realErrors).toEqual([]);
    });
});
