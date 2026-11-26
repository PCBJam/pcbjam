import { createHash } from 'node:crypto';
import { test, expect, type Page, type Route } from '@playwright/test';
import { openOverlayMenu, openSimulationMenu } from './overlay-menu';
import { shotPath } from '../e2e/utils/element-tracker';

/**
 * Simulation parts panel e2e (live simulation, first piece): the floating
 * list that says, for every symbol of the open schematic, what the simulation
 * library has for it. Opens the demo schematic (tests/fixtures/demo: R1-R4,
 * C1, C2, P1-P8, the three-unit valve U1, power symbols) and asserts
 *   - the Session menu has the "Simulation parts" row;
 *   - the panel lists one row per symbol from the editor's own read
 *     (kicadSimSymbols: all sheets, one row for the three units of U1, no
 *     power symbols), matched against the published library: the resistors
 *     are live, the valve is a suggestion, and the mounting holes (excluded
 *     from simulation in the file) say so;
 *   - for the symbols without a library part it says what KiCad's own
 *     netlist (kicadSimNetlist) has: the capacitors run with KiCad's model,
 *     the connectors have no part (why a symbol is left out has a test of its
 *     own, live-sim-left-out.spec.ts);
 *   - a library that cannot be reached is said in the panel, in words;
 *   - a chip that runs firmware has a second line with the file it runs and
 *     "Choose file...". A picked file is sent to the project and its name is
 *     written onto the chip's symbol as one undoable edit; a file that is no
 *     firmware image is refused in words and nothing is sent. The schematic
 *     is tests/fixtures/demo/live-sim/firmware.kicad_sch (a source and R1),
 *     and the library calls R1's symbol a chip. The test answers the save, so
 *     nothing is written into the fixture folder.
 *
 * The library is a published snapshot of static files. The e2e build points
 * VITE_SIM_LIBRARY_URL at /e2e-sim-library on the app's own origin
 * (playwright-web.config.ts); nothing is there, each test answers it.
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

// A chip, the way a published snapshot describes one: the index names its
// emulator, and its own description has the setting that names the firmware.
const CHIP = {
  schema: 1, id: 'e2e-chip', version: 1, title: 'Test chip',
  settings: [{ name: 'firmware', label: 'Firmware file', default: 'firmware.bin', accept: '^[A-Za-z0-9_.+-]+\\.bin$' }],
  // which chip it is: an image built for another one is not taken
  digital: { kind: 'emulator', emulator: 'e2e-emu', chip: 'esp32c3', orderParam: 'IRR', pads: {} },
};
const CHIP_TEXT = JSON.stringify(CHIP);
const CHIP_INDEX = {
  schema: 1,
  version: SNAPSHOT,
  parts: [
    {
      id: 'e2e-chip', version: 1, title: 'Test chip', description: '',
      fits: [{ symbol: 'Device:R' }], pins: ['1', '2'], code: true, emulator: 'e2e-emu',
      files: [{ name: 'part.json', bytes: Buffer.byteLength(CHIP_TEXT), sha256: createHash('sha256').update(CHIP_TEXT).digest('hex') }],
    },
  ],
  emulators: [],
};
// The first bytes of a real ESP32-C3 image, and a file of words with a firmware's name.
const IMAGE = Buffer.concat([Buffer.from('e903022f10bf3c40ee0000000500000000ffff0000000001', 'hex'), Buffer.alloc(40, 0xff)]);
const WORDS = Buffer.from('just words, long enough to fill the header of an image');
// The same image as built for an ESP32-S3: the number of the chip is in bytes 12 and 13.
const OTHER_CHIP = Buffer.from(IMAGE);
OTHER_CHIP[12] = 0x09;

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

/** Answers the project's save of one file (the test's own answer: the fixture folder stays as it is). Returns what was sent. */
async function takeSave(page: Page, name: string): Promise<Buffer[]> {
  const sent: Buffer[] = [];
  await page.route(`**/projects/demo/files/${name}*`, (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'PUT, OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
      'access-control-expose-headers': 'x-pcbjam-file-revision',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() !== 'PUT') return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    sent.push(request.postDataBuffer() ?? Buffer.alloc(0));
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'x-pcbjam-file-revision': String(sent.length) },
      contentType: 'application/json',
      body: JSON.stringify({ path: name, revision: sent.length }),
    });
  });
  return sent;
}

/** What the editor reports as a symbol's settings field: null when the symbol has none. */
function settingsField(page: Page, ref: string): Promise<string | null> {
  return page.evaluate((ref) => {
    const mod = (window as unknown as { Module: { kicadSimSymbols(): string } }).Module;
    const symbols = (JSON.parse(mod.kicadSimSymbols()) as { symbols: { ref: string; fields: Record<string, string> }[] }).symbols;
    return symbols.find((s) => s.ref === ref)?.fields['PCBJam.SimSettings'] ?? null;
  }, ref);
}

async function bootSchematic(page: Page, file = 'demo.kicad_sch'): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${file}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

