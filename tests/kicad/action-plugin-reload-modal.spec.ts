import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    assertEditorRuntimeHealthy,
    clickMenuBarItem,
    waitUntil,
} from '../e2e/utils/element-tracker';
import { waitForPcbnew } from './utils/pcbnew-ready';

/**
 * Real-application regression for PendingEventDelegate.
 *
 * Preferences is a modal owner.  PANEL_PCBNEW_ACTION_PLUGINS disables its
 * grid, asks API_PLUGIN_MANAGER to reload, and enables the grid only when
 * EDA_EVT_PLUGIN_AVAILABILITY_CHANGED reaches the panel.  In the WASM build
 * the plugin manager is a stub, but it must still queue that completion event.
 *
 * An unowned wxApp completion is ordinary root work, so the open modal blocks
 * it and the panel stays disabled until Preferences closes.  Delegating that
 * same wxApp event is also too broad: one event dispatch reaches both the
 * panel and unrelated global listeners such as the parked PCB frame.  The
 * correct adapter delegates one completion directly to the initiating panel;
 * the grid becomes enabled while Preferences stays open, without publishing
 * the capability to the process-wide listener set.
 *
 * The enabled-state probe below observes the real wx window object published
 * by the WASM element registry.  Native DoEnable() writes that object on both
 * edges, even though the click handler and its queued completion are flushed
 * in one browser receipt.  Thus every click must produce the exact observable
 * state pair [false, true]; merely finding the button or missing the click
 * cannot make the test pass.
 */

