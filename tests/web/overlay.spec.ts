import { test, expect, type Page } from '@playwright/test';
import { waitForRegistry, shotPath } from '../e2e/utils/element-tracker';

/**
 * The guide overlay (docs/features/overlay-system/0002 M1) over a real
 * eeschema session, driven through the `?overlayDemo` handle
 * (window.__pcbjamOverlay) — no owner (tutorial/plugin) exists yet.
 *
 * Covers: a toolbar tool resolved by its tooltip lands the card + arrow on
 * the button's registry rect; clicks pass THROUGH the spotlight to wx (the
 * tool toggles); the card follows a window resize; a trusted prompt hides the
 * overlay and emits paused/resumed; a canvas `area:` target follows zoom.
 */

// The page-side handle (web/standalone src/overlay/demo.ts), typed loosely:
// the spec only drives it.
type OverlayEventName = 'shown' | 'cleared' | 'button' | 'targetFound' | 'targetLost' | 'paused' | 'resumed';
interface OverlayHandle {
  show(step: Record<string, unknown>): { id: number };
  on(type: OverlayEventName, cb: (e: { type: string }) => void): () => void;
  resolve(target: string): { rect: Rect } | null;
  openTrustedPrompt(): () => void;
}
declare global {
  interface Window {
    __pcbjamOverlay?: OverlayHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module: any;
  }
}

const TOOL = 'Place Symbols'; // SCH_ACTIONS::placeSymbol friendly name

type Rect = { x: number; y: number; width: number; height: number };

async function bootEeschema(page: Page): Promise<void> {
  await page.goto('/default/projects/demo/-/eeschema?overlayDemo=1');
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 150000 });
  await waitForRegistry(page, 150000);
  await expect
    .poll(() => page.title(), { timeout: 150000, intervals: [1000] })
    .toMatch(/Schematic Editor/i);
  await page.waitForFunction(() => !!window.__pcbjamOverlay, null, { timeout: 60000 });
  // The toolbars paint (and register their tools) after the frame shows.
  await expect
    .poll(() => toolRect(page, TOOL), { timeout: 60000, intervals: [500] })
    .not.toBeNull();
}

/** The tool's page rect, computed independently of the overlay code. */
async function toolRect(page: Page, tooltip: string): Promise<Rect | null> {
  return page.evaluate((want) => {
    const reg = window.wxElementRegistry;
    const origin = document.getElementById('canvas')!.getBoundingClientRect();
    const hit = (reg?.findAllRendered?.({ elementType: 'tool' }) ?? []).find(
      (t) => (t.tooltip.split('\n')[0] ?? '').split('\t')[0]!.trim() === want && t.width > 0,
    );
    return hit
      ? { x: origin.left + hit.screenX, y: origin.top + hit.screenY, width: hit.width, height: hit.height }
      : null;
  }, tooltip);
}

async function toolChecked(page: Page, tooltip: string): Promise<boolean> {
  return page.evaluate((want) => {
    const hit = (window.wxElementRegistry?.findAllRendered?.({ elementType: 'tool' }) ?? []).find(
      (t) => (t.tooltip.split('\n')[0] ?? '').split('\t')[0]!.trim() === want,
    );
    return !!hit && / \[checked\]$/.test(hit.label);
  }, tooltip);
}

async function box(page: Page, testid: string): Promise<Rect | null> {
  return page.getByTestId(testid).boundingBox();
}

/** Distance from the arrow's centre to the target's centre along the card edge axis. */
async function arrowOffset(page: Page, target: Rect): Promise<number> {
  const side = await page.getByTestId('overlay-card').getAttribute('data-side');
  const arrow = await box(page, 'overlay-arrow');
  if (!arrow || !side) return Infinity;
  const ax = arrow.x + arrow.width / 2;
  const ay = arrow.y + arrow.height / 2;
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;
  return side === 'top' || side === 'bottom' ? Math.abs(ax - tx) : Math.abs(ay - ty);
}

