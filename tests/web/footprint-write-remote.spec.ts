import { test, expect, type Page } from '@playwright/test';
import { clickByTooltip, waitForWxApp, focusCanvas, stableShot } from '../e2e/utils/element-tracker';

// Mirrors @pcbjam/shared USER_HEADER (tests/ doesn't depend on the shared pkg).
const USER_HEADER = 'x-pcbjam-user';
// The reference backend serves its single project/libs under any scope.
const SCOPE = 'default';

/**
 * 0009-C: the FULL remote footprint write round-trip — no in-memory spike. Boot
 * ensures a user lib via the backend's createLib; selecting it + New Footprint
 * auto-saves into it, routing through PCB_IO_PCBJAM_FP::FootprintSave →
 * window.kicadLibs.request("save", …, "footprint") → remoteLibsSource.saveItemBody
 * → PUT /api/libs/:lib/items/footprint/:name on the example backend. Verify the
 * backend persisted a fork-native .kicad_mod.
 *
 * Requires the example backend (:3060) running with USER_LIBS_DIR set.
 */

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3060';
const USER_LIB = 'my-symbols'; // slug of the boot-ensured "My Symbols" container

/** Click a LIB_TREE row by label, correcting the constant dataviewitem Y offset. */
async function clickTreeRow(page: Page, label: string): Promise<boolean> {
  const hit = await page.evaluate((wanted) => {
    const rd = window.wxElementRegistry.findAllRendered({});
    const hdr = rd.find((e: any) => e.elementType === 'columnheader' && e.label === 'Item');
    const rows = rd
      .filter((e: any) => e.elementType === 'dataviewitem')
      .sort((a: any, b: any) => a.centerY - b.centerY);
    if (!hdr || rows.length === 0) return null;
    const pitch = rows.length > 1 ? rows[1].centerY - rows[0].centerY : 17;
    const offset = hdr.centerY + hdr.height / 2 + pitch / 2 - rows[0].centerY;
    const row = rows.find((r: any) => r.label === wanted);
    return row ? { x: row.centerX, y: row.centerY + offset } : null;
  }, label);
  if (!hit) return false;
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: tree-row selection commit; no observable
  return true;
}

  // KNOWN-BROKEN: the fp/sym editor kicadLibs enumerate/save flows are dead
  // (docs/features/web-e2e-rot/01-editor-lib-bridge-flows.md). fixme, not fail:
  // on CI this dies in a 180s boot timeout per engine — running it buys no signal.
// Probed 2026-08-13 on the JSPI build: still dead — wedges at the New Symbol/
// Footprint dialog step on BOTH engines (web-e2e-rot 01 stands for writes).
test.fixme(
  'footprint editor save persists to the backend (remote write round-trip)', async ({ page }) => {
  const owner = `e2e-fp-${Date.now()}`;
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(`/default/projects/demo/-/footprint_editor?libowner=${owner}`);
  await waitForWxApp(page, { timeout: 180000 });
  await page.waitForFunction(() => !!(window as any).kicadLibs, null, { timeout: 60000 });
  await stableShot(page, 'fpremote-01-boot.png');

  // Boot's ensure-user-lib created the writable container for this owner.
  const ownerHeaders = { [USER_HEADER]: owner };
  let libsBody: { id: string; type: string }[] = [];
  await expect
    .poll(
      async () => {
        const libsRes = await fetch(`${BACKEND}/api/scopes/${SCOPE}/libs?kind=footprint`, { headers: ownerHeaders });
        libsBody = libsRes.ok ? ((await libsRes.json()) as { id: string; type: string }[]) : [];
        return libsBody.some((l) => l.type === 'user' && l.id === USER_LIB);
      },
      { message: 'user lib created at boot', timeout: 30000, intervals: [500] },
    )
    .toBe(true);
  logs.push(`[spec] libs: ${JSON.stringify(libsBody)}`);

  // Select the writable USER lib (NOT an origin — origins would mirror, which the
  // example backend doesn't implement) so New Footprint targets it.
  expect(await clickTreeRow(page, 'My Symbols'), 'selected the user lib row').toBe(true);
  await stableShot(page, 'fpremote-02-lib-selected.png');

  // New Footprint → auto-saves into the writable lib (tryToSaveFootprintInLibrary).
  expect(await clickByTooltip(page, 'New Footprint'), 'New Footprint clicked').toBe(true);
  await page.waitForTimeout(1500); // eslint-disable-line -- documented interaction dwell: New Footprint dialog/creation commit
  // Belt-and-braces explicit save.
  await focusCanvas(page);
  await page.keyboard.press('Control+s');
  await stableShot(page, 'fpremote-03-created.png');

  // Poll the backend until a footprint item lands.
  let items: { kind: string; name: string }[] = [];
  await expect
    .poll(
      async () => {
        const r = await fetch(`${BACKEND}/api/scopes/${SCOPE}/libs/${USER_LIB}/items`, { headers: ownerHeaders });
        items = r.ok ? ((await r.json()) as { kind: string; name: string }[]) : [];
        return items.filter((i) => i.kind === 'footprint').length;
      },
      { timeout: 30000, intervals: [500] },
    )
    .toBeGreaterThan(0);
  await stableShot(page, 'fpremote-04-saved.png');

  const saved = items.find((i) => i.kind === 'footprint')!;
  logs.push(`[spec] backend footprint item: ${JSON.stringify(saved)}`);

  // The persisted body is a well-formed fork-native footprint (native version).
  const bodyRes = await fetch(
    `${BACKEND}/api/scopes/${SCOPE}/libs/${USER_LIB}/items/footprint/${encodeURIComponent(saved.name)}`,
    { headers: ownerHeaders },
  );
  const body = await bodyRes.text();
  logs.push(`[spec] persisted body (${body.length} bytes):\n${body}`);
  expect(body).toContain('(footprint');
  expect(body).toContain('(version 20251028)');
  expect(body).toContain('(generator "pcbnew")');
  expect(body).toContain(saved.name);

  // App stayed live.
  expect(logs.some((l) => l.includes('Aborted(')), 'no WASM abort').toBe(false);
  expect(new URL(page.url()).searchParams.get('oomRetry'), 'no OOM respawn').toBeNull();

  console.log('--- spec log ---\n' + logs.join('\n'));
});
