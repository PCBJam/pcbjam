import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * PROBE (temporary, not a gate): the reported "Symbol Properties dialog is
 * unresponsive to clicks, only the titlebar X closes it" bug.
 * Triage 2026-08-04 blamed a dispatch-interlock self-deadlock; this spec exists
 * to establish the ACTUAL mechanism empirically before any fix lands:
 *
 *   A. clicks never reach wx           → wx_dom_event early-returns
 *                                        (!IsEnabled — WINDOW_DISABLER makes
 *                                        IsEnabled() false through the parent
 *                                        chain), or no DOM element is hit;
 *   B. clicks reach wx but are DEFERRED → wxWasmDispatchParked() true and the
 *                                        drain is gated on the same predicate;
 *   C. clicks dispatch and work        → the bug needs another ingredient.
 *
 * The probe instruments wx_dom_event traffic from JS and reports which.
 */

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "aaaa0000-0000-0000-0000-000000000001")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R"
\t\t\t(pin_numbers (hide yes))
\t\t\t(pin_names (offset 0))
\t\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54)
\t\t\t\t\t(stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 100 100 0)
\t\t(unit 1)
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "bbbb0000-0000-0000-0000-000000000002")
\t\t(property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(instances (project "probe" (path "/aaaa0000-0000-0000-0000-000000000001" (reference "R1") (unit 1))))
\t)
)`;

type Mod = { kicadOpenFile(p: string): unknown; kicadOpenFileBusy?: () => boolean };
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };

async function bootAndLoad(page: Page): Promise<void> {
  await page.goto('/kicad/eeschema.html');
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => typeof (window.Module as unknown as Partial<Mod>)?.kicadOpenFile === 'function',
    null,
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry.findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || '').endsWith('Frame')),
    null,
    { timeout: 90000 },
  );
  await page.evaluate((sch) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const dir = '/home/kicad/documents';
    try { w.FS.mkdirTree(dir); } catch { /* exists */ }
    w.FS.writeFile(`${dir}/probe.kicad_sch`, sch);
    w.Module.kicadOpenFile(`${dir}/probe.kicad_sch`);
  }, SCH);
  await expect.poll(() => page.title(), { timeout: 60000 }).toMatch(/probe/i);
  await page.waitForTimeout(2000);
}

test.describe('PROBE: symbol-properties dialog responsiveness', () => {
  test('double-click a symbol, then click OK — what happens to the click?', async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(180000);
    await bootAndLoad(page);

    // Instrument the DOM-event bridge: record every wx_dom_event ccall and
    // whether wx deferred it (interlock parked) at that moment.
    await page.evaluate(() => {
      const w = window as unknown as {
        Module: { ccall: (...a: unknown[]) => unknown; _wxWasmDispatchDepthProbe?: () => number };
        __probe: { calls: { domId: number; kind: number }[] };
      };
      w.__probe = { calls: [] };
      const origCcall = w.Module.ccall.bind(w.Module);
      w.Module.ccall = function (name: unknown, ...rest: unknown[]) {
        if (name === 'wx_dom_event') {
          const args = rest[2] as number[];
          w.__probe.calls.push({ domId: args[0], kind: args[1] });
        }
        return origCcall(name, ...rest);
      } as typeof w.Module.ccall;
    });

    // Open Symbol Properties WITHOUT pixel hit-testing: select the first item
    // through the e2e lever, then use the "edit properties" hotkey (E).
    const canvas = page.locator('#canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 40); // focus the canvas
    const selected = await page.evaluate(() => {
      const m = window.Module as unknown as { kicadCollabTestSelectFirst?: () => unknown };
      if (typeof m.kicadCollabTestSelectFirst !== 'function') return 'lever-missing';
      try { m.kicadCollabTestSelectFirst(); return 'ok'; } catch (e) { return String(e); }
    });
    console.log(`[PROBE] select-first: ${selected}`);
    await page.waitForTimeout(500);
    await page.keyboard.press('e');

    // A dialog should appear. Report what the registry sees either way.
    const dialogInfo = await page
      .waitForFunction(
        () => {
          const r = window.wxElementRegistry!;
          const dlg = r.findAll({ visible: true })
            .filter((e) => /Dialog/.test(e.typeName));
          return dlg.length > 0 ? JSON.stringify(dlg.map((d) => ({ t: d.typeName, n: d.name }))) : null;
        },
        null,
        { timeout: 30000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    console.log(`[PROBE] dialogs after dblclick: ${dialogInfo ?? 'NONE'}`);
    test.skip(!dialogInfo, 'no dialog opened — dblclick did not reach the edit tool');

    // Find a clickable DOM button inside the dialog and click it.
    const buttons = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button'));
      return els.map((b, i) => ({
        i,
        text: (b.textContent || '').trim().slice(0, 24),
        visible: !!(b.offsetWidth || b.offsetHeight),
        enabled: !b.disabled,
        domId: (b as HTMLElement).dataset.wxDomId ?? null,
      })).filter((b) => b.visible);
    });
    console.log(`[PROBE] visible DOM buttons: ${JSON.stringify(buttons.slice(0, 12))}`);

    const okIdx = buttons.findIndex((b) => /^OK$/i.test(b.text));
    console.log(`[PROBE] OK button index: ${okIdx}`);
    if (okIdx >= 0) {
      await page.evaluate((i) => {
        const els = Array.from(document.querySelectorAll('button')).filter(
          (b) => !!((b as HTMLElement).offsetWidth || (b as HTMLElement).offsetHeight),
        );
        (els[i] as HTMLElement).click();
      }, okIdx);
    }
    await page.waitForTimeout(3000);

    const after = await page.evaluate(() => {
      const r = window.wxElementRegistry!;
      const dlgs = r.findAll({ visible: true }).filter((e) => /Dialog/.test(e.typeName));
      const p = (window as unknown as { __probe: { calls: unknown[] } }).__probe;
      return { dialogsStillOpen: dlgs.length, domEventCalls: p.calls.length };
    });
    console.log(
      `[PROBE] after OK click: dialogsStillOpen=${after.dialogsStillOpen} ` +
        `wx_dom_event calls seen=${after.domEventCalls}`,
    );
    const deferBeacons = testLogger.consoleLogs.filter((l) => /wx-dispatch|retry storm/.test(l));
    console.log(`[PROBE] interlock beacons: ${deferBeacons.length}`);

    // The probe always "passes"; its console output is the deliverable.
    expect(true).toBe(true);
  });
});
