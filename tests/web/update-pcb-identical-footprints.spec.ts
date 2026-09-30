import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { clickByLabel, clickMenuBarItem, clickMenuItemByText, shotPath, waitForRegistry, waitUntil } from '../e2e/utils/element-tracker';

/**
 * Every footprint Update PCB adds must get its own uuid — also when one run adds
 * several copies of the SAME library footprint.
 *
 * Field report (2026-09-29, USB-stick tutorial): three LEDs, all
 * LED_SMD:LED_0603_1608Metric, came out of Update PCB with one uuid (their pads
 * shared uuids too). The room document keys board items by uuid, so it kept one
 * LED, and a reload showed one. Cause: PCB_IO_PCBJAM_FP::FootprintLoad (the
 * network-backed footprint libraries) returned a plain Clone() of its cached
 * master on every load, where KiCad's own reader returns Duplicate() — new
 * uuids — unless the footprint editor asks to keep them.
 *
 * This spec is the engine-level guard and needs no room: on the PCB page it
 * replaces the staged schematic the netlist updater reads with one holding three
 * identical LEDs, runs Update PCB once, and checks the three footprints (and
 * their pads) carry distinct uuids. The full flow with the room document and a
 * reload is apps/tests/specs/smoke/update-pcb-identical-footprints.spec.ts.
 * Nothing persists: the reference backend re-seeds from its files on the next boot.
 */

const FOOTPRINT = 'LED_SMD:LED_0603_1608Metric';
const REFS = ['D91', 'D92', 'D93'];
const SCRATCH = '/tmp/update-pcb-identical-footprints';

type RegistryEl = { typeName?: string; label?: string; name?: string };
type W = Window & {
  Module: { kicadSaveBoard(path: string): void };
  FS: {
    readFile(p: string, o: { encoding: 'utf8' }): string;
    writeFile(p: string, data: string): void;
    readdir(p: string): string[];
    mkdirTree(p: string): void;
    analyzePath(p: string): { exists: boolean };
  };
  wxElementRegistry?: { findAll?: (o: { visible: boolean }) => RegistryEl[] };
};

/** Device:LED as eeschema 10 embeds it in a sheet (pin 1 = K, pin 2 = A). */
const LED_LIB_SYMBOL = `(symbol "Device:LED" (pin_numbers (hide yes)) (pin_names (offset 1.016) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "D" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
      (property "Value" "LED" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
      (property "Datasheet" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
      (symbol "LED_0_1"
        (polyline (pts (xy -1.27 -1.27) (xy -1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
        (polyline (pts (xy 1.27 -1.27) (xy 1.27 1.27) (xy -1.27 0) (xy 1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "LED_1_1"
        (pin passive line (at -3.81 0 0) (length 2.54) (name "K" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 3.81 0 180) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
      (embedded_fonts no))`;

function ledsSchematic(project: string): string {
  const root = randomUUID();
  const placed = REFS.map((ref, i) => {
    const x = (100 + 15 * i).toFixed(2);
    return `  (symbol (lib_id "Device:LED") (at ${x} 100 0) (unit 1) (in_bom yes) (on_board yes) (uuid "${randomUUID()}")
    (property "Reference" "${ref}" (at ${x} 95 0) (effects (font (size 1.27 1.27))))
    (property "Value" "LED" (at ${x} 105 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "${FOOTPRINT}" (at ${x} 100 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "" (at ${x} 100 0) (hide yes) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "${randomUUID()}")) (pin "2" (uuid "${randomUUID()}"))
    (instances (project "${project}" (path "/${root}" (reference "${ref}") (unit 1)))))`;
  });
  return `(kicad_sch (version 20250114) (generator "pcbjam-e2e") (generator_version "0.1") (uuid "${root}") (paper "A4")
  (lib_symbols
    ${LED_LIB_SYMBOL})
${placed.join('\n')}
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no))
`;
}

type FootprintBlock = { ref: string; uuid: string; lib: string; pads: string[] };

