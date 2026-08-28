import { test, expect, type Page } from './fixtures';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { injectFromSubmodule } from './utils/fs-inject';
import { waitForBoardLoaded } from './utils/board-ready';
import { PROJECT_DIR_MEMFS } from './utils/threed-viewer';
import { clickMenuBarItem, clickMenuItemByText, waitUntil } from '../e2e/utils/element-tracker';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Repro for findings O-2 (footprint chooser reliability): type a filter in
 * the chooser's search field, press Enter, and assert the chooser CONFIRMS
 * (closes with a footprint) and that a footprint is actually placed after
 * the follow-up canvas click.
 *
 * Why Enter is expected to be dead on this port (source read, wx
 * src/wasm/app.cpp KeyCallback): while a wx-dom <input> owns browser focus,
 * every key except Escape / Cmd+S returns to the browser WITHOUT any wx
 * dispatch, so the search field never sees the wxEVT_CHAR_HOOK that
 * LIB_TREE::onQueryCharHook (common/widgets/lib_tree.cpp) binds for
 * WXK_RETURN / WXK_UP / WXK_DOWN. The only wx-side echo of Enter is
 * wxEVT_TEXT_ENTER (textctrl.cpp wxDOM_EVENT_ENTER), which LIB_TREE does not
 * bind. Same dead path for arrow-key row navigation.
 *
 * Board: the ecc83 demo, which ships a PROJECT footprint lib
 * (${KIPRJMOD}/footprints.pretty) so the chooser tree is populated in this
 * harness (the global fp-lib-table is empty).
 */

const TRAP =
    /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function|memory access out of bounds/;

const DEMO_DIR = 'kicad/demos/ecc83';
const STEM = 'ecc83-pp';
const FILTER = 'ECC-83-1';

function frameCount(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                /Frame$/.test(e.typeName || ''),
            ).length,
    );
}

function itemCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        const m = (window as any).Module;
        try { return JSON.parse(m.kicadCollabTestListItems(100000)).length as number; }
        catch { return -1; }
    });
}

async function synthClick(page: Page, x: number, y: number): Promise<void> {
    await page.evaluate(
        ([cx, cy]) => {
            const c = document.querySelector('#canvas') as HTMLCanvasElement;
            const opt = (b: number) => ({
                clientX: cx, clientY: cy, bubbles: true, cancelable: true,
                view: window, button: 0, buttons: b,
            });
            c.dispatchEvent(new MouseEvent('mousemove', opt(0)));
            c.dispatchEvent(new MouseEvent('mousedown', opt(1)));
            c.dispatchEvent(new MouseEvent('mouseup', opt(0)));
            c.dispatchEvent(new MouseEvent('click', opt(0)));
        },
        [x, y],
    );
}

/** Visible wx-dom text inputs with viewport boxes (chooser search field is one). */
function visibleTextInputs(page: Page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('input.wx-dom-control'))
            .map((i) => i as HTMLInputElement)
            .filter((i) => i.style.display !== 'none' && i.getBoundingClientRect().width > 0)
            .map((i) => {
                const r = i.getBoundingClientRect();
                return { value: i.value, type: i.type, focused: document.activeElement === i,
                         x: r.x, y: r.y, w: r.width, h: r.height };
            }),
    );
}

