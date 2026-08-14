import { test, expect } from './fixtures';
import { stableShot } from '../e2e/utils/element-tracker';

/**
 * Eeschema schematic-LOAD regression test (JSPI load-chain gate).
 *
 * Pins the programmatic load chain end to end: kicadOpenFile (an embind async
 * export that suspends via JSPI while OpenProjectFiles runs) must complete a
 * real schematic load. Opening a schematic calls SCH_EDIT_FRAME::SetScreen()
 * -> m_toolManager->RunAction(selectionClear), which rides a tool coroutine —
 * so a regression anywhere in the chain (the async export, the scheduler
 * ring, the libcontext JSPI backend) shows up here as a load that suspends
 * and never resumes: the editor title stays "untitled".
 *
 * Historical note: this spec originally guarded the asyncify-era fiber
 * trampoline self-heal shim, whose absence hung exactly this chain. The shim
 * and its injector are gone with the JSPI migration; the spec stays as the
 * canonical schematic-load gate because the failure mode (a suspended load
 * chain that never resumes) is mechanism-independent.
 *
 * Assertion strategy: open a minimal (text-free) schematic via the programmatic
 * Module.kicadOpenFile() hook and poll the editor title. GREEN once it shows the
 * file name; RED (poll timeout) if the load hangs.
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
type KicadModule = { kicadOpenFile(path: string): unknown };

test.describe('Eeschema schematic load', () => {
    test('opens a .kicad_sch via kicadOpenFile and finishes loading (load-chain regression)', async ({
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
        // kicadOpenFile is a promising export: it suspends via JSPI and hands
        // back a Promise, so we ignore the return and poll the title.
        const openedPath = await page.evaluate((content) => {
            const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* already exists */
            }
            const path = `${dir}/regression.kicad_sch`;
            w.FS.writeFile(path, content);
            w.Module.kicadOpenFile(path);
            return path;
        }, SAMPLE_SCH);
        expect(openedPath).toContain('regression.kicad_sch');

        // On a healthy build the load completes and the title switches to the
        // opened file. If the selectionClear coroutine never resumes, the title
        // stays "untitled" -> this poll times out (RED).
        await expect
            .poll(async () => page.title(), {
                message:
                    'Schematic load did not complete (title stayed "untitled"). ' +
                    'Suspect the JSPI load chain: the kicadOpenFile embind async export, ' +
                    'the scheduler ring, or a refused coroutine transition — the ' +
                    '[wx-scheduler]/[libctx-jspi] console beacons say which.',
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
