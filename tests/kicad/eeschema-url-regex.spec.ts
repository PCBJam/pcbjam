import { test, expect } from './fixtures';
import { stableShot } from '../e2e/utils/element-tracker';

/**
 * Eeschema URL-detection wxRegEx regression (WASM strconv UTF-8 fix).
 *
 * Loading a schematic that renders text/symbol fields calls IsURL() /
 * LinkifyHTML() (kicad/common/string_utils.cpp), whose static wxRegEx pattern
 * ends in a negated class containing U+00B6 (PILCROW). In the emscripten build
 * wxString stores UTF-8 (wxUSE_UNICODE_UTF8) and `wxS(...)` is a NARROW literal;
 * clang emits U+00B6 as UTF-8 bytes 0xC2 0xB6. The implicit char*->wxString
 * conversion used wxConvLibc, which under musl's default "C" locale (MB_CUR_MAX
 * == 1) does NOT decode UTF-8 — it maps each non-ASCII byte into the
 * surrogate-escape range (0xDF80 + byte), so 0xC2 0xB6 became U+DFC2 U+DFB6.
 * utf8_str() then re-emitted those as WTF-8 and PCRE2 rejected the pattern with
 * "Invalid regular expression ...: code points 0xd800-0xdfff are not defined",
 * popping a modal error dialog over the schematic.
 *
 * Fix (wxwidgets/src/common/strconv.cpp): on __EMSCRIPTEN__ bind wxConvLibc to a
 * UTF-8 converter instead of the libc/locale one, so narrow literals (and all
 * web I/O, which is UTF-8) decode correctly regardless of the current locale.
 *
 * This test opens a text_box-bearing schematic (with a real URL) through the
 * programmatic Module.kicadOpenFile() hook and asserts the regex error never
 * fires: no "Invalid regular expression" in the console, no error dialog.
 */

const URL_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "44444444-4444-4444-4444-444444444444")
\t(paper "A4")
\t(lib_symbols)
\t(text_box "Docs: https://kicad.org/help ¶ end"
\t\t(exclude_from_sim no)
\t\t(at 50.8 50.8 0)
\t\t(size 80 20)
\t\t(margins 0.9525 0.9525 0.9525 0.9525)
\t\t(stroke (width 0) (type default))
\t\t(fill (type none))
\t\t(effects (font (size 1.27 1.27)) (justify left top))
\t\t(uuid "55555555-0000-0000-0000-000000000001")
\t)
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

const REGEX_ERR = /invalid regular expression|0xd800|UTF-8 error|code points/i;

test.describe('Eeschema URL-detection regex', () => {
    test('renders a text_box with a URL without the wxRegEx UTF-8 modal', async ({ page }) => {
        const consoleLines: string[] = [];
        page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

        await page.goto('/kicad/eeschema.html');

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

        expect(await page.title()).toMatch(/untitled/i);

        const openedPath = await page.evaluate(async (content) => {
            const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* already exists */
            }
            const path = `${dir}/url.kicad_sch`;
            w.FS.writeFile(path, content);
            await w.Module.kicadOpenFile(path);
            return path;
        }, URL_SCH);
        expect(openedPath).toContain('url.kicad_sch');

        await expect
            .poll(async () => page.title(), { timeout: 30000, intervals: [500] })
            .toMatch(/url/i);

        // Capture the painted text_box. Stabilizing the screenshot waits for the paint
        // to settle — which is when IsURL()/LinkifyHTML() compile the static wxRegEx and
        // would have thrown the modal — so the error checks below see the real outcome.
        // (Replaces the old fixed 1500ms "let the canvas paint" sleep.)
        await stableShot(page, 'eeschema-url-regex.png');

        // The wxRegEx compile failure surfaces two ways: a wxLogError logged to
        // the console, and (its default GUI target) a modal error dialog. Assert
        // neither happened. A pre-fix build renders this same text_box and so
        // hits IsURL() -> the failing static regex -> both signals fire.
        const regexConsole = consoleLines.filter((l) => REGEX_ERR.test(l));
        expect(regexConsole, `regex error in console:\n${regexConsole.join('\n')}`).toHaveLength(0);

        const errDialogs = await page.evaluate((src) => {
            const reg = window.wxElementRegistry;
            if (!reg) return [];
            return reg
                .findAll({})
                .filter((e: any) =>
                    new RegExp(src, 'i').test(`${e.name || ''} ${e.label || ''} ${e.text || ''}`)
                )
                .map((e: any) => ({ typeName: e.typeName, name: e.name, text: e.text }));
        }, REGEX_ERR.source);
        expect(errDialogs, `error dialog present:\n${JSON.stringify(errDialogs)}`).toHaveLength(0);
    });
});
