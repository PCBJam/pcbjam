// UI Polish Test - Regression guards for the wasm-ui-polish fixes
// (wxwidgets wasm-port commit 4a02a39c07).
//
// The C++ app (tests/apps/standalone/uipolish/uipolish_test.cpp) runs
// self-asserting checks at boot and logs one "[UIPOLISH_TEST] <check>: PASS/
// FAIL" line each plus a "done checks=N pass=N" summary:
//   clip-clear / clip-empty / clip-box  DC clip box reaches the canvas
//     (pre-fix every clip was empty and the JS layer disabled clipping —
//     the collapsed wire-properties-panel bug)
//   blit-origin   Blit honors the source DC device origin (wxBufferedDC)
//   mask-alpha    ConvertToImage carries wxMask as alpha (infobar close btn)
//   scaled-dims   ConvertToImage returns physical size for scaled bitmaps
//   checkbox-floor  wxCheckBox best-height floor (selection-filter density)
//   statbmp-best  wxStaticBitmap best size is the bundle's LOGICAL size
//
// statbmp-best only discriminates at devicePixelRatio >= 1.5 (pre-fix the
// FromPhys path inflated 16 -> 32 there), so a second pass runs the app at
// deviceScaleFactor: 2 and additionally asserts the <img> ships the 32px
// asset at 16 CSS px — the crisp-layer-eyes contract.
//
// Determinism: no waitForTimeout; readiness via waitForWxApp plus polling for
// the app's own "done" summary line.
import { test, expect, waitForWxApp } from './utils/fixtures';
import { stableShot } from './utils/element-tracker';
import { Page } from '@playwright/test';

const CHECKS = [
  'clip-clear',
  'clip-empty',
  'clip-box',
  'blit-origin',
  'mask-alpha',
  'scaled-dims',
  'checkbox-floor',
  'statbmp-best',
];

async function waitForDone(page: Page, logs: string[]) {
  await expect.poll(
    () => logs.some((l) => l.includes('[UIPOLISH_TEST] done checks=')),
    { message: 'app should log its check summary' },
  ).toBe(true);
}

function collectUipolishLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[UIPOLISH_TEST]')) logs.push(text);
  });
  return logs;
}

function assertChecks(logs: string[]) {
  for (const check of CHECKS) {
    const pass = logs.some((l) => l.includes(`[UIPOLISH_TEST] ${check}: PASS`));
    const fail = logs.find((l) => l.includes(`[UIPOLISH_TEST] ${check}: FAIL`));
    expect(fail, `${check} must not FAIL (${fail ?? ''})`).toBeUndefined();
    expect(pass, `${check} must PASS`).toBe(true);
  }
}

test.describe('UI Polish regression guards', () => {
  test('all DC/bestsize checks pass at default DPR', async ({ page }) => {
    const logs = collectUipolishLogs(page);
    await page.goto('/standalone/uipolish/uipolish_test.html');
    await waitForWxApp(page);
    await waitForDone(page, logs);

    await stableShot(page, 'uipolish-01-default-dpr.png', { fullPage: true });

    assertChecks(logs);
  });
});

test.describe('UI Polish regression guards @2x', () => {
  // statbmp-best is only a regression guard on a hi-DPI display: pre-fix the
  // base DoGetBestSize inflated the layout box to physical pixels (32) once
  // GetDPIScaleFactor() >= 1.5.
  test.use({ deviceScaleFactor: 2 });

  test('statbmp lays out at logical size and ships the 2x asset', async ({ page }) => {
    const logs = collectUipolishLogs(page);
    await page.goto('/standalone/uipolish/uipolish_test.html');
    await waitForWxApp(page);
    await waitForDone(page, logs);

    await stableShot(page, 'uipolish-02-hidpi.png', { fullPage: true });

    assertChecks(logs);

    // The frame's wxStaticBitmap is the only <img> control in the app: it must
    // ship the hi-res 32px asset but occupy the LOGICAL 16 CSS px.
    const img = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('img.wx-dom-control'))
        .map((e) => e as HTMLImageElement)
        .find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { naturalWidth: el.naturalWidth, cssWidth: Math.round(r.width) };
    });
    expect(img, 'the statbmp <img> should exist').not.toBeNull();
    expect(img!.naturalWidth, 'should ship the 2x (32px) asset').toBe(32);
    expect(img!.cssWidth, 'should occupy the logical 16 CSS px').toBe(16);
  });
});
