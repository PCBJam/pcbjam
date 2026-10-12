// Canvas-drawn combo popup over a dialog's DOM inputs (libs 0020 P17).
//
// A generic wxBitmapComboBox / wxOwnerDrawnComboBox dropdown is painted on a
// canvas inside a pointer-events:none .popup window, so a click on a row falls
// through to #canvas and the C++ hit-test hands it to the popup. The dialog's
// text inputs beneath the dropdown are real DOM <input>s with
// pointer-events:auto, though: before the fix a row lying over one of them
// lost the click to the input, which took focus — and focus leaving the popup
// dismissed it without picking the row (KiCad's Pin Properties orientation
// picker "sometimes" focused the field underneath instead).
//
// The fix (wx.js recomputePopupShadow) marks every lower-window control the
// open popup overlaps with .wx-popup-shadowed (pointer-events:none, focus
// untouched) and clears it when the popup closes.
//
// App: tests/apps/standalone/combo-shadow/combo-shadow_test.cpp
import type { Page } from '@playwright/test';
import { test, expect, waitForWxApp } from './utils/fixtures';
import { findRenderedByType, stableShot } from './utils/element-tracker';

const APP = '/standalone/combo-shadow/combo-shadow_test.html';
const ITEMS = ['Right', 'Left', 'Up', 'Down', 'Input', 'Output', 'Bidirectional', 'Passive'];

interface Rect { left: number; top: number; right: number; bottom: number }

// Viewport rect of the dialog text input showing `value` (each input's
// initial text is its name).
function inputRect(page: Page, value: string): Promise<Rect | null> {
    return page.evaluate((wanted) => {
        const input = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
            .find((i) => i.value === wanted);
        if (!input) return null;
        const r = input.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, value);
}

// Rect of the visible combo popup window, null while none is shown.
function popupRect(page: Page): Promise<Rect | null> {
    return page.evaluate(() => {
        const pop = Array.from(document.querySelectorAll<HTMLElement>('.window.popup'))
            .find((p) => p.style.display !== 'none' && p.isConnected);
        if (!pop) return null;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
}

function hasShadowClass(page: Page, value: string): Promise<boolean | null> {
    return page.evaluate((wanted) => {
        const input = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
            .find((i) => i.value === wanted);
        if (!input) return null;
        return !!input.closest('.wx-popup-shadowed');
    }, value);
}

function activeInputValue(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const a = document.activeElement;
        return a instanceof HTMLInputElement ? a.value : null;
    });
}

const inside = (x: number, y: number, r: Rect) =>
    x > r.left && x < r.right && y > r.top && y < r.bottom;

// The dropdown row (other than the current selection) whose centre lies
// over the given input, as painted into the open popup.
async function rowOverInput(page: Page, value: string) {
    const pop = await popupRect(page);
    const input = await inputRect(page, value);
    if (!pop || !input) return null;
    const rows = await findRenderedByType(page, 'listboxitem');
    return rows.find((r) =>
        ITEMS.includes(r.label) && r.label !== ITEMS[0] &&
        inside(r.centerX, r.centerY, pop) &&
        inside(r.centerX, r.centerY, input)) ?? null;
}

async function openDropdown(page: Page, testLogger: { consoleLogs: string[] }) {
    const button = (await findRenderedByType(page, 'combobutton'))[0];
    expect(button, 'the combo drop button is registered').toBeTruthy();
    await page.mouse.click(button.centerX, button.centerY);
    await expect.poll(
        () => testLogger.consoleLogs.some((l) => l.includes('[COMBOSHADOW] dropdown')),
        { message: 'wxEVT_COMBOBOX_DROPDOWN' },
    ).toBe(true);
    await expect.poll(() => popupRect(page), { message: 'popup visible' }).not.toBeNull();
}

test.describe('combo popup over dialog DOM controls', () => {

    test('a row lying over a text input is picked, the input stays unfocused', async ({ page, testLogger }) => {
        await page.goto(APP);
        await waitForWxApp(page);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOSHADOW] ready')),
            { message: 'app ready' },
        ).toBe(true);
        await expect.poll(() => inputRect(page, 'pinnumber'), { message: 'dialog inputs laid out' })
            .not.toBeNull();

        await openDropdown(page, testLogger);

        // A row whose centre sits over the "pinnumber" input.
        await expect.poll(() => rowOverInput(page, 'pinnumber'), {
            message: 'a dropdown row over the pinnumber input',
        }).not.toBeNull();
        const row = (await rowOverInput(page, 'pinnumber'))!;
        const expectedIndex = ITEMS.indexOf(row.label);

        // The covered input is shadowed; the one beside the popup is not.
        expect(await hasShadowClass(page, 'pinnumber')).toBe(true);
        expect(await hasShadowClass(page, 'sidefield')).toBe(false);
        await stableShot(page, 'combo-shadow-01-open.png', { fullPage: true });

        await page.mouse.click(row.centerX, row.centerY);

        await expect.poll(
            () => testLogger.consoleLogs.find((l) => l.includes('[COMBOSHADOW] selected')) ?? null,
            { message: 'the clicked row must be selected' },
        ).toContain(`[COMBOSHADOW] selected ${expectedIndex} ${row.label}`);
        await expect.poll(() => popupRect(page), { message: 'popup closed after the pick' }).toBeNull();
        expect(await activeInputValue(page), 'the input under the row must not take focus')
            .not.toBe('pinnumber');
        // The shadow clears with the popup.
        await expect.poll(
            () => page.evaluate(() => document.querySelectorAll('.wx-popup-shadowed').length),
            { message: 'no control stays shadowed after the popup closes' },
        ).toBe(0);
        await stableShot(page, 'combo-shadow-02-picked.png', { fullPage: true });

        // The input is live again: a click focuses it.
        const input = (await inputRect(page, 'pinnumber'))!;
        await page.mouse.click((input.left + input.right) / 2, (input.top + input.bottom) / 2);
        await expect.poll(() => activeInputValue(page), { message: 'input focusable again' })
            .toBe('pinnumber');
    });

    test('an input beside the open popup stays clickable', async ({ page, testLogger }) => {
        await page.goto(APP);
        await waitForWxApp(page);
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('[COMBOSHADOW] ready')),
            { message: 'app ready' },
        ).toBe(true);

        await openDropdown(page, testLogger);
        const side = (await inputRect(page, 'sidefield'))!;
        const pop = (await popupRect(page))!;
        expect(side.left, 'sidefield lies beside the popup').toBeGreaterThanOrEqual(pop.right);

        // Clicking outside the popup on a live input focuses it and dismisses
        // the popup without changing the selection.
        await page.mouse.click((side.left + side.right) / 2, (side.top + side.bottom) / 2);
        await expect.poll(() => activeInputValue(page), { message: 'side input focused' })
            .toBe('sidefield');
        await expect.poll(() => popupRect(page), { message: 'popup dismissed' }).toBeNull();
        expect(testLogger.consoleLogs.some((l) => l.includes('[COMBOSHADOW] selected'))).toBe(false);
    });
});
