/**
 * GAL WebGL Regression Test
 *
 * Runs all 28 GAL test scenarios in WebGL and captures screenshots
 * for comparison against native OpenGL rendering.
 */

import { test, expect } from './utils/fixtures';
import type { Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { PNG } from 'pngjs';

// Scenario names (must match native test)
const SCENARIO_NAMES = [
  'basic-lines',      // 0
  'line-widths',      // 1
  'circles',          // 2
  'arcs',             // 3
  'rectangles',       // 4
  'polygons',         // 5
  'alpha-blending',   // 6
  'transforms',       // 7
  'grid-cursor',      // 8
  'segments',         // 9
  'complex-scene',    // 10
  'bezier-curves',    // 11
  'arc-segments',     // 12
  'segment-chain',    // 13
  'group-caching',    // 14
  'polylines-multi',  // 15
  'hole-walls',       // 16
  'grid-native',      // 17
  'cursor-native',    // 18
  'render-targets',   // 19
  'screen-transform', // 20
  'clear-colors',     // 21
  'depth-testing',    // 22
  'negative-mode',    // 23
  'text-attrs',       // 24
  'glyphs',           // 25
  'bitmap',           // 26
  'transform-api'     // 27
];

// Output directory for WebGL screenshots
const OUTPUT_DIR = path.join(__dirname, '../gal-regression/output/webgl');

const RUNTIME_FAILURE = /Aborted\(|missing function|unreachable|mainWindow is not defined|assert .*GetTopWindow/i;

type GalLogger = { consoleLogs: string[]; errors: string[] };

async function waitForGalReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return (window as any).galTest?.isReady() === true;
  }, { timeout: 60000 });

  await expect(page.locator('.gl-canvas')).toHaveCount(1);
  await expect(page.locator('.gl-canvas')).toBeVisible();
}

async function assertGalOverlayGeometry(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const host = document.getElementById('main-window')!.getBoundingClientRect();
    const overlay = document.getElementById('window-container')!.getBoundingClientRect();
    const canvas = document.querySelector('.gl-canvas')!.getBoundingClientRect();

    return {
      host: { left: host.left, top: host.top, right: host.right, bottom: host.bottom },
      overlay: {
        left: overlay.left,
        top: overlay.top,
        right: overlay.right,
        bottom: overlay.bottom,
        position: getComputedStyle(document.getElementById('window-container')!).position,
      },
      canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom },
    };
  });

  expect(geometry.overlay.position).toBe('absolute');
  expect(Math.abs(geometry.overlay.left - geometry.host.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.overlay.top - geometry.host.top)).toBeLessThanOrEqual(1);
  expect(geometry.canvas.right).toBeGreaterThan(geometry.host.left);
  expect(geometry.canvas.left).toBeLessThan(geometry.host.right);
  expect(geometry.canvas.bottom).toBeGreaterThan(geometry.host.top);
  expect(geometry.canvas.top).toBeLessThan(geometry.host.bottom);
}

function assertHealthyRuntime(testLogger: GalLogger): void {
  const failures = [...testLogger.consoleLogs, ...testLogger.errors]
    .filter((line) => RUNTIME_FAILURE.test(line));
  expect(failures, 'GAL runtime must not abort or use an undefined symbol').toEqual([]);
  expect(testLogger.errors.filter((line) => !line.includes('favicon')), 'no page errors').toEqual([]);
}

function assertRenderedPixels(screenshot: Buffer, scenarioName: string): void {
  const png = PNG.sync.read(screenshot);
  const first = png.data.subarray(0, 4);
  let differs = false;

  for (let offset = 4; offset < png.data.length; offset += 4) {
    if (png.data[offset] !== first[0]
        || png.data[offset + 1] !== first[1]
        || png.data[offset + 2] !== first[2]
        || png.data[offset + 3] !== first[3]) {
      differs = true;
      break;
    }
  }

  expect(differs, `${scenarioName} must render more than one pixel color`).toBe(true);
}

