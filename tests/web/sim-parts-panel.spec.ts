import { test, expect, type Page, type Route } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';
import { shotPath } from '../e2e/utils/element-tracker';

/**
 * Simulation parts panel e2e (live simulation, first piece): the floating
 * list that says, for every symbol of the open schematic, what the simulation
 * library has for it. Opens the demo schematic (tests/fixtures/demo: R1-R4,
 * C1, C2, P1-P8, the three-unit valve U1, power symbols) and asserts
 *   - the Session menu has the "Simulation parts" row only when the backend
 *     turned `liveSimulation` on for the session (/api/me `features`);
 *   - the panel lists one row per symbol from the editor's own read
 *     (kicadSimSymbols: all sheets, one row for the three units of U1, no
 *     power symbols), matched against the published library: the resistors
 *     are live, the valve is a suggestion, and the mounting holes (excluded
 *     from simulation in the file) say so;
 *   - for the symbols without a library part it says what KiCad's own
 *     netlist (kicadSimNetlist) has: the capacitors run with KiCad's model,
 *     the connectors are not simulated;
 *   - a library that cannot be reached is said in the panel, in words.
 *
 * The library is a published snapshot of static files. The e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library on the app's own origin
 * (playwright-web.config.ts); nothing is there, each test answers it. The
 * reference backend has no /api/me, so the test answers that too.
 *
 * Needs a wasm build exporting kicadSimSymbols and kicadSimNetlist. A bundle
 * without the first hides the menu row (feature-detected), which fails the
 * first assertion; one without the second cannot tell KiCad's models apart:
 * rebuild + `npm run setup:kicad`.
 */

const SCOPE = 'default';
const SNAPSHOT = '0123456789ab';

// Two parts, the way a published snapshot's index describes them. The demo's
// resistor symbol is named outright; the valve is only known by its value.
const INDEX = {
  schema: 1,
  version: SNAPSHOT,
  parts: [
    {
      id: 'e2e-resistor', version: 1, title: 'Test resistor', description: '',
      fits: [{ symbol: 'ecc83-pp:R' }], pins: ['1', '2'], code: false, files: [],
    },
    {
      id: 'e2e-valve', version: 1, title: 'Test valve', description: '',
      fits: [{ value: 'ECC83' }], pins: ['1', '2', '3'], code: false, files: [],
    },
  ],
  emulators: [],
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** The session payload of a backend that turned live simulation on. */
async function turnFeatureOn(page: Page): Promise<void> {
  await page.route('**/api/me', (route) => {
    const origin = route.request().headers()['origin'] ?? '*';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ user: null, features: { liveSimulation: true } }),
    });
  });
}

/** Answers the library's address; returns the paths that were asked for. */
async function serveLibrary(page: Page, files: Record<string, unknown>): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/e2e-sim-library/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, '');
    asked.push(path);
    return path in files ? json(route, files[path]) : route.fulfill({ status: 404, body: 'not found' });
  });
  return asked;
}

