import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { test, expect } from './fixtures';
import { hideCursor } from './utils/screenshot-compare';

/**
 * "Import from file" → interactive placement (`Module.kicadPlaceImportedItem`).
 *
 * The React panel used to insert the imported symbol/footprint at a
 * JS-computed click point through the collab apply bridge: nothing was on the
 * cursor before the click, the insert carried SKIP_UNDO (Cmd+Z did nothing)
 * and it was folded into the collab baseline (peers never received it).
 *
 * The export hands the parsed item to the editor's OWN placement flow —
 * eeschema: SCH_ACTIONS::placeSymbol with a pre-built symbol (the chooser
 * path); pcbnew: the paste path (BOARD_COMMIT + synchronous move) — so:
 *  - DRAWN AT THE POINTER at once and FOLLOWS it (the two wx parked-dispatch
 *    fixes from paste-follows-cursor make this hold in the browser);
 *  - the click COMMITS at the click point, on the UNDO stack (+1 entry);
 *  - the commit is BROADCAST on the v2 items wire (window.kicadCollab.onItems),
 *    i.e. collaborators see it;
 *  - Esc CANCELS: nothing added, undo depth unchanged.
 *
 * RED on a build without the export (the panel's JS-only route); GREEN once
 * the bindings ship.
 */

const SCH_PATH = '/home/kicad/documents/importplace.kicad_sch';
const PCB_NAME = 'importplacepcb';

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
\t\t\t(project "importplace"
\t\t\t\t(path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))
\t\t\t)
\t\t)
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

// The clipboard-dialect blob the panel builds (wasm/import-item.ts
// buildSymbolImport): lib_symbols keyed by the full lib id + an unannotated
// instance. A NEW library nickname, so the definition must travel in the blob.
const SYMBOL_BLOB = `(lib_symbols (symbol "ImpLib:C" (pin_numbers hide) (pin_names (offset 0.254)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t(property "Reference" "C" (at 0.635 2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Value" "C" (at 0.635 -2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Footprint" "" (at 0.9652 -3.81 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(symbol "C_0_1"
\t\t(polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
\t)
\t(symbol "C_1_1"
\t\t(pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t(pin passive line (at 0 -3.81 90) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t)
))
(symbol (lib_id "ImpLib:C") (at 0 0 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t(uuid "dddddddd-3333-3333-3333-333333333333")
\t(property "Reference" "C?" (at 2.54 -0.635 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Value" "C" (at 2.54 0.635 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(pin "1" (uuid "dddddddd-0000-0000-0000-000000000001"))
\t(pin "2" (uuid "dddddddd-0000-0000-0000-000000000002"))
)
`;

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

// The bare `(footprint …)` blob the panel builds (buildFootprintImport). Pad
// layers limited to the fixture board's copper so the envelope parse resolves.
const FOOTPRINT_BLOB = `(footprint "ImpLib:C_TEST"
\t(version 20240108)
\t(generator "pcbnew")
\t(layer "F.Cu")
\t(at 0 0)
\t(attr smd)
\t(property "Reference" "REF**" (at 0 -4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
\t(property "Value" "C_TEST" (at 0 4 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
\t(fp_rect (start -2.5 -2) (end 2.5 2) (stroke (width 0.12) (type default)) (fill none) (layer "F.SilkS"))
\t(pad "1" smd rect (at -1.5 0) (size 1 1.5) (layers "F.Cu"))
\t(pad "2" smd rect (at 1.5 0) (size 1 1.5) (layers "F.Cu"))
)
`;

