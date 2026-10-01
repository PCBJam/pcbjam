import { test, expect, type Page } from '@playwright/test';
import { waitForRegistry, shotPath } from '../e2e/utils/element-tracker';

/**
 * Engine hooks the beginner tutorial's round 2 relies on (docs/features/overlay-system/0005 M2):
 *   - "Run ERC" / "Run DRC" (dialog buttons, not tool actions) report what the check found as a
 *     `checkFinished` editor event — a tour can celebrate a clean run;
 *   - the sheet read carries each symbol's angle / mirror / position and the board read each
 *     footprint's angle — "rotate the resistor" is a state a tour can check;
 *   - the footprint chooser (a modal FRAME, not a DIALOG_SHIM) reports dialogShown/Closed, opens
 *     centred with a title bar, and the field dialog's library icon (KiCad's STD_BITMAP_BUTTON)
 *     is a `dialog:…/control:StdBitmapButton` target.
 */

type Rect = { x: number; y: number; width: number; height: number };
type EditorEvent = { type: string; cls?: string; kind?: string; errors?: number; warnings?: number; unconnected?: number };
interface OverlayHandle {
  resolve(target: string): { rect: Rect } | null;
  onEditorEvent(cb: (e: EditorEvent) => void): () => void;
  openDialog(cls: string): { ptr: string } | null;
}
declare global {
  interface Window {
    __pcbjamOverlay?: OverlayHandle;
    __editorEvents?: EditorEvent[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module: any;
  }
}

async function boot(page: Page, file: string, title: RegExp): Promise<void> {
  await page.goto(`/default/projects/demo/${file}?overlayDemo=1`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect.poll(() => page.title(), { timeout: 150000, intervals: [1000] }).toMatch(title);
  await page.waitForFunction(() => !!window.__pcbjamOverlay, null, { timeout: 60000 });
  await expect(page.locator('div.absolute.inset-0.z-30')).toHaveCount(0, { timeout: 150000 });
  await page.evaluate(() => {
    window.__editorEvents = [];
    window.__pcbjamOverlay!.onEditorEvent((e) => window.__editorEvents!.push(e));
  });
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function resolved(page: Page, target: string): Promise<Rect> {
  let rect: Rect | null = null;
  await expect
    .poll(async () => (rect = await page.evaluate((t) => window.__pcbjamOverlay!.resolve(t)?.rect ?? null, target)), {
      timeout: 60000,
      message: `${target} resolves`,
    })
    .not.toBeNull();
  return rect!;
}

/** wx WASM runs posted follow-ups on the next input event: poll while nudging the mouse. */
async function pumpUntil<T>(page: Page, at: { x: number; y: number }, read: () => Promise<T>, message: string, timeout = 60000): Promise<void> {
  let probe = 0;
  await expect
    .poll(
      async () => {
        await page.mouse.move(at.x + (probe % 5) * 3, at.y + (probe % 3) * 3);
        probe++;
        return read();
      },
      { timeout, intervals: [500], message },
    )
    .toBeTruthy();
}

const dialogOpen = (page: Page, cls: string) => page.evaluate((c) => !!window.__pcbjamOverlay!.openDialog(c), cls);
const lastCheck = (page: Page, kind: string) =>
  page.evaluate((k) => (window.__editorEvents ?? []).filter((e) => e.type === 'checkFinished' && e.kind === k).pop() ?? null, kind);

test.describe('guide overlay engine hooks (tutorial round 2)', () => {
  test.setTimeout(300000);

  test('eeschema: ERC reports what it found; sheet symbols carry their orientation', async ({ page }) => {
    await boot(page, 'demo.kicad_sch', /Schematic Editor/i);

    const symbols = await page.evaluate(
      () => JSON.parse(window.Module.kicadSheetSymbols()) as { ref: string; angle: number; mirror: string; x: number; y: number }[],
    );
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) {
      expect([0, 90, 180, 270], `${s.ref} angle`).toContain(s.angle);
      expect(['', 'x', 'y'], `${s.ref} mirror`).toContain(s.mirror);
      expect(Number.isInteger(s.x) && Number.isInteger(s.y), `${s.ref} position`).toBe(true);
    }

    const erc = await resolved(page, 'tool:eeschema.InspectionTool.runERC');
    await page.mouse.click(center(erc).x, center(erc).y);
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const idle = { x: canvas.x + canvas.width * 0.85, y: canvas.y + canvas.height * 0.85 };
    await pumpUntil(page, idle, () => dialogOpen(page, 'DIALOG_ERC'), 'the ERC dialog opens');

    const run = await resolved(page, 'dialog:DIALOG_ERC/control:button:Run ERC');
    await page.mouse.click(center(run).x, center(run).y);
    await pumpUntil(page, idle, () => lastCheck(page, 'erc'), 'ERC reports its result', 120000);
    const result = (await lastCheck(page, 'erc'))!;
    expect(Number.isInteger(result.errors) && result.errors! >= 0).toBe(true);
    expect(Number.isInteger(result.warnings) && result.warnings! >= 0).toBe(true);
    await page.screenshot({ path: shotPath(page, 'overlay-checks-01-erc.png') });

    const close = await resolved(page, 'dialog:DIALOG_ERC/control:button:Close');
    await page.mouse.click(center(close).x, center(close).y);
    await pumpUntil(page, idle, async () => !(await dialogOpen(page, 'DIALOG_ERC')), 'the ERC dialog closes');
  });

  test('eeschema: the footprint chooser opens centred, with a title bar, as a dialog a tour can point into', async ({ page }) => {
    await boot(page, 'demo.kicad_sch', /Schematic Editor/i);
    const ref = await page.evaluate(
      () =>
        (JSON.parse(window.Module.kicadSheetSymbols()) as { ref: string }[]).map((s) => s.ref).find((r) => /^R\d/.test(r))!,
    );
    const sym = await resolved(page, `symbol:${ref}`);
    await page.mouse.move(center(sym).x, center(sym).y);
    await page.mouse.click(center(sym).x, center(sym).y);
    await page.keyboard.press('f');
    await pumpUntil(page, center(sym), () => dialogOpen(page, 'DIALOG_FIELD_PROPERTIES'), 'the footprint field dialog opens');

    // KiCad's library icon next to the field: a STD_BITMAP_BUTTON, registered by its window name.
    const browse = await resolved(page, 'dialog:DIALOG_FIELD_PROPERTIES/control:StdBitmapButton');
    await page.mouse.click(center(browse).x, center(browse).y);
    const viewport = page.viewportSize()!;
    const away = { x: viewport.width - 40, y: viewport.height - 60 };
    await pumpUntil(page, away, () => dialogOpen(page, 'FOOTPRINT_CHOOSER_FRAME'), 'the footprint chooser opens');

    // Its first open hydrates the footprint libraries under the full-page loading cover: wait
    // until the chooser's own search field is the element under its centre again.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const r = window.__pcbjamOverlay!.resolve('dialog:FOOTPRINT_CHOOSER_FRAME/control:searchctrl')?.rect;
            return !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName === 'INPUT';
          }),
        { timeout: 120000, intervals: [500], message: 'chooser search field uncovered (libraries loaded)' },
      )
      .toBe(true);

    const frame = await resolved(page, 'dialog:FOOTPRINT_CHOOSER_FRAME');
    // Centred, not at the page origin; fully on screen.
    expect(frame.x).toBeGreaterThan(20);
    expect(frame.y).toBeGreaterThan(20);
    expect(frame.x + frame.width).toBeLessThanOrEqual(viewport.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator('.window-titlebar-text', { hasText: /Footprint Chooser/ })).toBeVisible();
    await page.screenshot({ path: shotPath(page, 'overlay-checks-02-footprint-chooser.png') });

    const cancel = await resolved(page, 'dialog:FOOTPRINT_CHOOSER_FRAME/control:button:Cancel');
    await page.mouse.click(center(cancel).x, center(cancel).y);
    await pumpUntil(
      page,
      away,
      () =>
        page.evaluate(() =>
          (window.__editorEvents ?? []).some((e) => e.type === 'dialogClosed' && e.cls === 'FOOTPRINT_CHOOSER_FRAME'),
        ),
      'the chooser reports it closed',
    );
    const fieldCancel = await resolved(page, 'dialog:DIALOG_FIELD_PROPERTIES/control:button:Cancel');
    await page.mouse.click(center(fieldCancel).x, center(fieldCancel).y);
    await pumpUntil(page, away, async () => !(await dialogOpen(page, 'DIALOG_FIELD_PROPERTIES')), 'the field dialog closes');
  });

  test('pcbnew: DRC reports what it found; board footprints carry their angle', async ({ page }) => {
    await boot(page, 'demo.kicad_pcb', /PCB Editor/i);

    const footprints = await page.evaluate(
      () => JSON.parse(window.Module.kicadBoardStatus()).footprints as { ref: string; angle: number }[],
    );
    expect(footprints.length).toBeGreaterThan(0);
    for (const f of footprints) {
      expect(Number.isFinite(f.angle) && f.angle >= 0 && f.angle < 360, `${f.ref} angle ${f.angle}`).toBe(true);
    }

    const drc = await resolved(page, 'tool:pcbnew.DRCTool.runDRC');
    await page.mouse.click(center(drc).x, center(drc).y);
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const idle = { x: canvas.x + canvas.width * 0.85, y: canvas.y + canvas.height * 0.85 };
    await pumpUntil(page, idle, () => dialogOpen(page, 'DIALOG_DRC'), 'the DRC dialog opens');

    const run = await resolved(page, 'dialog:DIALOG_DRC/control:button:Run DRC');
    await page.mouse.click(center(run).x, center(run).y);
    await pumpUntil(page, idle, () => lastCheck(page, 'drc'), 'DRC reports its result', 180000);
    const result = (await lastCheck(page, 'drc'))!;
    expect(Number.isInteger(result.errors) && result.errors! >= 0).toBe(true);
    expect(Number.isInteger(result.warnings) && result.warnings! >= 0).toBe(true);
    expect(Number.isInteger(result.unconnected) && result.unconnected! >= 0).toBe(true);
    await page.screenshot({ path: shotPath(page, 'overlay-checks-03-drc.png') });

    const close = await resolved(page, 'dialog:DIALOG_DRC/control:button:Close');
    await page.mouse.click(center(close).x, center(close).y);
    await pumpUntil(page, idle, async () => !(await dialogOpen(page, 'DIALOG_DRC')), 'the DRC dialog closes');
  });
});
