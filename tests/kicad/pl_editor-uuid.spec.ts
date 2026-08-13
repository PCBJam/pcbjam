import { test, expect } from './fixtures';

/**
 * pl_editor (.kicad_wks) per-item `(uuid …)` round-trip + backfill.
 *
 * Guards Yjs-bridge commit 1 (identity/format): every DS_DATA_ITEM now carries a
 * stable KIID m_Uuid that is serialized as `(uuid …)` via the shared
 * KICAD_FORMAT::FormatUuid, parsed back per item, and — when absent from a
 * legacy/upstream file — backfilled (default-constructed random KIID) on load so
 * the first save upgrades the file in place.
 *
 * Strategy mirrors pl_editor-load.spec.ts: write a .kicad_wks into MEMFS, open it
 * with Module.kicadOpenFile(), then serialize the in-memory model back with the
 * test-only Module.kicadSaveDrawingSheet() hook and read the output from MEMFS.
 *   - backfill:    a uuid-less file gains one (uuid …) per item after save.
 *   - round-trip:  a file that already has uuids keeps the *exact same* strings.
 */

// Legacy file: no (uuid …) tokens. 1 line + 1 rect + 1 tbtext + 1 polygon = 4 items.
const LEGACY_WKS = `(page_layout
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (line (name segment) (start 20 20 ltcorner) (end 60 20 ltcorner))
  (rect (name border:Rect) (start 0 0 ltcorner) (end 0 0 rbcorner) (comment "page border"))
  (tbtext "Backfill me" (name title) (pos 100 20) (font (size 2.5 2.5) bold))
  (polygon (name logo) (pos 30 30 ltcorner) (pts (xy 0 0)(xy 5 0)(xy 5 5)(xy 0 5)))
)
`;

// Already-uuid'd file: each item carries an explicit, known uuid. These exact
// strings must survive load → save unchanged (parser reads them; writer re-emits).
const U_LINE = '11111111-1111-1111-1111-111111111111';
const U_RECT = '22222222-2222-2222-2222-222222222222';
const U_TEXT = '33333333-3333-3333-3333-333333333333';
const U_POLY = '44444444-4444-4444-4444-444444444444';
const UUID_WKS = `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (line (uuid "${U_LINE}") (name segment) (start 20 20 ltcorner) (end 60 20 ltcorner))
  (rect (uuid "${U_RECT}") (name border:Rect) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Keep my uuid" (uuid "${U_TEXT}") (name title) (pos 100 20) (font (size 2.5 2.5) bold))
  (polygon (uuid "${U_POLY}") (name logo) (pos 30 30 ltcorner) (pts (xy 0 0)(xy 5 0)(xy 5 5)(xy 0 5)))
)
`;

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
    readFile(path: string, opts: { encoding: 'utf8' }): string;
};
type KicadModule = {
    kicadOpenFile(path: string): Promise<unknown>;
    kicadSaveDrawingSheet(path: string): Promise<void>;
};

function hasAbort(testLogger: { consoleLogs: string[]; errors: string[] }): boolean {
    return [...testLogger.consoleLogs, ...testLogger.errors].some((l) => l.includes('Aborted('));
}

/** Open `content` in the editor, save it back, return the serialized output. */
async function openThenSave(
    page: import('@playwright/test').Page,
    name: string,
    content: string,
): Promise<string> {
    const inPath = `/home/kicad/documents/${name}.kicad_wks`;
    await page.evaluate(
        async ({ inPath, content }) => {
            const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* already exists */
            }
            w.FS.writeFile(inPath, content);
            await w.Module.kicadOpenFile(inPath);
        },
        { inPath, content },
    );

    // Title flips to the opened file once the load completes.
    await expect
        .poll(async () => page.title(), { timeout: 30000, intervals: [500] })
        .toMatch(new RegExp(name, 'i'));

    return page.evaluate(async (name) => {
        const w = window as unknown as { FS: EmscriptenFS; Module: KicadModule };
        const outPath = `/home/kicad/documents/${name}-out.kicad_wks`;
        await w.Module.kicadSaveDrawingSheet(outPath);
        return w.FS.readFile(outPath, { encoding: 'utf8' });
    }, name);
}

test.describe('pl_editor .kicad_wks uuid identity', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/pl_editor.html');
        await expect(page.locator('#canvas')).toBeVisible({ timeout: 90000 });
        await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
        await page.waitForFunction(
            () => {
                const m = (window as unknown as { Module?: KicadModule }).Module;
                return (
                    typeof m?.kicadOpenFile === 'function' &&
                    typeof m?.kicadSaveDrawingSheet === 'function'
                );
            },
            null,
            { timeout: 90000 },
        );
        await page.waitForFunction(
            () =>
                !!window.wxElementRegistry &&
                window.wxElementRegistry
                    .findAll({ visible: true })
                    .some((e) => /Frame$/.test(e.typeName) || (e.name || '').endsWith('Frame')),
            null,
            { timeout: 90000 },
        );
    });

    test('a uuid-less file is backfilled: one (uuid …) per item on save', async ({
        page,
        testLogger,
    }) => {
        const out = await openThenSave(page, 'legacy', LEGACY_WKS);

        // 4 items in, so 4 freshly-minted uuids out.
        const uuids = [...out.matchAll(/\(uuid\s+"([0-9a-fA-F-]{36})"\)/g)].map((m) => m[1]);
        expect(uuids, `expected 4 backfilled uuids, output was:\n${out}`).toHaveLength(4);

        // All non-nil and distinct (random backfill, not shared/zero).
        const NIL = '00000000-0000-0000-0000-000000000000';
        for (const u of uuids) expect(u).not.toBe(NIL);
        expect(new Set(uuids).size, 'backfilled uuids must be distinct').toBe(4);

        expect(hasAbort(testLogger), 'no WASM abort').toBe(false);
    });

    test('existing uuids survive load → save unchanged (round-trip)', async ({
        page,
        testLogger,
    }) => {
        const out = await openThenSave(page, 'withuuid', UUID_WKS);

        for (const u of [U_LINE, U_RECT, U_TEXT, U_POLY]) {
            expect(out, `uuid ${u} must be preserved through load/save`).toContain(`(uuid "${u}")`);
        }

        expect(hasAbort(testLogger), 'no WASM abort').toBe(false);
    });
});
