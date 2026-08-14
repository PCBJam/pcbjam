import { test, expect, type Page } from '@playwright/test';
import { clickMenuBarItem, clickMenuItemByText } from '../e2e/utils/element-tracker';

/**
 * File → Quit after a tool switch: quitting must land on the project overview.
 *
 * A tool switch (Tools → "Switch to PCB Editor", ExecuteFile →
 * window.kicadWebOpenTool) is a hard location.assign that pushes a history
 * entry. Quit therefore cannot rely on stepping history back: after
 * project → schematic → switch-to-pcb, one history step back is the schematic
 * editor, not the project page. Quit must navigate to the project overview
 * explicitly (WasmTool installQuitHook), wherever the session wandered first.
 *
 * URL + project-page DOM assertions — no screenshots.
 */

/** Scope segment for the demo project (the reference backend serves it for any). */
const SCOPE = 'default';

const SCH_URL_RE = /\/default\/projects\/demo\/demo\.kicad_sch/;
const PCB_URL_RE = /\/default\/projects\/demo\/demo\.kicad_pcb/;
// Project overview: path ends at /projects/demo (optionally a query string).
const PROJECT_URL_RE = /\/default\/projects\/demo\/?(\?.*)?$/;

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
}

async function quitViaFileMenu(page: Page): Promise<void> {
  expect(await clickMenuBarItem(page, 'File'), 'File menubar item clickable').toBe(true);
  await clickMenuItemByText(page, 'Quit');
}

test.describe('web app — File → Quit after a tool switch', () => {
  test('quit after switching sch → pcb lands on the project page, not the previous editor', async ({
    page,
  }) => {
    test.setTimeout(480000); // two full wasm boots (schematic, then pcbnew)

    // Enter the editor the way a user does: the project page's "Open in …"
    // link is a hard navigation.
    await page.goto(`/${SCOPE}/projects/demo`);
    await page
      .getByRole('link', { name: /Open in Schematic Editor/i })
      .first()
      .click();
    await page.waitForURL(SCH_URL_RE, { timeout: 30000 });
    await waitForToolReady(page, /demo — Schematic Editor/i);

    // Switch to the PCB editor — a hard navigation that stacks a second
    // editor history entry on top of the schematic one.
    expect(await clickMenuBarItem(page, 'Tools'), 'Tools menubar item clickable').toBe(true);
    await clickMenuItemByText(page, 'Switch to PCB Editor');
    await page.waitForURL(PCB_URL_RE, { timeout: 30000 });
    await waitForToolReady(page, /demo — PCB Editor/i);

    await quitViaFileMenu(page);

    // Must land on the project overview — not back in the schematic editor.
    // Poll the URL instead of waitForURL: the quit flow can supersede its own
    // navigation while the wasm tears down, and Firefox then kills a pending
    // waitForURL with NS_BINDING_ABORTED even though the final URL is right.
    await expect
      .poll(() => page.url(), { timeout: 30000 })
      .toMatch(PROJECT_URL_RE);
    // And the overview must actually render (guards a URL-push-without-render
    // regression, which a URL-only assertion would miss).
    await expect(
      page.getByRole('link', { name: /Open in Schematic Editor/i }).first()
    ).toBeVisible({ timeout: 30000 });
  });
});
