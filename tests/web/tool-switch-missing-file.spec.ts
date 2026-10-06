import { test, expect, type Page } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText, stableShot } from '../e2e/utils/element-tracker';

/**
 * Tool-switch with a MISSING counterpart: eeschema Tools → "Switch to PCB
 * Editor" in a project that has no .kicad_pcb must CREATE the templated board
 * and navigate to it (native KiCad opens pcbnew on a new board at the derived
 * path) — not silently no-op (the old behavior: the WasmTool nav hook logged
 * "[nav] no project file found" and returned false). Like every schematic ⇄
 * PCB switch, the board opens in a NEW TAB and the schematic tab stays
 * (cross-probe 0001).
 *
 * The backend demo fixture carries both files, so this spec builds a
 * schematic-only project the way a user does: home page Tools grid →
 * "Schematic Editor" → NewFileDialog (project "Untitled" → slug "untitled",
 * file "main.kicad_sch") → a browser-local IndexedDB project under the @local
 * scope. That flow only renders when the standalone runs with
 * VITE_LOCAL_PROJECTS=idb (playwright-web.config.ts sets it for cold starts;
 * a hand-started stack must set it too — the dialog assertion below names the
 * flag so a mis-configured stack fails self-diagnosingly). A fresh Playwright
 * context has an empty IDB, so the slug is deterministically "untitled".
 */

async function waitForToolReady(page: Page, titleRe: RegExp): Promise<void> {
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `editor never reached title ${titleRe}`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(titleRe);
  // The menu helpers drive the rendered-element registry.
  await page.waitForFunction(
    () =>
      !!(window as unknown as { wxElementRegistry?: { findAllRendered?: unknown } })
        .wxElementRegistry,
    null,
    { timeout: 30000 }
  );
  // The boot and eager-library overlays (WasmTool, `absolute inset-0 z-30`)
  // cover the whole editor including the menubar — synthetic menu clicks land
  // on them until they clear (eeschema hydrates the full symbol set post-boot).
  await expect(page.locator('div.absolute.inset-0.z-30')).toHaveCount(0, {
    timeout: 180000,
  });
}

test.describe('web app — tool switch creates the missing counterpart', () => {
  test('eeschema → Switch to PCB Editor creates and opens main.kicad_pcb', async ({ page }) => {
    test.setTimeout(420000); // two full wasm boots

    // Home → Tools grid: with the local store on, launching a document tool
    // opens the new-file dialog (HomePage onLaunch → setNewFileTool).
    await page.goto('/');
    await page.getByRole('button', { name: 'Schematic Editor', exact: true }).click();
    await expect(
      page.locator('#newfile-projectname'),
      'new-file dialog must open — is the stack running with VITE_LOCAL_PROJECTS=idb?'
    ).toBeVisible();
    // The defaults are what the URL assertions below rely on (and their
    // presence doubles as a dialog-hydrated wait).
    await expect(page.locator('#newfile-projectname')).toHaveValue('Untitled');
    await expect(page.locator('#newfile-name')).toHaveValue('main.kicad_sch');
    await page.getByRole('button', { name: 'Create & open' }).click();

    // NewFileDialog persists to IDB, then hard-navigates to the file route.
    await page.waitForURL(/\/@local\/projects\/untitled\/main\.kicad_sch/, { timeout: 30000 });
    await waitForToolReady(page, /main — Schematic Editor/i);

    // The switch. Before the fix nothing happens (no new tab, no dialog), so
    // the popup wait below is where this spec fails.
    const schUrl = page.url();
    expect(await clickMenuBarItem(page, 'Tools'), 'Tools menubar item clickable').toBe(true);
    const [pcb] = await Promise.all([
      page.waitForEvent('popup', { timeout: 30000 }),
      clickMenuItemByText(page, 'Switch to PCB Editor'),
    ]);

    await expect(pcb).toHaveURL(/\/@local\/projects\/untitled\/main\.kicad_pcb/, { timeout: 30000 });
    await waitForToolReady(pcb, /main — PCB Editor/i);
    expect(page.url(), 'the schematic tab stays').toBe(schUrl);

    await stableShot(pcb, 'web-switch-missing-pcb-created.png');
  });
});
