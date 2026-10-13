import { test, expect } from './fixtures';
import {
    clickMenuBarItem,
    clickRenderedByLabel,
    findRenderedByLabel,
    waitUntil,
} from '../e2e/utils/element-tracker';

/**
 * Preferences → Hotkeys → double-click a command → press a key.
 *
 * The Set Hotkey prompt is a dialog created on a CONTROL (the hotkey list)
 * inside another modal dialog. The wasm wxDialog::ShowModal used to re-point
 * m_parent at the top-level Preferences dialog (a wxUniv-ism), so destroying
 * the prompt unlinked it from the wrong parent and left a dangling child in the
 * hotkey list: the next mouse hit-test trapped ("index out of bounds"), the
 * error containment force-resolved the Preferences modal, the Preferences
 * teardown trapped again, and OK/Cancel went dead (the X then crashed the
 * editor with "indirect call to null").
 */

// Page function (serialized into the page): true once exactly `n` wx dialogs are visible.
const dialogsVisible = (n: number) =>
    window.wxElementRegistry.findAll({ visible: true })
        .filter((e: { typeName: string }) => /^wxDialog/.test(e.typeName)).length === n;

test('editing a hotkey keeps Preferences alive and closable', async ({ page, testLogger }) => {
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));

    await page.goto('/kicad/eeschema.html');
    await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
    await expect
        .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
        .toMatch(/Schematic Editor/i);

    // Preferences → Preferences… (the popup entry, not the menubar item again).
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
    await waitUntil(page, dialogsVisible, 'Preferences dialog open', { arg: 1, timeout: 60000 });

    // Hotkeys page.
    await waitUntil(
        page,
        () => window.wxElementRegistry.findAllRendered({ elementType: 'treeitem' })
            .some((i) => i.label === 'Hotkeys'),
        'Hotkeys page entry rendered',
    );
    expect(await clickRenderedByLabel(page, 'Hotkeys', { elementType: 'treeitem' }), 'Hotkeys page').toBe(true);
    await waitUntil(
        page,
        () => window.wxElementRegistry.findAllRendered({ elementType: 'dataviewitem' })
            .some((i) => i.label === 'Show SMD 3D Models'),
        'hotkey rows rendered',
    );

    // Double-click a command → Set Hotkey prompt (a second dialog).
    const row = await findRenderedByLabel(page, 'Show SMD 3D Models', { elementType: 'dataviewitem' });
    expect(row, 'hotkey row').not.toBeNull();
    const list = await page.evaluate(() => {
        const dv = window.wxElementRegistry.findAll({ visible: true })
            .find((e: { typeName: string }) => e.typeName === 'wxDataViewMainWindow');
        return dv ? { x: dv.screenX } : null;
    });
    expect(list, 'hotkey list').not.toBeNull();
    const rowX = list!.x + 60;
    await page.mouse.dblclick(rowX, row!.centerY);
    await waitUntil(page, dialogsVisible, 'Set Hotkey prompt open', { arg: 2 });

    // Assign F7: the prompt closes on key-up and the Preferences dialog stays.
    await page.keyboard.press('F7');
    await waitUntil(page, dialogsVisible, 'Set Hotkey prompt closed', { arg: 1 });

    // A mouse move over the list hit-tests through its children (the dangling
    // child used to trap here), then Cancel must close Preferences.
    await page.mouse.move(rowX, row!.centerY + 40);
    await page.mouse.move(rowX + 10, row!.centerY + 60);
    const cancel = await page.evaluate(() => {
        const b = window.wxElementRegistry.findAll({ visible: true })
            .find((e: { typeName: string; label?: string }) => e.typeName === 'wxButton' && e.label === '&Cancel');
        return b ? { x: b.centerX as number, y: b.centerY as number } : null;
    });
    expect(cancel, 'Preferences Cancel button').not.toBeNull();
    await page.mouse.click(cancel!.x, cancel!.y);
    await waitUntil(page, dialogsVisible, 'Preferences closed by Cancel', { arg: 0 });

    const traps = [...consoleLines, ...testLogger.consoleLogs, ...testLogger.errors]
        .filter((l) => /tick rejected|job tick error|RuntimeError|indirect call|entry REJECTED|Aborted\(/.test(l));
    expect(traps, `no wasm trap while editing a hotkey:\n${traps.join('\n')}`).toEqual([]);
});
