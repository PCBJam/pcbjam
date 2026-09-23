import { test, expect, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * Project comments document e2e (git-integration 0001, design-comments §5 +
 * §6.1): threads live in ONE per-project room (`~comments`) that every
 * session of the project opens beside its file room. Two tabs on the same
 * schematic see one thread set through that room; a thread whose anchor item
 * is gone from the document is DETACHED — off the canvas and out of the main
 * list, filed under "Not on this revision", drawn only behind the "show
 * detached pins" toggle.
 *
 * BroadcastChannel transport (the reference backend); the controller's test
 * handle (`__pcbjamComments`) creates threads deterministically — the UI
 * placement path is covered by comments.spec.ts.
 */

const SCOPE = 'default';
const ROUTE = 'demo.kicad_sch';
const TITLE = /demo — Schematic Editor/i;

type Handle = {
  threads(): Array<{ id: string; state: 'anchored' | 'detached'; detached: boolean; messages: Array<{ body: string }> }>;
  deleteThread(id: string): void;
  create(anchor: { itemUuid?: string; pos: { x: number; y: number } }, body: string): string;
  document(): { filePath: string } | undefined;
};

async function bootAs(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(TITLE);
  await openOverlayMenu(page);
  await expect(page.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30000 });
}

async function resetComments(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctl = (window as unknown as { __pcbjamComments?: Handle }).__pcbjamComments;
    ctl?.threads().forEach((t) => ctl.deleteThread(t.id));
  });
  await expect(page.getByTestId('comment-pin')).toHaveCount(0);
}

const create = (page: Page, anchor: { itemUuid?: string; pos: { x: number; y: number } }, body: string) =>
  page.evaluate(
    ([a, b]) => (window as unknown as { __pcbjamComments: Handle }).__pcbjamComments.create(a as never, b as string),
    [anchor, body] as const,
  );

const threads = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __pcbjamComments: Handle }).__pcbjamComments
      .threads()
      .map((t) => ({ state: t.state, body: t.messages[0]?.body })),
  );

test('threads ride the project comments document; detached ones leave the canvas', async ({
  page,
  context,
}) => {
  test.setTimeout(360000); // two full tool boots

  await bootAs(page, 'alice');
  await resetComments(page);
  // The controller is bound to the project document, filtered by this file.
  expect(
    await page.evaluate(
      () => (window as unknown as { __pcbjamComments: Handle }).__pcbjamComments.document(),
    ),
  ).toEqual({ filePath: ROUTE });

  // ── anchored thread, visible in a second tab through the project room ──
  await create(page, { pos: { x: 250000, y: 250000 } }, 'shared note');
  await expect(page.getByTestId('comment-pin')).toHaveCount(1);

  const pageB = await context.newPage();
  await bootAs(pageB, 'bob');
  await expect(pageB.getByTestId('comment-pin')).toHaveCount(1, { timeout: 30000 });
  await expect.poll(() => threads(pageB)).toEqual([{ state: 'anchored', body: 'shared note' }]);

  // ── detached thread: its anchor item does not exist in this document ──
  await create(page, { itemUuid: '00000000-dead-4000-8000-000000000000', pos: { x: 500000, y: 250000 } }, 'orphan');
  await expect.poll(() => threads(page)).toEqual([
    { state: 'anchored', body: 'shared note' },
    { state: 'detached', body: 'orphan' },
  ]);
  // Off the canvas by default (C-N4) — in both tabs.
  await expect(page.getByTestId('comment-pin')).toHaveCount(1);
  await expect.poll(() => threads(pageB)).toHaveLength(2);
  await expect(pageB.getByTestId('comment-pin')).toHaveCount(1);

  // The panel: main list holds the anchored thread only; the detached one is
  // filed under "Not on this revision", collapsed by default.
  await openOverlayMenu(page);
  await page.getByTestId('comment-panel-toggle').click();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
  await expect(page.getByTestId('comment-panel-item')).toHaveCount(1);
  await expect(page.getByTestId('comment-panel-item')).toContainText('shared note');
  const section = page.getByTestId('comments-detached-section');
  await expect(section).toContainText('Not on this revision (1)');
  await expect(page.getByTestId('comment-panel-detached-item')).toHaveCount(0);
  await page.getByTestId('comments-detached-summary').click();
  await expect(page.getByTestId('comment-panel-detached-item')).toHaveCount(1);
  await expect(page.getByTestId('comment-panel-detached-item')).toContainText('orphan');

  // "show detached pins" draws it at the stored position; off again hides it.
  const toggle = page.getByTestId('comments-detached-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByTestId('comment-pin')).toHaveCount(2);
  await toggle.uncheck();
  await expect(page.getByTestId('comment-pin')).toHaveCount(1);

  // Cleanup so the next spec starts clean (comments persist in the room).
  await resetComments(page);
  await expect.poll(() => threads(pageB)).toEqual([]);
});
