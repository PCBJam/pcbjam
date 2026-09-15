import { test, expect, devices, type Page, type Browser } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';
import { shotPath, settledShot } from '../e2e/utils/element-tracker';

// One shared page across the checks (beforeAll boots pcbnew ONCE — each boot
// costs minutes). Serial group: fullyParallel would re-boot per test.
test.describe.configure({ mode: 'serial' });

/**
 * Mobile canvas-only mode e2e (features/mobile) — runs under the
 * `web-mobile` project (Pixel 7 emulation on the bundled Chromium).
 *
 * Boots pcbnew ONCE on the demo board with `?mobile=1` (the wasm runtime is
 * process-global and each boot costs minutes, so the four checks share one
 * serial page):
 *
 *   1. chrome-less: no visible wx toolbars/menubar, GL canvas ≈ viewport
 *      (needs kicadSetChrome — the wasm side of features/mobile)
 *   2. tap contract: a touch tap synthesizes a LEFT click (selection keeps
 *      working), and no phantom middle-button events
 *   3. pinch: two-finger pinch-out zooms in (and pinch-in restores) — rides
 *      the wheel→zoom-to-cursor path, asserted per zoom-cursor.spec.ts logic
 *   4. pan: a one-finger drag translates the view (and is NOT the old
 *      single-finger rubber-band select, which left the view unchanged)
 *
 * Touches are dispatched as synthetic TouchEvents on #canvas — exactly what
 * the boot shim (touch-gestures.ts) consumes; Playwright has no pinch API.
 */

const FRONTEND_URL = process.env.WEB_APP_URL ?? 'http://localhost:3048';
const SCOPE = 'default';

// NOT describe.serial: the config is fullyParallel:false + workers:1, so the
// file's tests already run in order in one worker sharing `page` — and a
// failure (e.g. chrome-hide RED before the wasm lands) must not skip the rest.
let page: Page;

interface Pt {
  id: number;
  x: number;
  y: number;
}

/** Dispatch a TouchEvent on #canvas; `active` is the post-event touch list
 *  (the shape of `event.touches` — empty for the final touchend). */
async function touch(pg: Page, type: string, active: Pt[], changed?: Pt[]): Promise<void> {
  await pg.evaluate(
    ({ type, active, changed }) => {
      const canvas = document.getElementById('canvas');
      if (!canvas) throw new Error('#canvas not found');
      const mk = (p: { id: number; x: number; y: number }) =>
        new Touch({
          identifier: p.id,
          target: canvas,
          clientX: p.x,
          clientY: p.y,
          screenX: p.x,
          screenY: p.y,
          radiusX: 2.5,
          radiusY: 2.5,
          force: 1,
        });
      const touches = active.map(mk);
      canvas.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches,
          targetTouches: touches,
          changedTouches: (changed ?? active).map(mk),
        }),
      );
    },
    { type, active, changed },
  );
}

/** One-finger drag as a touch sequence. */
async function fingerDrag(
  pg: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
): Promise<void> {
  await touch(pg, 'touchstart', [{ id: 1, x: from.x, y: from.y }]);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await touch(pg, 'touchmove', [{ id: 1, x, y }]);
    // The pacing IS the input: it gives the gesture a finger-plausible velocity.
    await pg.waitForTimeout(30); // eslint-disable-line -- documented interaction dwell: gesture pacing
  }
  await touch(pg, 'touchend', [], [{ id: 1, x: to.x, y: to.y }]);
}

/** Two-finger horizontal pinch around a centre, from ±spreadFrom to ±spreadTo. */
async function pinch(
  pg: Page,
  centre: { x: number; y: number },
  spreadFrom: number,
  spreadTo: number,
  steps = 8,
): Promise<void> {
  const at = (s: number): Pt[] => [
    { id: 1, x: centre.x - s, y: centre.y },
    { id: 2, x: centre.x + s, y: centre.y },
  ];
  await touch(pg, 'touchstart', at(spreadFrom));
  for (let i = 1; i <= steps; i++) {
    const s = spreadFrom + ((spreadTo - spreadFrom) * i) / steps;
    await touch(pg, 'touchmove', at(s));
    // The pacing IS the input: it gives the gesture a finger-plausible velocity.
    await pg.waitForTimeout(30); // eslint-disable-line -- documented interaction dwell: gesture pacing
  }
  await touch(pg, 'touchend', [], at(spreadTo));
}

/** The visible GAL WebGL canvas box (same lookup as zoom-cursor.spec.ts). */
async function getGlBox(pg: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const id = await pg.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find((c) => {
        const rect = c.getBoundingClientRect();
        return window.getComputedStyle(c).display !== 'none' && rect.width > 0 && rect.height > 0;
      });
    return (visible ?? (document.querySelector('[id^="glcanvas-"]') as HTMLCanvasElement | null))?.id ?? null;
  });
  if (!id) throw new Error('No visible GL canvas found');
  const box = await pg.locator(`#${id}`).boundingBox();
  if (!box) throw new Error('GL canvas bounding box unavailable');
  return box;
}

