import { test, expect } from './fixtures';
import { clickMenuBarItem, waitUntil } from '../e2e/utils/element-tracker';

/**
 * Escape's browser default is "leave fullscreen": Firefox on macOS exits even
 * the browser's own fullscreen on an Escape keydown the page did not
 * preventDefault (nsCocoaWindow::PostHandleKeyEvent). The canvas path always
 * prevented it, but handlers that stop Escape before wx sees it did not — a
 * wx-dom text input stops every key — so Escape typed into a field threw the
 * user out of fullscreen. wx now claims every Escape in a window capture
 * listener. Browser fullscreen itself can't be driven from Playwright, so this
 * asserts the precondition: the keydown's default is prevented, both on the
 * canvas and inside a DOM text field.
 */

// Records each Escape keydown's final verdict, read after dispatch completes
// (a stopPropagation below the window would hide it from a bubble listener).
const recordEscapes = () => {
    const w = window as unknown as { __escSeen: boolean[] };
    w.__escSeen = [];
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setTimeout(() => w.__escSeen.push(e.defaultPrevented), 0);
    }, true);
};
const escSeen = () => (window as unknown as { __escSeen: boolean[] }).__escSeen.slice();

test('Escape never keeps its browser default (fullscreen exit)', async ({ page }) => {
    await page.goto('/kicad/eeschema.html');
    await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
    await expect
        .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
        .toMatch(/Schematic Editor/i);
    await page.evaluate(recordEscapes);

    // Canvas, selection mode.
    const box = await page.locator('#canvas').boundingBox();
    expect(box, 'canvas box').not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(escSeen)).toEqual([true]);

    // A DOM text field: Preferences → Common → the text editor path.
    expect(await clickMenuBarItem(page, 'Preferences'), 'Preferences menubar item').toBe(true);
    await waitUntil(
        page,
        () => window.wxElementRegistry.findAllRendered({ elementType: 'menuitem' })
            .some((i) => i.subType !== 'menubar' && /Preferences/i.test(i.label ?? '')),
        'Preferences… popup item rendered',
    );
    const popupItem = await page.evaluate(() => {
        const hit = window.wxElementRegistry.findAllRendered({ elementType: 'menuitem' })
            .find((i) => i.subType !== 'menubar' && /Preferences/i.test(i.label ?? ''));
        return hit ? { x: hit.centerX, y: hit.centerY } : null;
    });
    expect(popupItem, 'Preferences… popup item').not.toBeNull();
    await page.mouse.click(popupItem!.x, popupItem!.y);
    const field = page.locator('input.wx-dom-control[type="text"]:visible').first();
    await expect(field, 'a visible Preferences text field').toBeVisible({ timeout: 60000 });
    await field.click();
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(escSeen)).toEqual([true, true]);
});
