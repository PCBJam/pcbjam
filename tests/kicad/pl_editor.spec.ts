import { test, expect } from './fixtures';
import {
    clickMenuBarItem,
    clickMenuItem,
    waitForEditorReady,
    waitForRenderedByLabel,
    waitUntil, stableShot } from '../e2e/utils/element-tracker';

/**
 * pl_editor (drawing-sheet editor) WASM E2E Tests
 *
 * Mirrors eeschema.spec.ts. Smoke + the wxFileDialog folder-navigation
 * regression we fixed at the wxWidgets level (filedlgg.cpp). The widget-level
 * coverage lives in tests/e2e/filedialog-folder-nav.spec.ts; this file proves
 * the fix also works through pl_editor's own File menu.
 *
 * Determinism: no waitForTimeout, no "if element exists" branches, no retries.
 * Screenshots use stableShot(page, name): it re-captures until the frame stops
 * changing, then writes the PNG for the offline compare gate — that is what makes
 * e.g. the Save As dialog shot reliable (it used to catch the file list mid-paint
 * as a black rectangle behind a fixed 600ms sleep).
 */

function hasAbort(testLogger: { consoleLogs: string[]; errors: string[] }): boolean {
    return [...testLogger.consoleLogs, ...testLogger.errors].some(line => line.includes('Aborted('));
}

