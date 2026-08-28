import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/**
 * REPRO (findings: "when user A disconnects, user B still sees them minutes
 * later"). Two users (separate browser contexts) on demo.kicad_wks over the
 * real sync stack (VITE_YJS_PROVIDER=partykit → apps/sync gateway). alice's
 * websocket is then broken in two ways and bob's roster is timed:
 *
 *  - HALF-OPEN: alice's outbound frames are dropped but the socket stays up
 *    (laptop sleep / wifi drop before TCP notices). The gateway sees no close
 *    → no tombstone; bob is left with the 30s y-protocols awareness timeout.
 *  - UNCLEAN CLOSE: outbound dropped, then the socket is closed (no null-state
 *    broadcast reaches the server). Locally (wrangler, no hibernation) the
 *    gateway's in-memory clientID table tombstones alice; on a hibernated DO
 *    that table is gone (see gateway-hub-tombstone-hibernation.test.ts) and
 *    this degenerates into the half-open case.
 *
 * Requires the partykit/gateway stack (apps/sync :3055) — skipped on the BC
 * provider, where there is no server to lose the departure.
 *
 * MEASURED 2026-08-28 (local wrangler, serial): half-open → 30s (y-protocols
 * awareness timeout, the only fallback); unclean close → tombstone within
 * ~10ms, roster clears immediately. The "minutes" ghost was NOT reproduced
 * locally; see docs/features/findings/groups/Y-multiplayer-presence.md.
 */

// Both tests use the SAME demo project and the same user slugs, so they must
// never overlap: a parallel worker's alice keeps this worker's roster alive
// (that is exactly how the first run of this spec "reproduced" a 180s ghost).
test.describe.configure({ mode: 'serial' });

const SCOPE = 'default';
const ROUTE = 'demo.kicad_wks';
const TITLE = /demo — Drawing Sheet Editor/i;

const WS_HOOK = `
  (() => {
    const Orig = window.WebSocket;
    const list = [];
    window.__wsList = list;
    window.__cutAll = false;
    window.WebSocket = new Proxy(Orig, {
      construct(target, args) {
        const ws = new target(...args);
        list.push({ ws, url: String(args[0]), t: Date.now() });
        // Once cut, the "network" stays down: any reconnect attempt dies too.
        if (window.__cutAll) { ws.send = () => {}; setTimeout(() => ws.close(), 0); }
        return ws;
      },
    });
    window.__wsCut = (close) => {
      window.__cutAll = true;
      let n = 0;
      for (const { ws } of list) {
        if (ws.readyState !== 1) continue;
        ws.send = () => {};
        n++;
        if (close) ws.close();
      }
      return n;
    };
    window.__wsReport = () => list.map((w) => ({ url: w.url.slice(0, 50), state: w.ws.readyState, t: w.t }));
  })();
`;

async function bootAs(context: BrowserContext, user: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(WS_HOOK);
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(TITLE);
  return page;
}

async function timeUntilGone(page: Page, user: string, budgetMs: number): Promise<number> {
  const t0 = Date.now();
  await expect(page.locator(`[data-presence-user="${user}"]`)).toHaveCount(0, {
    timeout: budgetMs,
  });
  return Date.now() - t0;
}

for (const mode of ['half-open', 'unclean-close'] as const) {
  test(`alice ${mode}: bob's roster drops alice promptly`, async ({ browser }) => {
    test.setTimeout(420000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const alice = await bootAs(ctxA, 'alice');
    // Gate BEFORE the roster assertion: on the BroadcastChannel provider (CI's
    // standalone preview has no apps/sync) two browser CONTEXTS never see each
    // other, so bob would wait 30s for an alice that cannot arrive.
    const liveWs = await alice.evaluate(
      () => (window as unknown as { __wsList: Array<{ ws: WebSocket; url: string }> }).__wsList.filter((w) => w.ws.readyState === 1 && /\/parties\//.test(w.url)).length,
    );
    test.skip(liveWs === 0, 'no live websocket on alice — BC stack (no apps/sync), nothing to lose');
    const bob = await bootAs(ctxB, 'bob');
    await openOverlayMenu(bob);
    await expect(bob.locator('[data-presence-user="alice"]')).toBeVisible({ timeout: 30000 });

    const wsCount = await alice.evaluate(
      (close) => (window as unknown as { __wsCut(c: boolean): number }).__wsCut(close),
      mode === 'unclean-close',
    );
    test.skip(wsCount === 0, 'no live websocket on alice — BC stack?');

    const t0 = Date.now();
    const seen: string[] = [];
    let ms = -1;
    while (Date.now() - t0 < 180000) {
      const present = await bob.locator('[data-presence-user="alice"]').count();
      seen.push(`+${Math.round((Date.now() - t0) / 1000)}s:${present}`);
      if (present === 0) { ms = Date.now() - t0; break; }
      await bob.waitForTimeout(5000); // eslint-disable-line -- documented sampling dwell: presence-eviction probe cadence inside an explicit bounded loop
    }
    const sockets = await alice.evaluate(() => (window as unknown as { __wsReport(): unknown }).__wsReport());
    // eslint-disable-next-line no-console
    console.log(`[ghost-peer] ${mode}: roster timeline ${seen.join(' ')} | alice sockets ${JSON.stringify(sockets)}`);
    if (ms < 0) ms = Date.now() - t0;
    test.info().annotations.push({ type: 'ghost-ms', description: `${mode}: ${ms}ms` });
    // eslint-disable-next-line no-console
    console.log(`[ghost-peer] ${mode}: bob dropped alice after ${ms}ms (ws cut: ${wsCount})`);
    // "promptly" = inside the awareness timeout with slack; the roster spec
    // budgets 20s for a clean leave.
    expect(ms, `${mode}: alice lingered on bob's roster for ${ms}ms`).toBeLessThan(45000);
    await ctxA.close();
    await ctxB.close();
  });
}
