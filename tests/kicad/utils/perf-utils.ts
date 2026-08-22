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
 * Count completed GAL frames instead of rAF ticks.
 *
 * A GAL frame ends with the compositor blitting to the DEFAULT framebuffer, so a
 * run of draws issued while no framebuffer is bound is exactly one frame. The run
 * has to be collapsed: the number of present draws per frame depends on the AA
 * mode (1 under supersampling, 2 under AA_NONE, +1 when the crosshair is drawn),
 * but a run *boundary* happens once per frame in every mode — so no divisor.
 *
 * Wrapping the prototypes works even though the context already exists: methods
 * resolve on the prototype at call time, not at context creation. The initial
 * framebuffer binding is assumed to be the default and self-corrects on the first
 * bindFramebuffer, which the GAL issues several times per frame.
 */
async function installGalFrameCounter(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __galFrames?: number; __galHooked?: boolean };
        w.__galFrames = 0;
        if (w.__galHooked) return;
        w.__galHooked = true;
        const protos = [
            (window as unknown as { WebGL2RenderingContext?: { prototype: object } }).WebGL2RenderingContext,
            (window as unknown as { WebGLRenderingContext?: { prototype: object } }).WebGLRenderingContext,
        ].filter(Boolean) as Array<{ prototype: Record<string, unknown> }>;
        const state = new WeakMap<object, { fb: unknown; inPresent: boolean }>();
        const st = (ctx: object) => {
            let s = state.get(ctx);
            if (!s) { s = { fb: null, inPresent: false }; state.set(ctx, s); }
            return s;
        };
        const DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
        for (const proto of protos) {
            for (const name of ['bindFramebuffer', ...DRAWS]) {
                const orig = proto.prototype[name] as ((...a: unknown[]) => unknown) | undefined;
                if (typeof orig !== 'function') continue;
                const isDraw = DRAWS.indexOf(name) >= 0;
                proto.prototype[name] = function (this: object, ...args: unknown[]) {
                    const s = st(this);
                    if (!isDraw) {
                        s.fb = args[1];
                        if (args[1]) s.inPresent = false;
                    } else if (s.fb === null || s.fb === undefined) {
                        if (!s.inPresent) { s.inPresent = true; w.__galFrames = (w.__galFrames ?? 0) + 1; }
                    } else {
                        s.inPresent = false;
                    }
                    return orig.apply(this, args);
                };
            }
        }
    });
}

/** Zoom-to-fit, so every measurement starts from the same visible geometry. */
async function resetViewToFit(page: Page, cx: number, cy: number): Promise<void> {
    await page.mouse.move(cx, cy);
    await page.keyboard.press('Escape').catch(() => {}); // eslint-disable-line -- best-effort
    await page.keyboard.press('Home').catch(() => {});   // eslint-disable-line -- best-effort
    await page.waitForFunction(() => true, null, { timeout: 5000 });
}

/**
 * Sustained interaction FPS, reported two ways.
 *
 * `galFps` is the real one: completed GAL frames per second (see
 * installGalFrameCounter). `rafFps` is the legacy main-thread requestAnimationFrame
 * count, kept only so historical CI numbers stay comparable — it is NOT a frame
 * rate. rAF ticks on the compositor's schedule whether or not the GAL redrew, so
 * it can read 120 while the renderer is completely stalled (measured: the 80 MB
 * jetson board on a software rasteriser renders 0 frames while rAF reports 120).
 *
 * The drive is a pure middle-drag PAN. Wheel zoom used to be mixed into the same
 * loop, and it makes the metric unusable: zooming continuously changes how much
 * geometry is on screen, so the result depends on where the wheel happens to
 * leave the view. Measured spread across three identical repeats was ±20%
 * (34.7 / 42.1 / 27.1 fps) with zoom in the loop, versus ±2% (19.9 / 19.0 / 19.6)
 * for pan alone. Pan also keeps the workload honest — it continuously reveals
 * geometry that has to be cached, which is the expensive path.
 *
 * The view is zoomed to fit first, so every run starts from the same visible
 * geometry (the whole board — the worst case) rather than inheriting whatever
 * zoom level the previous measurement left behind.
 */
export async function measureInteractionFps(
    page: Page,
    seconds: number,
): Promise<{ rafFps: number; galFps: number }> {
    const box = await page.locator(MAIN_CANVAS).boundingBox();
    if (!box) return { rafFps: 0, galFps: 0 };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await resetViewToFit(page, cx, cy);
    await installGalFrameCounter(page);

    type W = { __perfFrames: number; __perfRAF?: number; __galFrames?: number };
    await page.evaluate(() => {
        const w = window as unknown as W;
        if (w.__perfRAF !== undefined) cancelAnimationFrame(w.__perfRAF);
        w.__perfFrames = 0;
        w.__galFrames = 0;
        const loop = () => {
            w.__perfFrames++;
            w.__perfRAF = requestAnimationFrame(loop);
        };
        w.__perfRAF = requestAnimationFrame(loop);
    });
    const start = Date.now();
    let k = 0;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'middle' });
    while (Date.now() - start < seconds * 1000) {
        await page.mouse.move(cx + Math.round(140 * Math.sin(k / 6)), cy + Math.round(90 * Math.cos(k / 7)));
        k++;
    }
    await page.mouse.up({ button: 'middle' });
    const elapsed = Date.now() - start;
    const counts = await page.evaluate(() => {
        const w = window as unknown as W;
        if (w.__perfRAF !== undefined) cancelAnimationFrame(w.__perfRAF);
        return { raf: w.__perfFrames, gal: w.__galFrames ?? 0 };
    });
    const secs = elapsed / 1000;
    return { rafFps: +(counts.raf / secs).toFixed(1), galFps: +(counts.gal / secs).toFixed(1) };
}

/**
 * Sustained interaction FPS: drive real pan/zoom on #canvas (the emscripten input
 * surface — glcanvas-* can be display:none) for `seconds`, counting main-thread rAF
 * frames. Whatever throttle is currently set applies.
 *
 * @deprecated rAF ticks are not GAL frames — use measureInteractionFps().galFps.
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