test.describe('pl_editor WASM', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/pl_editor.html');
    });

    test('app loads, canvas visible, no WASM abort', async ({ page, testLogger }) => {
        await waitForEditorReady(page);
        await stableShot(page, 'pl_editor-01-loaded.png');

        expect(hasAbort(testLogger), 'no WASM abort during load').toBe(false);

        const canvasCount = await page.locator('canvas').count();
        expect(canvasCount).toBeGreaterThan(0);
    });

    test('first-run wizard is skipped by the seeded config (none appears)', async ({ page, testLogger }) => {
        // The harness seeds a default KiCad config in preRun (like the web app's
        // boot.ts), so STARTWIZARD::CheckAndRun() finds NeedsUserInput()==false and
        // never opens the modal wizard. The editor therefore comes straight up —
        // assert no wizard/dialog is ever visible.
        await waitForEditorReady(page);

        const blockingDialogs = await page.evaluate(() => {
            const registry = window.wxElementRegistry!;
            return registry.findAll({ visible: true })
                .filter((el) => /^wxDialog|Wizard/.test(el.typeName))
                .length;
        });
        expect(blockingDialogs, 'no setup wizard/dialog should be visible (seed skipped it)').toBe(0);
        expect(hasAbort(testLogger), 'no WASM abort during launch').toBe(false);

        await stableShot(page, 'pl_editor-02-no-wizard.png');
    });

    test('File menu exposes Open... and Save As...', async ({ page, testLogger }) => {
        await waitForEditorReady(page);

        const fileMenuClicked = await clickMenuBarItem(page, 'File');
        expect(fileMenuClicked, 'File menubar item should be clickable').toBe(true);

        // Wait for the popup menu to actually render its items (replaces waitForTimeout(400)).
        await waitUntil(
            page,
            () => {
                const r = window.wxElementRegistry;
                if (!r || !r.findAllRendered) return false;
                return r.findAllRendered({})
                    .filter((el) => el.elementType === 'menuitem')
                    .length > 3;
            },
            'File menu items rendered',
        );

        await stableShot(page, 'pl_editor-03-file-menu.png');

        const menuLabels = await page.evaluate(() => {
            const registry = window.wxElementRegistry!;
            return registry.findAllRendered!({})
                .filter((r) => r.elementType === 'menuitem')
                .map((r) => r.label || '')
                .filter((l) => l.length > 0);
        });

        // wxWidgets labels typically end with "..." (three ASCII dots) but some
        // builds use the Unicode horizontal ellipsis "…". Accept either.
        const hasOpen = menuLabels.some(l => /^Open[\.…]/.test(l) || l === 'Open');
        const hasSaveAs = menuLabels.some(l => /^Save As[\.…]/.test(l) || l === 'Save As');
        expect(hasOpen, `menu should contain "Open..." (saw labels: ${menuLabels.slice(0, 30).join(', ')})`).toBe(true);
        expect(hasSaveAs, `menu should contain "Save As..." (saw labels: ${menuLabels.slice(0, 30).join(', ')})`).toBe(true);

        // Dismiss the menu. beforeEach re-navigates to a fresh page, so there's no
        // cross-test leak to wait on — and menu closure isn't what this test asserts.
        await page.keyboard.press('Escape');

        expect(hasAbort(testLogger)).toBe(false);
    });

    test('Save As file dialog: typing a folder + Enter navigates into it (regression)', async ({ page, testLogger }) => {
        await waitForEditorReady(page);

        // Open File > Save As
        await clickMenuBarItem(page, 'File');
        await waitForRenderedByLabel(page, 'Save As...', { elementType: 'menuitem' });
        const savedAsClicked = await clickMenuItem(page, 'Save As...');
        expect(savedAsClicked, 'Save As... menu item should be clickable').toBe(true);

        // Wait for the wxFileDialog to appear in the registry.
        await waitUntil(
            page,
            () => {
                const r = window.wxElementRegistry;
                if (!r) return false;
                return r.findAll({ visible: true })
                    .some((el) => el.typeName === 'wxFileDialog');
            },
            'wxFileDialog visible',
        );

        // The dialog object exists in the registry as soon as C++ constructs it, but the
        // directory enumeration (MEMFS readdir → JSPI suspend) hasn't returned yet so
        // the inner file list isn't painted. stableShot's stabilization waits for the
        // list to finish painting — deterministically replacing the old waitForTimeout(600)
        // that used to catch the dialog as a black rectangle.
        await stableShot(page, 'pl_editor-04-save-as-dialog.png');

        // The bug: pressing Enter on a folder name treated it as a file and surfaced
        // "Unable to load /dev file". After the OnOk fix, the dialog should navigate
        // into the folder instead.
        await page.keyboard.type('/dev');
        await page.keyboard.press('Enter');

        await stableShot(page, 'pl_editor-04b-after-enter.png');

        // The wxFileDialog should still be visible — we navigated into /dev, didn't close it.
        const dialogStillOpen = await page.evaluate(() => {
            const registry = window.wxElementRegistry!;
            return registry.findAll({ visible: true })
                .some((el) => el.typeName === 'wxFileDialog');
        });
        expect(dialogStillOpen, 'wxFileDialog should remain open after Enter on a folder').toBe(true);

        // The pre-fix error path surfaced "Unable to load <path> file" through KiCad's
        // logger when the folder was returned as a "file". Ensure it didn't fire.
        const unableToLoad = testLogger.consoleLogs.some(l => /Unable to load.*\/dev/.test(l));
        expect(unableToLoad, 'KiCad must not surface "Unable to load /dev file"').toBe(false);

        // Close the dialog cleanly so it doesn't leak to a subsequent step.
        await page.keyboard.press('Escape');

        expect(hasAbort(testLogger)).toBe(false);
    });

    test('canvas + toolbar metrics look sane', async ({ page, testLogger }) => {
        await waitForEditorReady(page);

        const metrics = await page.evaluate(() => {
            const registry = window.wxElementRegistry!;
            const all = registry.findAll({ visible: true });
            const toolbars = all.filter((el) => /ToolBar/.test(el.typeName));
            const glCanvas = document.querySelector('canvas[id*="gl"]') as HTMLCanvasElement | null;

            return {
                registryTotal: all.length,
                toolbarCount: toolbars.length,
                mainCanvasOk: (() => {
                    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
                    return !!c && c.width > 0 && c.height > 0;
                })(),
                glCanvasOk: !!glCanvas && glCanvas.width > 0 && glCanvas.height > 0,
            };
        });

        expect(metrics.registryTotal, 'registry should be populated').toBeGreaterThan(10);
        expect(metrics.toolbarCount, 'at least one toolbar should be visible').toBeGreaterThanOrEqual(1);
        expect(metrics.mainCanvasOk, 'main canvas has nonzero dimensions').toBe(true);
        expect(metrics.glCanvasOk, 'GL canvas has nonzero dimensions').toBe(true);
        expect(hasAbort(testLogger)).toBe(false);
    });
});
