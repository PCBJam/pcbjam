import * as fs from 'fs';
import * as path from 'path';
import type { Page, CDPSession } from '@playwright/test';
import { injectFileIntoMemfs } from './fs-inject';
import { waitForBoardLoaded } from './board-ready';

/**
 * Runtime-perf helpers for the track-only perf specs (eeschema-perf, pcbnew-perf).
 *
 * Measures the CURRENT build (whatever setup:kicad staged into tests/apps/kicad/):
 * cold load, open+render time, and interaction FPS. No version A/B, no gating —
 * results are logged and written to tests/test-results/perf-<app>.json (gitignored,
 * uploaded by CI). The measurement logic (the #canvas real-input FPS driver, the
 * ready-signal, CDP throttling) is lifted from the validated native-vs-JS-EH
 * benchmark harness — see docs/features/wasm-exceptions/12-native-vs-jseh-benchmark.md.
 */

const MAIN_CANVAS = '#canvas';
const RESULTS_DIR = path.join(__dirname, '..', '..', 'test-results');

type KicadModule = { kicadOpenFile(p: string): unknown };

/** Fully booted editor: visible canvas + wx registry + kicadOpenFile hook + a top-level *Frame. */
export async function waitForReady(page: Page, timeout = 120000): Promise<void> {
    await page.locator(MAIN_CANVAS).waitFor({ state: 'visible', timeout });
    await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout });
    await page.waitForFunction(
        () =>
            typeof (window as unknown as { Module?: KicadModule }).Module?.kicadOpenFile === 'function',
        null,
        { timeout },
    );
    await page.waitForFunction(
        () =>
            !!window.wxElementRegistry &&
            window.wxElementRegistry
                .findAll({ visible: true })
                .some((e) => /Frame$/.test(e.typeName) || (e.name || '').endsWith('Frame')),
        null,
        { timeout },
    );
}

/** Cold load: navigate then wait until fully ready. Returns ms. */
export async function measureLoad(page: Page, url: string, timeout = 120000): Promise<number> {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'commit', timeout });
    await waitForReady(page, timeout);
    return Date.now() - t0;
}

/**
 * Open a document via Module.kicadOpenFile and wait until it's loaded+rendered.
 * 'schematic' polls the editor title; 'board' uses the pcbnew progress-dialog signal.
 * Returns ms.
 */
export async function measureOpenRender(
    page: Page,
    hostPath: string,
    kind: 'schematic' | 'board',
    logger: { consoleLogs: string[]; errors: string[] },
    timeout = 120000,
): Promise<number> {
    const ext = kind === 'board' ? 'kicad_pcb' : 'kicad_sch';
    const memfsPath = `/home/kicad/documents/perf-demo.${ext}`;
    await injectFileIntoMemfs(page, hostPath, memfsPath);
    return openAndWait(page, memfsPath, kind, logger, timeout);
}

/**
 * Open an ALREADY-INJECTED memfs document and wait until loaded+rendered.
 * Split out of measureOpenRender so large fixtures can arrive via
 * fetchIntoMemfs (or any other route) and still get the same timed open.
 */
export async function openAndWait(
    page: Page,
    memfsPath: string,
    kind: 'schematic' | 'board',
    logger: { consoleLogs: string[]; errors: string[] },
    timeout = 120000,
): Promise<number> {
    const stem = memfsPath.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const t0 = Date.now();
    await page.evaluate((p) => {
        (window as unknown as { Module: KicadModule }).Module.kicadOpenFile(p);
    }, memfsPath);

    if (kind === 'board') {
        await waitForBoardLoaded(page, logger, timeout);
    } else {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (new RegExp(stem, 'i').test(await page.title())) break;
            await page.waitForTimeout(200);
        }
    }
    return Date.now() - t0;
}

export interface MemorySample {
    /** WebAssembly linear memory size (Module.HEAPU8.byteLength). */
    wasmHeapBytes: number;
    /** Chromium-only usedJSHeapSize; 0 elsewhere. */
    jsHeapBytes: number;
}