test.describe('GAL WebGL Regression Tests', () => {
  test.beforeAll(async () => {
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  });

  test('Load GAL WebGL test module', async ({ page, testLogger }) => {
    await page.goto('/gal-webgl/gal_webgl_test.html');

    await waitForGalReady(page);
    await assertGalOverlayGeometry(page);

    // Verify module loaded
    const totalScenarios = await page.evaluate(() => {
      return (window as any).galTest.getTotalScenarios();
    });

    expect(totalScenarios).toBe(28);

    const canvasSize = await page.locator('.gl-canvas').evaluate((canvas: HTMLCanvasElement) => ({
      width: canvas.width,
      height: canvas.height,
    }));
    expect(canvasSize).toEqual({ width: 1600, height: 1200 });
    assertHealthyRuntime(testLogger);

    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'gal-module-loaded.png'),
      fullPage: true
    });

    console.log(`GAL WebGL test module loaded with ${totalScenarios} scenarios`);
  });

  test('same-tab reload retires the old paint pump cleanly', async ({ page, testLogger }) => {
    await page.goto('/gal-webgl/gal_webgl_test.html');
    await waitForGalReady(page);

    // Keep the same Page so console output from the outgoing document remains
    // observable.  A fresh Page per test used to miss the last admitted rAF
    // paint after the old document had removed its top-level window.
    await page.goto('/gal-webgl/gal_webgl_test.html');
    await waitForGalReady(page);

    assertHealthyRuntime(testLogger);
  });

  // Generate a test for each scenario
  for (let i = 0; i < SCENARIO_NAMES.length; i++) {
    const scenarioName = SCENARIO_NAMES[i];
    const scenarioIndex = i;

    test(`Scenario ${scenarioIndex}: ${scenarioName}`, async ({ page, testLogger }) => {
      await page.goto('/gal-webgl/gal_webgl_test.html');

      await waitForGalReady(page);

      // Run the scenario
      const result = await page.evaluate((index) => {
        return (window as any).galTest.runScenario(index);
      }, scenarioIndex);
      expect(result).toBe(0);

      // Wait deterministically for rendering to complete: runScenario reports
      // success by logging `[GAL Test] Rendered: <name>` (setStatus).
      await expect.poll(
        () => page.locator('#status').textContent(),
        { message: `scenario ${scenarioName} did not report render completion` }
      ).toContain(`Rendered: ${scenarioName}`);

      const canvas = page.locator('.gl-canvas');

      // Hide controls overlay before screenshot (it sits on top of canvas)
      await page.locator('#controls-overlay').evaluate(el => el.style.visibility = 'hidden');

      // Screenshot the canvas (matching native 800x600 output)
      const screenshotPath = path.join(OUTPUT_DIR, `gal-${scenarioName}.png`);
      const screenshot = await canvas.screenshot({ path: screenshotPath });
      assertRenderedPixels(screenshot, scenarioName);

      // Restore overlay for manual debugging
      await page.locator('#controls-overlay').evaluate(el => el.style.visibility = 'visible');

      assertHealthyRuntime(testLogger);

      console.log(`Saved: ${screenshotPath}`);
    });
  }

  test('Run all scenarios sequentially', async ({ page, testLogger }) => {
    await page.goto('/gal-webgl/gal_webgl_test.html');

    await waitForGalReady(page);

    console.log('Running all 28 scenarios...');

    const canvas = page.locator('.gl-canvas');

    for (let i = 0; i < SCENARIO_NAMES.length; i++) {
      const scenarioName = SCENARIO_NAMES[i];

      // Run scenario
      const result = await page.evaluate((index) => {
        return (window as any).galTest.runScenario(index);
      }, i);
      expect(result).toBe(0);

      // Wait deterministically for rendering to complete: on success runScenario
      // sets the status element to `Rendered: <name>` (setStatus).
      await expect.poll(
        () => page.evaluate(() => document.getElementById('status')?.textContent ?? ''),
        { message: `scenario ${scenarioName} did not report render completion` }
      ).toContain(`Rendered: ${scenarioName}`);

      // Hide controls overlay before screenshot
      await page.locator('#controls-overlay').evaluate(el => el.style.visibility = 'hidden');

      // Screenshot the GL canvas
      const screenshotPath = path.join(OUTPUT_DIR, `gal-${scenarioName}.png`);
      const screenshot = await canvas.screenshot({ path: screenshotPath });
      assertRenderedPixels(screenshot, scenarioName);

      // Restore overlay
      await page.locator('#controls-overlay').evaluate(el => el.style.visibility = 'visible');

      console.log(`[${i + 1}/28] ${scenarioName}`);
    }

    assertHealthyRuntime(testLogger);
    console.log('All scenarios completed');
  });
});
