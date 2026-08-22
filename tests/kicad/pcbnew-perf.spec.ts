import { test, expect } from './fixtures';
import * as path from 'path';
import { measureLoad, measureOpenRender, measureInteractionFps, setThrottle, recordPerf } from './utils/perf-utils';

/**
 * pcbnew runtime-perf (TRACK-ONLY, no gating). Mirrors eeschema-perf for the board editor.
 *
 * Measures the CURRENT build: cold load, open+render of the demo board, and sustained
 * pan FPS across CPU-throttle rates → tests/test-results/perf-pcbnew.json (CI uploads it).
 * Runs on the Chromium 'perf' project (pcbnew's big module OOMs Firefox/SpiderMonkey anyway,
 * and CDP throttling is Chromium-only). Only asserts booted + opened; never a perf threshold.
 */

const THROTTLES = (process.env.PERF_THROTTLES || '1,4,6').split(',').map(Number);
const FPS_SECS = parseInt(process.env.PERF_FPS_SECS || '6', 10);
const DEMO = path.join(__dirname, '..', 'fixtures', 'demo', 'demo.kicad_pcb');

test.describe('pcbnew perf', () => {
    test('load + open+render + FPS (track-only)', async ({ page, testLogger }) => {
        test.setTimeout(300000);

        const loadMs = await measureLoad(page, '/kicad/pcbnew.html');
        console.log(`[perf] pcbnew cold load = ${loadMs} ms`);

        const openMs = await measureOpenRender(page, DEMO, 'board', testLogger);
        console.log(`[perf] pcbnew open+render = ${openMs} ms`);
        await page.keyboard.press('Escape').catch(() => {});  // eslint-disable-line -- best-effort Escape (may not apply in all states)

        const cdp = await page.context().newCDPSession(page);
        // galFps is the real frame rate (completed GAL frames). fps is the legacy
        // rAF tick count, kept so historical CI numbers stay comparable.
        const fps: { throttle: number; fps: number; galFps: number }[] = [];
        for (const rate of THROTTLES) {
            await setThrottle(cdp, rate);
            const f = await measureInteractionFps(page, FPS_SECS);
            console.log(`[perf] pcbnew @ ${rate}x: GAL ${f.galFps} fps (rAF ${f.rafFps})`);
            fps.push({ throttle: rate, fps: f.rafFps, galFps: f.galFps });
        }
        await setThrottle(cdp, 1);

        recordPerf('pcbnew', { loadMs, openMs, fps });

        expect(loadMs).toBeGreaterThan(0);
        expect(openMs).toBeGreaterThan(0);
    });
});
