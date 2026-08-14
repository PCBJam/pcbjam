import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    measureLoad,
    measureOpenRender,
    openAndWait,
    measureFpsDetailed,
    setThrottle,
    sampleMemory,
    startHeapPeakSampler,
    stopHeapPeakSampler,
    getWasmResourceTiming,
} from './utils/perf-utils';
import { fetchIntoMemfs } from './utils/fs-inject';
import { waitForBoardLoaded } from './utils/board-ready';

/**
 * Large-board perf battery (TRACK-ONLY, bench-driven). Extends pcbnew-perf with
 * the measurements the JSPI-vs-asyncify comparison needs: repeated cold loads,
 * open+render of a REAL large board (vme-wren: 1508 footprints / 24 858
 * segments), rAF + distinct-frame FPS under CPU throttle, and wasm-heap /
 * JS-heap checkpoints. Results append to
 * tests/test-results/perf-bench-<arm>.ndjson (gitignored), one JSON row per
 * measurement, each row carrying the sha256 of the wasm actually measured so
 * A/B artifact swaps can't get misattributed.
 *
 * Gated behind PERF_LARGE=1 so the CI perf project (which matches
 * *-perf.spec.ts) is unaffected. Fixtures are expected in
 * tests/apps/kicad/board/ (gitignored) — see docs/features/async/
 * migration-evidence/jspi-vs-asyncify-bench-2026-08.md for the bench flow.
 */

const ARM = process.env.BENCH_ARM || 'current';
const LOAD_RUNS = parseInt(process.env.PERF_LOAD_RUNS || '5', 10);
const OPEN_RUNS = parseInt(process.env.PERF_OPEN_RUNS || '3', 10);
const THROTTLES = (process.env.PERF_THROTTLES || '1,4,6').split(',').map(Number);
const FPS_SECS = parseInt(process.env.PERF_FPS_SECS || '6', 10);
const FPS_REPS = parseInt(process.env.PERF_FPS_REPS || '2', 10);

const APPS_KICAD = path.join(__dirname, '..', 'apps', 'kicad');
const DEMO = path.join(__dirname, '..', 'fixtures', 'demo', 'demo.kicad_pcb');
const VME_URL = '/kicad/board/vme-wren.kicad_pcb';
const JETSON_URL = '/kicad/board/jetson-agx-thor-baseboard.kicad_pcb';
// NOT under test-results/ — Playwright clears that whole dir at session start,
// so an A/B pair of invocations would each wipe the other arm's rows.
const RESULTS = path.join(__dirname, '..', 'bench-results', `perf-bench-${ARM}.ndjson`);

let wasmSha = '';
function wasmSha256(): string {
    if (!wasmSha) {
        const bytes = fs.readFileSync(path.join(APPS_KICAD, 'kicad_editor.wasm'));
        wasmSha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    }
    return wasmSha;
}

function record(section: string, data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
    const row = { arm: ARM, sha256: wasmSha256(), when: new Date().toISOString(), section, ...data };
    fs.appendFileSync(RESULTS, JSON.stringify(row) + '\n');
    // eslint-disable-next-line no-console
    console.log(`[bench] ${section}: ${JSON.stringify(data)}`);
}

