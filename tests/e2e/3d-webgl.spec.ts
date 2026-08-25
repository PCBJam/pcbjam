/**
 * 3D Renderer WebGL Regression — capture-only.
 *
 * Renders every scenario of the 3D suite (tests/3d-regression) in the browser
 * and writes 3d-<name>.png into tests/3d-regression/output/webgl/. This spec
 * never compares pixels: the gates live in `npm run 3d:check:webgl`
 * (browser-regression, once baseline-webgl exists) and the informational
 * `npm run 3d:check:parity` port-progress meter (expected ~100% changed while
 * the FFP stubs render blank — the TDD red state).
 *
 * Anti-drift: no hand-typed scenario list. The committed
 * tests/3d-regression/manifest.json (written by the native golden generator,
 * cmp-guarded by scripts/test-3d-regression.sh) is the single source of truth,
 * and the wasm registry is asserted against it name-by-name.
 */

import { test, expect } from './utils/fixtures';
import * as path from 'path';
import * as fs from 'fs';

const MANIFEST_PATH = path.join(__dirname, '../3d-regression/manifest.json');
const OUTPUT_DIR = path.join(__dirname, '../3d-regression/output/webgl');
const APP_JS = path.join(__dirname, '../apps/3d-webgl/3d_webgl_test.js');

const MANIFEST: { width: number; height: number; scenarios: string[] } = JSON.parse(
  fs.readFileSync(MANIFEST_PATH, 'utf8')
);