/** Every footprint of the open board as pcbnew would save it — copies with a shared uuid included. */
async function boardFootprints(page: Page): Promise<FootprintBlock[]> {
  const text = await page.evaluate((dir) => {
    const w = window as unknown as W;
    if (!w.FS.analyzePath(dir).exists) w.FS.mkdirTree(dir); // idempotent scratch dir
    w.Module.kicadSaveBoard(`${dir}/board.kicad_pcb`);
    return w.FS.readFile(`${dir}/board.kicad_pcb`, { encoding: 'utf8' });
  }, SCRATCH);
  const starts = [...text.matchAll(/\(footprint "([^"]*)"/g)].map((m) => m.index!);
  return starts.map((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    return {
      lib: block.match(/^\(footprint "([^"]*)"/)?.[1] ?? '',
      uuid: block.match(/\(uuid "([^"]+)"\)/)?.[1] ?? '',
      ref: block.match(/\(property "Reference" "([^"]*)"/)?.[1] ?? '',
      pads: [...block.matchAll(/\(pad "[^"]*"[\s\S]*?\(uuid "([^"]+)"\)/g)].map((m) => m[1]!),
    };
  });
}

const added = async (page: Page) => (await boardFootprints(page)).filter((b) => REFS.includes(b.ref));

test('Update PCB gives every copy of one library footprint its own uuid', async ({ page }) => {
  test.setTimeout(600000);
  await page.goto('/default/projects/demo/demo.kicad_pcb');
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect.poll(() => page.title(), { timeout: 150000, intervals: [1000] }).toMatch(/demo — PCB Editor/i);
  await expect(page.locator('div.absolute.inset-0.z-30')).toHaveCount(0, { timeout: 150000 });

  // The netlist updater reads the schematic staged next to the board in MEMFS.
  const staged = await page.evaluate((sch) => {
    const w = window as unknown as W;
    const root = '/home/kicad/documents/kicad';
    const hit = w.FS.readdir(root)
      .filter((d) => d !== '.' && d !== '..')
      .map((v) => `${root}/${v}/projects/demo/demo.kicad_sch`)
      .find((p) => w.FS.analyzePath(p).exists);
    if (!hit) throw new Error(`staged demo.kicad_sch not found under ${root}`);
    w.FS.writeFile(hit, sch);
    return hit;
  }, ledsSchematic('demo'));
  test.info().annotations.push({ type: 'staged schematic', description: staged });
  expect(await added(page), 'no D9x footprints before the update').toEqual([]);

  expect(await clickMenuBarItem(page, 'Tools'), 'Tools menu opens').toBe(true);
  await clickMenuItemByText(page, 'Update PCB from Schematic');
  await waitUntil(
    page,
    () => {
      const visible = (window as unknown as W).wxElementRegistry?.findAll?.({ visible: true }) ?? [];
      return (
        visible.some((e) => e.typeName === 'wxDialog') &&
        visible.some((e) => /Update PCB|Changes to Be Applied/i.test(`${e.label ?? ''} ${e.name ?? ''}`))
      );
    },
    'DIALOG_UPDATE_PCB visible',
    { timeout: 120000 },
  );
  expect(await clickByLabel(page, 'Update PCB', { visible: true, exact: true }), 'Update PCB button').toBe(true);
  await expect
    .poll(async () => (await added(page)).map((b) => b.ref).sort(), { timeout: 120000, intervals: [1000] })
    .toEqual(REFS);
  await page.screenshot({ path: shotPath(page, 'update-pcb-identical-footprints.png') });
  expect(await clickByLabel(page, 'Close', { visible: true, exact: true }), 'Close button').toBe(true);

  const leds = await added(page);
  const ids = leds.map((b) => `${b.ref}=${b.uuid}`).join(' ');
  expect(leds.every((b) => b.lib === FOOTPRINT), `all three are ${FOOTPRINT}`).toBe(true);
  expect(new Set(leds.map((b) => b.uuid)).size, `each copy has its own uuid (${ids})`).toBe(REFS.length);
  const pads = leds.flatMap((b) => b.pads);
  expect(pads.length, 'two pads per LED').toBe(2 * REFS.length);
  expect(new Set(pads).size, 'and so does every pad').toBe(pads.length);
});
