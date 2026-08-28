import { test, expect, type Page } from './fixtures';
import { waitForPcbnew } from './utils/pcbnew-ready';
import { injectFileIntoMemfs } from './utils/fs-inject';
import { waitForBoardLoaded } from './utils/board-ready';
import { PROJECT_DIR_MEMFS } from './utils/threed-viewer';
import { clickMenuBarItem, clickMenuItemByText, waitUntil } from '../e2e/utils/element-tracker';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Repro for findings O-3 (info bar close glyph / dismiss layout shift).
 *
 * Loads a board whose (version …) predates the current format so pcbnew shows
 * the "created by an older version" WX_INFOBAR (pcbnew/files.cpp), then:
 *   (a) dispatches a SYNTHETIC click on #canvas at the close glyph's
 *       coordinates — the way the demo-video probes drove the UI — and
 *       records whether the bar dismissed (expected: no — on this port a
 *       wxBitmapButton is a real wx-dom <button> layered over the canvas, so
 *       a canvas-targeted event never reaches it);
 *   (b) performs a REAL pointer click on the same spot and asserts the bar
 *       dismisses (the product path);
 *   (c) measures the GAL panel's DOM rect before/after the dismiss and logs
 *       the origin shift (the anchor-invalidation half of the finding).
 */

const OLD_PCB = `(kicad_pcb
\t(version 20240108)
\t(generator "pcbnew")
\t(generator_version "8.0")
\t(general
\t\t(thickness 1.6)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(31 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(gr_line (start 100 100) (end 120 100) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
)
`;

const STEM = 'oldboard';

type Rect = { x: number; y: number; w: number; h: number };

function glRect(page: Page): Promise<Rect | null> {
    return page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
            const r = (c as HTMLElement).getBoundingClientRect();
            return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
        }) as HTMLElement | undefined;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
}

/** The infobar message text element, if the bar is up. */
function infobarText(page: Page) {
    return page.evaluate(() => {
        const e = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find((el) =>
            /older version of KiCad/i.test(el.label || ''));
        return e ? { x: e.screenX, y: e.screenY, w: e.width, h: e.height, cx: e.centerX, cy: e.centerY,
                     type: e.typeName, id: e.id, parentId: e.parentId } : null;
    });
}

/** wx-dom <button>s that carry an <img> (bitmap buttons), with their viewport boxes. */
function domImageButtons(page: Page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('button.wx-dom-control'))
            .filter((b) => b.querySelector('img') && (b as HTMLElement).style.display !== 'none')
            .map((b) => {
                const r = b.getBoundingClientRect();
                return { id: b.id, x: r.x, y: r.y, w: r.width, h: r.height };
            })
            .filter((r) => r.w > 0 && r.h > 0),
    );
}

async function synthCanvasClick(page: Page, x: number, y: number): Promise<void> {
    await page.evaluate(([cx, cy]) => {
        const c = document.querySelector('#canvas') as HTMLCanvasElement;
        const opt = (b: number) => ({ clientX: cx, clientY: cy, bubbles: true, cancelable: true,
                                      view: window, button: 0, buttons: b });
        c.dispatchEvent(new MouseEvent('mousemove', opt(0)));
        c.dispatchEvent(new MouseEvent('mousedown', opt(1)));
        c.dispatchEvent(new MouseEvent('mouseup', opt(0)));
        c.dispatchEvent(new MouseEvent('click', opt(0)));
    }, [x, y]);
}

async function loadOldBoard(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o3-'));
    const host = path.join(tmp, `${STEM}.kicad_pcb`);
    fs.writeFileSync(host, OLD_PCB);
    await injectFileIntoMemfs(page, host, `${PROJECT_DIR_MEMFS}/${STEM}.kicad_pcb`);

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
    console.log(`[TEST] old board-ready result: ${result}`);
}