/** One-shot memory census — portable across builds (HEAPU8 verified reachable in both). */
export async function sampleMemory(page: Page): Promise<MemorySample> {
    return await page.evaluate(() => {
        const w = window as unknown as {
            Module?: { HEAPU8?: { byteLength: number }; wasmMemory?: { buffer: ArrayBuffer } };
        };
        const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
        return {
            wasmHeapBytes:
                w.Module?.wasmMemory?.buffer?.byteLength ?? w.Module?.HEAPU8?.byteLength ?? 0,
            jsHeapBytes: perf.memory?.usedJSHeapSize ?? 0,
        };
    });
}

/**
 * In-page wasm-heap peak sampler (250 ms). Start before a heavy operation
 * (board open), stop after — returns the max linear-memory size observed.
 */
export async function startHeapPeakSampler(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as {
            Module?: { HEAPU8?: { byteLength: number }; wasmMemory?: { buffer: ArrayBuffer } };
            __heapPeak?: number;
            __heapPeakTimer?: number;
        };
        if (w.__heapPeakTimer !== undefined) clearInterval(w.__heapPeakTimer);
        w.__heapPeak = 0;
        w.__heapPeakTimer = setInterval(() => {
            const b =
                w.Module?.wasmMemory?.buffer?.byteLength ?? w.Module?.HEAPU8?.byteLength ?? 0;
            if (b > (w.__heapPeak ?? 0)) w.__heapPeak = b;
        }, 250) as unknown as number;
    });
}

export async function stopHeapPeakSampler(page: Page): Promise<number> {
    return await page.evaluate(() => {
        const w = window as unknown as { __heapPeak?: number; __heapPeakTimer?: number };
        if (w.__heapPeakTimer !== undefined) clearInterval(w.__heapPeakTimer);
        w.__heapPeakTimer = undefined;
        return w.__heapPeak ?? 0;
    });
}

/** Resource-timing attribution for the main wasm fetch (download share of loadMs). */
export async function getWasmResourceTiming(
    page: Page,
): Promise<{ durationMs: number; transferSize: number } | null> {
    return await page.evaluate(() => {
        const e = performance
            .getEntriesByType('resource')
            .find((r) => r.name.includes('kicad_editor.wasm')) as PerformanceResourceTiming | undefined;
        return e ? { durationMs: Math.round(e.duration), transferSize: e.transferSize } : null;
    });
}