test.describe('pcbnew large-board bench', () => {
    test.skip(!process.env.PERF_LARGE, 'bench battery — run with PERF_LARGE=1');

    for (let run = 0; run < LOAD_RUNS; run++) {
        test(`cold load #${run + 1}`, async ({ page }) => {
            test.setTimeout(300000);
            const loadMs = await measureLoad(page, '/kicad/pcbnew.html');
            const wasmFetch = await getWasmResourceTiming(page);
            const mem = await sampleMemory(page);
            record('load', { run: run + 1, loadMs, wasmFetch, bootMem: mem });
            expect(loadMs).toBeGreaterThan(0);
        });
    }

    test('cold load with CDP pre-attached (tier-down sanity)', async ({ page }) => {
        test.setTimeout(300000);
        const cdp = await page.context().newCDPSession(page);
        await setThrottle(cdp, 1); // attach + a no-op emulation command, like the FPS path
        const loadMs = await measureLoad(page, '/kicad/pcbnew.html');
        record('load-cdp-sanity', { loadMs });
        expect(loadMs).toBeGreaterThan(0);
    });

    for (let run = 0; run < OPEN_RUNS; run++) {
        test(`open demo board #${run + 1}`, async ({ page, testLogger }) => {
            test.setTimeout(300000);
            await measureLoad(page, '/kicad/pcbnew.html');
            const openMs = await measureOpenRender(page, DEMO, 'board', testLogger);
            const mem = await sampleMemory(page);
            record('open-demo', { run: run + 1, openMs, postOpenMem: mem });
            expect(openMs).toBeGreaterThan(0);
        });
    }

    for (let run = 0; run < OPEN_RUNS; run++) {
        test(`open vme-wren (27.7 MB) #${run + 1}`, async ({ page, testLogger }) => {
            test.setTimeout(600000);
            await measureLoad(page, '/kicad/pcbnew.html');
            const bytes = await fetchIntoMemfs(page, VME_URL, '/home/kicad/documents/vme-wren.kicad_pcb');
            await startHeapPeakSampler(page);
            const openMs = await openAndWait(
                page,
                '/home/kicad/documents/vme-wren.kicad_pcb',
                'board',
                testLogger,
                480000,
            );
            const peak = await stopHeapPeakSampler(page);
            const mem = await sampleMemory(page);
            record('open-vme', { run: run + 1, bytes, openMs, openPeakHeap: peak, postOpenMem: mem });
            expect(openMs).toBeGreaterThan(0);
        });
    }

    test('FPS on vme-wren across throttles', async ({ page, testLogger }) => {
        test.setTimeout(900000);
        await measureLoad(page, '/kicad/pcbnew.html');
        await fetchIntoMemfs(page, VME_URL, '/home/kicad/documents/vme-wren.kicad_pcb');
        await openAndWait(page, '/home/kicad/documents/vme-wren.kicad_pcb', 'board', testLogger, 480000);
        await page.keyboard.press('Escape').catch(() => {}); // eslint-disable-line -- best-effort Escape

        const cdp = await page.context().newCDPSession(page);
        for (const rate of THROTTLES) {
            await setThrottle(cdp, rate);
            for (let rep = 0; rep < FPS_REPS; rep++) {
                const f = await measureFpsDetailed(page, FPS_SECS);
                record('fps-vme', { throttle: rate, rep: rep + 1, ...f });
                expect(f.rafFps).toBeGreaterThan(0);
            }
        }
        await setThrottle(cdp, 1);
        const mem = await sampleMemory(page);
        record('fps-vme-postmem', { postFpsMem: mem });
    });

    test('open jetson-agx-thor (80.9 MB) — outcome, OOM allowed', async ({ page, testLogger }) => {
        test.setTimeout(900000);
        await measureLoad(page, '/kicad/pcbnew.html');
        const bytes = await fetchIntoMemfs(
            page,
            JETSON_URL,
            '/home/kicad/documents/jetson-agx-thor-baseboard.kicad_pcb',
        );
        await startHeapPeakSampler(page);
        const t0 = Date.now();
        try {
            await page.evaluate(() => {
                (window as unknown as { Module: { kicadOpenFile(p: string): unknown } }).Module.kicadOpenFile(
                    '/home/kicad/documents/jetson-agx-thor-baseboard.kicad_pcb',
                );
            });
            await waitForBoardLoaded(page, testLogger, 780000);
            const peak = await stopHeapPeakSampler(page);
            const mem = await sampleMemory(page);
            record('open-jetson', {
                bytes,
                outcome: 'loaded',
                openMs: Date.now() - t0,
                openPeakHeap: peak,
                postOpenMem: mem,
            });
        } catch (e) {
            // A 4 GB-cap OOM / abort is a RESULT for this stress tier, not a harness error.
            const peak = await stopHeapPeakSampler(page).catch(() => -1);
            record('open-jetson', {
                bytes,
                outcome: 'failed',
                afterMs: Date.now() - t0,
                openPeakHeap: peak,
                error: String(e).slice(0, 300),
            });
        }
    });
});
