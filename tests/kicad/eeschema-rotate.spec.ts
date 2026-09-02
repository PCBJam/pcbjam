import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { test, expect } from './fixtures';
import { hideCursor } from './utils/screenshot-compare';

/**
 * Eeschema "R" rotate regression (reported 2026-09-02, local wasm editor).
 *
 * Symptom: with a symbol selected, pressing R flips the Properties panel's
 * Orientation from 0 to 180 (not 90) while the symbol on the canvas does not
 * visibly rotate at all.
 *
 * Two independent facets, asserted separately so a failure names the layer:
 *  - MODEL: one R press must apply exactly ONE 90° CCW step. Read back from the
 *    bridge's per-item snapshot (`kicadCollabSnapshotItems` → `(at x y ROT)`)
 *    and, independently, from the file written by Ctrl+S.
 *  - CANVAS: the GL canvas must repaint — a vertical resistor becoming
 *    horizontal at "zoom to objects" changes a large share of the pixels.
 *
 * The second test rotates through the C++ test hook (`kicadCollabTestRotateItem`,
 * the same SCH_COMMIT path a native edit takes, no hotkey involved). If it
 * repaints while the hotkey test does not, the bug is in the wasm port's key
 * → action dispatch; if neither repaints, it is the redraw after rotate.
 *
 * Bisected on built bundles (2026-09-02): the 2026-08-25 build (wx c1f14775ba3)
 * rotates 90; the 2026-08-31 build (wx 4e6cc5a441e) rotates 180. The only
 * key-contract change in that window is wx d32535fefb0 (2026-08-27, "sync
 * preventDefault for printable keys"): a deferred keydown job no longer cancels
 * the browser 'keypress', so KiCad receives the hotkey twice — once as the
 * keydown-synthesized wxEVT_CHAR_HOOK, once as the keypress-derived wxEVT_CHAR.
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
\t\t\t(project "rotate"
\t\t\t\t(path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))
\t\t\t)
\t\t)
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

const SCH_PATH = '/home/kicad/documents/rotate.kicad_sch';
const SYMBOL_UUID = 'bbbbbbbb-2222-2222-2222-222222222222';

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
    readFile(path: string): Uint8Array;
};
type KicadModule = {
    kicadOpenFile(path: string): unknown;
    kicadCollabSnapshotItems(): string;
    kicadCollabTestRotateItem(uuid: string, deg: number): boolean;
};
type WxWindow = Window & { FS: EmscriptenFS; Module: KicadModule };

async function bootWithSchematic(page: Page) {
    await page.goto('/kicad/eeschema.html');

    await expect(page.locator('#canvas')).toBeVisible({ timeout: 90000 });
    await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
    await page.waitForFunction(
        () =>
            typeof (window as unknown as { Module?: Partial<KicadModule> }).Module?.kicadOpenFile ===
                'function' &&
            typeof (window as unknown as { Module?: Partial<KicadModule> }).Module
                ?.kicadCollabSnapshotItems === 'function',
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
        .toMatch(/rotate/i);

    // Focus the drawing area so hotkeys land in the editor (see
    // eeschema-copy-paste.spec.ts for the layout numbers).
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the click's focus handoff rides the wx scheduler with no page-observable
    // Zoom to objects: the lone resistor fills the view, so a real rotation
    // moves a large share of the GL canvas pixels.
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: zoom animates on the wx scheduler with no page-observable
    await hideCursor(page);
}

async function visibleGlCanvasBox(page: Page) {
    const glCanvasId = await page.evaluate(() => {
        const glCanvas =
            Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
                .map((c) => c as HTMLCanvasElement)
                .find((c) => {
                    const rect = c.getBoundingClientRect();
                    const style = window.getComputedStyle(c);
                    return style.display !== 'none' && rect.width > 0 && rect.height > 0;
                }) ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null);
        return glCanvas?.id ?? null;
    });
    expect(glCanvasId, 'visible GL canvas').not.toBeNull();
    const box = await page.locator(`#${glCanvasId}`).boundingBox();
    expect(box, 'GL canvas bounding box').not.toBeNull();
    return box!;
}

/** Share of GL-canvas pixels that differ between two clipped screenshots. */
function changedShare(a: Buffer, b: Buffer): number {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    expect(pa.width, 'screenshot widths agree').toBe(pb.width);
    expect(pa.height, 'screenshot heights agree').toBe(pb.height);
    const changed = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
    return changed / (pa.width * pa.height);
}

/** The symbol's `(at x y ROT)` as the bridge sees it right now. */
async function symbolRotationFromBridge(page: Page): Promise<number> {
    const sexprs: string[] = await page.evaluate(() => {
        const w = window as unknown as WxWindow;
        const wire = JSON.parse(w.Module.kicadCollabSnapshotItems()) as {
            added: { sexpr: string }[];
        };
        return wire.added.map((i) => i.sexpr);
    });
    const symbol = sexprs.find((s) => s.includes('(lib_id "Device:R")'));
    expect(symbol, 'bridge snapshot contains the Device:R symbol').toBeTruthy();
    const m = symbol!.match(/\(lib_id "Device:R"\)\s*\(at\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\)/);
    expect(m, `symbol blob carries an (at x y rot) clause: ${symbol!.slice(0, 200)}`).not.toBeNull();
    return Number(m![3]);
}