/** CDP CPU throttling (Chromium only): 1 = none, N = N× slower. */
export async function setThrottle(cdp: CDPSession, rate: number): Promise<void> {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/**
 * Sustained interaction FPS: drive real pan/zoom on #canvas (the emscripten input
 * surface — glcanvas-* can be display:none) for `seconds`, counting main-thread rAF
 * frames. Whatever throttle is currently set applies.
 */
export async function measureFps(page: Page, seconds: number): Promise<number> {
    const box = await page.locator(MAIN_CANVAS).boundingBox();
    if (!box) return 0;
    type W = { __perfFrames: number; __perfRAF?: number };
    // Start ONE rAF frame counter, cancelling any loop left over from a prior call
    // (otherwise loops accumulate across a throttle sweep and inflate the count).
    await page.evaluate(() => {
        const w = window as unknown as W;
        if (w.__perfRAF !== undefined) cancelAnimationFrame(w.__perfRAF);
        w.__perfFrames = 0;
        const loop = () => {
            w.__perfFrames++;
            w.__perfRAF = requestAnimationFrame(loop);
        };
        w.__perfRAF = requestAnimationFrame(loop);
    });
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const start = Date.now();
    let k = 0;
    await page.mouse.move(cx, cy);
    while (Date.now() - start < seconds * 1000) {
        await page.mouse.move(cx + Math.round(120 * Math.sin(k / 3)), cy + Math.round(80 * Math.cos(k / 4)));
        if (k % 3 === 0) await page.mouse.wheel(0, k % 6 < 3 ? -120 : 120);
        k++;
    }
    const elapsed = Date.now() - start;
    const frames = await page.evaluate(() => {
        const w = window as unknown as W;
        if (w.__perfRAF !== undefined) cancelAnimationFrame(w.__perfRAF);
        return w.__perfFrames;
    });
    return +(frames / (elapsed / 1000)).toFixed(1);
}

/**
 * measureFps plus a DISTINCT-frame counter: rAF keeps ticking at vsync even
 * when the GAL skips redraws (draw_panel_gal enforces a min redraw period and
 * re-arms a timer when it can't keep up), so under load the rAF number can
 * decouple from real render throughput. Alongside the rAF loop this samples
 * the largest visible canvas at ~30 Hz (48×48 downscale hash — the
 * waitForCanvasStable technique; GAL sets preserveDrawingBuffer) and counts
 * samples whose content changed. distinctFps is capped by the ~30 Hz sample
 * rate; read it as "real redraws per second, up to 30".
 */
export async function measureFpsDetailed(
    page: Page,
    seconds: number,
): Promise<{ rafFps: number; distinctFps: number }> {
    await page.evaluate(() => {
        const w = window as unknown as {
            __dfPrev?: string;
            __dfCount?: number;
            __dfSamples?: number;
            __dfTimer?: number;
        };
        if (w.__dfTimer !== undefined) clearInterval(w.__dfTimer);
        w.__dfPrev = undefined;
        w.__dfCount = 0;
        w.__dfSamples = 0;
        const scratch = document.createElement('canvas');
        scratch.width = 48;
        scratch.height = 48;
        const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
        w.__dfTimer = setInterval(() => {
            const canvases = Array.from(document.querySelectorAll('canvas')).filter((c) => {
                const r = c.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && c !== scratch;
            });
            if (!canvases.length) return;
            // The GAL draws into a wxGLCanvas (id glcanvas-*), NOT the
            // full-window emscripten #canvas — sample the GL surface where the
            // board pixels actually change, falling back to the largest canvas.
            const gl = canvases.filter((c) => /^glcanvas/.test(c.id));
            const pool = gl.length ? gl : canvases;
            const src = pool.reduce((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return ra.width * ra.height >= rb.width * rb.height ? a : b;
            });
            try {
                ctx.drawImage(src, 0, 0, 48, 48);
                const d = ctx.getImageData(0, 0, 48, 48).data;
                let h = 0;
                for (let i = 0; i < d.length; i += 16) h = ((h << 5) - h + d[i]) | 0;
                const hs = String(h);
                w.__dfSamples = (w.__dfSamples ?? 0) + 1;
                if (w.__dfPrev !== undefined && hs !== w.__dfPrev) w.__dfCount = (w.__dfCount ?? 0) + 1;
                w.__dfPrev = hs;
            } catch {
                /* tainted/zero-size canvas — skip the sample */
            }
        }, 33) as unknown as number;
    });

    const t0 = Date.now();
    const rafFps = await measureFps(page, seconds);
    const elapsed = (Date.now() - t0) / 1000;

    const distinct = await page.evaluate(() => {
        const w = window as unknown as { __dfCount?: number; __dfTimer?: number };
        if (w.__dfTimer !== undefined) clearInterval(w.__dfTimer);
        w.__dfTimer = undefined;
        return w.__dfCount ?? 0;
    });
    return { rafFps, distinctFps: +(distinct / elapsed).toFixed(1) };
}

/** Write per-app results to tests/test-results/perf-<app>.json (gitignored, CI-uploaded). */
export function recordPerf(app: string, data: Record<string, unknown>): void {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const out = { app, when: new Date().toISOString(), ...data };
    fs.writeFileSync(path.join(RESULTS_DIR, `perf-${app}.json`), JSON.stringify(out, null, 2));
    // Also echo a compact line so it lands in the captured test log / CI output.
    // eslint-disable-next-line no-console
    console.log(`[perf] ${app}: ${JSON.stringify(data)}`);
}
