import { test, expect, type Page } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText, stableShot } from '../e2e/utils/element-tracker';

/**
 * Tool-switch e2e: eeschema Tools → "Switch to PCB Editor" (and the reverse)
 * opens the other editor in a NEW TAB and keeps this one (cross-probe 0001).
 *
 * Native KiCad spawns a process for this via ExecuteFile (common/gestfich.cpp);
 * the WASM build delegates to window.kicadWebOpenTool (tool-navigation.ts),
 * which maps the MEMFS file path to the project-relative file. Schematic ⇄ PCB
 * goes through the cross-probe transport: open a tab when none is there, focus
 * it when this tab opened it, otherwise a toast (a tab can't focus its opener).
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
  await expect(page.locator("div.absolute.inset-0.z-30")).toHaveCount(0, {
    timeout: 180000,
  });
  await page.waitForFunction(
    () => typeof (window as unknown as { kicadCrossProbeStats?: unknown }).kicadCrossProbeStats === 'function',
    null,
    { timeout: 60000 }
  );
}

async function clickSwitch(page: Page, menuLabel: string): Promise<void> {
  expect(await clickMenuBarItem(page, 'Tools'), 'Tools menubar item clickable').toBe(true);
  await clickMenuItemByText(page, menuLabel);
}

const stats = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as {
      kicadCrossProbeStats: () => { opened: number; focused: number; notices: number };
    }).kicadCrossProbeStats(),
  );

test.describe('web app — tool switching', () => {
  test('eeschema → Switch to PCB Editor opens pcbnew in a new tab, then focuses it', async ({
    page,
    context,
  }) => {
    test.setTimeout(420000); // two full wasm boots

    await page.goto('/default/projects/demo/demo.kicad_sch');
    await waitForToolReady(page, /demo — Schematic Editor/i);
    const schUrl = page.url();

    const [pcb] = await Promise.all([
      page.waitForEvent('popup', { timeout: 30000 }),
      clickSwitch(page, 'Switch to PCB Editor'),
    ]);
    await expect(pcb).toHaveURL(/\/default\/projects\/demo\/demo\.kicad_pcb/, { timeout: 30000 });
    await waitForToolReady(pcb, /demo — PCB Editor/i);
    expect(page.url(), 'the schematic tab stays').toBe(schUrl);
    // Same frame as the old same-tab switch: the freshly booted board.
    await stableShot(pcb, 'web-switch-sch-to-pcb.png');

    // Switching again focuses the tab this one opened — no second tab.
    await clickSwitch(page, 'Switch to PCB Editor');
    await expect.poll(() => stats(page).then((s) => s.focused), { timeout: 20000 }).toBe(1);
    expect(context.pages()).toHaveLength(2);
    expect((await stats(page)).opened).toBe(1);

    // The opened tab can't focus its opener: switching back shows a toast.
    await clickSwitch(pcb, 'Switch to Schematic Editor');
    await expect(pcb.getByTestId('cross-probe-toast')).toContainText(
      /Schematic editor is open in another tab/i,
      { timeout: 20000 }
    );
    expect(context.pages()).toHaveLength(2);
  });

  test('pcbnew → Switch to Schematic Editor opens eeschema in a new tab', async ({ page }) => {
    test.setTimeout(420000);

    await page.goto('/default/projects/demo/demo.kicad_pcb');
    await waitForToolReady(page, /demo — PCB Editor/i);
    const pcbUrl = page.url();

    const [sch] = await Promise.all([
      page.waitForEvent('popup', { timeout: 30000 }),
      clickSwitch(page, 'Switch to Schematic Editor'),
    ]);
    await expect(sch).toHaveURL(/\/default\/projects\/demo\/demo\.kicad_sch/, { timeout: 30000 });
    await waitForToolReady(sch, /demo — Schematic Editor/i);
    expect(page.url(), 'the PCB tab stays').toBe(pcbUrl);

    await stableShot(sch, 'web-switch-pcb-to-sch.png');
  });
});