/** Fraction of pixels that differ (luma) between two PNGs inside a region
 *  (ported from zoom-cursor.spec.ts). */
async function diffRatio(
  pg: Page,
  a: Buffer,
  b: Buffer,
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return pg.evaluate(
    async ({ aB64, bB64, box }) => {
      const load = async (s: string) => {
        const i = new Image();
        i.src = `data:image/png;base64,${s}`;
        await i.decode();
        return i;
      };
      const [ia, ib] = await Promise.all([load(aB64), load(bB64)]);
      const w = Math.min(ia.width, ib.width),
        h = Math.min(ia.height, ib.height);
      const px = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d')!;
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const da = px(ia),
        db = px(ib);
      const x0 = Math.max(0, Math.round(box.x)),
        x1 = Math.min(w, Math.round(box.x + box.width));
      const y0 = Math.max(0, Math.round(box.y)),
        y1 = Math.min(h, Math.round(box.y + box.height));
      let diff = 0,
        total = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
          const lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
          if (Math.abs(la - lb) > 24) diff++;
          total++;
        }
      return diff / total;
    },
    { aB64: a.toString('base64'), bB64: b.toString('base64'), box },
  );
}

const shot = (name: string) =>
  page.screenshot({ path: shotPath(page, `mobile-${name}.png`), scale: 'css' });

/** Settle the render (two consecutive identical canvas screenshots), then capture
 *  the named gate shot — the deterministic replacement for sleep-then-shoot. */
