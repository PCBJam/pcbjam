import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Seen/unread e2e (comments-ux 0001 C): alice comments → bob's FAB grows an
 * unread badge and the panel row an unread dot; opening the thread clears
 * them (event-driven mark-seen — popover open, own writes); a reply re-arms
 * alice's badge, and "mark all as seen" clears it without opening.
 */

const SCOPE = 'default';
const ROUTE = 'demo.kicad_sch';
const TITLE = /demo — Schematic Editor/i;

async function bootAs(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(TITLE);
  await openOverlayMenu(page);
  await expect(page.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30000 });
}

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

test('unread badges: create → badge for the peer only → open clears → reply re-arms → mark-all', async ({
  page,
  context,
}) => {
  test.setTimeout(360000); // two full tool boots

  await bootAs(page, 'alice');
  await deleteAllThreads(page);
  const pageB = await context.newPage();
  await bootAs(pageB, 'bob');

  // alice creates via comment mode (own write = auto-seen for alice).
  await page.getByTestId('comment-mode-toggle').click();
  await page.getByTestId('comment-click-catcher').click({ position: { x: 400, y: 250 } });
  await page.getByTestId('comment-composer').locator('textarea').fill('unseen by bob');
  await page.getByTestId('comment-submit').click();
  await expect(page.getByTestId('comment-popover')).toBeVisible();

  // bob: FAB unread badge + menu-row badge + panel unread dot. alice: none.
  await expect(pageB.getByTestId('overlay-menu-unread-badge')).toHaveText('1', {
    timeout: 20000,
  });
  await expect(page.getByTestId('overlay-menu-unread-badge')).toHaveCount(0);

  await openOverlayMenu(pageB);
  await expect(pageB.getByTestId('comment-unread-badge')).toHaveText('1');
  await pageB.getByTestId('comment-panel-toggle').click();
  await expect(pageB.getByTestId('comment-unread-dot')).toHaveCount(1);

  // Opening the thread marks it seen — badges and dot clear, GAL pins get
  // unread=false (asserted indirectly: the DOM state is the driver).
  await pageB.getByTestId('comment-pin').click();
  await expect(pageB.getByTestId('comment-popover')).toBeVisible();
  await expect(pageB.getByTestId('overlay-menu-unread-badge')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(pageB.getByTestId('comment-unread-dot')).toHaveCount(0);

  // bob replies from his open popover → alice (popover closed first) unreads.
  await page.getByTestId('comment-popover').getByTitle('Close').click();
  await pageB.getByTestId('comment-reply').fill('now you have mail');
  await pageB.getByTestId('comment-reply').press('Enter');
  await expect(page.getByTestId('overlay-menu-unread-badge')).toHaveText('1', {
    timeout: 20000,
  });

  // "Mark all as seen" from alice's panel header clears without opening.
  await openOverlayMenu(page);
  await page.getByTestId('comment-panel-toggle').click();
  await page.getByTestId('comments-mark-all-seen').click();
  await expect(page.getByTestId('overlay-menu-unread-badge')).toHaveCount(0, {
    timeout: 20000,
  });

  await pageB.close();
});
