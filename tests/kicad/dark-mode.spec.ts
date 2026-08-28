import { test, expect } from './fixtures';
import { compareToReference, hideCursor, pcbnewReferenceFor, PCBNEW_HEADER_REGION } from './utils/screenshot-compare';
import { waitForEditorReady, shotPath } from '../e2e/utils/element-tracker';

/**
 * Dark-mode regression test.
 *
 * The wasm/wxUniversal UI always renders a light theme regardless of the
 * browser's prefers-color-scheme; KIPLATFORM::UI::IsDarkTheme() must report
 * that rendered theme, not the browser preference. When it reported the
 * browser preference, a dark-mode browser got dark-variant (light-stroke)
 * icons and dark widget colours painted onto the light UI.
 *
 * This test loads pcbnew with the browser forced to dark mode and asserts the
 * header (menubar + top toolbar, where the icons live) renders identically to
 * the light-mode reference used by pcbnew.spec.ts.
 */

// colorScheme emulation alone is lost in Firefox on cross-origin-isolated
// pages (the COOP/COEP headers serve.json adds for SharedArrayBuffer put the
// page in an isolated process the override doesn't reach), so also set the
// browser-wide dark-theme pref for the firefox project. launchOptions forces a
// new worker, so this must be top-level rather than inside the describe.
test.use({
    colorScheme: 'dark',
    launchOptions: { firefoxUserPrefs: { 'ui.systemUsesDarkTheme': 1 } },
});

test.describe('PCBnew dark-mode browser', () => {
    test('toolbar icons render the light theme under a dark-mode browser', async ({ page, browserName }) => {
        await page.goto('/kicad/pcbnew.html');

        // Sanity-check the browser really reports dark mode to the app.
        expect(await page.evaluate(() =>
            window.matchMedia('(prefers-color-scheme: dark)').matches
        )).toBe(true);

        await waitForEditorReady(page);
        await hideCursor(page);

        const cssScreenshot = await page.screenshot({
            path: shotPath(page, 'pcbnew-dark-mode-loaded.png'),
            scale: 'css'
        });

        const reference = await compareToReference(page, cssScreenshot, pcbnewReferenceFor(browserName), PCBNEW_HEADER_REGION);

        expect(reference.actualWidth).toBe(reference.referenceWidth);
        expect(reference.actualHeight).toBe(reference.referenceHeight);
        expect(reference.diffRatio, 'header diff ratio vs light-mode reference').toBeLessThan(PCBNEW_HEADER_REGION.maxDiffRatio);
        expect(reference.meanChannelDiff, 'header mean channel diff vs light-mode reference').toBeLessThan(PCBNEW_HEADER_REGION.maxMeanChannelDiff);
    });
});
