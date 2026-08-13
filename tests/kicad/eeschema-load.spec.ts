import { test, expect } from './fixtures';
import { stableShot } from '../e2e/utils/element-tracker';

/**
 * Eeschema schematic-LOAD regression test (fiber / Asyncify trampoline shim).
 *
 * This guards the fix in scripts/common/inject-dyncall-shims.sh
 * ("3c. Fiber trampoline self-heal").
 *
 * Background: KiCad's tool framework runs action handlers in coroutines that
 * switch stacks via emscripten_fiber_swap. The emscripten fiber glue gates its
 * context switch on `Fibers.trampolineRunning` and resets that flag at the end of
 * `Fibers.trampoline()`. At startup `emscripten_set_main_loop(...,1)` throws
 * "unwind" to establish the main loop; KiCad does that from inside a tool
 * coroutine, so the throw propagates THROUGH the trampoline and skips the reset.
 * The flag then stays `true` forever, `Fibers.trampoline()` becomes a permanent
 * no-op, and EVERY fiber swap after startup silently fails to switch contexts.
 *
 * Opening a schematic calls SCH_EDIT_FRAME::SetScreen() ->
 * m_toolManager->RunAction(selectionClear), which performs such a fiber swap. So
 * without the shim, OpenProjectFiles() suspends in selectionClear and never
 * resumes: the load hangs and the editor title stays "untitled".
 *
 * The shim wraps the trampoline loop in try/finally so the flag is always reset.
 * With it, the load completes and the title switches to the opened file.
 *
 * Assertion strategy: open a minimal (text-free) schematic via the programmatic
 * Module.kicadOpenFile() hook and poll the editor title. GREEN once it shows the
 * file name; RED (poll timeout) if the load hangs because the shim is missing.
 *
 * The schematic holds a few wires + junctions (a box with a crossbar) so a dev
 * can eyeball a screenshot and immediately see whether it rendered. It uses ONLY
 * geometry — no text/symbol fields — both to keep the visual unambiguous and to
 * avoid an unrelated, still-open URL-detection wxRegEx bug that pops a modal when
 * text is rendered (see the regex follow-up). version 20250114 is within this
 * build's supported schematic version (SEXPR_SCHEMATIC_FILE_VERSION 20251012).
 */

const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))
\t(wire (pts (xy 50.8 101.6) (xy 101.6 101.6)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000002"))
\t(wire (pts (xy 50.8 50.8) (xy 50.8 101.6)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000003"))
\t(wire (pts (xy 101.6 50.8) (xy 101.6 101.6)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000004"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000005"))
\t(junction (at 50.8 76.2) (diameter 1.016) (color 0 0 0 0) (uuid "33333333-0000-0000-0000-000000000001"))
\t(junction (at 101.6 76.2) (diameter 1.016) (color 0 0 0 0) (uuid "33333333-0000-0000-0000-000000000002"))
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
)
`;

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
};
type KicadModule = { kicadOpenFile(path: string): Promise<unknown> };

test.describe('Eeschema schematic load', () => {
    test('opens a .kicad_sch via kicadOpenFile and finishes loading (fiber shim regression)', async ({
        page,
    }) => {
        await page.goto('/kicad/eeschema.html');

        // Editor must be fully up before we drive the open: a visible canvas, the
        // wx element registry, the embind open hook, and a top-level Frame (so
        // kicadOpenFile's GetTopWindow() resolves to the editor, not a wizard).
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

        // Sanity: editor starts on an untitled schematic.
        expect(await page.title()).toMatch(/untitled/i);

        // Write a minimal, version-compatible schematic into MEMFS and open it.
        // The owned-open Promise settles only after the exact open owner retires.
        // Await it here; the title poll below remains the UI-render assertion.
        const openedPath = await page.evaluate(async (content) => {
            const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* already exists */
            }
            const path = `${dir}/regression.kicad_sch`;
            w.FS.writeFile(path, content);
            await w.Module.kicadOpenFile(path);
            return path;
        }, SAMPLE_SCH);
        expect(openedPath).toContain('regression.kicad_sch');

        // With the fiber trampoline self-heal shim the load completes and the
        // title switches to the opened file. WITHOUT it, the selectionClear fiber
        // swap hangs and the title stays "untitled" -> this poll times out (RED).
        await expect
            .poll(async () => page.title(), {
                message:
                    'Schematic load did not complete (title stayed "untitled"). ' +
                    'The fiber trampoline self-heal shim (inject-dyncall-shims.sh "3c") is ' +
                    'likely missing or broken.',
                timeout: 30000,
                intervals: [500],
            })
            .toMatch(/regression/i);

        // Capture the loaded geometry (box with a crossbar) so a dev can eyeball that
        // it rendered. stableShot stabilizes the paint before comparing, replacing
        // the old fixed "give the canvas a moment" sleep.
        await stableShot(page, 'eeschema-load-rendered.png');
    });
});
