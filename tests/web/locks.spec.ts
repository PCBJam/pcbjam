import { test, expect, type Page } from '@playwright/test';

/**
 * Selection soft-locks e2e (collab-presence 0007): two tabs of the real app
 * on the SAME board share the per-file room — one tab's live selection must
 * soft-lock those items for the other, and an overlapping hold (both grab the
 * same item inside the propagation window — simulated with the programmatic
 * select, which bypasses the acquisition veto exactly like a real race)
 * resolves by the deterministic (user.id, clientID) tiebreak: alice keeps,
 * bob's client releases.
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabGetSelection(): Promise<string>;
  kicadCollabTestGetLocked(): Promise<string>;
  kicadCollabTestSelectComponent(): Promise<string>;
  kicadCollabTestSelectByUuid(uuid: string): Promise<boolean>;
  kicadCollabTestClearSelection(): Promise<boolean>;
};
type W = { Module: Mod };

async function bootBoard(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), {
      message: `${user}: board editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
  await page.waitForFunction(
    () =>
      typeof (window as unknown as Partial<W>).Module?.kicadCollabTestGetLocked ===
      'function',
    null,
    { timeout: 60000 },
  );
}

const selection = (page: Page) =>
  page.evaluate(async () =>
    JSON.parse(await (window as unknown as W).Module.kicadCollabGetSelection()),
  );
const locked = (page: Page) =>
  page.evaluate(async () =>
    JSON.parse(await (window as unknown as W).Module.kicadCollabTestGetLocked()),
  );

test('a peer selection locks the item; overlapping holds tiebreak deterministically', async ({
  page,
  context,
}) => {
  test.setTimeout(480000); // two full board boots

  const alice = page;
  await bootBoard(alice, 'alice');
  const bob = await context.newPage();
  await bootBoard(bob, 'bob');

  // ── lock propagation ───────────────────────────────────────────────────────
  const fpId = await alice.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectComponent(),
  );
  expect(fpId, 'demo board should contain a footprint').toBeTruthy();

  await expect
    .poll(() => locked(bob), {
      timeout: 20000,
      message: "bob never saw alice's selection as a lock",
    })
    .toEqual([{ uuid: fpId, name: 'alice' }]);
  // The holder's own tab is NOT locked against itself.
  await expect.poll(() => locked(alice), { timeout: 20000 }).toEqual([]);

  // ── overlapping hold → tiebreak ────────────────────────────────────────────
  // bob grabs the SAME footprint programmatically (the race-window simulation:
  // AddItemToSel bypasses the acquisition veto, like two grabs inside the
  // awareness propagation window). By uuid — bob's ysync-materialized board
  // need not iterate footprints in alice's parse order, so "the first
  // footprint" is not a cross-tab invariant.
  const bobPick = await bob.evaluate(
    (uuid) => (window as unknown as W).Module.kicadCollabTestSelectByUuid(uuid),
    fpId,
  );
  expect(bobPick, "bob must resolve alice's footprint by uuid").toBe(true);

  // alice ("alice" < "bob") keeps it; bob's client releases it.
  await expect
    .poll(() => selection(bob), {
      timeout: 20000,
      message: "bob's losing hold was never released",
    })
    .toEqual([]);
  expect(await selection(alice)).toContain(fpId);

  // ── unlock on clear ────────────────────────────────────────────────────────
  await alice.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestClearSelection(),
  );
  await expect.poll(() => locked(bob), { timeout: 20000 }).toEqual([]);

  // Now bob's grab sticks, and it locks the item for alice (same uuid — the
  // assertions below compare against fpId).
  await bob.evaluate(
    (uuid) => (window as unknown as W).Module.kicadCollabTestSelectByUuid(uuid),
    fpId,
  );
  await expect
    .poll(() => selection(bob), { timeout: 20000 })
    .toContain(fpId);
  await expect
    .poll(() => locked(alice), { timeout: 20000 })
    .toEqual([{ uuid: fpId, name: 'bob' }]);
});
