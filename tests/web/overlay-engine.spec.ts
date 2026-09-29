import { test, expect, type Page } from '@playwright/test';
import { waitForRegistry, shotPath } from '../e2e/utils/element-tracker';

/**
 * Guide-overlay engine hooks (docs/features/overlay-system/0002 M2):
 *   - registry tool entries carry the tool id; `Module.kicadToolbarActions()`
 *     maps it to the KiCad action → `tool:<action>` targets resolve;
 *   - TOOL_MANAGER::processEvent emits `action` events (toolbar click AND
 *     hotkey land on the same name);
 *   - DIALOG_SHIM::Show emits `dialogShown` / `dialogClosed` with the class
 *     name → `dialog:<CLASS>` targets resolve while it is open.
 * Plus the target list the beginner tutorial relies on, in both editors —
 * a KiCad upgrade that renames or drops one of these actions fails here.
 */

type Rect = { x: number; y: number; width: number; height: number };
type EditorEvent = { type: string; name?: string; depth?: number; cls?: string; ptr?: string };
interface OverlayHandle {
  show(step: Record<string, unknown>): { id: number };
  resolve(target: string): { rect: Rect } | null;
  onEditorEvent(cb: (e: EditorEvent) => void): () => void;
  openDialog(cls: string): { ptr: string } | null;
}
declare global {
  interface Window {
    __pcbjamOverlay?: OverlayHandle;
    __editorEvents?: EditorEvent[];
  }
}

const PLACE_SYMBOL = 'eeschema.InteractiveDrawing.placeSymbol';

const SCH_TARGETS = [
  `tool:${PLACE_SYMBOL}`,
  'tool:eeschema.InteractiveDrawing.placePowerSymbol',
  'tool:eeschema.InteractiveDrawingLineWireBus.drawWires',
  'tool:eeschema.InteractiveDrawing.placeNoConnect',
  'tool:eeschema.InspectionTool.runERC',
];
const PCB_TARGETS = ['tool:pcbnew.InteractiveRouter.SingleTrack', 'tool:pcbnew.InteractiveDrawing.rectangle'];