async function loadEcc83(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }) {
    const root = path.resolve(__dirname, '..', '..');
    const pretty = path.join(root, DEMO_DIR, 'footprints.pretty');
    for (const f of fs.readdirSync(pretty)) {
        await injectFromSubmodule(page, `${DEMO_DIR}/footprints.pretty/${f}`,
            `${PROJECT_DIR_MEMFS}/footprints.pretty/${f}`);
    }
    for (const f of ['fp-lib-table', `${STEM}.kicad_pcb`, `${STEM}.kicad_pro`]) {
        await injectFromSubmodule(page, `${DEMO_DIR}/${f}`, `${PROJECT_DIR_MEMFS}/${f}`);
    }

    expect(await clickMenuBarItem(page, 'File'), 'File menu').toBe(true);
    await clickMenuItemByText(page, 'Open');
    await page.waitForFunction(() =>
        !!window.wxElementRegistry && window.wxElementRegistry.findAll({ visible: true })
            .some((el) => el.typeName === 'wxFileDialog'), null, { timeout: 15000 });
    await waitUntil(page, () => {
        const r = window.wxElementRegistry;
        return !!r && r.findAll({ visible: true }).some((el) => el.typeName === 'wxTextCtrl' && el.name === 'text');
    }, 'file dialog filename input');
    const input = await page.evaluate(() => {
        const t = window.wxElementRegistry!.findAll({ visible: true })
            .find((el) => el.typeName === 'wxTextCtrl' && el.name === 'text');
        return t ? { x: t.centerX, y: t.centerY } : null;
    });
    if (!input) throw new Error('filename input not found');
    await page.mouse.click(input.x, input.y);
    await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell
    await page.keyboard.type(`${STEM}.kicad_pcb`);
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell
    await page.keyboard.press('Enter');
    const result = await waitForBoardLoaded(page, testLogger, 60000);
    console.log(`[TEST] ecc83 board-ready result: ${result}`);
}