async function bootSchematic(page: Page): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_sch`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

async function openPanel(page: Page) {
  await openOverlayMenu(page);
  await page.getByTestId('sim-parts-panel-toggle').click();
  const panel = page.getByTestId('sim-parts-panel');
  await expect(panel).toBeVisible();
  // The open menu sits over the panel: close it (the FAB toggles).
  await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
  return panel;
}

test.describe('simulation parts panel', () => {
  test('lists every symbol with what the library has for it', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    const asked = await serveLibrary(page, {
      'current.json': { schema: 1, version: SNAPSHOT },
      [`${SNAPSHOT}/index.json`]: INDEX,
    });
    await bootSchematic(page);

    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 30000 });

    // One row per symbol the editor reports: library rows first, then the
    // rest, then what KiCad leaves out; each group by reference.
    const rows = page.getByTestId('sim-part-row');
    const expected: [string, string, RegExp][] = [
      ['R1', 'live', /1\.5K.*Test resistor.*live/],
      ['R2', 'live', /Test resistor.*live/],
      ['R3', 'live', /100K.*Test resistor.*live/],
      ['R4', 'live', /Test resistor.*live/],
      ['U1', 'suggested', /ECC83.*Test valve.*suggestion/],
      // no library part: KiCad's netlist says what happens to them
      ['C1', 'kicad', /10uF.*KiCad's model/],
      ['C2', 'kicad', /680nF.*KiCad's model/],
      ['P1', 'none', /IN.*not simulated/],
      ['P2', 'none', /OUT.*not simulated/],
      ['P3', 'none', /POWER.*not simulated/],
      ['P4', 'none', /CONN_2.*not simulated/],
      // the demo's mounting holes are excluded from simulation in KiCad
      ['P5', 'excluded', /MOUNTING_HOLE.*excluded/],
      ['P6', 'excluded', /MOUNTING_HOLE.*excluded/],
      ['P7', 'excluded', /MOUNTING_HOLE.*excluded/],
      ['P8', 'excluded', /MOUNTING_HOLE.*excluded/],
    ];
    await expect(rows).toHaveCount(expected.length);
    await expect(rows).toHaveText(expected.map(([, , text]) => text));
    for (const [i, [ref, state]] of expected.entries()) {
      await expect(rows.nth(i)).toHaveAttribute('data-ref', ref);
      await expect(rows.nth(i)).toHaveAttribute('data-state', state);
    }
    await expect(page.getByTestId('sim-parts-live-count')).toHaveText('4 live');
    // KiCad's netlist export had nothing to complain about on this schematic.
    await expect(page.getByTestId('sim-parts-problem')).toHaveCount(0);
    await expect(page.getByTestId('sim-parts-library-version')).toHaveText(`Library ${SNAPSHOT}`);

    // The rows are the editor's own read, nothing more and nothing less.
    const reported = await page.evaluate(() => {
      const mod = (window as unknown as { Module: { kicadSimSymbols(): string } }).Module;
      return (JSON.parse(mod.kicadSimSymbols()) as { symbols: { ref: string }[] }).symbols.map((s) => s.ref);
    });
    expect([...reported].sort()).toEqual(expected.map(([ref]) => ref).sort());

    await page.screenshot({ path: shotPath(page, 'web-sim-parts-panel.png'), scale: 'css' });

    // Reading again asks the editor again, not the library: one pointer, one index.
    await page.getByTestId('sim-parts-panel-refresh').click();
    await expect(page.getByTestId('sim-parts-panel-refresh')).toBeEnabled();
    await expect(rows).toHaveCount(expected.length);
    expect(asked).toEqual(['current.json', `${SNAPSHOT}/index.json`]);

    // Collapse to the header, expand, close.
    await page.getByTestId('sim-parts-panel-collapse').click();
    await expect(page.getByTestId('sim-parts-panel-list')).toHaveCount(0);
    await page.getByTestId('sim-parts-panel-collapse').click();
    await expect(rows).toHaveCount(expected.length);
    await page.getByTestId('sim-parts-panel-close').click();
    await expect(panel).toHaveCount(0);
  });

  test('says so when the library cannot be reached, and recovers', async ({ page }) => {
    test.setTimeout(300000);
    await turnFeatureOn(page);
    const files: Record<string, unknown> = {};
    await serveLibrary(page, files);
    await bootSchematic(page);

    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'error', { timeout: 30000 });
    await expect(page.getByTestId('sim-parts-panel-error')).toHaveText(
      'The parts could not be listed: simulation library: current.json: HTTP 404',
    );
    await expect(page.getByTestId('sim-part-row')).toHaveCount(0);

    // The library comes back: the next read gets it, the page needs no reload.
    files['current.json'] = { schema: 1, version: SNAPSHOT };
    files[`${SNAPSHOT}/index.json`] = INDEX;
    await page.getByTestId('sim-parts-panel-refresh').click();
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 30000 });
    await expect(page.getByTestId('sim-part-row')).toHaveCount(15);
  });

  test('is not offered when the feature is off for the session', async ({ page }) => {
    test.setTimeout(300000);
    const asked = await serveLibrary(page, {});
    await bootSchematic(page);

    await openOverlayMenu(page);
    await expect(page.getByTestId('sim-parts-panel-toggle')).toHaveCount(0);
    await expect(page.getByTestId('sim-parts-panel')).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});
