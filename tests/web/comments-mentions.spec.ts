import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * @-mention e2e (comments-ux 0001 E): with alice and bob live in the same
 * room, alice types `@b` in the composer → the combobox offers bob (the
 * presence-roster fallback covers backends without a members model),
 * keyboard-accepts → `@bob ` lands in the body, the sent message renders a
 * mention chip, and bob's unread badge takes the mention accent.
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

test('mentions: autocomplete from the live roster, chip render, mention-accent badge', async ({
  page,
  context,
}) => {
  test.setTimeout(360000); // two full tool boots

  await bootAs(page, 'alice');
  await deleteAllThreads(page);
  const pageB = await context.newPage();
  await bootAs(pageB, 'bob');

  // Both present: alice's roster knows bob (fallback mention source).
  await expect(page.getByTestId('overlay-menu-badge')).toHaveText('1', { timeout: 30000 });

  await page.getByTestId('comment-mode-toggle').click();
  await page.getByTestId('comment-click-catcher').click({ position: { x: 400, y: 250 } });
  const textarea = page.getByTestId('comment-composer').locator('textarea');
  await textarea.fill('please check this ');
  await textarea.press('End');
  await textarea.pressSequentially('@b');

  const combobox = page.getByTestId('mention-combobox');
  await expect(combobox).toBeVisible();
  await expect(combobox.locator('[data-slug="bob"]')).toBeVisible();
  await textarea.press('Enter'); // accept the selected completion
  await expect(textarea).toHaveValue('please check this @bob ');
  await expect(combobox).toHaveCount(0);

  await page.getByTestId('comment-submit').click();

  // The sent message renders the mention as a chip.
  await expect(page.getByTestId('comment-popover')).toBeVisible();
  await expect(page.getByTestId('comment-mention')).toHaveText('@bob');

  // bob's unread badge wears the mention accent (rose, not amber).
  const badgeB = pageB.getByTestId('overlay-menu-unread-badge');
  await expect(badgeB).toHaveText('1', { timeout: 20000 });
  await expect(badgeB).toHaveClass(/bg-rose-500/);
  // …and on bob's side the message chip carries his slug + amber self accent.
  await pageB.getByTestId('comment-pin').click();
  await expect(pageB.getByTestId('comment-mention')).toHaveClass(/text-amber-300/);

  await pageB.close();
});