test.describe('Footprint chooser confirm (O-2 repro)', () => {
    test('typed filter + Enter confirms the chooser and a footprint gets placed', async ({
        page, testLogger,
    }) => {
        test.setTimeout(240000);
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadEcc83(page, testLogger);

        const itemsBefore = await itemCount(page);
        const framesBefore = await frameCount(page);
        console.log(`[PROBE] items before=${itemsBefore} frames=${framesBefore}`);

        expect(await clickMenuBarItem(page, 'Place'), 'Place menu findable').toBe(true);
        await clickMenuItemByText(page, 'Place Footprints');
        const canvas = await page.locator('#canvas').boundingBox();
        if (!canvas) throw new Error('canvas not found');
        const target = { x: Math.round(canvas.width * 0.5), y: Math.round(canvas.height * 0.5) };
        await synthClick(page, target.x, target.y);

        await page.waitForFunction((n) =>
            (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                /Frame$/.test(e.typeName || '')).length > n, framesBefore, { timeout: 60000 })
            // best-effort wait: the frame-count expect right below is the
            // real assertion; a timeout must reach it, not throw (documented)
            .catch(() => {});
        const framesOpen = await frameCount(page);
        console.log(`[PROBE] frames after Place click: ${framesOpen}`);
        expect(framesOpen, 'footprint chooser frame opened').toBeGreaterThan(framesBefore);

        // The chooser's search field: a wx-dom <input>. Wait for it to be projected.
        await expect.poll(async () => (await visibleTextInputs(page)).length,
            { timeout: 30000, message: 'chooser search input projected' }).toBeGreaterThan(0);
        const inputs = await visibleTextInputs(page);
        console.log(`[PROBE] inputs: ${JSON.stringify(inputs)}`);
        // Topmost visible input (the search field sits at the top of the chooser).
        const search = inputs.reduce((a, b) => (b.y < a.y ? b : a));
        await page.mouse.click(search.x + search.w / 2, search.y + search.h / 2);
        await page.waitForTimeout(200); // eslint-disable-line -- focus dwell
        await page.keyboard.type(FILTER, { delay: 30 });
        await expect.poll(async () =>
            (await visibleTextInputs(page)).some((i) => i.value.includes(FILTER)),
            { timeout: 10000, message: 'filter text landed in the search input' }).toBe(true);
        // Let the filter/re-select settle (LIB_TREE filters on a timer).
        await page.waitForTimeout(1500); // eslint-disable-line -- filter timer dwell

        // ── Step 1: Enter in the search field should confirm the selection ──
        await page.keyboard.press('Enter');
        const closedByEnter = await page.waitForFunction((n) =>
            (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                /Frame$/.test(e.typeName || '')).length <= n, framesBefore, { timeout: 8000 })
            .then(() => true).catch(() => false);
        console.log(`[PROBE] chooser closed by Enter: ${closedByEnter}`);

        // ── Step 2a (diagnostic): single-click the already-selected match row, the
        //    way a user would before hitting OK (ledger: "clicking the result row
        //    deselects what typing already selected"). A deselect here makes OK take
        //    the DismissModal(false) branch — chooser closes, nothing placed.
        if (!closedByEnter) {
            const tree = await page.evaluate(() => {
                const t = (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
                    .find((e) => /DataView/i.test(e.typeName || ''));
                return t ? { x: t.screenX, y: t.screenY, w: t.width, h: t.height } : null;
            });
            console.log(`[PROBE] tree: ${JSON.stringify(tree)}`);
            if (tree) {
                // Screenshot geometry: header ~18px, then the "Footprints" lib row, then the match.
                await page.mouse.click(tree.x + 80, tree.y + 45);
                await page.waitForTimeout(600); // eslint-disable-line -- selection settle
            }
        }

        // ── Step 2 (fallback, diagnostic): the OK button — the mouse path ──
        let closedByOk = false;
        if (!closedByEnter) {
            const ok = await page.evaluate(() => {
                const b = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find(
                    (e) => /Button/i.test(e.typeName || '') && /^ok$/i.test((e.label || '').replace(/&/g,'').trim()),
                );
                return b ? { x: b.centerX, y: b.centerY, type: b.typeName } : null;
            });
            console.log(`[PROBE] OK button: ${JSON.stringify(ok)}`);
            if (ok) {
                await page.mouse.click(ok.x, ok.y);
                closedByOk = await page.waitForFunction((n) =>
                    (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                        /Frame$/.test(e.typeName || '')).length <= n, framesBefore, { timeout: 8000 })
                    .then(() => true).catch(() => false);
            }
            console.log(`[PROBE] chooser closed by OK click: ${closedByOk}`);
        }

        // ── Step 2b (diagnostic): double-click the selected tree row ──
        let closedByDbl = false;
        if (!closedByEnter && !closedByOk) {
            const tree = await page.evaluate(() => {
                const t = (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
                    .find((e) => /DataView/i.test(e.typeName || ''));
                return t ? { x: t.screenX, y: t.screenY, w: t.width, h: t.height } : null;
            });
            console.log(`[PROBE] tree: ${JSON.stringify(tree)}`);
            if (tree) {
                // Screenshot geometry: header ~20px, "Footprints" lib row, then the match row.
                for (const dy of [44, 56, 30]) {
                    await page.mouse.dblclick(tree.x + 80, tree.y + dy);
                    closedByDbl = await page.waitForFunction((n) =>
                        (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
                            /Frame$/.test(e.typeName || '')).length <= n, framesBefore, { timeout: 4000 })
                        .then(() => true).catch(() => false);
                    console.log(`[PROBE] dblclick at dy=${dy}: closed=${closedByDbl}`);
                    if (closedByDbl) break;
                }
            }
        }

        // ── Step 3: if the chooser closed, place the footprint with a canvas click ──
        let itemsAfter = itemsBefore;
        if (closedByEnter || closedByOk || closedByDbl) {
            await page.waitForTimeout(1000); // eslint-disable-line -- footprint load dwell
            await synthClick(page, target.x + 40, target.y + 40);
            await expect.poll(() => itemCount(page), { timeout: 10000 })
                .toBeGreaterThan(itemsBefore)
                // best-effort wait: the placed-count expect at the end is the
                // real assertion; a timeout must reach it, not throw (documented)
                .catch(() => {});
            itemsAfter = await itemCount(page);
        }
        console.log(`[PROBE] items after=${itemsAfter} (before=${itemsBefore})`);

        const traps = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) => TRAP.test(l));
        expect(traps, 'no wasm trap').toEqual([]);
        expect(closedByEnter, 'O-2: Enter in the chooser search field confirms the selection').toBe(true);
        expect(itemsAfter, 'O-2: a footprint was actually placed').toBeGreaterThan(itemsBefore);
    });
});
