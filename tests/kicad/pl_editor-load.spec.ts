import { test, expect } from './fixtures';
import { stableShot } from '../e2e/utils/element-tracker';

/**
 * pl_editor (drawing-sheet editor) programmatic-open regression.
 *
 * Guards the web-app wiring added for pl_editor:
 *   1. the generic kicadOpenFile() embind hook (wasm/bindings/pl_editor_embind.cpp)
 *      — PL_EDITOR_FRAME overrides OpenProjectFiles, so a .kicad_wks can be opened
 *      deterministically without UI automation, and
 *   2. the seeded KiCad config that skips the first-run STARTWIZARD (the harness
 *      now seeds it in preRun, matching the web app's boot.ts) — without it the
 *      wizard's modal loop crashes Asyncify and no file can load.
 *
 * Strategy mirrors eeschema-load.spec.ts: write a minimal .kicad_wks into MEMFS,
 * call Module.kicadOpenFile(), and poll the editor title. GREEN once it shows the
 * file name; also asserts no setup wizard is visible and no WASM abort fired.
 */

const SAMPLE_WKS = `(page_layout
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (name border:Rect) (start 0 0 ltcorner) (end 0 0 rbcorner) (comment "page border"))
  (rect (name titleblock:Rect) (start 110 34) (end 2 2) (comment "title block frame"))
  (tbtext "KiCad WASM — Drawing Sheet Load Test" (name title) (pos 100 20) (font (size 2.5 2.5) (bold)))
)
`;

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
};
type KicadModule = { kicadOpenFile(path: string): Promise<unknown> };

function hasAbort(testLogger: { consoleLogs: string[]; errors: string[] }): boolean {
    return [...testLogger.consoleLogs, ...testLogger.errors].some((l) => l.includes('Aborted('));
}

test.describe('pl_editor drawing-sheet load', () => {
    test('opens a .kicad_wks via kicadOpenFile, wizard-free', async ({ page, testLogger }) => {
        await page.goto('/kicad/pl_editor.html');

        // Editor must be fully up: canvas, registry, the embind open hook, and a
        // top-level Frame (so kicadOpenFile's GetTopWindow() resolves to the editor).
        await expect(page.locator('#canvas')).toBeVisible({ timeout: 90000 });
        await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
        await page.waitForFunction(
            () =>
                typeof (window as unknown as { Module?: KicadModule }).Module?.kicadOpenFile ===
                'function',
            null,
            { timeout: 90000 }
        );
        await page.waitForFunction(
            () =>
                !!window.wxElementRegistry &&
                window.wxElementRegistry
                    .findAll({ visible: true })
                    .some((e) => /Frame$/.test(e.typeName) || (e.name || '').endsWith('Frame')),
            null,
            { timeout: 90000 }
        );

        // The seed must have suppressed the first-run wizard: no wizard/dialog up.
        const wizardVisible = await page.evaluate(() => {
            const reg = window.wxElementRegistry;
            if (!reg) return -1;
            return reg
                .findAll({ visible: true })
                .filter((e: { typeName: string }) => /^wxDialog|Wizard/.test(e.typeName)).length;
        });
        expect(wizardVisible, 'no setup wizard/dialog should be visible (seed skipped it)').toBe(0);

        // Write a minimal drawing sheet into MEMFS and open it via the hook.
        const openedPath = await page.evaluate(async (content) => {
            const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* already exists */
            }
            const path = `${dir}/load-test.kicad_wks`;
            w.FS.writeFile(path, content);
            await w.Module.kicadOpenFile(path);
            return path;
        }, SAMPLE_WKS);
        expect(openedPath).toContain('load-test.kicad_wks');

        // The title switches to the opened file once the load completes.
        await expect
            .poll(async () => page.title(), {
                message:
                    'Drawing sheet load did not complete (title never showed the file). ' +
                    'kicadOpenFile / the pl_editor embind hook is likely missing or broken.',
                timeout: 30000,
                intervals: [500],
            })
            .toMatch(/load-test/i);

        await stableShot(page, 'pl_editor-load-rendered.png');

        expect(hasAbort(testLogger), 'no WASM abort during open').toBe(false);
    });
});