const settledCapture = async (name: string): Promise<Buffer> => {
  await settledShot(page.locator('#canvas'), expect);
  return shot(name);
};

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(420_000); // cold load: 136 MB wasm download + compile
  page = await browser.newPage({ ...devices['Pixel 7'], baseURL: FRONTEND_URL });
  page.on('console', (m) => {
    if (/Aborted\(|pageerror/i.test(m.text())) console.log(`[mobile-e2e console] ${m.text()}`);
  });
  // `mode=edit` answers the mobile session-mode gate (mobile 0002) up front:
  // this spec is about the FULL editor on a phone; the gate itself is
  // covered by mobile-mode-gate.spec.ts.
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?mobile=1&mode=edit`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(/demo — PCB Editor/i);
  // The full-screen loading overlays (boot + lib fat-load, both `inset-0 z-30`
  // in WasmTool) must be GONE — the gesture tests diff screenshots, and an
  // overlay screenshot diffs to zero (learned the hard way on a cold load).
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
  // First paint + fit-to-view + the chrome-hide poll: settled when two
  // consecutive canvas screenshots are byte-identical.
  await settledShot(page.locator('#canvas'), expect);
});

test.afterAll(async () => {
  await page?.close();
});

test('tap contract: a touch tap synthesizes a LEFT click, no phantom middle-drag', async () => {
  const box = await getGlBox(page);
  await page.evaluate(() => {
    const c = document.getElementById('canvas')!;
    const log: [string, number][] = ((window as unknown as { __mouseLog: [string, number][] }).__mouseLog = []);
    for (const type of ['mousedown', 'mouseup'])
      c.addEventListener(type, (e) => log.push([e.type, (e as MouseEvent).button]), true);
  });

  const p = { id: 1, x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  await touch(page, 'touchstart', [p]);
  // A tap's physical duration — instantaneous taps can be filtered as noise.
  await page.waitForTimeout(60); // eslint-disable-line -- documented interaction dwell: tap duration
  await touch(page, 'touchend', [], [p]);
  // The synthesized click is the observable: wait for the mouseup to land in the log.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __mouseLog: [string, number][] }).__mouseLog.length,
        ),
      { timeout: 10000, message: 'tap never synthesized any mouse events' },
    )
    .toBeGreaterThanOrEqual(2);

  const log = await page.evaluate(
    () => (window as unknown as { __mouseLog: [string, number][] }).__mouseLog,
  );
  expect(log, 'tap → left mousedown').toContainEqual(['mousedown', 0]);
  expect(log, 'tap → left mouseup').toContainEqual(['mouseup', 0]);
  expect(
    log.filter(([, button]) => button === 1),
    'a tap must not press the middle (pan) button',
  ).toHaveLength(0);
});

test('pinch: two-finger pinch-out zooms in, pinch-in restores', async () => {
  // shim marker: mobile mode must have armed the canvas for touch
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('canvas')!).touchAction),
    'canvas touch-action none (gesture shim installed)',
  ).toBe('none');

  const box = await getGlBox(page);
  const centre = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.45 };

  const base = await settledCapture('pinch-00-base');
  await pinch(page, centre, 40, 140); // pinch OUT = zoom in
  const zoomed = await settledCapture('pinch-01-zoomed');

  await pinch(page, centre, 140, 40); // pinch IN at the same centre = zoom back out
  const restored = await settledCapture('pinch-02-restored');

  const dIn = await diffRatio(page, base, zoomed, box);
  const dBack = await diffRatio(page, base, restored, box);
  console.log(`[mobile pinch] dIn=${dIn.toFixed(3)} dBack=${dBack.toFixed(3)}`);

  expect(dIn, 'pinch-out visibly zooms').toBeGreaterThan(0.006);
  // zoom-to-cursor at a fixed centroid is invertible (same discriminator as
  // zoom-cursor.spec.ts)
  expect(dBack, 'pinch in+out returns near baseline').toBeLessThan(dIn / 3);
});

test('pan: one-finger drag translates the view (not a rubber-band select)', async () => {
  const box = await getGlBox(page);
  // start/end in the bottom-left margin: the old single-finger LEFT-drag would
  // rubber-band an EMPTY region there (no selection highlight → no pixel change),
  // so this fails RED before the shim and can't false-pass on item selection.
  const from = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.88 };
  const to = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.7 };

  const base = await settledCapture('pan-00-base');
  await fingerDrag(page, from, to);
  const panned = await settledCapture('pan-01-panned');

  await fingerDrag(page, to, from); // drag back — translation is invertible
  const restored = await settledCapture('pan-02-restored');

  const dPan = await diffRatio(page, base, panned, box);
  const dBack = await diffRatio(page, base, restored, box);
  console.log(`[mobile pan] dPan=${dPan.toFixed(3)} dBack=${dBack.toFixed(3)}`);

  expect(dPan, 'one-finger drag visibly pans the view').toBeGreaterThan(0.006);
  expect(dBack, 'panning back returns near baseline').toBeLessThan(dPan / 3);
});

/** Count of visible menubar titles (0 ⇒ menubar hidden). */
async function visibleMenuTitles(pg: Page): Promise<number> {
  return pg.evaluate(
    () =>
      Array.from(document.querySelectorAll('.wx-menu-title')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      }).length,
  );
}

test('editor is canvas-only: no menubar, GL canvas fills the viewport', async () => {
  await shot('chrome');

  // The menubar is real DOM (.wx-menu-title per menu); AUI toolbars/panels are
  // canvas islands, so the GL-canvas-fills-viewport check below is what proves
  // THEY are gone (hidden AUI panes release their space to the center pane).
  expect(await visibleMenuTitles(page), 'no visible menubar titles').toBe(0);

  // the drawing canvas reclaims the whole viewport
  const box = await getGlBox(page);
  const vp = page.viewportSize()!;
  expect(box.width, 'GL canvas width ≈ viewport').toBeGreaterThan(vp.width * 0.95);
  expect(box.height, 'GL canvas height ≈ viewport').toBeGreaterThan(vp.height * 0.9);

  // the shell's own persistent overlays are gone too
  expect(await page.getByText(/console \(/).count(), 'console toggle hidden').toBe(0);
});

test('the floating toggle brings the full UI up and back off (Figma-like hide-UI)', async () => {
  // Canvas-only is the mobile DEFAULT, but the toggle must stay reachable —
  // inside the overlay menu (0010); the FAB is the persistent control.
  await openOverlayMenu(page);
  const toggle = page.locator('[data-testid="chrome-toggle"]');
  await expect(toggle, 'toggle button present in canvas-only mode').toBeVisible();

  await toggle.tap();
  await expect
    .poll(() => visibleMenuTitles(page), { timeout: 15000 })
    .toBeGreaterThan(0);
  // console footer follows the toggle (full shell UI back)
  await expect(page.getByText(/console \(/)).toHaveCount(1);
  // chrome takes real estate again (side toolbars + layers panel eat width)
  const shown = await getGlBox(page);
  const vp = page.viewportSize()!;
  expect(shown.width, 'chrome reclaims width').toBeLessThan(vp.width * 0.95);
  await shot('toggle-shown');

  // …and back to canvas-only, leaving the file in its baseline hidden state.
  await toggle.tap();
  await expect.poll(() => visibleMenuTitles(page), { timeout: 15000 }).toBe(0);
  await expect
    .poll(async () => (await getGlBox(page)).width, { timeout: 15000 })
    .toBeGreaterThan(vp.width * 0.95);
  expect(await page.getByText(/console \(/).count(), 'console toggle hidden again').toBe(0);
  await shot('toggle-rehidden');
});
