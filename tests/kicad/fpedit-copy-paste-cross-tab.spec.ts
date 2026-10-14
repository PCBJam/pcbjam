import { test, expect } from './fixtures';
import { editorAction, editorFootprint, loadInEditor, openEcc83WithFootprintEditor, PRETTY_MEMFS } from './utils/fpedit-lib';

/**
 * Footprint Editor "Copy Footprint" in one tab, "Paste Footprint" in another.
 *
 * Each browser tab is its own KiCad, and Copy Footprint kept the footprint in
 * FOOTPRINT_EDITOR_CONTROL::m_copiedFootprint only, so the other tab had
 * nothing to paste. Fix (footprint_editor_control.cpp, wasm only): Copy also
 * puts the footprint on the system clipboard as .kicad_mod text, and Paste
 * takes a footprint from the clipboard.
 *
 * Chromium only: Playwright can't grant Firefox clipboard read/write.
 */

const SRC = 'Valve_ECC-83-1';

test('Copy Footprint in one tab, Paste Footprint in another', async ({ page, context, browserName, testLogger }) => {
    test.skip(browserName === 'firefox', 'firefox cannot grant clipboard read/write to tests');
    test.setTimeout(300000);

    // Tab A: copy the library footprint.
    await openEcc83WithFootprintEditor(page, testLogger);
    await loadInEditor(page, SRC);
    await page.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-BEFORE-COPY'));
    await editorAction(page, 'pcbnew.ModuleEditor.copyFootprint', SRC);
    await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: 'copied footprint on the clipboard', timeout: 30000 })
        .toMatch(new RegExp(`^\\s*\\(footprint "${SRC}"`));

    // Tab B: a separate KiCad; paste into the same-named library.
    const tabB = await context.newPage();
    const logB = { consoleLogs: [] as string[], errors: [] as string[] };
    tabB.on('console', (m) => logB.consoleLogs.push(`[${m.type()}] ${m.text()}`));
    await openEcc83WithFootprintEditor(tabB, logB);
    await loadInEditor(tabB, 'C_Disc_D4.7mm_W2.5mm_P5.00mm');
    await tabB.bringToFront();
    await editorAction(tabB, 'pcbnew.ModuleEditor.pasteFootprint');

    // The name exists, so the paste lands as <name>_copy, saved and opened.
    await expect.poll(() => editorFootprint(tabB), { message: 'pasted footprint open in tab B', timeout: 60000 })
        .toMatch(new RegExp(`^Footprints:${SRC}_copy\\|`));
    const saved = await tabB.evaluate((p) => {
        const FS = (window as any).FS;
        try { return FS.readFile(p, { encoding: 'utf8' }) as string; } catch { return ''; }
    }, `${PRETTY_MEMFS}/${SRC}_copy.kicad_mod`);
    expect(saved, 'pasted footprint saved into the library').toContain(`(footprint "${SRC}_copy"`);
    await tabB.close();
});
