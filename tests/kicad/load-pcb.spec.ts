import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    clickMenuBarItem,
    clickMenuItem,
    waitForEditorReady,
    waitForRenderedByLabel,
    waitUntil, stableShot, shotPath } from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';
import { waitForBoardLoaded } from './utils/board-ready';

/**
 * Spike test: load real .kicad_pcb demos through pcbnew's File → Open.
 *
 * Flow (parametrized for each demo below):
 *   1. Wait for pcbnew to come up (dismiss the first-run KiCad Setup wizard
 *      if it appears — depends on whether MEMFS already has config).
 *   2. Inject the demo's .kicad_pcb (+ .kicad_pro for completeness) into
 *      MEMFS at PATHS::GetDefaultUserProjectsPath() — confirmed by
 *      load-pcb-probe.spec.ts to be /home/kicad/documents/kicad/10.0/projects/.
 *   3. Drive File → Open via menu helpers.
 *   4. Click on the file row in wxFileListCtrl (wasm port doesn't register
 *      listctrl rows in wxElementRegistry, so we click by the filelist's
 *      bounding box), then focus the filename text input and press Enter to
 *      trigger wxGenericFileDialog's accept path. (A direct OK button click
 *      doesn't dismiss the dialog in the wasm port; the listctrl row click
 *      populates the text input but doesn't mark the row selected enough for
 *      OK to satisfy validation.)
 *   5. Dismiss any post-load info dialogs (missing-libs etc. — pic_programmer
 *      uses local footprint libs and may pop one of these).
 *   6. Wait until the file dialog and the LoadBoard progress dialog both go
 *      away. Screenshot the loaded board, named per-demo.
 *
 * The board load itself was crashing in `Classify` inside `rtree.h` until we
 * fixed the wasm-only `ELEMTYPEREAL = intptr_t` (32-bit on wasm32) typo at
 * `kicad/libs/kimath/src/geometry/shape_poly_set.cpp:1927`. See
 * `features/<branch>/rtree-debug-findings.md` for the full trail.
 */

// KiCad 10 stores projects under /home/kicad/documents/kicad/10.0/projects
// (GetMajorMinorVersion() = "10.0"); the old WASM port used "9.99".
const KICAD_VERSION_DIR = '10.0';
const PROJECT_DIR_MEMFS = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

type DemoCfg = {
    name: string;        // appears in test name & screenshot filename
    dir: string;         // folder under kicad/demos/
    stem: string;        // file stem (kicad_pcb / kicad_pro)
};

const DEMOS: DemoCfg[] = [
    {
        // RF-polygon-heavy board — small, no external libs, was the case that
        // tripped the rtree overflow in the first place.
        name: 'microwave',
        dir: 'microwave',
        stem: 'microwave',
    },
    {
        // "Normal" through-hole/SMD design — larger (~698 KB), uses local
        // footprint libs from its own project tree (may pop a missing-libs
        // warning, which we dismiss before screenshotting).
        name: 'pic_programmer',
        dir: 'pic_programmer',
        stem: 'pic_programmer',
    },
];

