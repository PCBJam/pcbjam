import { test, expect, type Page } from '@playwright/test';

/**
 * Plot outputs reach the project (overlay-system 0007 P1). KiCad's Plot and
 * Generate Drill Files dialogs write to MEMFS only: the Plot dialog printed
 * "Done." while the project got no file and a reload lost everything. The
 * editor now hands every Gerber, Gerber job and drill file it writes in the
 * project's folder to the project.
 *
 * Like tool-switch-missing-file.spec.ts this builds a browser-local IndexedDB
 * project (VITE_LOCAL_PROJECTS=idb, set by playwright-web.config.ts for cold
 * starts): home Tools grid -> "PCB Editor" -> new-file dialog ->
 * /@local/projects/untitled/main.kicad_pcb. The new board keeps KiCad's default
 * plot layers (copper, mask, paste, silk, Edge.Cuts) and has no zones, so Plot
 * writes the Gerbers without a prompt; Generate Drill Files in Excellon format
 * always writes the plated-holes file, holes or not.
 */

const SLUG = 'untitled';
const MEMFS_DIR = `/home/kicad/documents/kicad/10.0/projects/${SLUG}`;

type W = {
  Module: { kicadTestRunAction(name: string): boolean };
  FS: { readdir(path: string): string[] };
};

async function waitForToolReady(page: Page): Promise<void> {
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { message: 'the board never opened', timeout: 120000, intervals: [1000] })
    .toMatch(/main.*PCB Editor/i);
  await page.waitForFunction(
    () => typeof (window as unknown as Partial<W>).Module?.kicadTestRunAction === 'function',
    null,
    { timeout: 30000 }
  );
  // The boot overlay (WasmTool, `absolute inset-0 z-30`) covers the editor until it clears.
  await expect(page.locator('div.absolute.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

/** The local project's file paths in IndexedDB: the store the editor saves to. */
function projectFiles(page: Page): Promise<string[]> {
  return page.evaluate(
    (slug) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('pcbjam-local-projects');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const keys = open.result.transaction('files', 'readonly').objectStore('files').getAllKeys();
          keys.onerror = () => reject(keys.error);
          keys.onsuccess = () => {
            open.result.close();
            const prefix = `${slug}\u0000`;
            resolve(
              (keys.result as string[])
                .filter((k) => k.startsWith(prefix))
                .map((k) => k.slice(prefix.length))
                .sort()
            );
          };
        };
      }),
    SLUG
  );
}

test.describe('web app - plot outputs reach the project', () => {
  test('Plot and Generate Drill Files put the Gerbers and the drill file into the project', async ({ page }) => {
    test.setTimeout(420000); // two full wasm boots

    await page.goto('/');
    await page.getByRole('button', { name: 'PCB Editor', exact: true }).click();
    await expect(
      page.locator('#newfile-projectname'),
      'new-file dialog must open - is the stack running with VITE_LOCAL_PROJECTS=idb?'
    ).toBeVisible();
    await expect(page.locator('#newfile-name')).toHaveValue('main.kicad_pcb');
    await page.getByRole('button', { name: 'Create & open' }).click();
    await page.waitForURL(/\/@local\/projects\/untitled\/main\.kicad_pcb/, { timeout: 30000 });
    await waitForToolReady(page);

    // Plot with the board's settings. Before the fix the files stayed in MEMFS.
    expect(await page.evaluate(() => (window as unknown as W).Module.kicadTestRunAction('common.Control.plot'))).toBe(true);
    await page.getByRole('button', { name: 'Plot', exact: true }).click();
    await expect
      .poll(() => projectFiles(page), { timeout: 60000, message: 'the plot reaches the project' })
      .toEqual(expect.arrayContaining(['main-F_Cu.gbr', 'main-B_Cu.gbr', 'main-Edge_Cuts.gbr', 'main-job.gbrjob']));

    await page.getByRole('button', { name: /^Generate Drill Files/ }).click();
    // The dialog opens with neither format ticked here, and the Gerber X2 drill
    // writer skips a board without holes: ask for Excellon.
    await page.getByRole('radio', { name: 'Excellon' }).check();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect
      .poll(() => projectFiles(page), { timeout: 60000, message: 'the drill file reaches the project' })
      .toEqual(expect.arrayContaining(['main-PTH.drl']));

    // A reload stages the project again: the outputs live in it, not in the tab.
    await page.reload();
    await waitForToolReady(page);
    expect(await page.evaluate((dir) => (window as unknown as W).FS.readdir(dir), MEMFS_DIR)).toEqual(
      expect.arrayContaining(['main-F_Cu.gbr', 'main-job.gbrjob', 'main-PTH.drl'])
    );
  });
});
