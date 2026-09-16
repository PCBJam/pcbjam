import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { test, expect } from './fixtures';
import { hideCursor } from './utils/screenshot-compare';

/**
 * Eeschema paste-follows-cursor regression (wasm port).
 *
 * Desktop KiCad: Ctrl+V attaches the pasted items to the pointer, the preview
 * follows every mouse move, and a click commits the placement where the
 * pointer is. In the wasm build the click still committed, but the preview
 * stayed glued to the pointer position of the Ctrl+V moment.
 *
 * Why: SCH_EDITOR_CONTROL::Paste starts the move with
 * TOOL_MANAGER::RunSynchronousAction, whose `wxYield(); wxMilliSleep(1);` spin
 * runs on the Ctrl+V key handler's stack. That chain holds the wasm dispatch
 * interlock (wxWasmDispatchGuard) and the sleep shim suspends the stack in
 * place, so the port stays "parked" for the whole placement. The parked branch
 * of wxApp::HandleMouseEvent re-posted button events (the spin's wxYield drains
 * them, hence the click worked) but DROPPED wxEVT_MOTION, so no TA_MOUSE_MOTION
 * ever woke the move tool. Fix: the wx port queues one coalesced motion per
 * drain while parked (wxwidgets/src/wasm/app.cpp).
 *
 * Two facets, asserted separately so a failure names the layer:
 *  - CANVAS (the RED pin): after Ctrl+V at A, moving the pointer to B must
 *    repaint the GL canvas (the preview + crosshair move). Bug: ~0 % changed.
 *  - MODEL: the committed symbol must sit at B, not at A. The move tool commits
 *    wherever the last motion left the items (click -> break, no cursor
 *    re-read), so pre-fix it lands at A.
 * Plus the save sanity from eeschema-copy-paste.spec.ts (two Device:R, no
 * stray text), so a broken paste cannot masquerade as "moved".
 *
 * The wx-API-level contract has its own harness:
 * wxwidgets/tests/wasm/parked_motion_test.cpp + e2e/parked-motion.spec.ts.
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
\t\t\t(project "pastefollow"
\t\t\t\t(path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))
\t\t\t)
\t\t)
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

const SCH_PATH = '/home/kicad/documents/pastefollow.kicad_sch';
const ORIGINAL_UUID = 'bbbbbbbb-2222-2222-2222-222222222222';

type EmscriptenFS = {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
    readFile(path: string): Uint8Array;
};
type SnapItem = { id: string; type: string; x: number; y: number };
type KicadModule = {
    kicadOpenFile(path: string): unknown;
    kicadCollabSnapshot(): string;
    kicadCollabGetViewport(): string;
    kicadCollabGetSelection(): string;
};
type WxWindow = Window & { FS: EmscriptenFS; Module: KicadModule };
type Pt = { x: number; y: number };

async function bootWithSchematic(page: Page) {
    await page.goto('/kicad/eeschema.html');

    // Same boot gates as eeschema-copy-paste.spec.ts: canvas, element
    // registry, the embind hooks, and a top-level Frame.
    await expect(page.locator('#canvas')).toBeVisible({ timeout: 90000 });
    await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
    await page.waitForFunction(
        () => {
            const m = (window as unknown as { Module?: Partial<KicadModule> }).Module;
            return (
                typeof m?.kicadOpenFile === 'function' &&
                typeof m?.kicadCollabSnapshot === 'function' &&
                typeof m?.kicadCollabGetViewport === 'function' &&
                typeof m?.kicadCollabGetSelection === 'function'
            );
        },
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
        .toMatch(/pastefollow/i);

    // Focus the drawing area so hotkeys land in the editor (layout numbers:
    // see eeschema-copy-paste.spec.ts).
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the click's focus handoff rides the wx scheduler with no page-observable
    // Zoom to objects: the lone fixture item fills the view, so the pasted
    // preview (and its move) changes a large share of the GL pixels; at the
    // sheet-level default zoom the copy is only a few dozen pixels.
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: zoom animates on the wx scheduler with no page-observable
    await hideCursor(page);
}

// Plain 'Control+…' on purpose: the kicad projects run under a Windows UA, so
// the wasm port maps Control from ctrlKey ('ControlOrMeta' would send Meta,
// which the "Windows" app ignores) — see eeschema-copy-paste.spec.ts.
async function selectAllAndCopy(page: Page) {
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: select-all resolves inside the wx tool framework with no page-observable
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(2500); // eslint-disable-line -- documented interaction dwell: the copy's clipboard write suspends via JSPI (2 s browser round-trip budget) and firefox offers no readText to poll
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

async function snapshotItems(page: Page): Promise<SnapItem[]> {
    return page.evaluate(() => {
        const m = (window as unknown as WxWindow).Module;
        return (JSON.parse(m.kicadCollabSnapshot()) as { added: SnapItem[] }).added;
    });
}

/**
 * World (internal units) -> CSS pixels through the live GAL viewport — the
 * mapping the comment pins render through (web/read-only-editor.spec.ts).
 */
async function screenPosOf(page: Page, world: Pt): Promise<Pt> {
    return page.evaluate((w: Pt) => {
        const win = window as unknown as WxWindow;
        const vp = JSON.parse(win.Module.kicadCollabGetViewport()) as {
            cx: number; cy: number; scale: number; w: number; h: number;
        };
        const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
            const r = (c as HTMLElement).getBoundingClientRect();
            return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
        }) as HTMLElement;
        const r = gl.getBoundingClientRect();
        const ratio = r.width / vp.w;
        return {
            x: r.x + ((w.x - vp.cx) * vp.scale + vp.w / 2) * ratio,
            y: r.y + ((w.y - vp.cy) * vp.scale + vp.h / 2) * ratio,
        };
    }, world);
}

