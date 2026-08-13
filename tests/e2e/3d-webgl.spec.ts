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

expect(
  fs.existsSync(APP_JS),
  'CI/current-tree prerequisite: build the 3D WebGL harness before running browser tests',
).toBe(true);

const MANIFEST: { width: number; height: number; scenarios: string[] } = JSON.parse(
  fs.readFileSync(MANIFEST_PATH, 'utf8')
);

test.describe('3D WebGL Regression', () => {
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