test.describe('3D WebGL Regression', () => {
  test.skip(
    !fs.existsSync(APP_JS),
    '3d-webgl harness not built (run scripts/build-3d-webgl-test.sh)'
  );

  test.beforeAll(async () => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  });

  test('module loads and registry matches the committed manifest', async ({ page }) => {
    await page.goto('/3d-webgl/3d_webgl_test.html');

    await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, {
      timeout: 60000,
    });

    const total = await page.evaluate(() => (window as any).threeDTest.getTotalScenarios());
    expect(total).toBe(MANIFEST.scenarios.length);

    const names = await page.evaluate((count) => {
      const t = (window as any).threeDTest;
      return Array.from({ length: count }, (_, i) => t.getScenarioName(i));
    }, total);
    expect(names).toEqual(MANIFEST.scenarios);

    const width = await page.evaluate(() => (window as any).threeDTest.getCanvasWidth());
    const height = await page.evaluate(() => (window as any).threeDTest.getCanvasHeight());
    expect(width).toBe(MANIFEST.width);
    expect(height).toBe(MANIFEST.height);
  });

  /**
   * Regression: WebGL context recreation (the 3D-viewer close/reopen model).
   *
   * The app's viewer close destroys the wxGLCanvas's WebGL context and DOM canvas;
   * reopen creates fresh ones. The gl1 shim caches GL object names (FFP program,
   * stream/scratch VBOs) in statics — pre-fix it kept using names owned by the
   * destroyed context in the new one, so every draw died with INVALID_OPERATION and
   * the reopened viewer rendered blank. recreateContext() reproduces exactly that
   * (fresh canvas element + fresh context, no shim call — the shim must self-detect).
   *
   * Renders redraw-mini-board-navigator (the port-complete gate scenario: display
   * lists, VBO models, grid, gizmo, materials) before and after recreation and
   * requires the second render to be non-blank and pixel-identical-ish to the first.
   */
  test('re-renders identically after WebGL context recreation', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/3d-webgl/3d_webgl_test.html');
    await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, {
      timeout: 60000,
    });

    const name = 'redraw-mini-board-navigator';
    const idx = MANIFEST.scenarios.indexOf(name);
    expect(idx, `${name} must exist in the committed manifest`).toBeGreaterThanOrEqual(0);

    // Snapshot the canvas backing store into an in-page buffer (one drawImage readback,
    // CPU-backed 2D canvas — SwiftShader-safe) plus a 16x16 distinct-colour count.
    const capture = (slot: string) =>
      page.evaluate((s) => {
        const el = document.getElementById('canvas') as HTMLCanvasElement;
        const tmp = document.createElement('canvas');
        tmp.width = el.width;
        tmp.height = el.height;
        const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(el, 0, 0);
        const img = ctx.getImageData(0, 0, el.width, el.height).data;
        (window as any)[s] = img;
        const colors = new Set<string>();
        for (let i = 0; i < 16; i++) {
          for (let j = 0; j < 16; j++) {
            const p =
              (Math.floor((el.height * j) / 16) * el.width + Math.floor((el.width * i) / 16)) * 4;
            colors.add(`${img[p]},${img[p + 1]},${img[p + 2]}`);
          }
        }
        return colors.size;
      }, slot);

    const first = await page.evaluate((i) => (window as any).threeDTest.runScenario(i), idx);
    expect(first, `runScenario(${idx}) [${name}] before recreation`).toBe(0);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const colorsBefore = await capture('__reopenFirst');
    expect(colorsBefore, 'the scenario must render before the context swap').toBeGreaterThan(8);
    // NOT in OUTPUT_DIR: the parity compare treats that dir as scenario renders.
    await page
      .locator('#canvas')
      .screenshot({ path: path.join(OUTPUT_DIR, '..', `3d-ctx-recreate-before.png`) });

    const rc = await page.evaluate(() => (window as any).threeDTest.recreateContext());
    expect(rc, 'recreateContext() should mint a fresh WebGL context').toBe(0);

    const second = await page.evaluate((i) => (window as any).threeDTest.runScenario(i), idx);
    expect(second, `runScenario(${idx}) [${name}] after recreation`).toBe(0);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const colorsAfter = await capture('__reopenSecond');
    await page
      .locator('#canvas')
      .screenshot({ path: path.join(OUTPUT_DIR, '..', `3d-ctx-recreate-after.png`) });

    expect(
      colorsAfter,
      'the re-rendered scenario must not be blank — a uniform canvas means the gl1 shim ' +
        'drew with GL object names from the destroyed context'
    ).toBeGreaterThan(8);

    // Pixel-level identity check (same code, same context attributes → deterministic).
    // Tolerance mirrors the suite's pixelmatch spirit: <0.1% differing pixels.
    const diff = await page.evaluate(() => {
      const a = (window as any).__reopenFirst as Uint8ClampedArray;
      const b = (window as any).__reopenSecond as Uint8ClampedArray;
      if (!a || !b || a.length !== b.length) return { changed: -1, total: 0 };
      let changed = 0;
      for (let p = 0; p < a.length; p += 4) {
        if (
          Math.abs(a[p] - b[p]) > 2 ||
          Math.abs(a[p + 1] - b[p + 1]) > 2 ||
          Math.abs(a[p + 2] - b[p + 2]) > 2
        )
          changed++;
      }
      return { changed, total: a.length / 4 };
    });
    expect(diff.changed, 'both captures must exist and agree in size').toBeGreaterThanOrEqual(0);
    expect(
      diff.changed / diff.total,
      `render after context recreation must match the one before ` +
        `(${diff.changed}/${diff.total} pixels differ)`
    ).toBeLessThan(0.001);
  });

  /**
   * Engine-toggle regressions: the raytracing round-trip poisons the shim's global
   * FFP routing state (a MODEL_3D BeginDrawMulti-style window leaves GL_VERTEX_ARRAY
   * enabled with a VBO captured), after which modern-GL consumers (the raytracer
   * blit, the 2D GAL) get their glDrawArrays misrouted through the FFP pipeline.
   * Three deterministic reproductions of the traced failure modes:
   *  - T1: a misrouted draw must not corrupt the CALLER's VAO (blit collision).
   *  - T2: a draw under a FOREIGN context (the 2D GAL model) must pass through.
   *  - T3: FFP client-array state must die with its context.
   */
  test.describe('FFP routing isolation (engine-toggle model)', () => {
    const glLines = (arr: string[]) => arr.filter((l) => l.includes('[gl1] WebGL context changed'));

    test('T1: misrouted draw does not corrupt the victim VAO', async ({ page }) => {
      await page.goto('/3d-webgl/3d_webgl_test.html');
      await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, { timeout: 60000 });

      const rc = await page.evaluate(() => {
        const t = (window as any).threeDTest;
        const r: Record<string, number> = {};
        r.init = t.appQuadInit();
        r.clean = t.appQuadDraw(1);           // sanity: quad renders before poisoning
        t.ffpMakeStale();                     // the BeginDrawMulti-window leak shape
        r.routed = t.appQuadDraw(0);          // blit-style draw with victim VAO bound → misrouted today
        t.ffpClearStale();                    // later state cleanup (flag off again)
        r.after = t.appQuadDraw(1);           // the victim draws again — must still work
        return r;
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const green = await page.evaluate(() => {
        const el = document.getElementById('canvas') as HTMLCanvasElement;
        const c = document.createElement('canvas');
        c.width = el.width; c.height = el.height;
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.drawImage(el, 0, 0);
        const d = x.getImageData(0, 0, el.width, el.height).data;
        let g = 0, n = 0;
        for (let i = 0; i < 16; i++)
          for (let j = 0; j < 16; j++) {
            const p = (Math.floor((el.height * j) / 16) * el.width + Math.floor((el.width * i) / 16)) * 4;
            n++;
            if (d[p] < 40 && d[p + 1] > 200 && d[p + 2] < 40) g++;
          }
        return g / n;
      });
      console.log(`[TEST] T1 rc=${JSON.stringify(rc)} greenFraction=${green}`);
      expect(rc.init, 'app quad init').toBe(0);
      expect(rc.clean, 'app quad renders before poisoning').toBe(0);
      expect(rc.after,
        'the victim VAO must survive a misrouted draw (nonzero = the shim scribbled its attributes)')
        .toBe(0);
      expect(green,
        'the victim quad must still render green after the misroute (blank = corrupted VAO)')
        .toBeGreaterThan(0.9);
    });

    test('T2: stale FFP flag must not route draws under a foreign context', async ({ page }) => {
      const consoleLines: string[] = [];
      page.on('console', (m) => consoleLines.push(m.text()));

      await page.goto('/3d-webgl/3d_webgl_test.html');
      await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, { timeout: 60000 });

      const rc = await page.evaluate((idx) => {
        const t = (window as any).threeDTest;
        const r: Record<string, number> = {};
        r.scenario = t.runScenario(idx);      // adopt ctx1 as the shim owner (real FFP work)
        t.ffpMakeStale();                     // poison the global mirror under ctx1
        r.ctx2 = t.createSecondContext();     // the "2D GAL" context
        r.use2 = t.useContext(2);
        r.draw2 = t.quadDrawFresh();          // GAL-style modern draw → must pass through
        t.useContext(1);
        (window as any).threeDTest.ffpClearStale();
        return r;
      }, MANIFEST.scenarios.indexOf('redraw-mini-board-navigator'));
      const thrash = glLines(consoleLines);
      console.log(`[TEST] T2 rc=${JSON.stringify(rc)} gl1Lines=${thrash.length}`);
      expect(rc.scenario, 'owner-context scenario render').toBe(0);
      expect(rc.ctx2, 'second context created').toBe(0);
      expect(rc.use2, 'second context current').toBe(0);
      expect(rc.draw2,
        'a modern-GL draw under a foreign context must pass through untouched '
        + '(nonzero = it was routed through the FFP pipeline)')
        .toBe(0);
      expect(thrash,
        'the context guard must not fire for foreign-context draws (thrash)').toEqual([]);
    });

    test('T3: FFP client-array state dies with its context', async ({ page }) => {
      await page.goto('/3d-webgl/3d_webgl_test.html');
      await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, { timeout: 60000 });

      const rc = await page.evaluate(() => {
        const t = (window as any).threeDTest;
        const r: Record<string, number> = {};
        t.ffpMakeStale();                     // poison under the original context
        r.recreate = t.recreateContext();     // context (and its VBO) destroyed
        r.draw = t.quadDrawFresh();           // fresh modern draw in the new context
        return r;
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const green = await page.evaluate(() => {
        const el = document.getElementById('canvas') as HTMLCanvasElement;
        const c = document.createElement('canvas');
        c.width = el.width; c.height = el.height;
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.drawImage(el, 0, 0);
        const d = x.getImageData(0, 0, el.width, el.height).data;
        let g = 0, n = 0;
        for (let i = 0; i < 16; i++)
          for (let j = 0; j < 16; j++) {
            const p = (Math.floor((el.height * j) / 16) * el.width + Math.floor((el.width * i) / 16)) * 4;
            n++;
            if (d[p] < 40 && d[p + 1] > 200 && d[p + 2] < 40) g++;
          }
        return g / n;
      });
      console.log(`[TEST] T3 rc=${JSON.stringify(rc)} greenFraction=${green}`);
      expect(rc.recreate, 'context recreation').toBe(0);
      expect(rc.draw,
        'client-array state from a dead context must not route draws in the new one '
        + '(nonzero = the stale enabled flag survived the context change)')
        .toBe(0);
      expect(green,
        'the fresh-context quad must render green (blank/garbage = draw was routed '
        + 'through the FFP pipeline with dead-context state)')
        .toBeGreaterThan(0.9);
    });
  });

  test('render all scenarios', async ({ page }) => {
    test.setTimeout(300000);

    await page.goto('/3d-webgl/3d_webgl_test.html');
    await page.waitForFunction(() => (window as any).threeDTest?.isReady(), undefined, {
      timeout: 60000,
    });

    for (const [i, name] of MANIFEST.scenarios.entries()) {
      const rc = await page.evaluate((idx) => (window as any).threeDTest.runScenario(idx), i);
      expect(rc, `runScenario(${i}) [${name}]`).toBe(0);

      // One composite tick so the preserved drawing buffer is presentable.
      await page.evaluate(() => new Promise(requestAnimationFrame));

      await page
        .locator('#canvas')
        .screenshot({ path: path.join(OUTPUT_DIR, `3d-${name}.png`) });
    }
  });
});