const TRAP =
    /Aborted\(|unreachable executed|memory access out of bounds|null function|fiber-resume-refused/;

type ReloadProbe = {
    gridId: string;
    current: boolean;
    changes: boolean[];
    writes: number;
};

type SchedulerState = {
    dead?: boolean;
    nativeTraps?: number;
    pendingWaits?(kind: string): number;
    canTouchNative?(): boolean;
};

type ActionPluginControls = {
    gridId: string;
    reloadDx: number;
    reloadDy: number;
};

type ToolbarFanoutProbe = {
    toolbarCount: number;
    toolCount: number;
    frameEventCount: number;
};

type Mod = {
    kicadTestPcbPluginAvailabilityFrameEvents(): number;
};

const preferencesTitle = (page: Page) => page
    .locator('#window-container .window-titlebar-text')
    .filter({ hasText: /^Preferences$/ });

async function openPreferences(page: Page): Promise<void> {
    expect(await clickMenuBarItem(page, 'Preferences'),
        'Preferences menubar item is clickable').toBe(true);

    // The menubar title and its popup command have the same base label.  Pick
    // the non-menubar row explicitly; a label-only helper would toggle the
    // title closed instead of opening the dialog.
    await waitUntil(
        page,
        () => {
            const rows = window.wxElementRegistry?.findAllRendered?.({
                elementType: 'menuitem',
            }) ?? [];
            return rows.some((row) =>
                row.subType !== 'menubar'
                && (row.label ?? '').replace(/&/g, '').replace(/[.…\s]+$/u, '').trim()
                    === 'Preferences');
        },
        'Preferences popup command rendered',
    );

    const command = await page.evaluate(() => {
        const rows = window.wxElementRegistry?.findAllRendered?.({
            elementType: 'menuitem',
        }) ?? [];
        const row = rows.find((item) =>
            item.subType !== 'menubar'
            && (item.label ?? '').replace(/&/g, '').replace(/[.…\s]+$/u, '').trim()
                === 'Preferences');
        return row ? { x: row.centerX, y: row.centerY } : null;
    });
    expect(command, 'Preferences popup command has click coordinates').not.toBeNull();
    await page.mouse.click(command!.x, command!.y);

    // Top-level window titles are projected into their DOM title bars.  They
    // are not wxWindow labels: wxDialog::GetLabel() is empty even though
    // wxTopLevelWindow::GetTitle() is "Preferences".
    await expect(preferencesTitle(page), 'Preferences modal title bar')
        .toBeVisible({ timeout: 30000 });

    await waitUntil(
        page,
        () => {
            const registry = window.wxElementRegistry;
            if (!registry) return false;
            const pcbPage = registry.findAllRendered?.({ elementType: 'treeitem' })
                .some((item) => item.label === 'PCB Editor');
            return pcbPage === true;
        },
        'PCB Editor tree page painted in the Preferences modal',
        { timeout: 30000 },
    );
}

async function selectPcbPluginPage(page: Page): Promise<ActionPluginControls> {
    const target = await page.evaluate(() => {
        const items = window.wxElementRegistry?.findAllRendered?.({
            elementType: 'treeitem',
        }) ?? [];
        const pcb = items.find((item) => item.label === 'PCB Editor');
        if (!pcb) {
            return { point: null, matches: [], labels: items.map((item) => item.label) };
        }

        // There is also a top-level IPC "Plugins" page.  Tree hierarchy is
        // visible in the rendered geometry: the PCB child is indented and is
        // below its PCB Editor parent, while the unrelated page is not.
        const matches = items.filter((item) =>
            item.label === 'Plugins'
            && item.screenX > pcb.screenX
            && item.screenY > pcb.screenY);
        const hit = matches.length === 1 ? matches[0] : null;
        return {
            point: hit ? { x: hit.centerX, y: hit.centerY } : null,
            matches: matches.map((item) => ({ x: item.screenX, y: item.screenY })),
            labels: items.map((item) => item.label),
        };
    });

    expect(target.matches,
        `one indented PCB Editor/Plugins page; tree=${JSON.stringify(target.labels)}`)
        .toHaveLength(1);
    expect(target.point, 'PCB Editor/Plugins has click coordinates').not.toBeNull();
    await page.mouse.click(target.point!.x, target.point!.y);

    await waitUntil(
        page,
        () => {
            const registry = window.wxElementRegistry;
            if (!registry) return false;
            const grids = registry.findAll({ visible: true })
                .filter((item) => /grid$/i.test(item.typeName));
            return grids.length === 1;
        },
        'lazy PCB action-plugins grid resolved',
        { timeout: 30000 },
    );

    const controls = await page.evaluate(() => {
        const registry = window.wxElementRegistry!;
        const grids = registry.findAll({ visible: true })
            .filter((item) => /grid$/i.test(item.typeName));
        const grid = grids.length === 1 ? grids[0] : null;
        return {
            gridId: grid?.id ?? null,
            grid: grid ? {
                x: grid.screenX,
                y: grid.screenY,
                w: grid.width,
                h: grid.height,
            } : null,
        };
    });
    expect(controls.gridId, 'the active action-plugin grid has an id').not.toBeNull();
    expect(controls.grid, 'the active action-plugin grid has geometry').not.toBeNull();

    // STD_BITMAP_BUTTON is a canvas-painted wxPanel, not a DOM <button>, so
    // it has no accessible role/name and, because it derives directly from
    // wxPanel, no element-registry record.  The generated panel lays out the
    // four visible controls on the row immediately below the grid.  Derive the
    // fourth (Reload) centre from that tracked grid.  These are relative form
    // metrics, not viewport coordinates, and the enable-edge oracle below
    // independently proves that the click reached Reload: any other button or
    // a missed click produces no [false, true] grid transition.
    const reloadDx = 110;
    const reloadDy = controls.grid!.h + 21;
    return { gridId: controls.gridId!, reloadDx, reloadDy };
}

async function installGridEnableProbe(page: Page, gridId: string): Promise<{
    count: number;
    initial: boolean | null;
    types: string[];
}> {
    return page.evaluate((wantedId) => {
        const registry = window.wxElementRegistry;
        if (!registry) return { count: 0, initial: null, types: [] };

        const grid = registry.getElement(wantedId);
        if (!grid) {
            return {
                count: 0,
                initial: null,
                types: [],
            };
        }

        const runtime = globalThis as typeof globalThis & {
            __actionPluginReloadProbe?: ReloadProbe;
        };
        const probe: ReloadProbe = {
            gridId: grid.id,
            current: grid.enabled,
            changes: [],
            writes: 0,
        };

        // wxElementUpdate assigns elem.enabled directly.  Preserve the
        // property's normal read/write behavior while retaining its state
        // edges, including edges completed synchronously inside one click.
        Object.defineProperty(grid, 'enabled', {
            configurable: true,
            enumerable: true,
            get: () => probe.current,
            set: (enabled: boolean) => {
                probe.writes++;
                if (enabled !== probe.current) {
                    probe.current = enabled;
                    probe.changes.push(enabled);
                }
            },
        });
        runtime.__actionPluginReloadProbe = probe;
        return { count: 1, initial: probe.current, types: [grid.typeName] };
    }, gridId);
}

async function reloadProbe(page: Page): Promise<ReloadProbe | null> {
    return page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
            __actionPluginReloadProbe?: ReloadProbe;
        };
        const probe = runtime.__actionPluginReloadProbe;
        return probe ? {
            gridId: probe.gridId,
            current: probe.current,
            changes: [...probe.changes],
            writes: probe.writes,
        } : null;
    });
}

