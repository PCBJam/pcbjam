import * as fs from 'fs';
import * as path from 'path';
import { expect, type Page } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText, waitUntil } from '../../e2e/utils/element-tracker';
import { injectFromSubmodule } from './fs-inject';
import { waitForBoardLoaded } from './board-ready';
import { waitForPcbnew } from './pcbnew-ready';
import { PROJECT_DIR_MEMFS } from './threed-viewer';

/**
 * A Footprint Editor with a real, writable footprint library in its tree.
 *
 * The footprint_editor harness has no libraries, so these specs boot pcbnew
 * with the ecc83 demo, whose PROJECT library `Footprints`
 * (${KIPRJMOD}/footprints.pretty) the Footprint Editor then lists. Extra
 * footprints can be dropped into that library before the board opens.
 * Footprint Editor actions run through Module.kicadLibsTestEditorAction
 * (wasm/bindings/pcbnew_embind.cpp), which selects a tree row first, as the
 * tree's context menu would.
 */

export const LIB = 'Footprints';
const DEMO_DIR = 'kicad/demos/ecc83';
const STEM = 'ecc83-pp';
export const PRETTY_MEMFS = `${PROJECT_DIR_MEMFS}/footprints.pretty`;

type Logger = { consoleLogs: string[]; errors: string[] };

export async function openEcc83WithFootprintEditor(
    page: Page,
    testLogger: Logger,
    extraFootprints: Record<string, string> = {},
): Promise<void> {
    await page.goto('/kicad/pcbnew.html');
    await waitForPcbnew(page);

    const root = path.resolve(__dirname, '..', '..', '..');
    for (const f of fs.readdirSync(path.join(root, DEMO_DIR, 'footprints.pretty')))
        await injectFromSubmodule(page, `${DEMO_DIR}/footprints.pretty/${f}`, `${PRETTY_MEMFS}/${f}`);
    for (const f of ['fp-lib-table', `${STEM}.kicad_pcb`, `${STEM}.kicad_pro`])
        await injectFromSubmodule(page, `${DEMO_DIR}/${f}`, `${PROJECT_DIR_MEMFS}/${f}`);
    await page.evaluate(({ dir, files }) => {
        const FS = (window as any).FS;
        for (const [name, body] of Object.entries(files)) FS.writeFile(`${dir}/${name}.kicad_mod`, body);
    }, { dir: PRETTY_MEMFS, files: extraFootprints });

    // File > Open the board (its project brings the library in).
    expect(await clickMenuBarItem(page, 'File'), 'File menu').toBe(true);
    await clickMenuItemByText(page, 'Open');
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
    await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell: focus caret must land in the wx text ctrl before typing
    await page.keyboard.type(`${STEM}.kicad_pcb`);
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: typed filename must flush to the wx text ctrl before Enter confirms
    await page.keyboard.press('Enter');
    await waitForBoardLoaded(page, testLogger, 60000);

    // Opens the Footprint Editor frame; loadInEditor() waits for it to exist.
    await page.evaluate(() => (window as any).Module.kicadTestRunAction('common.Control.showFootprintEditor'));
}

/** The Footprint Editor's open footprint: "<lib>:<name>|<pads>" or "". */
export function editorFootprint(page: Page): Promise<string> {
    return page.evaluate(() => (window as any).Module.kicadLibsTestEditorFootprint() as string);
}

/** Open <lib>:<name> in the Footprint Editor and wait until it is loaded. */
export async function loadInEditor(page: Page, name: string): Promise<void> {
    await expect
        .poll(() => page.evaluate(({ lib, name }) => (window as any).Module.kicadLibsTestEditorLoad(lib, name) as boolean,
            { lib: LIB, name }), { message: 'footprint editor accepts a load' })
        .toBe(true);
    await expect.poll(() => editorFootprint(page), { message: `${name} open in the footprint editor` })
        .toMatch(new RegExp(`^${LIB}:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`));
}

/** Run a Footprint Editor action with <lib>:<name> (or the library row, name '') selected. */
export async function editorAction(page: Page, action: string, name = ''): Promise<void> {
    const ok = await page.evaluate(({ action, lib, name }) =>
        (window as any).Module.kicadLibsTestEditorAction(action, lib, name) as boolean, { action, lib: LIB, name });
    expect(ok, `${action} dispatched`).toBe(true);
}
