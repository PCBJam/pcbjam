import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { test, expect } from './fixtures';
import { hideCursor } from './utils/screenshot-compare';

/**
 * PCBnew paste-follows-cursor regression (wasm port) — twin of
 * eeschema-paste-follows-cursor.spec.ts; see that file for the full trace.
 *
 * PCB_CONTROL::placeBoardItems starts the paste-move with
 * TOOL_MANAGER::RunSynchronousAction on the Ctrl+V key handler's stack; while
 * that chain is parked in the spin's wxMilliSleep the wx port dropped every
 * wxEVT_MOTION (but re-posted button events), so the pasted footprint never
 * followed the pointer although a click still committed it — at the Ctrl+V
 * position. Fix: coalesced motion queueing in wxwidgets/src/wasm/app.cpp.
 *
 *  - CANVAS (the RED pin): moving the pointer after Ctrl+V must repaint the GL canvas.
 *  - MODEL: the committed footprint sits at the click point B, not at A.
 */

// One-footprint board (roundtrip.spec.ts fixture shape): the footprint is the
// only item, so Ctrl+A selects exactly it and zoom-to-fit frames it.
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(36 "F.Fab" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "66666666-0000-0000-0000-000000000001")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000bb") (effects (font (size 1 1) (thickness 0.15))))
\t\t(fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000cc") (effects (font (size 1 1) (thickness 0.15))))
\t\t(fp_rect (start -2 -3) (end 2 3) (stroke (width 0.12) (type default)) (fill none) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000dd"))
\t)
)
`;

const BOARD_NAME = 'pastefollowpcb';
const ORIGINAL_UUID = '66666666-0000-0000-0000-000000000001';

type EmscriptenFS = { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
type SnapItem = { id: string; type: string; x: number; y: number };
type KicadModule = {
    kicadOpenFile(path: string): unknown;
    kicadCollabSnapshot(): string;
    kicadCollabGetViewport(): string;
    kicadCollabGetSelection(): string;
};
type WxWindow = Window & { FS: EmscriptenFS; Module: KicadModule };
type Pt = { x: number; y: number };

async function bootWithBoard(page: Page) {
    // The seeded collab harness skips the first-run wizard (pcbnew-collab.spec.ts).
    await page.goto('/kicad/pcbnew-collab.html');
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
        ({ content, name }) => {
            const w = window as unknown as WxWindow;
            const dir = '/home/kicad/documents';
            try {
                w.FS.mkdirTree(dir);
            } catch {
                /* exists */
            }
            const p = `${dir}/${name}.kicad_pcb`;
            w.FS.writeFile(p, content);
            w.Module.kicadOpenFile(p);
        },
        { content: SAMPLE_PCB, name: BOARD_NAME }
    );
    await expect
        .poll(() => page.title(), { message: 'board load did not complete', timeout: 30000, intervals: [500] })
        .toMatch(new RegExp(BOARD_NAME, 'i'));

    // Focus the drawing area so hotkeys land in the editor.
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the click's focus handoff rides the wx scheduler with no page-observable
    // Zoom to objects: the lone fixture item fills the view, so the pasted
    // preview (and its move) changes a large share of the GL pixels; at the
    // sheet-level default zoom the copy is only a few dozen pixels.
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: zoom animates on the wx scheduler with no page-observable
    await hideCursor(page);
}

// Plain 'Control+…' on purpose (Windows UA in the kicad projects) — see
// eeschema-copy-paste.spec.ts.
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

/** World (internal units) -> CSS pixels through the live GAL viewport. */
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

test.describe('PCBnew paste follows the cursor', () => {
    test('after Ctrl+V the pasted footprint tracks the pointer and commits at the click', async ({
        page,
    }) => {
        await bootWithBoard(page);
        const glBox = await visibleGlCanvasBox(page);
        const glShot = () => page.screenshot({ clip: glBox });

        const before = await snapshotItems(page);
        const original = before.find((i) => i.id === ORIGINAL_UUID);
        expect(original, 'the fixture footprint is in the loaded model').toBeDefined();

        await selectAllAndCopy(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: selection-clear has no page-observable

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
                message: 'the pasted footprint (a fresh uuid) should be selected for the move after Ctrl+V',
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
                message: 'the pasted footprint must be drawn at the pointer right after Ctrl+V, before any mouse move',
                timeout: 5000,
                intervals: [250],
            })
            .toBeGreaterThan(0.002);
        const attached = await glShot();

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

        const after = await snapshotItems(page);
        const pasted = after.filter((i) => !knownIds.has(i.id) && i.type === original!.type);
        expect(pasted, 'exactly one pasted footprint').toHaveLength(1);

        const pastedScreen = await screenPosOf(page, pasted[0]);
        const toB = dist(pastedScreen, B);
        const toA = dist(pastedScreen, A);
        console.log(`[paste-follow] pasted footprint at (${pastedScreen.x.toFixed(0)},${pastedScreen.y.toFixed(0)}) px; A=(${A.x},${A.y}) B=(${B.x},${B.y}); toA=${toA.toFixed(0)} toB=${toB.toFixed(0)}`);
        expect(
            toB,
            'the committed footprint must land at the click point B (grid-snapped); pre-fix it stays at the Ctrl+V point A'
        ).toBeLessThan(80);
        expect(toB, 'closer to B than to A by a wide margin').toBeLessThan(toA / 4);
    });
});
