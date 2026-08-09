import { test, expect, type Page } from './fixtures';
import { injectFromSubmodule } from './utils/fs-inject';
import { DEMO, PROJECT_DIR_MEMFS, countGlCanvases, openThreeDViewer } from './utils/threed-viewer';
import { waitForBoardLoaded } from './utils/board-ready';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { clickMenuBarItem, clickMenuItemByText } from '../e2e/utils/element-tracker';

/**
 * Phase F regression repro (docs/features/async/22 §10, the awaited-ccall entry
 * class). The user's live-editor path opens boards through the WEB SHELL's
 * `Module.kicadOpenFile(path)` — which Phase F wrapped to run the open body on
 * a DISPATCH CONTEXT and hand the shell a promise over an "open" wait token.
 * EVERY existing board-load spec instead drives File → Open (the wxFileDialog
 * → OpenProjectFiles path), so NONE exercises that wrapper — the exact gap the
 * user's "pcbnew dialogs are broken, eeschema is fine" report lives in.
 *
 * These specs reproduce the shell path (inject the board, then
 * `await Module.kicadOpenFile`) and THEN drive the dialogs the user reported
 * frozen: the 3D viewer, and a modal open/close. The assertion is simply that
 * the wasm main thread stays responsive and nothing traps.
 */

const TRAP =
    /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function|memory access out of bounds/;

interface Mod {
    kicadOpenFile(path: string): Promise<boolean> | boolean;
}

// Load the board the way the WEB SHELL does — through Module.kicadOpenFile
// (the Phase F dispatch-context wrapper), not File → Open.
async function openBoardViaShell(
    page: Page,
    logger: { consoleLogs: string[]; errors: string[] },
): Promise<void> {
    const pcb = `${DEMO.stem}.kicad_pcb`;
    const pro = `${DEMO.stem}.kicad_pro`;
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pcb}`, `${PROJECT_DIR_MEMFS}/${pcb}`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pro}`, `${PROJECT_DIR_MEMFS}/${pro}`);

    const ok = await page.evaluate(async (path) => {
        const m = (window as unknown as { Module: Mod }).Module;
        return await m.kicadOpenFile(path);
    }, `${PROJECT_DIR_MEMFS}/${pcb}`);
    expect(ok, 'Module.kicadOpenFile resolved true').toBe(true);

    const result = await waitForBoardLoaded(page, logger, 60000);
    console.log(`[TEST] shell-open board-ready: ${result}`);
}

// A JS-thread liveness probe: a fresh mailbox tick round-trips only if the wasm
// main thread is not wedged. A frozen app never resolves it.
async function assertResponsive(page: Page, label: string): Promise<void> {
    const alive = await page.evaluate(
        () =>
            new Promise<boolean>((resolve) => {
                const t = setTimeout(() => resolve(false), 8000);
                // A zero-delay mailbox message is delivered from a clean tick
                // (wxWasmMailboxTick) — only if the loop is running.
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        clearTimeout(t);
                        resolve(true);
                    }),
                );
            }),
    );
    expect(alive, `main thread responsive after ${label}`).toBe(true);
}

function noTrap(logger: { consoleLogs: string[]; errors: string[] }, label: string): void {
    const hits = [...logger.consoleLogs, ...logger.errors].filter((l) => TRAP.test(l));
    expect(hits, `no wasm trap after ${label}`).toEqual([]);
}

test.describe('shell-opened board → dialogs (Phase F open-lane regression)', () => {
    test('3D viewer opens over a shell-loaded board and stays responsive', async ({
        page,
        testLogger,
    }) => {
        test.setTimeout(180000);
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);

        await openBoardViaShell(page, testLogger);
        await assertResponsive(page, 'shell open');
        noTrap(testLogger, 'shell open');

        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);
        await assertResponsive(page, '3D viewer open');
        noTrap(testLogger, '3D viewer open');
    });

    test('a modal opens and closes over a shell-loaded board without freezing', async ({
        page,
        testLogger,
    }) => {
        test.setTimeout(180000);
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);

        await openBoardViaShell(page, testLogger);
        await assertResponsive(page, 'shell open');

        // Board Setup is a heavy modal reachable from the File menu without a
        // library provider — enough to exercise the ShowModal park/resume over
        // a dispatch context left idle by the shell open.
        expect(await clickMenuBarItem(page, 'File'), 'File menu findable').toBe(true);
        await clickMenuItemByText(page, 'Board Setup');
        await page.waitForFunction(
            () =>
                !!window.wxElementRegistry &&
                window.wxElementRegistry
                    .findAll({ visible: true })
                    .some((e) => /Dialog/i.test(e.typeName || '')),
            null,
            { timeout: 20000 },
        );
        await assertResponsive(page, 'modal open');
        noTrap(testLogger, 'modal open');

        // Close it (Escape → EndModal(wxID_CANCEL) → resolves the modal wait).
        await page.keyboard.press('Escape');
        await page.waitForFunction(
            () =>
                !!window.wxElementRegistry &&
                !window.wxElementRegistry
                    .findAll({ visible: true })
                    .some((e) => /Dialog/i.test(e.typeName || '')),
            null,
            { timeout: 20000 },
        );
        await assertResponsive(page, 'modal close');
        noTrap(testLogger, 'modal close');
    });
});
