import { test, expect, type Page } from '@playwright/test';
import { clickByTooltip, stableShot, waitForWxApp } from '../e2e/utils/element-tracker';

/**
 * Cmd+S in the Footprint Editor must save the open footprint through the lib
 * write bridge, exactly like the toolbar Save icon does.
 *
 * Report (libs 0017): on a Mac, a footprint edited in the editor opened from
 * pcbnew saved from the Save icon but not from Cmd+S. tests/kicad/save-cmd-key
 * proves the Meta chord saves in the MAIN frames under a macOS UA; this spec
 * covers the lib editor frame. Recipe: `-/footprint_editor` → expand
 * Resistor_SMD → open a footprint → dirty it (select-all + R) → Cmd+S → expect
 * one `save` request on window.kicadLibs.request. The Save toolbar button is
 * the control.
 *
 * Root cause + fix (2026-08-25): the lib-tree filter <input> kept BROWSER focus
 * after a canvas click (the wasm mouse callback preventDefaults mousedown), so
 * every key stayed with the input. wxWindowWasm::SetFocus now blurs the active
 * wx-dom control when a canvas-drawn window takes wx focus (wxDomBlurActive).
 * The bug is a wx-layer focus rule, so the standalone frame reproduces it
 * exactly like the one opened from pcbnew (same FOOTPRINT_EDIT_FRAME); the
 * from-pcbnew variant was dropped — opening a second editor from a board
 * session timed out on CI (Chromium: frame never opened in 180 s; Firefox:
 * footprint load >60 s, the tier footprint-browse-remote also skips).
 *
 * UA: the Playwright device presets say Windows; wx.js derives the OS from the
 * UA and maps the Meta key to ControlDown only on a Mac — so pin a Mac UA.
 */

const SCOPE = 'default';
const BOOT_TIMEOUT = 180000;
const LIB = 'Resistor_SMD';

type SpyWindow = Window & {
  kicadLibs?: { request: (...a: unknown[]) => Promise<unknown> };
  __libOps: { op: string; arg: string }[];
};

function frameNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { wxElementRegistry: any }).wxElementRegistry
      .findAll({})
      .filter((e: any) => /Frame$/.test(e.typeName || ''))
      .map((e: any) => e.name as string),
  );
}

/** Map a rendered tree row's offset Y to its true screen Y (footprint-browse-remote). */
async function treeGeom(page: Page) {
  return page.evaluate(() => {
    const rd = (window as any).wxElementRegistry.findAllRendered({});
    const hdr = rd.find((e: any) => e.elementType === 'columnheader' && e.label === 'Item');
    const rows = rd
      .filter((e: any) => e.elementType === 'dataviewitem')
      .sort((a: any, b: any) => a.centerY - b.centerY);
    if (!hdr || rows.length === 0) return null;
    const pitch = rows.length > 1 ? rows[1].centerY - rows[0].centerY : 17;
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

/** Count of `save` ops the lib bridge received. */
function saveOps(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as SpyWindow).__libOps.filter((o) => o.op === 'save').length,
  );
}

async function clickCanvasCenter(page: Page): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  expect(box, 'canvas box').not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test.describe('footprint editor: Cmd+S saves', () => {
  test.describe.configure({ timeout: 480000 });
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });

  async function run(page: Page): Promise<void> {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    await page.goto(`/${SCOPE}/projects/demo/-/footprint_editor`);
    await waitForWxApp(page, { timeout: BOOT_TIMEOUT });
    await page.waitForFunction(() => !!(window as unknown as SpyWindow).kicadLibs, null, {
      timeout: 60000,
    });

    // Spy on the lib bridge: every op the editor asks for, in order.
    await page.evaluate(() => {
      const w = window as unknown as SpyWindow;
      w.__libOps = [];
      const real = w.kicadLibs!.request;
      w.kicadLibs!.request = (...a: unknown[]) => {
        // request(op, "/mnt/pcbjam/<id>", arg, kind)
        w.__libOps.push({ op: String(a[0]), arg: String(a[2] ?? '').slice(0, 60) });
        return real.apply(w.kicadLibs, a);
      };
    });

    await expect
      .poll(() => frameNames(page), { message: 'ModEditFrame opened', timeout: BOOT_TIMEOUT })
      .toContain('ModEditFrame');
    await expect
      .poll(() => treeGeom(page).then((g) => g?.rows.some((r) => r.label === LIB) ?? false), {
        message: `${LIB} row in the footprint tree`,
        timeout: 120000,
      })
      .toBe(true);
    await stableShot(page, 'fpedit-cmd-save-01-tree.png');

    expect(await dblclickRow(page, new RegExp(`^${LIB}$`)), 'lib expanded').toBeTruthy();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as any).wxElementRegistry
              .findAllRendered({ elementType: 'dataviewitem' })
              .some((e: any) => /Metric/.test(e.label || '')),
          ),
        { message: 'footprint child rows after enumerate', timeout: 60000 },
      )
      .toBe(true);
    const opened = await dblclickRow(page, /Metric/);
    expect(opened, 'a footprint row opened').toBeTruthy();
    await expect
      .poll(() => page.title(), { message: 'footprint loaded (title)', timeout: 60000 })
      .toContain(LIB);
    await stableShot(page, 'fpedit-cmd-save-02-loaded.png');

    // Dirty the footprint from the canvas: select all + rotate (R). Delete is
    // refused on the mandatory ${REFERENCE} field, so it doesn't dirty anything.
    await clickCanvasCenter(page);
    await page.waitForTimeout(300); // eslint-disable-line -- focus settle, no JS signal
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('r');
    await page.waitForTimeout(500); // eslint-disable-line -- modified flag settle, no JS signal
    await stableShot(page, 'fpedit-cmd-save-03-dirty.png');
    logs.push(
      `[spec] before chord: title="${await page.title()}" activeElement=${await page.evaluate(
        () => `${document.activeElement?.tagName}#${(document.activeElement as HTMLElement)?.id}`,
      )}`,
    );

    const before = await saveOps(page);
    await page.keyboard.press('Meta+s');
    await page
      .waitForFunction(
        (n) => (window as unknown as SpyWindow).__libOps.filter((o) => o.op === 'save').length > n,
        before,
        { timeout: 15000 },
      )
      .catch(() => undefined);
    const afterCmd = await saveOps(page);
    logs.push(`[spec] saves before=${before} afterCmd=${afterCmd}`);
    await stableShot(page, 'fpedit-cmd-save-04-after-cmd-s.png');

    // Control: the toolbar Save icon (what the user fell back to).
    if (afterCmd === before) {
      await clickByTooltip(page, 'Save', { elementType: 'tool' });
      await page
        .waitForFunction(
          (n) => (window as unknown as SpyWindow).__libOps.filter((o) => o.op === 'save').length > n,
          before,
          { timeout: 15000 },
        )
        .catch(() => undefined);
      logs.push(`[spec] saves after toolbar Save=${await saveOps(page)}`);
    }
    logs.push(
      `[spec] lib ops: ${JSON.stringify(await page.evaluate(() => (window as unknown as SpyWindow).__libOps))}`,
    );
    console.log('--- spec log ---\n' + logs.filter((l) => /\[spec\]|\[libs\]|save|accel/i.test(l)).join('\n'));

    expect(logs.some((l) => l.includes('Aborted(')), 'no WASM abort').toBe(false);
    expect(afterCmd, 'Cmd+S produced a lib save').toBeGreaterThan(before);
  }

  test('Cmd+S on a dirty footprint reaches the lib save bridge', async ({ page }) => {
    await run(page);
  });
});
