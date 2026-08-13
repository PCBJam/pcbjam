import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText } from '../../e2e/utils/element-tracker';
import { injectFromSubmodule } from './fs-inject';
import { openBoardProgrammatically } from './board-ready';

// Shared helpers for the 3D-viewer specs (3d-viewer.spec.ts + 3d-viewer-deadlock.spec.ts).

// KiCad 10 stores projects under /home/kicad/documents/kicad/10.0/projects.
export const KICAD_VERSION_DIR = '10.0';
export const PROJECT_DIR_MEMFS = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

// pic_programmer frames correctly in the default 3D camera (the microwave demo
// has a known board-bounding-box scale bug that projects it off-screen — a
// separate follow-up). Loads cleanly in this harness (see 2D load tests).
export const DEMO = { name: 'pic_programmer', dir: 'pic_programmer', stem: 'pic_programmer' } as const;

export async function loadBoard(
    page: Page,
    testLogger: { consoleLogs: string[]; errors: string[] },
): Promise<void> {
    const pcbFilename = `${DEMO.stem}.kicad_pcb`;
    const proFilename = `${DEMO.stem}.kicad_pro`;

    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pcbFilename}`,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${proFilename}`,
        `${PROJECT_DIR_MEMFS}/${proFilename}`);

    const result = await openBoardProgrammatically(
        page,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`,
        DEMO.stem,
        testLogger,
        60000,
    );
    console.log(`[TEST] ${DEMO.name} board-ready result: ${result}`);
}

export function countGlCanvases(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll('canvas[id^="glcanvas-"]').length);
}

// Resource-diagnostic snapshot for the heavy 3D-viewer specs. On CI these can kill the tab
// (renderer OOM, a lost WebGL context when the shared GPU process passes its ~16-context cap,
// or a raytracer pthread deadlock) and the failure surfaces identically ("Target crashed" /
// black canvas). Logging hardwareConcurrency, the emscripten pthread-pool ledger, the live
// GL-canvas count, and the wasm/JS heap sizes right before an interaction makes any recurrence
// attributable (GL-context exhaustion vs heap-OOM vs deadlock) — and confirms, on the real CI
// VM, what navigator.hardwareConcurrency actually is (the whole 2N+8 pool sizing depends on it).
// Best-effort: never throws, so it can't itself fail a spec.
export async function logThreeDDiag(page: Page, label: string): Promise<void> {
    const snap = await page.evaluate(() => {
        const w = window as unknown as { Module?: Record<string, unknown> };
        const M = (w.Module ?? {}) as Record<string, unknown>;
        const P = (M.PThread ?? {}) as { unusedWorkers?: unknown[]; runningWorkers?: unknown[] };
        const heap = M.HEAPU8 as { length?: number } | undefined;
        const perf = (performance as unknown as { memory?: Record<string, number> }).memory ?? {};
        const mb = (b?: number) => (typeof b === 'number' ? Math.round(b / 1048576) : null);
        return {
            hardwareConcurrency: navigator.hardwareConcurrency,
            // emscripten pool ledger: pre-warmed-but-idle + currently-running Workers.
            pthreadUnused: Array.isArray(P.unusedWorkers) ? P.unusedWorkers.length : null,
            pthreadRunning: Array.isArray(P.runningWorkers) ? P.runningWorkers.length : null,
            glCanvases: document.querySelectorAll('canvas[id^="glcanvas-"]').length,
            canvases: document.querySelectorAll('canvas').length,
            wasmHeapMB: mb(heap?.length),
            jsHeapUsedMB: mb(perf.usedJSHeapSize),
            jsHeapLimitMB: mb(perf.jsHeapSizeLimit),
        };
    }).catch((e: unknown) => ({ error: String(e) }));
    console.log(`[DIAG ${label}] ${JSON.stringify(snap)}`);
}

// Open the 3D viewer (View → 3D Viewer, with an Alt+3 fallback) and wait for the
// secondary frame + its NEW `glcanvas-*` to appear. The main pcbnew board view is
// itself a wxGLCanvas, so the viewer is detected by the GL-canvas COUNT increasing.
// Returns the glcanvas count after opening. `glBefore` is the count beforehand.
export async function openThreeDViewer(page: Page, glBefore: number): Promise<number> {
    // Open View → 3D Viewer deterministically (clickMenuItemByText waits for the item to
    // render, then clicks — no fixed post-menu sleep and no Alt+3 fallback that could mask
    // a real menu regression).
    expect(await clickMenuBarItem(page, 'View'), 'View menu should be findable').toBe(true);
    await clickMenuItemByText(page, '3D Viewer');

    // 180s (not 60s): opening the viewer kicks the scene build + first render. On CI
    // (headless SwiftShader software WebGL, 30 contended vCPUs) the raytracer-era run
    // 28649537489 opened in <60s but with little margin; a real GPU returns in ~2s. The
    // larger cap is CI headroom only — it never slows a passing run.
    await page.waitForFunction(() => {
        // A new top-level window div beyond the main pcbnew frame.
        return !!document.querySelector('#window-container [id^="window-"]')
            || document.querySelectorAll('canvas[id^="glcanvas-"]').length > 0;
    }, null, { timeout: 180000 });

    await page.waitForFunction((before: number) =>
        document.querySelectorAll('canvas[id^="glcanvas-"]').length > before,
        glBefore, { timeout: 180000 });

    const glAfter = await countGlCanvases(page);
    console.log(`[TEST] glcanvas count after opening 3D viewer: ${glAfter}`);
    expect(glAfter, 'a new WebGL canvas should appear for the 3D viewer').toBeGreaterThan(glBefore);
    return glAfter;
}

/**
 * Return the DOM window that owns the real 3D viewer chrome.
 *
 * Do not identify it as "the first window id created after the menu click".
 * Board-load warnings and other auxiliary top-level windows can finish their
 * delayed creation in the same interval.  The title-bar text is the stable
 * semantic identity supplied by EDA_3D_VIEWER_FRAME itself.
 */
export async function waitForThreeDViewerWindow(page: Page): Promise<string> {
    const findViewerWindow = () => {
        const title = Array.from(document.querySelectorAll<HTMLElement>(
            '#window-container .window-titlebar-text'))
            .find((el) => el.textContent?.trim() === '3D Viewer');
        return title?.closest<HTMLElement>('[id^="window-"]')?.id ?? null;
    };

    await page.waitForFunction(findViewerWindow, null, { timeout: 60000 });
    const id = await page.evaluate(findViewerWindow);
    expect(id, 'the 3D viewer should own a titled top-level DOM window').toBeTruthy();
    return id as string;
}

/**
 * Return the visible GL surface owned by the 3D viewer.
 *
 * DOM creation order is not an identity: the viewer can create later hidden
 * helper canvases while it resolves models.  The viewer surface is visible,
 * has a real client area, and occupies the raised secondary-frame z-layer.
 */
export async function waitForThreeDViewerCanvas(page: Page): Promise<string> {
    const findViewerCanvas = () => {
        const candidates = Array.from(document.querySelectorAll<HTMLCanvasElement>(
            '#window-container canvas[id^="glcanvas-"]'))
            .map((canvas) => {
                const style = getComputedStyle(canvas);
                const rect = canvas.getBoundingClientRect();
                return {
                    canvas,
                    visible: style.display !== 'none' && style.visibility !== 'hidden',
                    z: parseInt(style.zIndex, 10) || 0,
                    area: rect.width * rect.height,
                    sequence: parseInt(canvas.id.replace(/^glcanvas-/, ''), 10) || 0,
                };
            })
            .filter((candidate) => candidate.visible)
            // Pick identity before readiness.  The viewer's raised canvas is
            // briefly 20x20 during bootstrap; filtering by area first would
            // latch onto the older, already-large main-editor GAL canvas.
            .sort((a, b) => b.z - a.z || b.sequence - a.sequence || b.area - a.area);

        const viewer = candidates[0];
        return viewer && viewer.area > 32 * 32 ? viewer.canvas.id : null;
    };

    await page.waitForFunction(findViewerCanvas, null, { timeout: 60000 });
    const id = await page.evaluate(findViewerCanvas);
    expect(id, 'the 3D viewer should own a visible GL canvas').toBeTruthy();
    return id as string;
}

// Wait until the identified viewer canvas actually shows a rendered scene (> minColors distinct
// colours on a 16×16 grid) instead of sleeping a fixed interval. The viewer's first frame
// can lag the canvas's creation, especially on CI's software WebGL under parallel load —
// sampling too early reads an all-black backbuffer, which is exactly main's live 3D flake
// (run 28698861536: 3d-viewer.spec:26 flaky; run 28666407570: the deadlock spec red with an
// all-zero pixel signature). One full-frame read per 1s poll on a CPU-backed 2D canvas —
// NOT per-pixel getImageData calls, which are a GPU round-trip each and stall SwiftShader
// ("GPU stall due to ReadPixels").
export async function waitForThreeDRender(
    page: Page, minColors = 8, timeoutMs = 90000,
): Promise<void> {
    const canvasId = await waitForThreeDViewerCanvas(page);
    await page.waitForFunction(([id, min]: [string, number]) => {
        const el = document.getElementById(id) as HTMLCanvasElement | null;
        if (!el || !el.width || !el.height) return false;
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
        return colors.size > min;
    }, [canvasId, minColors] as [string, number], { timeout: timeoutMs, polling: 1000 });
}