test.describe('guide overlay (eeschema)', () => {
  test.setTimeout(300000);

  test('anchors to a toolbar tool, passes clicks through, follows resize, pauses for trusted prompts', async ({
    page,
  }) => {
    await bootEeschema(page);

    await page.evaluate(() => {
      const w = window as unknown as { __overlayEvents: string[] };
      w.__overlayEvents = [];
      for (const t of ['shown', 'cleared', 'button', 'targetFound', 'targetLost', 'paused', 'resumed'] as const) {
        window.__pcbjamOverlay!.on(t, (e) => w.__overlayEvents.push(e.type));
      }
      window.__pcbjamOverlay!.show({
        owner: 'e2e',
        target: 'tooltip:Place Symbols',
        title: 'Add a symbol',
        text: 'Click here to add symbols.',
        spotlight: true,
        pulse: true,
        buttons: ['skip', 'next'],
        progress: { step: 1, of: 3 },
        attribution: 'E2E',
      });
    });

    const card = page.getByTestId('overlay-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-target-state', 'found');
    await expect(page.getByTestId('overlay-spotlight')).toBeVisible();
    await expect(page.getByTestId('overlay-attribution')).toHaveText('from E2E');
    await expect(page.getByTestId('overlay-progress')).toHaveText('1 / 3');

    const target = (await toolRect(page, TOOL))!;
    await expect.poll(() => arrowOffset(page, target)).toBeLessThanOrEqual(16);
    // The ring hugs the tool (4 px padding each side).
    const ring = (await box(page, 'overlay-ring'))!;
    expect(Math.abs(ring.x + 4 - target.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(ring.y + 4 - target.y)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: shotPath(page, 'overlay-01-tool.png') });

    // Click-through: the dim and ring take no pointer events — the wx tool
    // under them toggles on.
    expect(await toolChecked(page, TOOL)).toBe(false);
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await expect.poll(() => toolChecked(page, TOOL), { timeout: 20000 }).toBe(true);
    // The tool opens the symbol chooser. Its first open loads libraries under a cover that
    // pauses the overlay; once the chooser is usable (Cancel actionable) the card is back and
    // the dim has stepped aside so the dialog does not look disabled.
    const cancel = page.locator('button', { hasText: /^Cancel$/ });
    await cancel.click({ trial: true, timeout: 120000 });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0);
    await page.screenshot({ path: shotPath(page, 'overlay-01b-dialog-undimmed.png') });
    await cancel.click();
    // The target was used (clicked): for the rest of this step the dim and the ring stay away,
    // so the canvas the user now works on is not greyed out.
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0);
    await expect(page.getByTestId('overlay-ring')).toHaveCount(0);
    await page.keyboard.press('Escape'); // KiCad: leave the placer (Esc on the canvas is not ours)
    await expect(card).toBeVisible();
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0);

    // Card buttons reach the owner.
    await page.getByTestId('overlay-next').click();

    // Resize: the tool moves (or not) with the frame layout; the arrow follows.
    await page.setViewportSize({ width: 1000, height: 640 });
    await expect
      .poll(
        async () => {
          const t = await toolRect(page, TOOL);
          return t ? arrowOffset(page, t) : Infinity;
        },
        { timeout: 20000 },
      )
      .toBeLessThanOrEqual(16);

    // Trusted prompt: overlay hidden while it is open, back afterwards.
    await page.evaluate(() => {
      (window as unknown as { __release: () => void }).__release = window.__pcbjamOverlay!.openTrustedPrompt();
    });
    await expect(page.getByTestId('overlay-root')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect(card).toBeVisible();

    // The user's close clears the step.
    await page.getByTestId('overlay-close').click();
    await expect(page.getByTestId('overlay-root')).toHaveCount(0);

    const events = await page.evaluate(() => (window as unknown as { __overlayEvents: string[] }).__overlayEvents);
    // Activating Place Symbols may hydrate the libraries under the loading
    // cover, which pauses/resumes the overlay too — only the trusted-prompt
    // pair at the end is ours to pin.
    expect(events.filter((e) => e !== 'paused' && e !== 'resumed')).toEqual([
      'shown',
      'targetFound',
      'button',
      'cleared',
    ]);
    expect(events.slice(-3)).toEqual(['paused', 'resumed', 'cleared']);
  });

  test('the tool hotkey counts as using the target; a new request dims again', async ({ page }) => {
    await bootEeschema(page);
    const WIRES = 'tool:eeschema.InteractiveDrawingLineWireBus.drawWires';
    const show = (text: string) =>
      page.evaluate(
        ({ target, text }) =>
          window.__pcbjamOverlay!.show({ owner: 'e2e', target, title: 'Wire it', text, spotlight: true, pulse: true }),
        { target: WIRES, text },
      );
    // Keyboard focus on the sheet BEFORE the step: a click on the sheet during the step would
    // itself lift the dim (next test), and this one is about the hotkey alone.
    const canvas = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.5);
    await show('Click Draw Wires (or press W).');
    const card = page.getByTestId('overlay-card');
    await expect(card).toHaveAttribute('data-target-state', 'found', { timeout: 20000 });
    await expect(page.getByTestId('overlay-spotlight')).toBeVisible();

    // W over the sheet runs the tool's action — no click on the button, no dialog.
    await page.keyboard.press('w');
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByTestId('overlay-ring')).toHaveCount(0);
    await page.screenshot({ path: shotPath(page, 'overlay-05-hotkey-used.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0);

    // Another step on the same tool is a new request: the dim is back.
    await show('Now draw the next wire: click Draw Wires again.');
    await expect(page.getByTestId('overlay-spotlight')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('overlay-close').click();
  });

  test('a click on the sheet makes the dim and ring step aside; the card stays', async ({ page }) => {
    await bootEeschema(page);
    const show = (text: string) =>
      page.evaluate(
        (text) =>
          window.__pcbjamOverlay!.show({
            owner: 'e2e',
            target: 'tool:eeschema.InteractiveDrawing.placeSymbol',
            title: 'Add a symbol',
            text,
            spotlight: true,
            pulse: true,
          }),
        text,
      );
    await show('Click Place Symbols.');
    const card = page.getByTestId('overlay-card');
    await expect(card).toHaveAttribute('data-target-state', 'found', { timeout: 20000 });
    await expect(page.getByTestId('overlay-spotlight')).toBeVisible();
    await expect(page.getByTestId('overlay-ring')).toBeVisible();

    // The user starts working on the sheet instead: nothing should grey it out any more.
    const gal = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[id^="glcanvas-"]')).find(
        (c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0,
      )!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.click(gal.x + gal.width * 0.3, gal.y + gal.height * 0.6);
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByTestId('overlay-ring')).toHaveCount(0);
    await expect(card).toBeVisible();
    await page.screenshot({ path: shotPath(page, 'overlay-06-sheet-click.png') });

    // A new request points again.
    await show('Now click Place Symbols once more.');
    await expect(page.getByTestId('overlay-spotlight')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('overlay-close').click();
  });

  test('the card lets the work on the sheet through; only its buttons take the pointer', async ({ page }) => {
    await bootEeschema(page);
    await page.evaluate(() =>
      window.__pcbjamOverlay!.show({
        owner: 'e2e',
        target: 'tool:eeschema.InteractiveDrawing.placeSymbol',
        title: 'Move it',
        text: 'Press M over the part, then click where it should go — even right under this card.',
      }),
    );
    const card = page.getByTestId('overlay-card');
    await expect(card).toHaveAttribute('data-target-state', 'found', { timeout: 20000 });
    // A part moved under the card keeps following the mouse: the text passes the pointer to the
    // canvas below, the close button keeps it.
    const under = (testid: string) =>
      page.evaluate((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit?.closest('[data-testid="overlay-card"]') ? (hit.closest('[data-testid]')?.getAttribute('data-testid') ?? 'card') : (hit?.tagName ?? null);
      }, testid);
    expect(await under('overlay-text')).toBe('CANVAS');
    expect(await under('overlay-close')).toBe('overlay-close');
    await page.getByTestId('overlay-close').click();
    await expect(card).toHaveCount(0);
  });

  test('a celebrating step throws a short rainbow at the mouse; reduced motion shows only the chip', async ({ page }) => {
    await bootEeschema(page);
    const canvas = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    const celebrate = (title: string) =>
      page.evaluate(
        (title) => window.__pcbjamOverlay!.show({ owner: 'e2e', title, text: 'No errors.', celebrate: 'rainbow' }),
        title,
      );
    await celebrate('ERC is clean');
    await expect(page.getByTestId('overlay-celebration')).toBeVisible();
    await expect(page.getByTestId('overlay-celebration-trail')).toHaveCount(1);
    // It is short, and it never takes clicks (the card does; the trail layer does not).
    await expect(page.getByTestId('overlay-celebration')).toHaveCount(0, { timeout: 10000 });
    await expect(page.getByTestId('overlay-celebration-trail')).toHaveCount(0);
    await expect(page.getByTestId('overlay-card')).toBeVisible();

    // Reduced motion: the chip only, nothing moves (and the screenshot is deterministic).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await celebrate('DRC is clean');
    await expect(page.getByTestId('overlay-celebration')).toBeVisible();
    await expect(page.getByTestId('overlay-celebration-trail')).toHaveCount(0);
    await page.screenshot({ path: shotPath(page, 'overlay-07-celebrate-reduced.png') });
    await page.getByTestId('overlay-close').click();
  });

  test('unknown and missing targets show an unanchored card with the lost text', async ({ page }) => {
    await bootEeschema(page);
    await page.evaluate(() =>
      window.__pcbjamOverlay!.show({
        owner: 'e2e',
        target: 'tooltip:No Such Tool',
        text: 'Pointing at something',
        lostText: 'Open the tool first',
      }),
    );
    const card = page.getByTestId('overlay-card');
    await expect(card).toHaveAttribute('data-target-state', 'lost');
    await expect(page.getByTestId('overlay-text')).toHaveText('Open the tool first');
    await expect(page.getByTestId('overlay-arrow')).toHaveCount(0);
  });

  test('menu bar titles resolve', async ({ page }) => {
    await bootEeschema(page);
    const rect = await page.evaluate(() => window.__pcbjamOverlay!.resolve('menu:File')?.rect ?? null);
    const title = await page.locator('.wx-menu-title', { hasText: /^File$/ }).first().boundingBox();
    expect(rect, 'menu:File resolves').not.toBeNull();
    expect(Math.abs(rect!.x - title!.x)).toBeLessThanOrEqual(1);
  });

  test('a card that cannot be closed has no × and leaves Escape to the editor', async ({ page }) => {
    await bootEeschema(page);
    await page.evaluate(() => {
      const w = window as unknown as { __overlayEvents: string[] };
      w.__overlayEvents = [];
      for (const t of ['shown', 'cleared', 'button'] as const) {
        window.__pcbjamOverlay!.on(t, (e) => w.__overlayEvents.push(e.type));
      }
      window.__pcbjamOverlay!.show({
        owner: 'e2e',
        title: 'Stay with me',
        text: 'Place the part, then press Esc.',
        buttons: ['next'],
        closable: false,
      });
    });
    const card = page.getByTestId('overlay-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('overlay-close')).toHaveCount(0);
    await page.screenshot({ path: shotPath(page, 'overlay-07-not-closable.png') });

    // Focus inside the card, as right after pressing one of its buttons: Escape is not a close.
    await page.getByTestId('overlay-next').focus();
    await page.keyboard.press('Escape');
    // The card's own button still answers — and nothing cleared the step in between.
    await page.getByTestId('overlay-next').click();
    const events = await page.evaluate(() => (window as unknown as { __overlayEvents: string[] }).__overlayEvents);
    expect(events).toEqual(['shown', 'button']);
    await expect(card).toBeVisible();
  });

  test('a canvas area target follows zoom', async ({ page }) => {
    await bootEeschema(page);
    const vp = await page.evaluate(() => JSON.parse(window.Module.kicadCollabGetViewport()));
    expect(vp.scale).toBeGreaterThan(0);
    // A 60x40 CSS-ish px box around the viewport centre, in world IU.
    const w = 60 / vp.scale;
    const h = 40 / vp.scale;
    await page.evaluate(
      (t) => window.__pcbjamOverlay!.show({ owner: 'e2e', target: t, text: 'Place it here', spotlight: true }),
      `area:${vp.cx - w / 2},${vp.cy - h / 2},${w},${h}`,
    );
    await expect(page.getByTestId('overlay-card')).toHaveAttribute('data-target-state', 'found');
    // Canvas targets never dim the canvas.
    await expect(page.getByTestId('overlay-spotlight')).toHaveCount(0);
    const before = (await box(page, 'overlay-ring'))!;

    const canvas = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -400);
    await expect
      .poll(async () => (await box(page, 'overlay-ring'))?.width ?? before.width, { timeout: 20000 })
      .not.toBe(before.width);
    await page.screenshot({ path: shotPath(page, 'overlay-02-area.png') });
  });
});
