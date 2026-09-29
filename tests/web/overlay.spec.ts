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
    await page.keyboard.press('Escape'); // KiCad: leave the placer (Esc on the canvas is not ours)
    await expect(card).toBeVisible();

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
    expect(events).toEqual(['shown', 'targetFound', 'button', 'paused', 'resumed', 'cleared']);
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
