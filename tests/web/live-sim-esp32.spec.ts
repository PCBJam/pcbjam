import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { openSimulationMenu } from './overlay-menu';

/**
 * An ESP32 module that runs firmware, in the real app, with the real simulation library:
 * the schematic editor reads the board, Play builds its circuit, the page fetches the
 * chip's emulator (esp32sim) and its ROM from the library and the firmware from the
 * project, and the live engine runs them next to ngspice.
 *
 * The board is tests/fixtures/demo/live-sim/esp32-c3.kicad_sch: an ESP32-C3-WROOM-02 on
 * 3.3 V, a button (SW1) from IO9 to ground, a red LED (D2) on IO8 and a green one (D3) on
 * IO10, each with its resistor.
 *
 * Neither the library nor a firmware image is in this repository, so the test runs only
 * where both are on the machine:
 *
 *   PCBJAM_SIM_SNAPSHOT  a folder with a published snapshot of the library and the files
 *                        of its emulators (the library's `publish:snapshot --to <folder>`)
 *   PCBJAM_ESP_FIRMWARE  a merged image for an ESP32-C3: prints "ready", toggles GPIO10
 *                        every 250 ms, holds GPIO8 high while GPIO9 is low
 *
 * The e2e build points VITE_SIM_LIBRARY_URL at /e2e-sim-library (playwright-web.config.ts);
 * the test answers that address from the folder, and the project's firmware.bin from the
 * image (the fixture folder stays as it is).
 *
 * Time is never waited for: every wait is a poll for a state of the page.
 */

const SCOPE = 'default';
const here = (p: string | undefined): string => (p && fs.existsSync(p) ? path.resolve(p) : '');
const LIBRARY = here(process.env.PCBJAM_SIM_SNAPSHOT);
const FIRMWARE = here(process.env.PCBJAM_ESP_FIRMWARE);

const menuRow = (page: Page) => page.getByTestId('live-sim-toggle');
const widget = (page: Page, kind: string, ref: string) => page.locator(`[data-testid="live-${kind}"][data-ref="${ref}"]`);
const level = async (glow: Locator): Promise<number> => Number(await glow.getAttribute('data-level'));

/** Answers the library's address from the published folder; returns the paths that were asked for. */
async function serveLibrary(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const types: Record<string, string> = { '.json': 'application/json', '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.lib': 'text/plain' };
  await page.route('**/e2e-sim-library/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/e2e-sim-library\//, ''));
    asked.push(rel);
    const file = path.join(LIBRARY, rel);
    const inside = file.startsWith(LIBRARY + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
    return inside
      ? route.fulfill({ status: 200, path: file, contentType: types[path.extname(file)] ?? 'application/octet-stream' })
      : route.fulfill({ status: 404, body: 'not found' });
  });
  return asked;
}

/** Answers the project's read of one file with a file of this machine. Returns how often it was read. */
async function serveProjectFile(page: Page, name: string, file: string): Promise<{ reads: number }> {
  const count = { reads: 0 };
  await page.route(`**/projects/demo/files/${name}*`, (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() !== 'GET') return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    count.reads++;
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: fs.readFileSync(file) });
  });
  return count;
}

async function bootSchematic(page: Page, file: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${file}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

async function closeOverlayMenu(page: Page): Promise<void> {
  if (await page.getByTestId('overlay-menu-panel').count()) await page.getByTestId('overlay-menu-fab').click();
  await expect(page.getByTestId('overlay-menu-panel')).toHaveCount(0);
}

test.describe('live simulation: an ESP32 module runs the firmware of the project', () => {
  test.skip(!LIBRARY || !FIRMWARE, 'needs the library and a firmware image on this machine (PCBJAM_SIM_SNAPSHOT, PCBJAM_ESP_FIRMWARE)');

  test('Play boots the chip: it prints, its LED blinks, and its button is answered', async ({ page }) => {
    test.setTimeout(600000);
    const asked = await serveLibrary(page);
    const firmware = await serveProjectFile(page, 'firmware.bin', FIRMWARE);
    await bootSchematic(page, 'live-sim/esp32-c3.kicad_sch');

    // The serial console first, so that nothing the chip prints is missed.
    await openSimulationMenu(page);
    await page.getByTestId('sim-console-panel-toggle').click();
    await expect(page.getByTestId('sim-console-panel')).toBeVisible();

    await openSimulationMenu(page);
    await expect(menuRow(page)).toHaveAttribute('data-live-state', 'idle', { timeout: 60000 });
    await menuRow(page).click();
    await openSimulationMenu(page);
    await expect(menuRow(page), 'the circuit runs').toHaveAttribute('data-live-state', 'running', { timeout: 180000 });
    await closeOverlayMenu(page);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    // What was fetched for the chip: its emulator's program and script, its own ROM (not the
    // other chip's), and the project's firmware.
    const emulator = asked.filter((p) => p.startsWith('emulators/esp32sim/')).map((p) => p.split('/').pop()).sort();
    expect(emulator).toEqual(['esp32c3_rev3_rom.elf', 'esp32sim.wasm', 'jit.mjs']);
    expect(firmware.reads).toBeGreaterThan(0);

    // The chip boots and its sketch says so, in the console; the ROM's lines are there once.
    const text = page.getByTestId('sim-console-text');
    await expect(text).toContainText('ready', { timeout: 120000 });
    expect(((await text.textContent()) ?? '').split('ESP-ROM:').length - 1).toBe(1);
    await expect(page.getByTestId('sim-console-panel')).toHaveAttribute('data-can-send', 'yes');

    // The heartbeat: the green LED on IO10 goes on and off.
    const beat = widget(page, 'glow', 'D3');
    const led = widget(page, 'glow', 'D2');
    const key = widget(page, 'press', 'SW1');
    for (const w of [beat, led, key]) await expect(w).toHaveCount(1);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is on', timeout: 30000, intervals: [20] }).toBeGreaterThan(0.5);
    await expect.poll(() => level(beat), { message: 'the heartbeat LED is off', timeout: 30000, intervals: [20] }).toBeLessThan(0.05);

    // The button: held, the sketch lights the red LED on IO8; let go, it goes out.
    expect(await level(led), 'the red LED is dark').toBeLessThan(0.05);
    const k = (await key.boundingBox())!;
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    await expect(key).toHaveAttribute('data-held', 'true');
    await expect.poll(() => level(led), { message: 'holding the button lights the LED', timeout: 30000 }).toBeGreaterThan(0.5);
    await page.mouse.up();
    await expect(key).toHaveAttribute('data-held', 'false');
    await expect.poll(() => level(led), { message: 'letting go puts it out', timeout: 30000 }).toBeLessThan(0.05);
    await expect(page.getByTestId('live-sim-error')).toHaveCount(0);

    await openSimulationMenu(page);
    await menuRow(page).click();
    await openSimulationMenu(page);
    await expect(menuRow(page), 'stopped').toHaveAttribute('data-live-state', 'idle', { timeout: 60000 });
  });
});