test.describe('Info bar dismiss (O-3 repro)', () => {
    test('older-version infobar: close glyph dismisses on a real click; layout shift measured', async ({
        page, testLogger,
    }) => {
        test.setTimeout(240000);
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);
        await loadOldBoard(page, testLogger);

        await expect.poll(() => infobarText(page), { timeout: 30000, message: 'older-version infobar shown' })
            .not.toBeNull();
        const text = (await infobarText(page))!;
        console.log(`[PROBE] infobar text: ${JSON.stringify(text)}`);
        const rectBefore = await glRect(page);
        console.log(`[PROBE] gl rect with infobar: ${JSON.stringify(rectBefore)}`);

        // The close glyph: the wx-dom image <button> on the infobar's row (same y band as the text).
        await expect.poll(async () => (await domImageButtons(page)).length, { timeout: 15000 }).toBeGreaterThan(0);
        const buttons = await domImageButtons(page);
        console.log(`[PROBE] image buttons: ${JSON.stringify(buttons)}`);
        const onRow = buttons.filter((b) => b.y + b.h > text.y && b.y < text.y + text.h);
        const close = onRow.reduce((a, b) => (a && a.x > b.x ? a : b), onRow[0]);
        expect(close, 'infobar close <button> found on the message row').toBeTruthy();
        const cx = close.x + close.w / 2;
        const cy = close.y + close.h / 2;

        // (a) synthetic canvas-dispatched click at the glyph — the probe-era driver.
        await synthCanvasClick(page, cx, cy);
        const gone1 = await page.waitForFunction(() =>
            !(window.wxElementRegistry?.findAll({ visible: true }) ?? []).some((el) =>
                /older version of KiCad/i.test(el.label || '')), null, { timeout: 3000 })
            .then(() => true).catch(() => false);
        console.log(`[PROBE] dismissed by synthetic #canvas click: ${gone1}`);

        // (b) real pointer click at the same spot — the product path.
        let gone2 = gone1;
        if (!gone1) {
            await page.mouse.click(cx, cy);
            gone2 = await page.waitForFunction(() =>
                !(window.wxElementRegistry?.findAll({ visible: true }) ?? []).some((el) =>
                    /older version of KiCad/i.test(el.label || '')), null, { timeout: 8000 })
                .then(() => true).catch(() => false);
            console.log(`[PROBE] dismissed by real pointer click: ${gone2}`);
        }

        const realClickDismissed = gone2;

        // Diagnostics for the real-click failure: what wx and the DOM think the button is.
        // (Findings 8/28: the wx-dom <button> is `disabled` while wx reports enabled — it was
        // created while the frame was under the load-time wxWindowDisabler and the DOM enabled
        // state is only pushed at creation / own DoEnable, never on an ancestor re-enable.)
        if (!gone2) {
            const diag = await page.evaluate(([bx, by]) => {
                const reg = (window.wxElementRegistry?.findAll({}) ?? []).filter((e) =>
                    /Button/i.test(e.typeName || '') && Math.abs(e.centerY - by) < 20 && Math.abs(e.centerX - bx) < 80)
                    .map((e) => ({ type: e.typeName, label: e.label, name: e.name, id: e.id, visible: e.visible,
                                   enabled: e.enabled, x: e.screenX, y: e.screenY, w: e.width, h: e.height }));
                const el = document.elementFromPoint(bx, by) as HTMLElement | null;
                const btn = el?.closest('button') as HTMLButtonElement | null;
                return { reg, hit: el ? el.tagName + '#' + el.id + '.' + el.className : null,
                         btn: btn ? { id: btn.id, disabled: btn.disabled, dataset: { ...btn.dataset },
                                      html: btn.outerHTML.slice(0, 300) } : null };
            }, [cx, cy]);
            console.log(`[PROBE] diag: ${JSON.stringify(diag)}`);
            const logsBefore = testLogger.consoleLogs.length;
            // Direct DOM click on the element under the pointer.
            await page.evaluate(([bx, by]) => {
                const el = document.elementFromPoint(bx, by) as HTMLElement | null;
                (el?.closest('button') as HTMLElement | null)?.click();
            }, [cx, cy]);
            const gone3 = await page.waitForFunction(() =>
                !(window.wxElementRegistry?.findAll({ visible: true }) ?? []).some((el) =>
                    /older version of KiCad/i.test(el.label || '')), null, { timeout: 5000 })
                .then(() => true).catch(() => false);
            console.log(`[PROBE] dismissed by element.click(): ${gone3}`);
            // Direct wx_dom_event(domId, CLICK=1) — bypasses the DOM listener entirely.
            if (!gone3 && diag.btn?.dataset?.wxDomId) {
                await page.evaluate((domId) => {
                    (window as any).Module.ccall('wx_dom_event', null, ['number', 'number'], [Number(domId), 1]);
                }, diag.btn.dataset.wxDomId);
                const gone4 = await page.waitForFunction(() =>
                    !(window.wxElementRegistry?.findAll({ visible: true }) ?? []).some((el) =>
                        /older version of KiCad/i.test(el.label || '')), null, { timeout: 5000 })
                    .then(() => true).catch(() => false);
                console.log(`[PROBE] dismissed by direct wx_dom_event: ${gone4}`);
                gone2 = gone4;
            } else {
                gone2 = gone3;
            }
            const newLogs = testLogger.consoleLogs.slice(logsBefore).filter((l) => /wx|error|dom/i.test(l));
            console.log(`[PROBE] console since click: ${JSON.stringify(newLogs.slice(0, 20))}`);
        }

        // (c) layout shift.
        await page.waitForTimeout(500); // eslint-disable-line -- relayout dwell after dismiss
        const rectAfter = await glRect(page);
        console.log(`[PROBE] gl rect after dismiss: ${JSON.stringify(rectAfter)}`);
        if (rectBefore && rectAfter) {
            console.log(`[PROBE] GAL origin shift: dx=${rectAfter.x - rectBefore.x} dy=${rectAfter.y - rectBefore.y} ` +
                        `dh=${rectAfter.h - rectBefore.h}`);
        }

        expect(realClickDismissed, 'O-3: a real click on the close glyph dismisses the infobar').toBe(true);
    });
});