async function reloadButtonPoint(page: Page, controls: ActionPluginControls): Promise<{
    visible: boolean;
    x: number;
    y: number;
} | null> {
    return page.evaluate((value) => {
        const grid = window.wxElementRegistry?.getElement(value.gridId);
        return grid ? {
            visible: grid.visible,
            x: grid.screenX + value.reloadDx,
            y: grid.screenY + value.reloadDy,
        } : null;
    }, controls);
}

async function visibleTooltipText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const tooltip = document.getElementById('wx-tooltip');
        if (!tooltip) return '';

        const visible = tooltip.style.display !== 'none'
            && getComputedStyle(tooltip).display !== 'none';
        return visible ? tooltip.textContent ?? '' : '';
    });
}

async function toolbarFanoutProbe(page: Page): Promise<ToolbarFanoutProbe> {
    return page.evaluate(() => {
        const registry = window.wxElementRegistry;
        const toolbars = registry?.findAll().filter((item) =>
            /(?:ACTION_TOOLBAR|wxAuiToolBar)$/i.test(item.typeName)) ?? [];
        const toolbarIds = new Set(toolbars.map((item) => item.id));
        const tools = registry?.findAllRendered?.({ elementType: 'tool' })
            .filter((item) => toolbarIds.has(item.parentId)) ?? [];
        const module = (window as unknown as { Module?: Partial<Mod> }).Module;
        return {
            toolbarCount: toolbars.length,
            toolCount: tools.length,
            frameEventCount:
                module?.kicadTestPcbPluginAvailabilityFrameEvents?.() ?? -1,
        };
    });
}