type EmscriptenFS = { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
type SnapItem = { id: string; type: string; x: number; y: number };
type KicadModule = {
    kicadOpenFile(path: string): unknown;
    kicadCollabSnapshot(): string;
    kicadCollabGetViewport(): string;
    kicadCollabGetSelection(): string;
    kicadCollabTestUndoDepth(): number;
    kicadPlaceImportedItem?: (sexpr: string) => string;
};
type ItemsWire = { added?: { sexpr: string }[]; changed?: { sexpr: string }[]; removed?: string[] };
type WxWindow = Window & {
    FS: EmscriptenFS;
    Module: KicadModule;
    kicadCollab?: { onItems?: (json: string) => void; onDelta?: (json: string) => void };
    __importPlaceWires?: ItemsWire[];
};
type Pt = { x: number; y: number };

const BOOT_TIMEOUT = 120000;

async function bootCommon(page: Page, url: string) {
    await page.goto(url);
    await expect(page.locator('#canvas')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
    await page.waitForFunction(
        () => {
            const m = (window as unknown as { Module?: Partial<KicadModule> }).Module;
            return (
                typeof m?.kicadOpenFile === 'function' &&
                typeof m?.kicadCollabSnapshot === 'function' &&
                typeof m?.kicadCollabGetViewport === 'function' &&
                typeof m?.kicadCollabGetSelection === 'function' &&
                typeof m?.kicadCollabTestUndoDepth === 'function'
            );
        },
        null,
        { timeout: BOOT_TIMEOUT }
    );
    await page.waitForFunction(
        () =>
            !!window.wxElementRegistry &&
            window.wxElementRegistry
                .findAll({ visible: true })
                .some((e) => /Frame$/.test(e.typeName) || (e.name || '').endsWith('Frame')),
        null,
        { timeout: BOOT_TIMEOUT }
    );
}

async function openFromMemfs(page: Page, path: string, content: string, titleRe: RegExp) {
    await page.evaluate(
        ({ content, path }) => {
            const w = window as unknown as WxWindow;
            try {
                w.FS.mkdirTree('/home/kicad/documents');
            } catch {
                /* exists */
            }
            w.FS.writeFile(path, content);
            w.Module.kicadOpenFile(path);
        },
        { content, path }
    );
    await expect
        .poll(() => page.title(), { message: 'document load did not complete', timeout: 30000, intervals: [500] })
        .toMatch(titleRe);

    // Focus the drawing area, zoom to objects (big pixels for the diffs).
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the click's focus handoff rides the wx scheduler with no page-observable
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

async function snapshotItems(page: Page): Promise<SnapItem[]> {
    return page.evaluate(() => {
        const m = (window as unknown as WxWindow).Module;
        return (JSON.parse(m.kicadCollabSnapshot()) as { added: SnapItem[] }).added;
    });
}

async function selectionUuids(page: Page): Promise<string[]> {
    return page.evaluate(() => JSON.parse((window as unknown as WxWindow).Module.kicadCollabGetSelection()) as string[]);
}

async function undoDepth(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as WxWindow).Module.kicadCollabTestUndoDepth());
}

/** Install the v2 items-wire listener the collab layer normally provides. */
async function captureItemsWire(page: Page) {
    await page.evaluate(() => {
        const w = window as unknown as WxWindow;
        w.__importPlaceWires = [];
        w.kicadCollab = {
            onItems: (json: string) => {
                w.__importPlaceWires!.push(JSON.parse(json) as ItemsWire);
            },
            onDelta: () => {},
        };
    });
}

/** Every blob the wire carried, added OR changed: receivers upsert both
 *  (pcbjam-shared items-wire.ts, the editors' doApplyItems). The flag depends
 *  on whether the bridge was re-baselined while the item was already staged
 *  on the board (the collab harness page does that on its own schedule). */
async function wiredBlobs(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const w = window as unknown as WxWindow;
        return (w.__importPlaceWires ?? []).flatMap((wire) => [...(wire.added ?? []), ...(wire.changed ?? [])].map((a) => a.sexpr));
    });
}

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