function runLoadPcbTest(demo: DemoCfg): void {
    const pcbFilename = `${demo.stem}.kicad_pcb`;
    const proFilename = `${demo.stem}.kicad_pro`;

    test(`opens ${demo.name} demo from MEMFS through the wxFileDialog`, async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);
        await stableShot(page, `load-pcb-${demo.name}-00-pcbnew-ready.png`);

        // ── Inject .kicad_pcb + .kicad_pro into the dialog's start dir. ──
        await injectFromSubmodule(
            page,
            `kicad/demos/${demo.dir}/${pcbFilename}`,
            `${PROJECT_DIR_MEMFS}/${pcbFilename}`,
        );
        await injectFromSubmodule(
            page,
            `kicad/demos/${demo.dir}/${proFilename}`,
            `${PROJECT_DIR_MEMFS}/${proFilename}`,
        );

        // ── Drive the menu. ────────────────────────────────────────────
        const fileClicked = await clickMenuBarItem(page, 'File');
        expect(fileClicked, 'File menu should be findable').toBe(true);
        await waitUntil(
            page,
            () => {
                const r = window.wxElementRegistry;
                if (!r?.findAllRendered) return false;
                return r.findAllRendered({ elementType: 'menuitem' }).length > 3;
            },
            'File menu items rendered',
        );

        // Items register progressively while the popup paints — wait for the one
        // we click (clickMenuItem is single-shot; the >3-items gate isn't enough).
        await waitForRenderedByLabel(page, 'Open...', { elementType: 'menuitem' });
        const openClicked = await clickMenuItem(page, 'Open...');
        expect(openClicked, 'Open… menu item should be findable').toBe(true);

        // ── Wait for the wxFileDialog to appear, file list to paint. ───
        await page.waitForFunction(() => {
            const registry = window.wxElementRegistry;
            if (!registry) return false;
            return registry.findAll({ visible: true })
                .some((el) => el.typeName === 'wxFileDialog');
        }, null, { timeout: 15000 });
        // stableShot stabilizes the file-list paint before comparing — deterministically
        // replacing a fixed 1000ms that used to catch the dialog mid-paint (black rectangle).
        await stableShot(page, `load-pcb-${demo.name}-01-dialog-open.png`);

        // ── Focus the filename text field, type the name, accept. ──────
        //    The Open dialog gives default keyboard focus to the file LIST,
        //    where keystrokes act as type-ahead (and Enter on the highlighted
        //    ".." row navigates up) rather than filename entry. So we must click
        //    the wxTextCtrl to focus it first, located via the element registry
        //    rather than a fixed pixel offset. No filelist row click is needed —
        //    the earlier version's extra row + offset clicks were what left focus
        //    off the field, so the typed name never registered, the field stayed
        //    empty, and Enter was a no-op (the board never loaded).
        const filenameInput = await page.evaluate(() => {
            const registry = window.wxElementRegistry;
            if (!registry) return null;
            const text = registry.findAll({ visible: true })
                .find((el) => el.typeName === 'wxTextCtrl' && el.name === 'text');
            return text ? { x: text.centerX, y: text.centerY } : null;
        });
        expect(filenameInput, 'filename text input should be visible').not.toBeNull();
        if (!filenameInput) throw new Error('filename text input not found');

        await page.mouse.click(filenameInput.x, filenameInput.y);
        // Small settle so the focus click lands before typing — no JS-observable "input
        // focused" signal here (documented interaction wait).
        await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell
        await page.keyboard.type(pcbFilename);
        await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell
        await page.keyboard.press('Enter');

        // ── Wait for the load to complete (no dialogs visible). The
        //    wxInfoBar that pcbnew shows for "older format" PCBs is not a
        //    wxDialog, so waitForBoardLoaded doesn't get blocked by it. ──
        //    If we ever need to dismiss post-load wxMessageDialogs (missing
        //    libs etc.), do it INSIDE waitForBoardLoaded so the dismiss
        //    side-effect lives with the polling loop — calling page.evaluate
        //    from the test driver hangs once the post-load asyncify clipboard
        //    runtime error breaks the wasm event loop. ───────────────────

        // ── Wait for the load to complete (no dialogs visible). ───────
        const result = await waitForBoardLoaded(page, testLogger, 60000);
        console.log(`[TEST] ${demo.name} board-ready result: ${result}`);

        // Take the screenshot immediately. Don't wait — KiCad's post-load
        // clipboard-polling path can hit a wasm RuntimeError that occasionally
        // closes the page entirely on Firefox; if we sleep first we sometimes
        // lose the page before page.screenshot runs. The canvas is already
        // fully painted by the time waitForBoardLoaded returns.
        await page.screenshot({
            path: shotPath(page, `load-pcb-${demo.name}.png`),
            scale: 'css',
        });

        const allLines = [...testLogger.consoleLogs, ...testLogger.errors];
        const rtreeDiag = allLines.filter((l) => l.includes('[RTREE-DIAG]'));
        expect(
            rtreeDiag,
            `RTree Classify duplicate-index reappeared for ${demo.name}; this means the wasm-layer fix at shape_poly_set.cpp:1927 has regressed:\n${rtreeDiag.join('\n\n')}`,
        ).toEqual([]);
        const aborts = allLines.filter((l) => l.includes('Aborted('));
        expect(
            aborts,
            `WASM aborted during ${demo.name} load:\n${aborts.join('\n\n')}`,
        ).toEqual([]);

        // ── Clean-console gate: NO asyncify corruption may surface anywhere in
        //    the load — not before, not after the board renders. The formerly
        //    tolerated post-load clipboard/unwind RuntimeErrors are fixed
        //    (sync clipboard IsSupported in wx; "unwind" sentinel handling in
        //    the scheduler shim; see docs/features/asyncify-arbiter/).
        const asyncifySignatures = [
            'index out of bounds',
            'indirect call to null',
            'uncaught exception: unwind',
            'invalid state',
            'is not a function',
        ];
        const asyncifyErrors = allLines.filter((l) =>
            asyncifySignatures.some((sig) => l.toLowerCase().includes(sig)),
        );
        expect(
            asyncifyErrors,
            `Asyncify corruption surfaced during ${demo.name} load:\n${asyncifyErrors.join('\n\n')}`,
        ).toEqual([]);
    });
}

test.describe('Load real PCB via File → Open', () => {
    // Two 187 MB wasm runtimes loaded in parallel saturate Firefox's memory
    // and slow each test enough that the 180s per-test budget runs out before
    // the post-load canvas-settle wait completes. Run serially.
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    for (const demo of DEMOS) {
        runLoadPcbTest(demo);
    }
});