test.describe('PCB action-plugin reload modal delegation', () => {
    test('modal tooltip and reload completion enter Preferences and retire cleanly',
        async ({ page, testLogger }) => {
            test.setTimeout(180000);
            await page.goto('/kicad/pcbnew.html');
            await waitForPcbnew(page);

            await openPreferences(page);
            const controls = await selectPcbPluginPage(page);

            // A derived wxTimer owns itself unless the tooltip layer explicitly
            // binds it to the hovered wxWindow. Self-owned timer delivery is
            // Ordinary work and must remain blocked while Preferences holds the
            // root owner. The visible tooltip is therefore a real-app oracle for
            // exact modal-scope capture: it must fire while Preferences remains
            // open, without widening admission for other unowned timers.
            const reloadForHover = await reloadButtonPoint(page, controls);
            expect(reloadForHover, 'Reload Plugins hover target exists').not.toBeNull();
            expect(reloadForHover?.visible, 'Reload Plugins hover target is visible').toBe(true);
            await page.mouse.move(reloadForHover!.x, reloadForHover!.y);
            await expect.poll(
                () => visibleTooltipText(page),
                {
                    message: 'the window-owned tooltip timer fires inside Preferences',
                    timeout: 4000,
                    intervals: [25, 50, 100],
                },
            ).toBe('Reload Plugins');
            expect(await preferencesTitle(page).isVisible(),
                'Preferences remains modal while its tooltip is visible').toBe(true);

            // Move to the grid before the click cycles. This proves the tooltip
            // is still tied to the exact hover and removes it from the following
            // reload oracle rather than relying on overlay behavior.
            const gridPoint = await page.evaluate((gridId) => {
                const grid = window.wxElementRegistry?.getElement(gridId);
                return grid ? {
                    x: grid.screenX + Math.max(1, grid.width / 2),
                    y: grid.screenY + Math.max(1, grid.height / 2),
                } : null;
            }, controls.gridId);
            expect(gridPoint, 'plugin grid has a safe non-tooltip point').not.toBeNull();
            await page.mouse.move(gridPoint!.x, gridPoint!.y);
            await expect.poll(() => visibleTooltipText(page), {
                message: 'leaving the exact Reload hover hides its tooltip',
                timeout: 2000,
            }).toBe('');

            const installed = await installGridEnableProbe(page, controls.gridId);
            expect(installed.count,
                `exactly one visible action-plugin grid; types=${JSON.stringify(installed.types)}`)
                .toBe(1);
            expect(installed.initial, 'the plugin grid starts enabled').toBe(true);

            // The editor frame also listens for the same process-wide event
            // and calls RecreateToolbars().  A delegate on wxApp would let
            // that unrelated root handler run under the panel's modal lease.
            // KiCad uses canvas-painted ACTION_TOOLBAR/wxAuiToolBar windows,
            // not the DOM-backed generic wxToolBar. The element registry
            // proves that the real PCB toolbars and their painted tools are
            // present. Their window roots survive RecreateToolbars(), so DOM
            // identity is not a rebuild oracle. Instead, use the exact native
            // PCB-frame listener count: each escaped process-wide completion
            // increments it immediately before RecreateToolbars().
            const toolbarBaseline = await toolbarFanoutProbe(page);
            expect(toolbarBaseline.toolbarCount,
                'the parked PCB editor exposes its main toolbars').toBeGreaterThanOrEqual(4);
            expect(toolbarBaseline.toolCount,
                'the parked PCB editor toolbars contain real tool nodes').toBeGreaterThan(0);
            expect(toolbarBaseline.frameEventCount,
                'the native PCB-frame fan-out oracle is exported').toBeGreaterThanOrEqual(0);

            // Three immediate UI cycles exercise fresh delegate capture and
            // retirement repeatedly without timing sleeps.  The modal remains
            // open for all of them.
            for (let cycle = 1; cycle <= 3; cycle++) {
                const reload = await reloadButtonPoint(page, controls);
                expect(reload, `reload control exists for cycle ${cycle}`).not.toBeNull();
                expect(reload?.visible, `reload control visible for cycle ${cycle}`).toBe(true);
                await page.mouse.click(reload!.x, reload!.y);

                const expected = Array.from(
                    { length: cycle * 2 },
                    (_, index) => index % 2 === 1,
                );
                await expect.poll(
                    async () => (await reloadProbe(page))?.changes ?? [],
                    {
                        message: `cycle ${cycle} disables the grid and its delegated event re-enables it`,
                        timeout: 10000,
                        intervals: [25, 50, 100],
                    },
                ).toEqual(expected);

                const current = await reloadProbe(page);
                expect(current?.current, `grid enabled after reload cycle ${cycle}`).toBe(true);
                const preferencesOpen = await preferencesTitle(page).isVisible();
                expect(preferencesOpen,
                    `Preferences remains open after reload cycle ${cycle}`).toBe(true);

                const toolbarProbe = await toolbarFanoutProbe(page);
                expect(toolbarProbe.frameEventCount,
                    `cycle ${cycle} completion must not fan out to the parked editor toolbar listener`)
                    .toBe(toolbarBaseline.frameEventCount);
            }

            // Retire the exact modal owner through a real dialog control.
            const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
            await expect(cancel, 'Preferences Cancel button').toBeVisible();
            await cancel.click();
            await expect(preferencesTitle(page), 'Preferences modal retired after Cancel')
                .toBeHidden({ timeout: 20000 });

            await assertEditorRuntimeHealthy(page, 'action-plugin reload modal close');

            // A new native menu receipt after modal retirement proves this is
            // not merely a painted last frame from a wedged runtime.
            expect(await clickMenuBarItem(page, 'Help'),
                'Help menu remains interactive after reload and close').toBe(true);
            await waitUntil(
                page,
                () => (window.wxElementRegistry?.findAllRendered?.({
                    elementType: 'menuitem',
                }) ?? []).some((item) =>
                    item.subType !== 'menubar' && /About/i.test(item.label ?? '')),
                'Help popup is produced by a post-modal native receipt',
            );
            await page.keyboard.press('Escape');

            const scheduler = await page.evaluate(() => {
                const state = (globalThis as typeof globalThis & {
                    __wxScheduler?: SchedulerState;
                }).__wxScheduler;
                return {
                    present: !!state,
                    dead: state?.dead ?? null,
                    nativeTraps: state?.nativeTraps ?? null,
                    pendingModal: state?.pendingWaits?.('modal') ?? null,
                    pendingNested: state?.pendingWaits?.('nested') ?? null,
                    canTouchNative: state?.canTouchNative?.() ?? false,
                };
            });
            expect(scheduler.present, 'execution scheduler is installed').toBe(true);
            expect(scheduler.dead, 'scheduler remains live').toBe(false);
            expect(scheduler.nativeTraps, 'no native entry trapped').toBe(0);
            expect(scheduler.pendingModal, 'no modal wait leaked').toBe(0);
            expect(scheduler.pendingNested, 'no nested wait leaked').toBe(0);
            expect(scheduler.canTouchNative, 'native entry is available after close').toBe(true);

            const traps = [...testLogger.consoleLogs, ...testLogger.errors]
                .filter((line) => TRAP.test(line));
            expect(traps, `no WASM trap or refused resume:\n${traps.join('\n')}`).toEqual([]);
        });
});
