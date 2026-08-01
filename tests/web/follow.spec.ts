import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Follow-user e2e (collab-presence 0008): two tabs on the demo BOARD share
 * the doc room's awareness. Tab B clicks tab A's roster avatar → B's viewport
 * continuously mirrors A's published world rect (contain-fit); B's own canvas
 * input breaks the follow.
 *
 * Assertions use the deterministic viewport transforms
 * (`kicadCollabGetViewport` / `kicadCollabFitViewport`) — the fit math itself
 * is covered per-editor in tests/kicad; this spec covers the wire + controller
 * loop: publish (100 ms trailing) → awareness → follow apply → echo
 * suppression → break-on-interact.
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabGetViewport(): string;
  kicadCollabFitViewport(cx: number, cy: number, hw: number, hh: number): void;
};
type W = { Module: Mod };
type Vp = { cx: number; cy: number; scale: number; w: number; h: number };

async function bootBoard(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `${user}: editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
  await page.waitForFunction(
    () => {
      const m = (window as unknown as Partial<W>).Module;
      return (
        typeof m?.kicadCollabGetViewport === 'function' &&
        typeof m?.kicadCollabFitViewport === 'function'
      );
    },
    null,
    { timeout: 60000 },
  );
}

const viewport = (page: Page): Promise<Vp> =>
  page.evaluate(() =>
    JSON.parse((window as unknown as W).Module.kicadCollabGetViewport()),
  );

const fit = (page: Page, cx: number, cy: number, hw: number, hh: number) =>
  page.evaluate(
    (t) => (window as unknown as W).Module.kicadCollabFitViewport(t.cx, t.cy, t.hw, t.hh),
    { cx, cy, hw, hh },
  );

/** Center-convergence check: within 2 % of the target half-width. */
const near = (vp: Vp, cx: number, cy: number, tol: number) =>
  Math.abs(vp.cx - cx) < tol && Math.abs(vp.cy - cy) < tol;

test('B follows A: viewport mirrors, then local input breaks the follow', async ({
  page,
  context,
}) => {
  test.setTimeout(480000); // two full pcbnew wasm boots

  const a = page;
  await bootBoard(a, 'alice');
  const b = await context.newPage();
  await bootBoard(b, 'bob');

  // A frames a distinctive region (world IU; demo board is an A4 sheet).
  const T1 = { cx: 120e6, cy: 90e6, hw: 40e6, hh: 30e6 };
  await fit(a, T1.cx, T1.cy, T1.hw, T1.hh);
  await expect
    .poll(async () => near(await viewport(a), T1.cx, T1.cy, 1e6), {
      timeout: 20000,
      message: 'A never landed on its own fit target',
    })
    .toBe(true);

  // B sees alice in the roster (inside the overlay menu, 0010) and clicks
  // her avatar → follow.
  await openOverlayMenu(b);
  const avatar = b.locator('[data-presence-user="alice"]');
  await expect(avatar).toBeVisible({ timeout: 30000 });
  await avatar.click();
  await expect(b.getByTestId('follow-banner')).toBeVisible({ timeout: 10000 });

  // B's viewport converges on A's rect (publish 100 ms + awareness relay).
  // 90s, not 30s: on a starved CI box the first delivery can be lost while
  // both wasm instances hog the loop; awareness re-broadcasts state
  // periodically, so a longer condition-poll converges where a short one
  // recorded 4 flakes in 6 runs (2026-08-01) — all with clean traces (no
  // guard beacons, A demonstrably on target).
  await expect
    .poll(async () => near(await viewport(b), T1.cx, T1.cy, T1.hw * 0.02), {
      timeout: 90000,
      message: 'B never converged on the followed viewport',
    })
    .toBe(true);

  // A moves again → B tracks. Sequence on A actually LANDING first (same
  // pattern as T1): without it, any A-side fit delay on a starved CI box gets
  // misreported as "B never tracked" — the exact flake that ate three release
  // runs on 2026-08-01 (green 10/10 locally on the same build). B's window
  // starts only once A's rect demonstrably went out.
  const T2 = { cx: 180e6, cy: 120e6, hw: 25e6, hh: 20e6 };
  await fit(a, T2.cx, T2.cy, T2.hw, T2.hh);
  await expect
    .poll(async () => near(await viewport(a), T2.cx, T2.cy, 1e6), {
      timeout: 20000,
      message: 'A never landed on its second fit target',
    })
    .toBe(true);
  await expect
    .poll(async () => near(await viewport(b), T2.cx, T2.cy, T2.hw * 0.02), {
      timeout: 90000, // see the T1 convergence comment (awareness re-broadcast)
      message: 'B never tracked the second viewport move',
    })
    .toBe(true);

  // B interacts (real wheel zoom on the canvas) → the follow breaks.
  const canvasBox = await b.locator('#canvas').boundingBox();
  if (!canvasBox) throw new Error('no canvas box');
  await b.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await b.mouse.wheel(0, -240);
  await expect(b.getByTestId('follow-banner')).toBeHidden({ timeout: 15000 });

  // A moves once more; B (unfollowed) must NOT track it. A landing on its own
  // target is the synchronization point — by then A's rect went out and B
  // demonstrably ignored it (its center is still near T2, zoom aside).
  const T3 = { cx: 80e6, cy: 60e6, hw: 30e6, hh: 25e6 };
  await fit(a, T3.cx, T3.cy, T3.hw, T3.hh);
  await expect
    .poll(async () => near(await viewport(a), T3.cx, T3.cy, 1e6), { timeout: 20000 })
    .toBe(true);
  const bVp = await viewport(b);
  expect(near(bVp, T3.cx, T3.cy, T3.hw * 0.05), 'B tracked A after unfollow').toBe(false);
});
