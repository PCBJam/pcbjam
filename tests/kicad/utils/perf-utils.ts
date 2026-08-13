import * as fs from 'fs';
import * as path from 'path';
import type { Page, CDPSession } from '@playwright/test';
import { injectFileIntoMemfs } from './fs-inject';
import { openBoardProgrammatically } from './board-ready';
import { waitForCanvasStable } from '../../e2e/utils/element-tracker';

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

type KicadModule = { kicadOpenFile(p: string): Promise<unknown> };

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

    const t0 = Date.now();
    if (kind === 'board') {
        await openBoardProgrammatically(page, memfsPath, 'perf-demo', logger, timeout);
    } else {
        await page.evaluate(async (p) => {
            await (window as unknown as { Module: KicadModule }).Module.kicadOpenFile(p);
        }, memfsPath);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (/perf-demo/i.test(await page.title())) break;
            await page.waitForTimeout(200);
        }
        if (!/perf-demo/i.test(await page.title())) {
            throw new Error(`Timed out waiting for schematic title after ${timeout}ms`);
        }
        await waitForCanvasStable(page, MAIN_CANVAS, { timeout });
    }
    return Date.now() - t0;
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

/** Write per-app results to tests/test-results/perf-<app>.json (gitignored, CI-uploaded). */
export function recordPerf(app: string, data: Record<string, unknown>): void {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const out = { app, when: new Date().toISOString(), ...data };
    fs.writeFileSync(path.join(RESULTS_DIR, `perf-${app}.json`), JSON.stringify(out, null, 2));
    // Also echo a compact line so it lands in the captured test log / CI output.
    // eslint-disable-next-line no-console
    console.log(`[perf] ${app}: ${JSON.stringify(data)}`);
}