async function boot(page: Page, file: string, title: RegExp): Promise<void> {
  await page.goto(`/default/projects/demo/${file}?overlayDemo=1`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect.poll(() => page.title(), { timeout: 150000, intervals: [1000] }).toMatch(title);
  await page.waitForFunction(() => !!window.__pcbjamOverlay, null, { timeout: 60000 });
  await page.evaluate(() => {
    window.__editorEvents = [];
    window.__pcbjamOverlay!.onEditorEvent((e) => window.__editorEvents!.push(e));
  });
}

const actions = (page: Page) =>
  page.evaluate(() => (window.__editorEvents ?? []).filter((e) => e.type === 'action').map((e) => e.name!));

async function resolved(page: Page, target: string): Promise<Rect | null> {
  return page.evaluate((t) => window.__pcbjamOverlay!.resolve(t)?.rect ?? null, target);
}

test.describe('guide overlay engine hooks', () => {
  test.setTimeout(300000);

  test('eeschema: tool targets, action events, dialog events', async ({ page }) => {
    await boot(page, 'demo.kicad_sch', /Schematic Editor/i);

    // Every tutorial target resolves (toolbars paint after the frame shows).
    for (const t of SCH_TARGETS) {
      await expect.poll(() => resolved(page, t), { timeout: 60000, message: t }).not.toBeNull();
    }
    // tool: and tooltip: agree on the Place Symbols button.
    const byAction = (await resolved(page, `tool:${PLACE_SYMBOL}`))!;
    expect(await resolved(page, 'tooltip:Place Symbols')).toEqual(byAction);

    // Toolbar click → the action event, as user input (depth 0).
    await page.mouse.click(byAction.x + byAction.width / 2, byAction.y + byAction.height / 2);
    await expect.poll(() => actions(page), { timeout: 20000 }).toContain(PLACE_SYMBOL);
    const clicked = await page.evaluate(
      (name) => window.__editorEvents!.find((e) => e.type === 'action' && e.name === name),
      PLACE_SYMBOL,
    );
    expect(clicked?.depth).toBe(0);

    // The armed placer opens the chooser on the first canvas click. wx WASM
    // defers posted follow-ups until the next input event, so the poll's
    // mouse moves pump the loop (same approach as eeschema-fp-selector).
    const canvas = (await page.locator('#canvas').boundingBox())!;
    const c = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    await page.mouse.click(c.x, c.y);
    let probe = 0;
    await expect
      .poll(
        async () => {
          await page.mouse.move(c.x + (probe % 5) * 4, c.y + (probe % 3) * 4);
          probe++;
          return page.evaluate(() => !!window.__pcbjamOverlay!.openDialog('DIALOG_SYMBOL_CHOOSER'));
        },
        { timeout: 90000, intervals: [1000] },
      )
      .toBe(true);

    // The chooser's first open hydrates the libraries under a full-page
    // loading cover (which also pauses the guide overlay): wait until the
    // chooser's Cancel button itself is under its registry point.
    const cancel = await page.evaluate(() => {
      const hit = window.wxElementRegistry!
        .findAll({ visible: true })
        .find((e) => /Button/i.test(e.typeName || '') && /^&?Cancel$/i.test(e.label ?? ''));
      if (!hit) return null;
      const origin = document.getElementById('canvas')!.getBoundingClientRect();
      return { x: origin.left + hit.centerX, y: origin.top + hit.centerY };
    });
    expect(cancel, 'chooser Cancel button registered').not.toBeNull();
    await expect
      .poll(
        () =>
          page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x!, y!);
            return el?.tagName === 'BUTTON' && /cancel/i.test(el.textContent ?? '');
          }, [cancel!.x, cancel!.y]),
        { timeout: 120000, intervals: [500], message: 'Cancel button uncovered (libraries loaded)' },
      )
      .toBe(true);
    // dialog: target resolves to the chooser window; a step anchors to it.
    await expect.poll(() => resolved(page, 'dialog:DIALOG_SYMBOL_CHOOSER'), { timeout: 20000 }).not.toBeNull();
    await page.evaluate(() =>
      window.__pcbjamOverlay!.show({ owner: 'e2e', target: 'dialog:DIALOG_SYMBOL_CHOOSER', text: 'Search for R' }),
    );
    await expect(page.getByTestId('overlay-card')).toHaveAttribute('data-target-state', 'found');
    await page.screenshot({ path: shotPath(page, 'overlay-engine-01-chooser.png') });

    // Cancel the chooser → dialogClosed, the target goes away. (Esc would
    // need keyboard focus inside the dialog; the Cancel button does not.)
    await page.mouse.click(cancel!.x, cancel!.y);
    await expect
      .poll(
        async () => {
          await page.mouse.move(c.x + (probe++ % 5) * 4, c.y);
          return page.evaluate(() =>
            (window.__editorEvents ?? []).some((e) => e.type === 'dialogClosed' && e.cls === 'DIALOG_SYMBOL_CHOOSER'),
          );
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(true);
    await expect(page.getByTestId('overlay-card')).toHaveAttribute('data-target-state', 'lost', { timeout: 10000 });

    // Leave the placer, then the hotkey path emits the same action name.
    await page.keyboard.press('Escape');
    const before = (await actions(page)).filter((n) => n === PLACE_SYMBOL).length;
    await page.mouse.click(c.x, c.y);
    await page.keyboard.press('a');
    await expect
      .poll(
        async () => {
          await page.mouse.move(c.x + (probe++ % 5) * 4, c.y);
          return (await actions(page)).filter((n) => n === PLACE_SYMBOL).length;
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBeGreaterThan(before);
  });

  test('pcbnew: tutorial tool targets resolve', async ({ page }) => {
    await boot(page, 'demo.kicad_pcb', /PCB Editor/i);
    for (const t of PCB_TARGETS) {
      await expect.poll(() => resolved(page, t), { timeout: 60000, message: t }).not.toBeNull();
    }
  });
});