/** Save with Ctrl+S and return the symbol's rotation as written to disk. */
async function symbolRotationFromSave(page: Page): Promise<number> {
    // Blank the file first so the poll below cannot pass on the pre-save bytes.
    await page.evaluate((path) => {
        (window as unknown as WxWindow).FS.writeFile(path, '');
    }, SCH_PATH);
    await page.keyboard.press('Control+s');
    await expect
        .poll(
            () =>
                page.evaluate((path) => {
                    const w = window as unknown as WxWindow;
                    return new TextDecoder().decode(w.FS.readFile(path));
                }, SCH_PATH),
            { message: 'Ctrl+S should rewrite the schematic file', timeout: 20000, intervals: [500] }
        )
        .toContain('(kicad_sch');
    const content = await page.evaluate((path) => {
        const w = window as unknown as WxWindow;
        return new TextDecoder().decode(w.FS.readFile(path));
    }, SCH_PATH);
    const m = content.match(/\(lib_id "Device:R"\)\s*\(at\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\)/);
    expect(m, 'saved schematic carries the symbol (at x y rot)').not.toBeNull();
    return Number(m![3]);
}

/** Diagnostic only: what the Properties panel shows next to "Orientation". */
async function orientationShownInPanel(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const registry = window.wxElementRegistry;
        const all = registry.findAllRendered ? registry.findAllRendered({}) : [];
        const label = all.find((e) => (e.label || '').trim() === 'Orientation');
        if (!label) return ['<no Orientation label rendered>'];
        return all
            .filter(
                (e) =>
                    e !== label &&
                    Math.abs(e.centerY - label.centerY) < 6 &&
                    e.centerX > label.centerX &&
                    (e.label || '').trim() !== ''
            )
            .map((e) => `${e.elementType}:${(e.label || '').trim()}`);
    });
}

test.describe('Eeschema rotate (R)', () => {
    test('one R press on a selected symbol rotates it once and repaints the canvas', async ({
        page,
    }) => {
        await bootWithSchematic(page);
        const box = await visibleGlCanvasBox(page);

        expect(await symbolRotationFromBridge(page), 'pristine symbol orientation').toBe(0);
        const before = await page.screenshot({ clip: box });

        // Select the (only) symbol through the UI, then rotate with the hotkey.
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: select-all resolves inside the wx tool framework with no page-observable
        console.log(`[rotate-spec] panel before R: ${JSON.stringify(await orientationShownInPanel(page))}`);
        await page.keyboard.press('r');
        await page.waitForTimeout(1200); // eslint-disable-line -- documented interaction dwell: the rotate commit + GAL repaint ride the wx scheduler with no page-observable
        console.log(`[rotate-spec] panel after R: ${JSON.stringify(await orientationShownInPanel(page))}`);

        const after = await page.screenshot({ clip: box });
        const share = changedShare(before, after);
        const rotBridge = await symbolRotationFromBridge(page);
        console.log(`[rotate-spec] hotkey: bridge rot=${rotBridge} canvasChanged=${(share * 100).toFixed(2)}%`);

        expect(
            rotBridge,
            'ONE R press must apply exactly one 90° CCW step (the bug reports 180 after a single press)'
        ).toBe(90);
        expect(
            share,
            'the GL canvas must repaint the rotated symbol (a vertical resistor turning horizontal at zoom-to-objects moves many pixels)'
        ).toBeGreaterThan(0.005);

        const rotSaved = await symbolRotationFromSave(page);
        console.log(`[rotate-spec] hotkey: saved rot=${rotSaved}`);
        expect(rotSaved, 'the saved file agrees with the bridge').toBe(rotBridge);
    });

    test('control: the C++ rotate hook rotates once and repaints the canvas', async ({ page }) => {
        await bootWithSchematic(page);
        const box = await visibleGlCanvasBox(page);

        expect(await symbolRotationFromBridge(page), 'pristine symbol orientation').toBe(0);
        const before = await page.screenshot({ clip: box });

        const ok = await page.evaluate(
            (uuid) => (window as unknown as WxWindow).Module.kicadCollabTestRotateItem(uuid, 90),
            SYMBOL_UUID
        );
        expect(ok, 'the test hook resolved the symbol').toBe(true);
        await page.waitForTimeout(1200); // eslint-disable-line -- documented interaction dwell: the hook's commit runs on the coroutine + GAL repaint with no page-observable

        const after = await page.screenshot({ clip: box });
        const share = changedShare(before, after);
        const rotBridge = await symbolRotationFromBridge(page);
        console.log(`[rotate-spec] hook: bridge rot=${rotBridge} canvasChanged=${(share * 100).toFixed(2)}%`);

        expect(rotBridge, 'the hook applies one 90° step').toBe(90);
        expect(share, 'the GL canvas repaints after a native rotate commit').toBeGreaterThan(0.005);
    });
});
