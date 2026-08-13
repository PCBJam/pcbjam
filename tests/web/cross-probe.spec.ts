import { test, expect, type Page } from '@playwright/test';

/**
 * Cross-app selection e2e (collab-presence 0006): one tab on the demo
 * SCHEMATIC and one on the demo BOARD of the same project share the
 * project-wide presence room over the default BroadcastChannel provider.
 * Selecting a symbol in eeschema must ghost-highlight the linked footprint in
 * pcbnew (footprint `(path …)` tail = symbol uuid — the demo fixtures are
 * linked), and vice versa. Assertions use the deterministic
 * `kicadCollabTestGetCrossMapped()` probe (what the ghost render draws from)
 * rather than pixel diffs — the render path itself is covered by the
 * tests/kicad specs.
 *
 * This is also the single-user cross-probe test by construction: both tabs
 * run as the same `?user=` in one browser context and still map each other
 * (cross-app peers are keyed by client, not user).
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabTestSelectComponent(): Promise<string>;
  kicadCollabTestClearSelection(): Promise<boolean>;
  kicadCollabTestGetCrossMapped(): Promise<string>;
  kicadCollabGetSelectionFull(): Promise<string>;
};
type W = { Module: Mod };

async function bootTool(
  page: Page,
  route: string,
  titleRe: RegExp,
  user: string,
): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${route}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `${route}: editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(titleRe);
  await page.waitForFunction(
    () => {
      const m = (window as unknown as Partial<W>).Module;
      return (
        typeof m?.kicadCollabTestSelectComponent === 'function' &&
        typeof m?.kicadCollabTestGetCrossMapped === 'function'
      );
    },
    null,
    { timeout: 60000 },
  );
}

const crossMapped = (page: Page) =>
  page.evaluate(async () =>
    JSON.parse(await (window as unknown as W).Module.kicadCollabTestGetCrossMapped()),
  );

test('selecting a symbol in eeschema ghost-highlights the footprint in pcbnew, and back', async ({
  page,
  context,
}) => {
  test.setTimeout(480000); // two full editor boots (eeschema + pcbnew wasm)

  const sch = page;
  await bootTool(sch, 'demo.kicad_sch', /demo — Schematic Editor/i, 'alice');
  const pcb = await context.newPage();
  await bootTool(pcb, 'demo.kicad_pcb', /demo — PCB Editor/i, 'bob');

  // ── eeschema → pcbnew ──────────────────────────────────────────────────────
  const symId = await sch.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectComponent(),
  );
  expect(symId, 'demo schematic should contain a symbol').toBeTruthy();

  // The board tab maps the symbol to ≥1 footprint (reused sheets map to more).
  await expect
    .poll(() => crossMapped(pcb), {
      timeout: 20000,
      message: 'pcbnew never received/mapped the eeschema selection',
    })
    .not.toEqual([]);

  // The selection emit carried the symbol uuid across (sanity on the wire).
  const schSel = await sch.evaluate(async () =>
    JSON.parse(await (window as unknown as W).Module.kicadCollabGetSelectionFull()),
  );
  expect(schSel.uuids).toContain(symId);

  // Clearing the schematic selection clears the board ghosts.
  await sch.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestClearSelection(),
  );
  await expect
    .poll(() => crossMapped(pcb), { timeout: 20000 })
    .toEqual([]);

  // ── pcbnew → eeschema ──────────────────────────────────────────────────────
  const fpId = await pcb.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectComponent(),
  );
  expect(fpId, 'demo board should contain a footprint').toBeTruthy();

  // The footprint's path tail resolves to a symbol on the schematic's sheet.
  await expect
    .poll(() => crossMapped(sch), {
      timeout: 20000,
      message: 'eeschema never received/mapped the pcbnew selection',
    })
    .not.toEqual([]);

  // …and the emit carried the footprint's schematic path.
  const pcbSel = await pcb.evaluate(async () =>
    JSON.parse(await (window as unknown as W).Module.kicadCollabGetSelectionFull()),
  );
  expect(pcbSel.uuids).toContain(fpId);
  expect(pcbSel.fpPaths.length).toBeGreaterThan(0);

  await pcb.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestClearSelection(),
  );
  await expect
    .poll(() => crossMapped(sch), { timeout: 20000 })
    .toEqual([]);
});
