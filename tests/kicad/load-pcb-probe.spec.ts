import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickMenuBarItem, clickMenuItem, waitForEditorReady, shotPath } from '../e2e/utils/element-tracker';

/**
 * Probe spec: drives the wizard, opens File menu, clicks Open, then dumps
 * everything we need to know about the wxFileDialog state — what frame paints,
 * what directory the dialog starts in, what list items are registered, what
 * the OK/Cancel button labels are, and which MEMFS directories exist.
 *
 * Output:
 *   tests/logs/kicad/load-pcb-probe/<test-name>.log       (everything via console)
 *   tests/test-results/probe-*.png                        (screenshots)
 *
 * This is a one-shot investigation, not a regression test. It always passes;
 * the value is the captured state.
 */

async function dumpRegistry(page: Page, label: string): Promise<void> {
    const summary = await page.evaluate((tag: string) => {
        const registry = window.wxElementRegistry;
        if (!registry) {
            return { tag, error: 'no registry' };
        }

        const stats = registry.getStats();
        const renderedStats = registry.getRenderedStats?.();

        const allElements = registry.findAll({ visible: true });

        const frames = allElements
            .filter((el) => /Frame|Dialog|Wizard/.test(el.typeName))
            .slice(0, 30)
            .map((el) => ({
                id: el.id,
                typeName: el.typeName,
                label: el.label,
                name: el.name,
                visible: el.visible,
                enabled: el.enabled,
                screenX: el.screenX,
                screenY: el.screenY,
                width: el.width,
                height: el.height,
            }));

        // Try to spot the file dialog specifically
        const fileDialogs = allElements
            .filter((el) =>
                /FileDialog|FileCtrl|FileList|GenericDir/.test(el.typeName) ||
                /file/i.test(el.label) ||
                /file/i.test(el.name)
            )
            .slice(0, 50)
            .map((el) => ({
                id: el.id,
                typeName: el.typeName,
                label: el.label,
                name: el.name,
                visible: el.visible,
                screenX: el.screenX,
                screenY: el.screenY,
                width: el.width,
                height: el.height,
            }));

        const rendered = registry.findAllRendered ? registry.findAllRendered({}) : [];
        const byType = rendered.reduce<Record<string, number>>((acc, item) => {
            acc[item.elementType] = (acc[item.elementType] ?? 0) + 1;
            return acc;
        }, {});

        const menuItems = rendered
            .filter((r) => r.elementType === 'menuitem')
            .slice(0, 60)
            .map((r) => ({
                id: r.id,
                subType: r.subType,
                label: r.label,
                enabled: r.enabled,
                screenX: r.screenX,
                screenY: r.screenY,
            }));

        const listItems = rendered
            .filter((r) => r.elementType === 'listitem')
            .slice(0, 60)
            .map((r) => ({
                id: r.id,
                label: r.label,
                index: r.index,
                screenX: r.screenX,
                screenY: r.screenY,
            }));

        // Buttons (rendered as wxButton in elements, not in rendered registry)
        const buttons = allElements
            .filter((el) => /Button/.test(el.typeName))
            .slice(0, 40)
            .map((el) => ({
                id: el.id,
                typeName: el.typeName,
                label: el.label,
                name: el.name,
                screenX: el.screenX,
                screenY: el.screenY,
            }));

        // Text controls (path bar in dialog is usually a wxTextCtrl)
        const textCtrls = allElements
            .filter((el) => /TextCtrl|ComboCtrl|ComboBox|Choice/.test(el.typeName))
            .slice(0, 30)
            .map((el) => ({
                id: el.id,
                typeName: el.typeName,
                label: el.label,
                name: el.name,
                screenX: el.screenX,
                screenY: el.screenY,
                width: el.width,
                height: el.height,
            }));

        return {
            tag,
            stats,
            renderedStats,
            renderedByType: byType,
            frames,
            fileDialogs,
            menuItems,
            listItems,
            buttons,
            textCtrls,
        };
    }, label);

    // Logged via console so it lands in tests/logs/kicad/load-pcb-probe/<test>.log
    console.log(`[PROBE] ${label} :: ${JSON.stringify(summary)}`);
}

async function dumpMemfs(page: Page, candidates: string[]): Promise<void> {
    const results = await page.evaluate((paths: string[]) => {
        const out: Array<{ path: string; entries: string[] | string }> = [];
        for (const p of paths) {
            try {
                // @ts-ignore — Emscripten FS is global on Module
                const entries = (window as any).FS.readdir(p) as string[];
                out.push({ path: p, entries });
            } catch (e: any) {
                out.push({ path: p, entries: `ERROR: ${e?.message ?? e}` });
            }
        }
        return out;
    }, candidates);

    console.log(`[PROBE-FS] ${JSON.stringify(results)}`);
}

test.describe('PCB load probe', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/kicad/pcbnew.html');
    });

    // NOTE: This is a one-shot DIAGNOSTIC probe (always green; its value is the logged
    // state dumps + screenshots). The fixed waits below are intentional "let state evolve,
    // then capture it" intervals, not readiness races — they are exempt from the no-sleep
    // guard on purpose. Regression specs (load-pcb, occ-export, …) use deterministic waits.
    test('inspect File→Open dialog state', async ({ page }) => {
        await waitForEditorReady(page);

        await page.screenshot({ path: shotPath(page, 'probe-00-after-wizard.png'), scale: 'css' });

        await dumpMemfs(page, [
            '/',
            '/home',
            '/home/kicad',
            '/home/kicad/documents',
            '/home/kicad/documents/kicad',
            '/home/kicad/documents/kicad/10.0',
            '/home/kicad/documents/kicad/10.0/projects',
            '/tmp',
            '/workspace',
        ]);

        await dumpRegistry(page, 'after-wizard');

        // Click File menu
        const fileClicked = await clickMenuBarItem(page, 'File');
        console.log(`[PROBE] File menu clicked: ${fileClicked}`);
        await page.waitForTimeout(500);  // eslint-disable-line -- diagnostic one-shot; intentional state-capture interval

        await page.screenshot({ path: shotPath(page, 'probe-01-file-menu-open.png'), scale: 'css' });
        await dumpRegistry(page, 'file-menu-open');

        // Click Open menu item (try common label variants)
        let openClicked = await clickMenuItem(page, 'Open...');
        if (!openClicked) openClicked = await clickMenuItem(page, 'Open…');
        if (!openClicked) openClicked = await clickMenuItem(page, 'Open');
        console.log(`[PROBE] Open menu item clicked: ${openClicked}`);

        // Give the file dialog generous time to render — wxGenericFileDialog
        // populates its file list by scanning the directory, which on MEMFS
        // is fast but goes through the suspending event loop.
        await page.waitForTimeout(3000);  // eslint-disable-line -- diagnostic one-shot; intentional state-capture interval

        await page.screenshot({ path: shotPath(page, 'probe-02-after-open-click.png'), scale: 'css' });
        await dumpRegistry(page, 'after-open-click');

        // Wait a bit longer and dump again, in case the dialog paints late
        await page.waitForTimeout(3000);  // eslint-disable-line -- diagnostic one-shot; intentional state-capture interval
        await page.screenshot({ path: shotPath(page, 'probe-03-late.png'), scale: 'css' });
        await dumpRegistry(page, 'late');

        // Final check: re-dump MEMFS so we can confirm nothing changed under us
        await dumpMemfs(page, [
            '/home/kicad/documents/kicad/10.0/projects',
            '/tmp',
        ]);

        // Probe is always green — the artifacts (logs + screenshots) are the result.
        expect(true).toBe(true);
    });
});