function changedShare(a: Buffer, b: Buffer): number {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    expect(pa.width, 'screenshot widths agree').toBe(pb.width);
    expect(pa.height, 'screenshot heights agree').toBe(pb.height);
    const changed = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
    return changed / (pa.width * pa.height);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The shared body: place `blob`, expect a new item of `type`, whose wire blob contains `wireMarker`. */
async function placeAndVerify(page: Page, blob: string, type: string, wireMarker: string) {
    const glBox = await visibleGlCanvasBox(page);
    const glShot = () => page.screenshot({ clip: glBox });

    // RED pin #1: the export exists.
    const hasExport = await page.evaluate(
        () => typeof (window as unknown as WxWindow).Module.kicadPlaceImportedItem === 'function'
    );
    expect(hasExport, 'Module.kicadPlaceImportedItem export (the interactive import placement)').toBe(true);

    await captureItemsWire(page);
    const before = await snapshotItems(page); // also registers the bridge listener + baseline
    const knownIds = new Set(before.map((i) => i.id));
    const depthBefore = await undoDepth(page);

    const A: Pt = { x: Math.round(glBox.x + glBox.width * 0.20), y: Math.round(glBox.y + glBox.height * 0.30) };
    const B: Pt = { x: Math.round(glBox.x + glBox.width * 0.65), y: Math.round(glBox.y + glBox.height * 0.70) };

    await page.mouse.move(A.x, A.y);
    await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before the placement reads the cursor
    const idle = await glShot();

    const res = await page.evaluate(
        (b) => JSON.parse((window as unknown as WxWindow).Module.kicadPlaceImportedItem!(b)) as { ok: boolean; error?: string },
        blob
    );
    expect(res.ok, `placement accepted (${res.error ?? ''})`).toBe(true);

    // Attached: the imported item (fresh uuid) is selected for placement.
    await expect
        .poll(async () => (await selectionUuids(page)).some((id) => !knownIds.has(id)), {
            message: 'the imported item should be selected for the placement',
            timeout: 15000,
            intervals: [250],
        })
        .toBe(true);

    // Drawn at the pointer before any mouse move.
    await expect
        .poll(async () => changedShare(idle, await glShot()), {
            message: 'the imported item must be drawn at the pointer right away, before any mouse move',
            timeout: 5000,
            intervals: [250],
        })
        .toBeGreaterThan(0.002);
    const attached = await glShot();

    // Follows the pointer.
    await page.mouse.move(B.x, B.y, { steps: 8 });
    await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before the preview repaints
    await page.mouse.move(B.x + 1, B.y);
    await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: same, for the final settling motion
    const moved = await glShot();
    const share = changedShare(attached, moved);
    console.log(`[import-place] canvasChanged after move=${(share * 100).toFixed(2)}%`);
    expect(share, 'the GL canvas must repaint as the pointer moves (the item follows it)').toBeGreaterThan(0.005);

    // Commit at B.
    await page.mouse.click(B.x + 1, B.y);
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: the placement commit has no page-observable
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: exit-tool has no page-observable

    // Broadcast: the commit reached the v2 items wire (what collaborators
    // receive). Polled BEFORE any kicadCollabSnapshot call: the snapshot
    // re-baselines the bridge, which would empty the queued flush.
    await expect
        .poll(async () => (await wiredBlobs(page)).some((s) => s.includes(wireMarker)), {
            message: `the placed item should be broadcast on window.kicadCollab.onItems (marker ${wireMarker})`,
            timeout: 10000,
            intervals: [250],
        })
        .toBe(true);

    const after = await snapshotItems(page);
    const placed = after.filter((i) => !knownIds.has(i.id) && i.type === type);
    expect(placed, `exactly one placed ${type}`).toHaveLength(1);

    const placedScreen = await screenPosOf(page, placed[0]);
    const toB = dist(placedScreen, B);
    const toA = dist(placedScreen, A);
    console.log(`[import-place] placed ${type} at (${placedScreen.x.toFixed(0)},${placedScreen.y.toFixed(0)}) px; A=(${A.x},${A.y}) B=(${B.x},${B.y}); toA=${toA.toFixed(0)} toB=${toB.toFixed(0)}`);
    expect(toB, 'the committed item must land at the click point B (grid-snapped)').toBeLessThan(80);
    expect(toB, 'closer to B than to A by a wide margin').toBeLessThan(toA / 4);

    // Undoable: exactly one new entry.
    expect(await undoDepth(page), 'the placement is one undo entry (Cmd+Z removes it)').toBe(depthBefore + 1);

    // Cancel path: a second placement dropped with Esc adds nothing.
    const countAfterPlace = after.length;
    const known2 = new Set(after.map((i) => i.id));
    await page.evaluate((b) => (window as unknown as WxWindow).Module.kicadPlaceImportedItem!(b), blob);
    await expect
        .poll(async () => (await selectionUuids(page)).some((id) => !known2.has(id)), {
            message: 'the second import should be selected for placement',
            timeout: 15000,
            intervals: [250],
        })
        .toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the cancel has no page-observable
    expect((await snapshotItems(page)).length, 'Esc cancels: nothing added').toBe(countAfterPlace);
    expect(await undoDepth(page), 'Esc cancels: undo depth unchanged').toBe(depthBefore + 1);
}

test.describe('Import from file: interactive placement', () => {
    test('eeschema: the imported symbol hangs off the cursor, commits at the click, is undoable and broadcast', async ({ page, testLogger }) => {
        void testLogger;
        await bootCommon(page, '/kicad/eeschema.html');
        await openFromMemfs(page, SCH_PATH, SAMPLE_SCH, /importplace/i);
        await placeAndVerify(page, SYMBOL_BLOB, 'SCH_SYMBOL', '(lib_id "ImpLib:C")');
    });

    test('pcbnew: the imported footprint hangs off the cursor, commits at the click, is undoable and broadcast', async ({ page, testLogger }) => {
        void testLogger;
        // The seeded collab harness skips the first-run wizard (pcbnew-collab.spec.ts).
        await bootCommon(page, '/kicad/pcbnew-collab.html');
        await openFromMemfs(page, `/home/kicad/documents/${PCB_NAME}.kicad_pcb`, SAMPLE_PCB, new RegExp(PCB_NAME, 'i'));
        await placeAndVerify(page, FOOTPRINT_BLOB, 'FOOTPRINT', '"ImpLib:C_TEST"');
    });
});
