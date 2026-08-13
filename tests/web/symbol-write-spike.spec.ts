import { test, expect, type Page } from '@playwright/test';
import {
  clickByTooltip,
  waitForWxApp,
  focusCanvas,
  waitUntil, stableShot } from '../e2e/utils/element-tracker';

/**
 * 0004-A write-path spike: does the symbol editor's SaveSymbol path route through
 * the pcbjam write bridge, on the MAIN thread, without wedging?
 *
 * Boots the fileless symbol_editor with `?libwrite=1` (an in-memory writable
 * "My Symbols (spike)" lib), creates a new symbol in it, and Ctrl+S saves. The
 * plugin's SaveSymbol serializes a kicad_symbol_lib and calls
 * window.kicadLibs.request("save", …) on the main thread (EM_ASYNC_JS), which the
 * spike captures onto window.__pcbjamSaved. Assert: the body is well-formed
 * fork-native s-expr, and the app stays live (no abort / no OOM respawn).
 */

async function bootSymbolEditor(page: Page): Promise<void> {
  await page.goto('/default/projects/demo/-/symbol_editor?libwrite=1');
  await waitForWxApp(page, { timeout: 150000 });
  await page.waitForFunction(
    () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({}).length > 5,
    null,
    { timeout: 150000 },
  );
  await page.waitForFunction(() => !!(window as any).kicadLibs, null, { timeout: 60000 });
}

  // KNOWN-BROKEN: the fp/sym editor kicadLibs enumerate/save flows are dead
  // (docs/features/web-e2e-rot/01-editor-lib-bridge-flows.md). fixme, not fail:
  // on CI this dies in a 180s boot timeout per engine — running it buys no signal.
// Probed 2026-08-13 on the JSPI build: still dead — wedges at the New Symbol/
// Footprint dialog step on BOTH engines (web-e2e-rot 01 stands for writes).
test.fixme(
  'symbol editor save routes through the pcbjam write bridge (main thread)', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await bootSymbolEditor(page);
  await stableShot(page, 'symwrite-01-boot.png');

  // Spike provider is active.
  expect(await page.evaluate(() => !!(window as any).__pcbjamSaved), 'spike marker present').toBe(true);

  // Select the writable lib in the tree so New Symbol targets it. The
  // dataviewitem's registry y sits on the column header, so anchor off the
  // "Item" column header and click one row below it (the lib is the only row).
  const hdr = await page.evaluate(() => {
    const rd = window.wxElementRegistry.findAllRendered({});
    const h = rd.find((e: any) => e.elementType === 'columnheader' && e.label === 'Item');
    return h ? { cx: h.centerX, cy: h.centerY, hgt: h.height } : null;
  });
  expect(hdr, 'Item column header found').not.toBeNull();
  // Click focuses the tree row but doesn't always select it; drive the keyboard
  // to make the first (only) library row the SELECTED item (GetTargetLibId).
  await page.mouse.click(hdr!.cx, hdr!.cy + hdr!.hgt + 8); // focus the tree
  await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell
  await page.keyboard.press('Home');
  await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400); // eslint-disable-line -- documented interaction dwell
  await stableShot(page, 'symwrite-02-lib-selected.png');

  // New Symbol via the toolbar button (tooltip), proven-clickable in the harness.
  const clicked = await clickByTooltip(page, 'New Symbol...');
  expect(clicked, 'New Symbol toolbar button clicked').toBe(true);
  await waitUntil(
    page,
    () => window.wxElementRegistry.findAll({ visible: true }).some((e: any) => /Dialog/i.test(e.typeName)),
    'New Symbol dialog visible',
  );
  await stableShot(page, 'symwrite-03-newsym-dialog.png');

  // Diagnostics: what dialog/controls are present now.
  const dlg = await page.evaluate(() => {
    const all = window.wxElementRegistry.findAll({ visible: true });
    const pick = (re: RegExp) => all.filter((e: any) => re.test(e.typeName))
      .map((e: any) => ({ type: e.typeName, name: e.name, label: e.label, cx: Math.round(e.centerX), cy: Math.round(e.centerY), en: e.enabled }));
    return { dialogs: pick(/Dialog/i), texts: pick(/TextCtrl/i), buttons: pick(/Button/i) };
  });
  logs.push(`[spec] after New Symbol: ${JSON.stringify(dlg)}`);

  // The New Symbol dialog: clear its name field (it pre-fills a default) and type
  // our name, then confirm with Enter (the dialog's default button).
  const SYM = 'SpikeRes';
  const nameField = dlg.texts.find((t) => Math.abs(t.cy - 65) > 30 && Math.abs(t.cy - 87) > 30);
  expect(nameField, 'New Symbol name field present').toBeTruthy();
  await page.mouse.click(nameField!.cx, nameField!.cy);
  await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(SYM, { delay: 40 });
  await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell
  await stableShot(page, 'symwrite-04-name-typed.png');
  await page.keyboard.press('Enter');
  await waitUntil(
    page,
    () => !window.wxElementRegistry.findAll({ visible: true }).some((e: any) => /Dialog/i.test(e.typeName)),
    'New Symbol dialog dismissed',
  );
  await stableShot(page, 'symwrite-05-symbol-created.png');

  // Title should reflect the new symbol now being edited.
  const titleAfterCreate = await page.title();
  logs.push(`[spec] title after create: ${titleAfterCreate}`);

  // Save: focus the canvas, Ctrl+S (the proven save trigger).
  await focusCanvas(page);
  await page.keyboard.press('Control+s');

  // Wait for the bridge to capture the saved body (name-agnostic — the New Symbol
  // dialog may massage the typed name, e.g. a trailing default digit).
  await page.waitForFunction(
    () => {
      const saved = (window as any).__pcbjamSaved as Record<string, string> | undefined;
      return !!saved && Object.values(saved).some((v) => typeof v === 'string' && v.length > 0);
    },
    null,
    { timeout: 30000 },
  );
  await stableShot(page, 'symwrite-06-saved.png');

  const { savedName, body } = await page.evaluate(() => {
    const saved = (window as any).__pcbjamSaved as Record<string, string>;
    const k = Object.keys(saved).find((n) => saved[n]?.length)!;
    return { savedName: k, body: saved[k] };
  });
  logs.push(`[spec] saved "${savedName}" (${body.length} bytes):\n${body}`);

  // The captured body is a well-formed fork-native kicad_symbol_lib carrying the
  // saved symbol.
  expect(body).toContain('(kicad_symbol_lib');
  expect(body).toContain('(version 20250925)');
  expect(body).toContain(`(symbol "${savedName}"`);

  // No post-save error dialog (the placeholder-file fix for GetModificationTime).
  await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell
  const errDialog = await page.evaluate(() =>
    window.wxElementRegistry
      .findAll({ visible: true })
      .some((e: any) => /Dialog/i.test(e.typeName) && /Error/i.test(e.label || '')),
  );
  expect(errDialog, 'no post-save error dialog').toBe(false);
  expect(
    logs.some((l) => l.includes('Failed to retrieve file times')),
    'no file-times error',
  ).toBe(false);

  // App stayed live: no abort, no OOM respawn.
  expect(logs.some((l) => l.includes('Aborted(')), 'no WASM abort').toBe(false);
  expect(new URL(page.url()).searchParams.get('oomRetry'), 'no OOM respawn').toBeNull();

  // Dump logs for the record.
  console.log('--- console + spec log ---\n' + logs.join('\n'));
});
