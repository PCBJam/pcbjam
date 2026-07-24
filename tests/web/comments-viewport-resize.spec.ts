import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Comment pins vs. canvas resize (collab-presence 0005 regression): the DOM
 * hit targets map world→CSS through the viewport transform pushed from C++
 * ({cx,cy,scale,w,h} → worldToScreen maps through w/2,h/2). The push used to
 * dedupe on scale+center only, so a canvas RESIZE (window resize, boot layout
 * settling after the bind-time seed) left a stale w/h in React and every pin
 * target sat vertically offset from its GAL dot — by exactly Δh/2 css-px —
 * until the next pan/zoom. Now wxEVT_SIZE re-pushes and size participates in
 * the dedupe, so pins must re-align after a resize with no pan/zoom at all.
 *
 * "GAL truth" is computed from a FRESH kicadCollabGetViewport() read + the
 * live glcanvas rect — the same mapping the GAL dot itself renders through.
 */

const SCOPE = 'default';
const ROUTE = 'demo.kicad_sch';
const TITLE = /demo — Schematic Editor/i;

async function bootAs(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `${user}: editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(TITLE);
  // The comment controls live in the overlay menu's "Comments" section and are
  // visible as soon as it opens — the nested expand toggle (comment-bar-toggle)
  // is gone, since the section itself is the group.
  await openOverlayMenu(page); // the comment controls live in the overlay menu (0010)
  await expect(page.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30000 });
}

/** Comments persist in the room's ydoc — start each run from a clean slate. */
async function deleteAllThreads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctl = (window as unknown as {
      __pcbjamComments?: {
        threads(): Array<{ id: string }>;
        deleteThread(id: string): void;
      };
    }).__pcbjamComments;
    ctl?.threads().forEach((t) => ctl.deleteThread(t.id));
  });
  await expect(page.getByTestId('comment-pin')).toHaveCount(0);
}

/** First pin's DOM center minus its GAL-truth CSS position (fresh transform). */
async function pinDelta(page: Page): Promise<{ dx: number; dy: number }> {
  return page.evaluate(() => {
    const win = window as unknown as {
      Module: { kicadCollabGetViewport(): string };
      __pcbjamComments: { threads(): Array<{ world: { x: number; y: number } }> };
    };
    const vp = JSON.parse(win.Module.kicadCollabGetViewport()) as {
      cx: number; cy: number; scale: number; w: number; h: number;
    };
    const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
    }) as HTMLElement;
    const r = gl.getBoundingClientRect();
    const ratio = r.width / vp.w;
    const world = win.__pcbjamComments.threads()[0].world;
    // Bubble-pin geometry (comments-ux 0001 A): the DOM target centers on the
    // bubble BODY at anchor + (r, -r) — the anchored point is the bubble's
    // sharp bottom-left corner. Keep in sync with standalone
    // src/wasm/collab/pin-geometry.ts (PIN_RADIUS_PX).
    const bubbleR = 9 * ratio;
    const truthX = r.x + ((world.x - vp.cx) * vp.scale + vp.w / 2) * ratio + bubbleR;
    const truthY = r.y + ((world.y - vp.cy) * vp.scale + vp.h / 2) * ratio - bubbleR;
    const pin = document.querySelector('[data-testid="comment-pin"]') as HTMLElement;
    const pr = pin.getBoundingClientRect();
    return { dx: pr.x + pr.width / 2 - truthX, dy: pr.y + pr.height / 2 - truthY };
  });
}

test('comment pin targets track the GAL dots across a canvas resize', async ({ page }) => {
  test.setTimeout(300000); // one full tool boot

  await bootAs(page, 'alice');
  await deleteAllThreads(page);

  // Place a comment mid-canvas via comment mode.
  await page.getByTestId('comment-mode-toggle').click();
  const catcher = page.getByTestId('comment-click-catcher');
  await expect(catcher).toBeVisible();
  const box = (await catcher.boundingBox())!;
  await catcher.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.getByTestId('comment-composer').locator('textarea').fill('resize pin');
  await page.getByTestId('comment-submit').click();
  await expect(page.getByTestId('comment-pin')).toHaveCount(1);

  // Aligned at the boot size (the composer click and the pin share the same
  // transform, so this mostly guards the harness itself).
  await expect
    .poll(async () => Math.abs((await pinDelta(page)).dy), {
      message: 'pin never aligned with GAL truth at the boot size',
      timeout: 15000,
    })
    .toBeLessThan(3);

  // Shrink the window: the canvas height changes while scale/center stay put.
  // The wxEVT_SIZE re-push must realign the DOM target with the GAL dot —
  // before the fix it stayed exactly Δh/2 css-px below until a pan/zoom.
  await page.setViewportSize({ width: 1280, height: 620 });
  await expect
    .poll(async () => Math.abs((await pinDelta(page)).dy), {
      message: 'pin target did not re-align after the canvas resize (stale viewport w/h?)',
      timeout: 15000,
    })
    .toBeLessThan(3);
  expect(Math.abs((await pinDelta(page)).dx)).toBeLessThan(3);
});
