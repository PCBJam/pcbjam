import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Emoji reactions e2e (comments-ux 0001 D): quick-row toggle on/off, two
 * users reacting with the same emoji both counted (flat own-key writes — no
 * LWW clobber), and the lazy full picker mounting on demand.
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

test('reactions: quick-row toggle, concurrent same-emoji, lazy full picker', async ({
  page,
  context,
}) => {
  test.setTimeout(360000); // two full tool boots

  await bootAs(page, 'alice');
  await deleteAllThreads(page);
  const pageB = await context.newPage();
  await bootAs(pageB, 'bob');

  // alice creates and keeps the popover open.
  await page.getByTestId('comment-mode-toggle').click();
  await page.getByTestId('comment-click-catcher').click({ position: { x: 400, y: 250 } });
  await page.getByTestId('comment-composer').locator('textarea').fill('react to me');
  await page.getByTestId('comment-submit').click();
  await expect(page.getByTestId('comment-popover')).toBeVisible();

  // alice: 👍 via the quick row ("add reaction" shows on message hover).
  await page.getByTestId('comment-message').hover();
  await page.getByTestId('comment-react').click();
  await page.getByTestId('comment-quick-react').locator('[data-emoji="👍"]').click();
  const chip = page.getByTestId('comment-reaction-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('1');

  // bob opens the same thread and clicks the existing chip → count 2 in BOTH.
  await expect(pageB.getByTestId('comment-pin')).toHaveCount(1, { timeout: 20000 });
  await pageB.getByTestId('comment-pin').click();
  const chipB = pageB.getByTestId('comment-reaction-chip');
  await expect(chipB).toContainText('1', { timeout: 20000 });
  await chipB.click();
  await expect(chipB).toContainText('2', { timeout: 20000 });
  await expect(chip).toContainText('2', { timeout: 20000 });

  // Toggle off (bob) → back to 1 everywhere.
  await chipB.click();
  await expect(chip).toContainText('1', { timeout: 20000 });

  // Full picker: quick row's "+" mounts the lazy emoji-mart chunk.
  await page.getByTestId('comment-message').hover();
  await page.getByTestId('comment-react').click();
  await page.getByTestId('comment-react-more').click();
  await expect(page.getByTestId('emoji-picker')).toBeVisible();
  await expect(page.locator('em-emoji-picker')).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('emoji-picker')).toHaveCount(0);

  await pageB.close();
});
