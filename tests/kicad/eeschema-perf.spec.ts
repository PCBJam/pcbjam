import { test, expect } from './fixtures';
import * as path from 'path';
import { measureLoad, measureOpenRender, measureInteractionFps, setThrottle, recordPerf } from './utils/perf-utils';

/**
 * eeschema runtime-perf (TRACK-ONLY, no gating).
 *
 * Measures the CURRENT build: cold load, open+render of the demo schematic, and
 * sustained pan FPS across CPU-throttle rates. Numbers are logged and written
 * to tests/test-results/perf-eeschema.json (CI uploads it). The only assertions are
 * "the app booted and the doc opened" — never a perf threshold (would flake CI).
 * Runs on the Chromium 'perf' project (CDP throttling); pass --headed for real-GPU FPS.
 * Note: on headless/SwiftShader CI, FPS is CPU-bound and noisy — openMs is the stable metric.
 */

const THROTTLES = (process.env.PERF_THROTTLES || '1,4,6').split(',').map(Number);
const FPS_SECS = parseInt(process.env.PERF_FPS_SECS || '6', 10);
const DEMO = path.join(__dirname, '..', 'fixtures', 'demo', 'demo.kicad_sch');

test.describe('eeschema perf', () => {
    test('load + open+render + FPS (track-only)', async ({ page, testLogger }) => {
        test.setTimeout(300000);

        const loadMs = await measureLoad(page, '/kicad/eeschema.html');
        console.log(`[perf] eeschema cold load = ${loadMs} ms`);

        const openMs = await measureOpenRender(page, DEMO, 'schematic', testLogger);
        console.log(`[perf] eeschema open+render = ${openMs} ms`);
        await page.keyboard.press('Escape').catch(() => {});  // eslint-disable-line -- best-effort Escape (may not apply in all states)

        const cdp = await page.context().newCDPSession(page);
        // galFps is the real frame rate (completed GAL frames). fps is the legacy
        // rAF tick count, kept so historical CI numbers stay comparable.
        const fps: { throttle: number; fps: number; galFps: number }[] = [];
        for (const rate of THROTTLES) {
            await setThrottle(cdp, rate);
            const f = await measureInteractionFps(page, FPS_SECS);
            console.log(`[perf] eeschema @ ${rate}x: GAL ${f.galFps} fps (rAF ${f.rafFps})`);
            fps.push({ throttle: rate, fps: f.rafFps, galFps: f.galFps });
        }
        await setThrottle(cdp, 1);

        recordPerf('eeschema', { loadMs, openMs, fps });

        // Track-only: assert only that it booted + opened.
        expect(loadMs).toBeGreaterThan(0);
        expect(openMs).toBeGreaterThan(0);
    });
});