async function openPanel(page: Page) {
  await openSimulationMenu(page);
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
      // (the demo's connectors are symbols of its own library, so they are not on the short
      // list of KiCad's symbols with nothing to simulate: they read "no part")
      ['P1', 'none', /IN.*no part/],
      ['P2', 'none', /OUT.*no part/],
      ['P3', 'none', /POWER.*no part/],
      ['P4', 'none', /CONN_2.*no part/],
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

  test('a chip has its firmware on its line: a picked file is sent and named on the symbol', async ({ page }) => {
    test.setTimeout(300000);
    const asked = await serveLibrary(page, {
      'current.json': { schema: 1, version: SNAPSHOT },
      [`${SNAPSHOT}/index.json`]: CHIP_INDEX,
      [`${SNAPSHOT}/parts/e2e-chip/part.json`]: CHIP,
    });
    const sent = await takeSave(page, 'blink.bin');
    await bootSchematic(page, 'live-sim/firmware.kicad_sch');

    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute('data-status', 'ready', { timeout: 30000 });
    await expect(page.locator('[data-testid="sim-part-row"][data-ref="R1"]')).toHaveAttribute('data-state', 'live');

    // The chip's line: the file its part asks for, which the project does not have.
    const line = page.getByTestId('sim-part-firmware');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('data-ref', 'R1');
    await expect(line).toHaveAttribute('data-name', 'firmware.bin');
    await expect(line).toHaveAttribute('data-stored', 'no');
    await expect(line).toHaveText(/Firmware.*firmware\.bin.*not in the project.*Choose file/);
    expect(await settingsField(page, 'R1')).toBeNull();
    // the part's description was asked for, once
    expect(asked.filter((path) => path.endsWith('/part.json'))).toEqual([`${SNAPSHOT}/parts/e2e-chip/part.json`]);

    // A file of words with a firmware's name: said on the line, nothing sent, the symbol as it was.
    const choose = page.getByTestId('sim-part-firmware-choose');
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
    await chooser.setFiles({ name: 'words.bin', mimeType: 'application/octet-stream', buffer: WORDS });
    await expect(page.getByTestId('sim-part-firmware-error')).toHaveText(/"words\.bin" is not taken: it does not start like an ESP32 firmware image/);
    expect(sent).toHaveLength(0);
    expect(await settingsField(page, 'R1')).toBeNull();

    // An image built for another chip than the part is: the same.
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
    await chooser.setFiles({ name: 'other.bin', mimeType: 'application/octet-stream', buffer: OTHER_CHIP });
    await expect(page.getByTestId('sim-part-firmware-error')).toHaveText('"other.bin" is not taken: it was built for the ESP32-S3, and this chip is an ESP32-C3');
    expect(sent).toHaveLength(0);
    expect(await settingsField(page, 'R1')).toBeNull();

    // A firmware image: sent to the project under its own name, and the symbol names it.
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
    await chooser.setFiles({ name: 'blink.bin', mimeType: 'application/octet-stream', buffer: IMAGE });
    await expect(line).toHaveAttribute('data-name', 'blink.bin', { timeout: 30000 });
    await expect(line).toHaveAttribute('data-stored', 'yes');
    await expect(line).toHaveAttribute('data-busy', 'no');
    await expect(page.getByTestId('sim-part-firmware-error')).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.equals(IMAGE)).toBe(true);
    expect(await settingsField(page, 'R1')).toBe('firmware=blink.bin');
    // The changed symbol is still wired: the part still fits it.
    await expect(page.locator('[data-testid="sim-part-row"][data-ref="R1"]')).toHaveAttribute('data-state', 'live');
    await page.screenshot({ path: shotPath(page, 'web-sim-parts-firmware.png'), scale: 'css' });

    // A new build under the same name: sent again, and the schematic is left alone.
    const depth = () =>
      page.evaluate(() => (window as unknown as { Module: { kicadCollabTestUndoDepth(): number } }).Module.kicadCollabTestUndoDepth());
    const steps = await depth();
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
    await chooser.setFiles({ name: 'blink.bin', mimeType: 'application/octet-stream', buffer: IMAGE });
    await expect.poll(() => sent.length, { message: 'the new build was not sent' }).toBe(2);
    await expect(line).toHaveAttribute('data-busy', 'no');
    expect(await depth()).toBe(steps);

    // The change of the symbol is one step of the schematic's history: undo takes it back,
    // and the list follows.
    expect(await page.evaluate(() => (window as unknown as { Module: { kicadCollabTestUndo(): boolean } }).Module.kicadCollabTestUndo())).toBe(true);
    await expect.poll(() => settingsField(page, 'R1'), { message: 'undo did not take the setting back' }).toBeNull();
    await expect(line).toHaveAttribute('data-name', 'firmware.bin', { timeout: 30000 });
    // and the chip is still wired after the undo
    await page.getByTestId('sim-parts-panel-refresh').click();
    await expect(page.getByTestId('sim-parts-panel-refresh')).toBeEnabled();
    await expect(page.locator('[data-testid="sim-part-row"][data-ref="R1"]')).toHaveAttribute('data-state', 'live');
    await expect(line).toHaveAttribute('data-name', 'firmware.bin');
  });

  test('says so when the library cannot be reached, and recovers', async ({ page }) => {
    test.setTimeout(300000);
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
});
