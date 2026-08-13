import { test, expect, type Page } from '@playwright/test';
import { waitForWxApp, stableShot } from '../e2e/utils/element-tracker';

/**
 * 0009-B footprint READ path: does the footprint editor browse + LOAD a real,
 * ingested KiCad-10.0.3 footprint through PCB_IO_PCBJAM_FP — i.e. does the fork's
 * footprint parser accept the version-capped (20260206→20251028) body? This is
 * the end-to-end proof of the 0009-A "version cap only, no token strip" finding.
 *
 * Boots the project-scoped footprint_editor against the GPL example backend
 * (:3060) serving its self-provisioned curated footprint fixtures. Boot
 * generates the fp-lib-table from `listLibs?kind=footprint`; the test expands a
 * lib in the tree (FootprintEnumerate) and opens a footprint (FootprintLoad →
 * Parse). Pass: the footprint OPENS (title = lib:footprint) — which requires
 * Parse to have succeeded; a FUTURE_FORMAT/token error would make FootprintLoad
 * return null and nothing would open.
 *
 * The LIB_TREE's rendered dataviewitem Y is offset by a constant (the rows live
 * below the column header); we calibrate that offset from the "Item" header +
 * row pitch, then double-click true positions.
 *
 * Determinism: no blind waitForTimeout. Readiness via waitForWxApp + the app's
 * own observables (kicadLibs, then the LIB_TREE's dataviewitem rows). Each
 * navigation step waits for the state it produces — child rows after enumerate,
 * the editor title after load — instead of sleeping; the static boot/expanded/
 * loaded frames use stableShot.
 */

const LIB = 'Resistor_SMD';

async function bootFootprintEditor(page: Page): Promise<void> {
  await page.goto('/default/projects/demo/-/footprint_editor');
  await waitForWxApp(page, { timeout: 180000 });
  await page.waitForFunction(
    () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({}).length > 5,
    null,
    { timeout: 180000 },
  );
  await page.waitForFunction(() => !!(window as any).kicadLibs, null, { timeout: 60000 });
  // Deterministic replacement for the fixed settle: the fp-lib-table is generated
  // from kicadLibs and rendered into the LIB_TREE — wait until its footprint-lib
  // rows (dataviewitems) actually exist, which is exactly what the downstream tree
  // navigation + geom assertions require.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.wxElementRegistry.findAllRendered({ elementType: 'dataviewitem' }).length,
        ),
      { message: 'footprint lib tree rows rendered', timeout: 60000 },
    )
    .toBeGreaterThan(0);
}

/** Map a rendered tree row's offset Y to its true screen Y (see header note). */
async function treeGeom(page: Page) {
  return page.evaluate(() => {
    const rd = window.wxElementRegistry.findAllRendered({});
    const hdr = rd.find((e: any) => e.elementType === 'columnheader' && e.label === 'Item');
    const rows = rd
      .filter((e: any) => e.elementType === 'dataviewitem')
      .sort((a: any, b: any) => a.centerY - b.centerY);
    if (!hdr || rows.length === 0) return null;
    const pitch = rows.length > 1 ? rows[1].centerY - rows[0].centerY : 17;
    // True center of the first visible row sits just below the header.
    const firstTrue = hdr.centerY + hdr.height / 2 + pitch / 2;
    const offset = firstTrue - rows[0].centerY;
    return {
      offset,
      rows: rows.map((r: any) => ({ label: r.label, cx: r.centerX, cy: r.centerY })),
    };
  });
}

async function dblclickRow(page: Page, re: RegExp): Promise<string | null> {
  const geom = await treeGeom(page);
  if (!geom) return null;
  const row = geom.rows.find((r) => re.test(r.label || ''));
  if (!row) return null;
  await page.mouse.dblclick(row.cx, row.cy + geom.offset);
  return row.label;
}

test('footprint editor browses + loads a real ingested footprint (read path / version cap)', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await bootFootprintEditor(page);
  await stableShot(page, 'fpbrowse-01-boot.png');

  const geom0 = await treeGeom(page);
  logs.push(`[spec] tree geom: ${JSON.stringify(geom0)}`);

  // Expand the footprint lib (FootprintEnumerate) by double-clicking its row.
  const libClicked = await dblclickRow(page, new RegExp(`^${LIB}$`));
  logs.push(`[spec] expanded lib: ${libClicked}`);
  // Enumerate is done when the footprint child rows (SMD fixtures carry "Metric")
  // appear in the tree — that's what the next dblclick targets.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.wxElementRegistry
            .findAllRendered({ elementType: 'dataviewitem' })
            .some((e: any) => /Metric/.test(e.label || '')),
        ),
      { message: 'footprint child rows present after FootprintEnumerate', timeout: 60000 },
    )
    .toBe(true);
  await stableShot(page, 'fpbrowse-02-expanded.png');

  // Open a footprint child (FootprintLoad → Parse). SMD fixtures carry "Metric".
  const fpClicked = await dblclickRow(page, /Metric/);
  logs.push(`[spec] opened footprint: ${fpClicked}`);
  // Load+Parse is done when the editor title reflects the opened footprint.
  await expect
    .poll(() => page.title(), {
      message: 'editor title reflects opened footprint (FootprintLoad + Parse)',
      timeout: 60000,
    })
    .toContain(LIB);
  await stableShot(page, 'fpbrowse-03-loaded.png');

  const title = await page.title();
  logs.push(`[spec] title after open: ${title}`);
  // Diagnostics BEFORE assertions so a failure stays legible.
  console.log('--- console + spec log ---\n' + logs.join('\n'));

  // fp-lib-table worked: the footprint origin is in the tree.
  expect(geom0?.rows.some((r) => r.label === LIB), 'footprint lib row present').toBe(true);
  // Enumerate worked end-to-end through the fork: a footprint child appeared.
  expect(fpClicked, 'footprint row present after expand (FootprintEnumerate)').toBeTruthy();
  // Parse SUCCEEDED: the editor opened a footprint from the capped 10.0.3 data.
  expect(title, 'a footprint opened (FootprintLoad + Parse on capped data)').toContain(LIB);
  expect(title, 'opened footprint name in title').toMatch(/Metric/);

  // No parser rejection of the capped data, no wedge.
  expect(logs.some((l) => /FUTURE_FORMAT|too recent|Expecting\(|Unexpected/i.test(l)), 'no parse/format error').toBe(false);
  expect(logs.some((l) => l.includes('Aborted(')), 'no WASM abort').toBe(false);
  expect(new URL(page.url()).searchParams.get('oomRetry'), 'no OOM respawn').toBeNull();
});