async function selectionUuids(page: Page): Promise<string[]> {
    return page.evaluate(() => JSON.parse((window as unknown as WxWindow).Module.kicadCollabGetSelection()) as string[]);
}

function changedShare(a: Buffer, b: Buffer): number {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    expect(pa.width, 'screenshot widths agree').toBe(pb.width);
    expect(pa.height, 'screenshot heights agree').toBe(pb.height);
    const changed = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
    return changed / (pa.width * pa.height);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

test.describe('Eeschema paste follows the cursor', () => {
    test('after Ctrl+V the pasted symbol tracks the pointer and commits at the click', async ({
        page,
    }) => {
        await bootWithSchematic(page);
        const glBox = await visibleGlCanvasBox(page);
        const glShot = () => page.screenshot({ clip: glBox });

        const before = await snapshotItems(page);
        const original = before.find((i) => i.id === ORIGINAL_UUID);
        expect(original, 'the fixture symbol is in the loaded model').toBeDefined();

        await selectAllAndCopy(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: selection-clear has no page-observable

        // A: where the pointer is when Ctrl+V lands. B: far away, still well
        // inside the canvas (no autopan margin).
        // A sits well away from the zoomed fixture item's anchors (origin, pins/pads):
        // the paste point snaps to an anchor within ~2 grid units, which would drop
        // the copy exactly onto the original and hide it from the pixel diff.
        const A: Pt = { x: Math.round(glBox.x + glBox.width * 0.20), y: Math.round(glBox.y + glBox.height * 0.30) };
        const B: Pt = { x: Math.round(glBox.x + glBox.width * 0.65), y: Math.round(glBox.y + glBox.height * 0.70) };

        await page.mouse.move(A.x, A.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before the hotkey reads the cursor

        const idle = await glShot();
        await page.keyboard.press('Control+v');

        // "Attached" signal: the paste parses the clipboard (a JSPI-suspending
        // read), adds the copy under a FRESH uuid and selects it for the move.
        // (Not a pixel gate: eeschema leaves pasted items at their source
        // position until the first motion, so nothing repaints at paste time.)
        const knownIds = new Set(before.map((i) => i.id));
        await expect
            .poll(async () => (await selectionUuids(page)).some((id) => !knownIds.has(id)), {
                message: 'the pasted symbol (a fresh uuid) should be selected for the move after Ctrl+V',
                timeout: 15000,
                intervals: [250],
            })
            .toBe(true);

        // VISIBLE-AT-ONCE facet: the copy is moved to the cursor in the model as
        // soon as the move starts, and desktop KiCad draws it there immediately.
        // The port repaints through EDA_DRAW_PANEL_GAL's one-shot refresh timer,
        // which the mailbox refused to deliver while the paste chain was parked, so
        // the copy only showed up once the first mouse move forced a synchronous
        // repaint. No pointer movement happens between Ctrl+V and this poll.
        await expect
            .poll(async () => changedShare(idle, await glShot()), {
                message: 'the pasted symbol must be drawn at the pointer right after Ctrl+V, before any mouse move',
                timeout: 5000,
                intervals: [250],
            })
            .toBeGreaterThan(0.002);
        const attached = await glShot();

        // Move the pointer to B in several steps: each one is a real mousemove
        // the wx port must deliver while the paste-move loop is parked.
        await page.mouse.move(B.x, B.y, { steps: 8 });
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before the preview repaints
        await page.mouse.move(B.x + 1, B.y);
        await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: same, for the final settling motion
        const moved = await glShot();

        const share = changedShare(attached, moved);
        console.log(`[paste-follow] canvasChanged after move=${(share * 100).toFixed(2)}%`);
        expect(
            share,
            'the GL canvas must repaint as the pointer moves after Ctrl+V (the pasted preview + crosshair follow it); ~0 means motion never reached the move tool'
        ).toBeGreaterThan(0.005);

        await page.mouse.click(B.x + 1, B.y);
        await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: the placement commit has no page-observable
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: exit-move-tool has no page-observable

        // MODEL facet: the pasted symbol (a fresh uuid of the original's type)
        // must sit where the click landed, not where Ctrl+V was pressed.
        const after = await snapshotItems(page);
        const pasted = after.filter((i) => !knownIds.has(i.id) && i.type === original!.type);
        expect(pasted, 'exactly one pasted symbol').toHaveLength(1);

        const pastedScreen = await screenPosOf(page, pasted[0]);
        const toB = dist(pastedScreen, B);
        const toA = dist(pastedScreen, A);
        console.log(`[paste-follow] pasted symbol at (${pastedScreen.x.toFixed(0)},${pastedScreen.y.toFixed(0)}) px; A=(${A.x},${A.y}) B=(${B.x},${B.y}); toA=${toA.toFixed(0)} toB=${toB.toFixed(0)}`);
        expect(
            toB,
            'the committed symbol must land at the click point B (grid-snapped); pre-fix it stays at the Ctrl+V point A'
        ).toBeLessThan(80);
        expect(toB, 'closer to B than to A by a wide margin').toBeLessThan(toA / 4);

        // Save sanity (eeschema-copy-paste.spec.ts): a real second symbol, no
        // stray text item from a failed clipboard parse.
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
                { message: 'saved schematic should contain the original AND the pasted symbol', timeout: 20000, intervals: [1000] }
            )
            .toBe(2);
        const content = await page.evaluate((path) => {
            const w = window as unknown as WxWindow;
            return new TextDecoder().decode(w.FS.readFile(path));
        }, SCH_PATH);
        expect(content).not.toContain('(text "');
    });
});
