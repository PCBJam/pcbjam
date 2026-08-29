import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';
import { shotPath } from '../e2e/utils/element-tracker';

/**
 * Sheet navigator panel e2e (sheet-panel): the floating React stand-in for
 * the wx hierarchy pane that canvas-only sessions can't reach. Opens the
 * hierarchical fixture (tests/fixtures/demo/hier: root → Power, IO → Sub) and
 * asserts
 *   - the panel lists every sheet instance, page-ordered and depth-indented,
 *     from the C++ tree export (kicadSheetsGetTree — names come from the
 *     Sheetname properties, not filenames);
 *   - clicking a row navigates (kicadSheetsEnter → SCH_ACTIONS::changeSheet)
 *     and the panel follows through the onSheetsState push; the collab sheet
 *     manager rebinds to the now-active .kicad_sch (the `[sheet]` log);
 *   - this works for the READ-ONLY viewer (`?readonly=1`): the navigate
 *     actions are on the PCBJAM_READ_ONLY allowlist;
 *   - a flat schematic (demo.kicad_sch) gets no panel and no menu row.
 *
 * Needs a wasm build exporting kicadSheetsGetTree/kicadSheetsEnter — an
 * older bundle hides the panel (feature-detected), which fails the first
 * assertion; rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';

type Mod = {
  kicadSheetsGetTree(): string;
  kicadSheetsEnter(path: string): boolean | Promise<boolean>;
};
type SheetsState = { current: string; sheets: { path: string; name: string; depth: number; page: string }[] };

async function bootSchematic(page: Page, file: string, params = ''): Promise<string[]> {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`/${SCOPE}/projects/demo/${file}${params}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
  return logs;
}

async function tree(page: Page): Promise<SheetsState> {
  return page.evaluate(() => {
    const mod = (window as unknown as { Module: Mod }).Module;
    return JSON.parse(mod.kicadSheetsGetTree()) as SheetsState;
  });
}

test.describe('sheet panel', () => {
  test('read-only viewer: lists the hierarchy and navigates between sheets', async ({ page }) => {
    test.setTimeout(300000); // Firefox cold boot alone is ~2 min; three navigations follow.
    const logs = await bootSchematic(page, 'hier/hier.kicad_sch', '?readonly=1');

    // Viewer boot: the panel is up as a collapsed header (viewer-panels default).
    const panel = page.getByTestId('sheet-panel');
    await expect(panel).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('sheet-panel-list')).toHaveCount(0);
    await page.getByTestId('sheet-panel-collapse').click();

    // Every instance, page-ordered, names from Sheetname, depth-indented.
    const rows = page.getByTestId('sheet-row');
    await expect(rows).toHaveCount(4);
    await expect(rows).toHaveText([/hier/, /Power/, /IO/, /Sub/]);
    const state = await tree(page);
    expect(state.sheets.map((s) => [s.name, s.depth, s.page])).toEqual([
      ['hier', 0, '1'],
      ['Power', 1, '2'],
      ['IO', 1, '3'],
      ['Sub', 2, '4'],
    ]);
    expect(state.current).toBe(state.sheets[0]!.path);
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true');

    await page.screenshot({ path: shotPath(page, 'web-sheet-panel-root.png'), scale: 'css' });

    // Navigate to the nested sheet: the row activates via the C++ push, the
    // frame's current sheet moved, and collab rebound its room to io_sub.
    await rows.nth(3).click();
    await expect(rows.nth(3)).toHaveAttribute('data-active', 'true', { timeout: 30000 });
    await expect(rows.nth(0)).not.toHaveAttribute('data-active', 'true');
    await expect.poll(async () => (await tree(page)).current).toBe(state.sheets[3]!.path);
    await expect
      .poll(() => logs.some((l) => /\[sheet\].*io_sub\.kicad_sch/.test(l)), { timeout: 30000 })
      .toBe(true);

    await page.screenshot({ path: shotPath(page, 'web-sheet-panel-sub.png'), scale: 'css' });

    // And back to the root.
    await rows.nth(0).click();
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true', { timeout: 30000 });
    await expect.poll(async () => (await tree(page)).current).toBe(state.sheets[0]!.path);

    // Menu row toggles it off/on; close button removes it.
    await openOverlayMenu(page);
    await page.getByTestId('sheet-panel-toggle').click();
    await expect(panel).toHaveCount(0);
    await openOverlayMenu(page);
    await page.getByTestId('sheet-panel-toggle').click();
    await expect(panel).toBeVisible();
    // The open menu (z-50) sits over the panel's right-anchored header —
    // close it (FAB toggles) before the close button is clickable.
    await page.getByTestId('overlay-menu-fab').click();
    await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
    await page.getByTestId('sheet-panel-close').click();
    await expect(panel).toHaveCount(0);
  });

  test('a flat schematic shows no sheet panel and no menu row', async ({ page }) => {
    await bootSchematic(page, 'demo.kicad_sch', '?readonly=1');
    // The other viewer panel proves the chrome-hidden panel layer is up.
    await expect(page.getByTestId('inspector-panel')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('sheet-panel')).toHaveCount(0);
    await openOverlayMenu(page);
    await expect(page.getByTestId('inspector-panel-toggle')).toBeVisible();
    await expect(page.getByTestId('sheet-panel-toggle')).toHaveCount(0);
    const state = await tree(page);
    expect(state.sheets).toHaveLength(1);
  });

  test('wx-driven navigation updates the panel (kicadSheetsEnter without the panel open)', async ({
    page,
  }) => {
    test.setTimeout(300000);
    await bootSchematic(page, 'hier/hier.kicad_sch', '?readonly=1');
    const panel = page.getByTestId('sheet-panel');
    await expect(panel).toBeVisible({ timeout: 30000 });
    await page.getByTestId('sheet-panel-collapse').click();
    const rows = page.getByTestId('sheet-row');
    await expect(rows).toHaveCount(4);
    const state = await tree(page);
    // Drive the bridge directly (stands in for a double-clicked sheet symbol /
    // toolbar arrow: both end in DisplayCurrentSheet → OnSchSheetChanged push).
    const ok = await page.evaluate(
      (p) => (window as unknown as { Module: Mod }).Module.kicadSheetsEnter(p),
      state.sheets[1]!.path,
    );
    expect(ok).toBe(true);
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true', { timeout: 30000 });
    // An unknown path is rejected synchronously and changes nothing.
    const bad = await page.evaluate(
      () => (window as unknown as { Module: Mod }).Module.kicadSheetsEnter('/not-a-sheet'),
    );
    expect(bad).toBe(false);
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true');
  });
});
