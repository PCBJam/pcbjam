import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { clickMenuBarItem, clickMenuItem, waitForRenderedByLabel, waitUntil } from '../../e2e/utils/element-tracker';

/**
 * Shared wx dialog/menu drivers for the kicad specs (one copy — previously
 * duplicated per spec, and the copies had started to drift).
 *
 * All clicks are coordinate clicks through the wx element registry: wx
 * controls are canvas-rendered on this line (no DOM identity exists — nothing
 * ever produces a data-wx-dom-id attribute), so the registry's geometry is
 * the one supported click path.
 */

/** Wait for a rendered popup menu to have its items (replaces a fixed post-menu-click sleep). */
export async function waitForMenuItems(page: Page): Promise<void> {
    await waitUntil(
        page,
        () => {
            const r = window.wxElementRegistry;
            if (!r?.findAllRendered) return false;
            return r.findAllRendered({ elementType: 'menuitem' }).length > 3;
        },
        'popup menu items rendered',
    );
}

/** Resolve one visible wx button (label or &-mnemonic label) to its registry geometry. */
export async function findWxButton(page: Page, label: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((wanted: string) => {
        const registry = window.wxElementRegistry;
        if (!registry) return null;
        const el = registry.findAll({ visible: true })
            .find((e) => (e.label === wanted || e.label === `&${wanted}`)
                && (e.typeName ?? '').includes('Button'));
        return el ? { x: el.centerX, y: el.centerY } : null;
    }, label);
}

/** Click a visible wx button by label; returns whether it was found. */
export async function clickWxButton(page: Page, label: string): Promise<boolean> {
    const pos = await findWxButton(page, label);
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y);
    return true;
}

/**
 * Drive File → Export → STEP/GLB/… and wait until the export dialog's Export
 * button is visible (the dialog object exists before its controls register).
 */
export async function openStepExportDialog(page: Page): Promise<void> {
    expect(await clickMenuBarItem(page, 'File'), 'File menu').toBe(true);
    await waitForMenuItems(page);
    await waitForRenderedByLabel(page, 'Export', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Export'), 'Export submenu').toBe(true);
    // Wait for the SUBMENU's item — waitForMenuItems(>3) is satisfied by
    // the still-rendered File menu items before the submenu paints.
    await waitForRenderedByLabel(page, 'STEP/GLB/BREP/XAO/PLY/STL...', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'STEP/GLB/BREP/XAO/PLY/STL...'),
        'STEP export menu item').toBe(true);
    await page.waitForFunction(() => {
        const registry = window.wxElementRegistry;
        return !!registry && registry.findAll({ visible: true })
            .some((el) => (el.label === 'Export' || el.label === '&Export')
                && (el.typeName ?? '').includes('Button'));
    }, null, { timeout: 20000 });
}

/** Observable count of parked modal waits (each open wx modal holds one lease). */
export async function pendingModalWaits(page: Page): Promise<number> {
    return page.evaluate(() => {
        const scheduler = (globalThis as { __wxScheduler?: { pendingWaits?: (kind: string) => number } }).__wxScheduler;
        return scheduler?.pendingWaits?.('modal') ?? -1;
    });
}

/**
 * Dismiss a report dialog that opens on top of the current modal stack (e.g.
 * the "Export complete" report): wait for its modal lease and its OK button,
 * click OK, and wait for the lease to release. `baseline` is the modal count
 * before the report dialog appears.
 */
export async function dismissReportDialog(page: Page, baseline: number, what: string): Promise<void> {
    await expect.poll(
        () => pendingModalWaits(page),
        { message: `${what}: report dialog must open (modal lease)`, timeout: 30000 },
    ).toBe(baseline + 1);
    await expect.poll(
        () => findWxButton(page, 'OK'),
        { message: `${what}: report dialog OK button must render`, timeout: 10000 },
    ).not.toBeNull();
    expect(await clickWxButton(page, 'OK'), `${what}: dismiss report dialog`).toBe(true);
    await expect.poll(
        () => pendingModalWaits(page),
        { message: `${what}: report dialog must release its modal lease`, timeout: 10000 },
    ).toBe(baseline);
}
