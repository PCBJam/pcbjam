import { expect, type Page } from '@playwright/test';

/**
 * Open the overlay menu (collab-presence 0010) if its panel isn't already
 * open. The roster, source chip, view-only pill, comment bar and chrome
 * toggle live inside the panel; the FAB (with the peer-count badge) is the
 * only overlay control always on screen. Any canvas click closes the panel
 * (click-away), so specs re-open it before each in-panel interaction.
 */
export async function openOverlayMenu(page: Page): Promise<void> {
  const fab = page.getByTestId('overlay-menu-fab');
  await expect(fab).toBeVisible({ timeout: 30000 });
  if (await page.getByTestId('overlay-menu-panel').count()) return;
  await fab.click();
  await expect(page.getByTestId('overlay-menu-panel')).toBeVisible();
}

/**
 * Open the Session menu's Simulation child menu if it isn't already open. Live
 * simulation's rows are in it: Play and Stop, the sound, the serial console and
 * the parts list. The menu has it only in a session with live simulation. The
 * child menu closes with the menu (a click on Play closes both), so specs
 * re-open it before each of its rows.
 */
export async function openSimulationMenu(page: Page): Promise<void> {
  await openOverlayMenu(page);
  const rows = page.getByTestId('overlay-menu-sub-simulation-panel');
  if (await rows.count()) return;
  await page.getByTestId('overlay-menu-sub-simulation').click();
  await expect(rows).toBeVisible();
}
