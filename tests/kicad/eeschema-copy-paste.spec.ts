import { test, expect } from './fixtures';
import { stableShot } from '../e2e/utils/element-tracker';

/**
 * Eeschema copy/paste regression (wasm clipboard truncation).
 *
 * The bug: without wxNEEDS_UTF8_FOR_TEXT_DATAOBJ the wasm port's
 * wxTextDataObject served UTF-32 for wxDF_UNICODETEXT; wxClipboard::AddData
 * read it as UTF-8 (ASCII-in-UTF-32 = "valid" UTF-8 full of NULs) and the JS
 * write helper's UTF8ToString truncated at the first NUL. Cmd+C left exactly
 * "(" on navigator.clipboard; Cmd+V then failed the s-expression parse and
 * eeschema's fallback pasted a stray SCH_TEXT("(") — rendered by the stroke
 * font as a small blue arc instead of the copied symbol.
 *
 * Two layers:
 *  - chromium-only: the copied s-expression must reach the browser clipboard
 *    IN FULL (cross-instance copy/paste transport).
 *  - both engines: copy → paste → save must yield a second symbol and no
 *    stray text item. On firefox (no clipboard permission grants) the paste
 *    exercises the wxClipboard m_textCache fallback; on chromium the real
 *    browser clipboard — both transports covered.
 *
 * The wx-API-level contract has its own harness:
 * wxwidgets/tests/wasm/textdataobj_test.cpp + e2e/textdataobj.spec.ts.
 */

const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "aaaaaaaa-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
\t\t\t(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(symbol (lib_id "Device:R") (at 127 95.25 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "bbbbbbbb-2222-2222-2222-222222222222")
\t\t(property "Reference" "R1" (at 129.54 94.615 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 129.54 96.52 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Footprint" "" (at 125.222 95.25 90) (effects (font (size 1.27 1.27)) hide))
\t\t(property "Datasheet" "~" (at 127 95.25 0) (effects (font (size 1.27 1.27)) hide))
\t\t(pin "1" (uuid "cccccccc-0000-0000-0000-000000000001"))
\t\t(pin "2" (uuid "cccccccc-0000-0000-0000-000000000002"))
\t\t(instances
\t\t\t(project "copypaste"
\t\t\t\t(path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))
\t\t\t)
\t\t)
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

const SCH_PATH = '/home/kicad/documents/copypaste.kicad_sch';

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
    readFile(path: string): Uint8Array;
};
type KicadModule = { kicadOpenFile(path: string): unknown };
type WxWindow = Window & { FS: EmscriptenFS; Module: KicadModule };

async function bootWithSchematic(page: import('@playwright/test').Page) {
    await page.goto('/kicad/eeschema.html');

    // Same boot gates as eeschema-load.spec.ts: canvas, element registry,
    // the embind open hook, and a top-level Frame.
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

    await page.evaluate(
        ({ content, path }) => {
            const w = window as unknown as WxWindow;
            try {
                w.FS.mkdirTree('/home/kicad/documents');
            } catch {
                /* already exists */
            }
            w.FS.writeFile(path, content);
            w.Module.kicadOpenFile(path);
        },
        { content: SAMPLE_SCH, path: SCH_PATH }
    );

    await expect
        .poll(async () => page.title(), {
            message: 'schematic load did not complete (title stayed untitled)',
            timeout: 30000,
            intervals: [500],
        })
        .toMatch(/copypaste/i);

    // Focus the schematic drawing area so hotkeys land in the editor. The
    // whole wx UI renders inside the one #canvas element — the left-hand
    // panels are wx widgets, so the click must land right of them
    // (drawing area ≈ x 340-1250, y 90-660 at the 1280x720 viewport).
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500);
}

// The kicad projects run under devices['Desktop Chrome'/'Desktop Firefox'],
// whose user agents claim Windows; the wasm port's mac-detection follows the
// UA (wxGetOsVersion → platformInfo.name), so the editor maps Control from
// ctrlKey. Plain 'Control+…' is therefore correct on every host OS here —
// 'ControlOrMeta' would send Meta on a mac host, which the "Windows" app
// ignores (observed: 'a' alone opened the Place Symbol dialog).
async function selectAllAndCopy(page: import('@playwright/test').Page) {
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(800);
    await page.keyboard.press('Control+c');
    // The clipboard write suspends via JSPI (browser round-trip, 2s timeout
    // budget inside wxClipboard) — give it room before acting on the result.
    await page.waitForTimeout(2500);
}

test.describe('Eeschema copy/paste', () => {
    test('Cmd+C puts the full schematic s-expression on the browser clipboard', async ({
        page,
        browserName,
    }) => {
        test.skip(browserName === 'firefox', 'firefox cannot grant clipboard read/write to tests');

        await bootWithSchematic(page);

        // Seed known clipboard state so a failed write cannot pass as success.
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-BEFORE-COPY'));

        await selectAllAndCopy(page);

        const clip = await page.evaluate(() => navigator.clipboard.readText());
        // eeschema's clipboard blob is the multi-form shape
        // `(lib_symbols ...)\n(symbol ...)` (see pcbjam-shared items-wire.ts).
        // The original bug left exactly "(" here (UTF-32 truncated at its
        // first NUL by the clipboard write helper).
        expect(clip).toMatch(/^\(lib_symbols/);
        expect(clip).toContain('(symbol "Device:R"');
        expect(clip).toContain('(lib_id "Device:R")');
    });

    test('copy → paste → save yields a second symbol and no stray text item', async ({
        page,
    }) => {
        await bootWithSchematic(page);

        await selectAllAndCopy(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // Paste attaches the items to the cursor; click commits the placement.
        await page.mouse.move(500, 300);
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(2500);
        await stableShot(page, 'eeschema-copy-paste-preview.png');
        await page.mouse.click(500, 300);
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        await page.keyboard.press('Control+s');

        await expect
            .poll(
                async () => {
                    const content = await page.evaluate((path) => {
                        const w = window as unknown as WxWindow;
                        return new TextDecoder().decode(w.FS.readFile(path));
                    }, SCH_PATH);
                    return (content.match(/\(lib_id "Device:R"\)/g) || []).length;
                },
                {
                    message:
                        'saved schematic should contain the original AND the pasted symbol ' +
                        '(the truncation bug pasted a stray "(" text item instead)',
                    timeout: 20000,
                    intervals: [1000],
                }
            )
            .toBe(2);

        const content = await page.evaluate((path) => {
            const w = window as unknown as WxWindow;
            return new TextDecoder().decode(w.FS.readFile(path));
        }, SCH_PATH);

        // The failure mode of the truncation bug: an unparseable clipboard
        // pastes as a SCH_TEXT (serialized as a (text …) node).
        expect(content).not.toContain('(text "');

        await stableShot(page, 'eeschema-copy-paste-committed.png');
    });
});
