import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';

/** Diagnostic companion of presence-ghost-peer.spec.ts: records bob's inbound
 *  awareness entries (clientId/clock) after alice's socket is cut, so we can
 *  tell "alice keeps getting re-published" from "bob never times her out". */

const SCOPE = 'default';
const ROUTE = 'demo.kicad_wks';
const TITLE = /demo — Drawing Sheet Editor/i;

const HOOK = `
  (() => {
    const Orig = window.WebSocket;
    const list = [];
    window.__wsList = list;
    window.__cutAll = false;
    window.__awLog = [];
    const rv = (b, p) => { let r = 0, m = 1; for (;;) { const x = b[p++]; r += (x & 127) * m; if (x < 128) return [r, p]; m *= 128; } };
    const decode = (u8) => {
      try {
        let p = 0, v;
        [v, p] = rv(u8, p); const ch = v;
        [v, p] = rv(u8, p); const type = v;
        if (type !== 1) return { ch, type };
        [v, p] = rv(u8, p);
        [v, p] = rv(u8, p); const n = v;
        const ents = [];
        for (let i = 0; i < n; i++) {
          let cid, clk, len;
          [cid, p] = rv(u8, p); [clk, p] = rv(u8, p); [len, p] = rv(u8, p);
          const s = new TextDecoder().decode(u8.subarray(p, p + len)); p += len;
          let user = null; try { user = JSON.parse(s)?.user?.id ?? (s === 'null' ? 'REMOVED' : '?'); } catch {}
          ents.push({ cid, clk, user });
        }
        return { ch, type, ents };
      } catch (e) { return { err: String(e) }; }
    };
    window.WebSocket = new Proxy(Orig, {
      construct(target, args) {
        const ws = new target(...args);
        list.push({ ws, url: String(args[0]), t: Date.now() });
        ws.addEventListener('message', async (ev) => {
          let d = ev.data;
          if (d instanceof Blob) d = await d.arrayBuffer();
          if (d instanceof ArrayBuffer) window.__awLog.push({ t: Date.now(), ...decode(new Uint8Array(d)) });
        });
        if (window.__cutAll) { ws.send = () => {}; setTimeout(() => ws.close(), 0); }
        return ws;
      },
    });
    window.__wsCut = (close) => {
      window.__cutAll = true;
      let n = 0;
      for (const { ws } of list) {
        if (ws.readyState !== 1) continue;
        ws.send = () => {}; n++;
        if (close) ws.close();
      }
      return n;
    };
  })();
`;

async function bootAs(context: BrowserContext, user: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(HOOK);
  await page.goto(`/${SCOPE}/projects/demo/${ROUTE}?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect.poll(() => page.title(), { timeout: 120000, intervals: [1000] }).toMatch(TITLE);
  return page;
}

test.skip(!process.env.PRESENCE_DIAG, 'diagnostic only — PRESENCE_DIAG=1 to run');
for (const close of [true, false]) test(`diag: what bob receives after alice ${close ? 'closes uncleanly' : 'goes half-open'}`, async ({ browser }) => {
  test.setTimeout(400000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const alice = await bootAs(ctxA, 'alice');
  const bob = await bootAs(ctxB, 'bob');
  await openOverlayMenu(bob);
  await expect(bob.locator('[data-presence-user="alice"]')).toBeVisible({ timeout: 30000 });

  const tCut = Date.now();
  const n = await alice.evaluate((c) => (window as any).__wsCut(c), close);
  console.log(`[diag] cut ${n} alice sockets at ${tCut}`);

  const before = await bob.evaluate((since) => (window as any).__awLog.filter((e: any) => e.type === 1 && e.t < since).flatMap((e: any) => e.ents.map((x: any) => `${new Date(e.t).toISOString().slice(14, 19)} ch${e.ch} cid=${x.cid} clk=${x.clk} ${x.user}`)), tCut);
  console.log(`[diag] bob inbound awareness BEFORE cut (last 12):\n  ${before.slice(-12).join('\n  ')}`);
  for (let i = 1; i <= 4; i++) {
    await bob.waitForTimeout(10000); // eslint-disable-line -- documented sampling dwell: diag probe cadence inside an explicit loop
    const present = await bob.locator('[data-presence-user="alice"]').count();
    const aliceWs = await alice.evaluate(() => (window as any).__wsList.map((w: any) => ({ url: w.url.slice(0, 60), state: w.ws.readyState, t: w.t })));
    const log = await bob.evaluate((since) => (window as any).__awLog.filter((e: any) => e.t >= since), tCut);
    const aw = log.filter((e: any) => e.type === 1).flatMap((e: any) => e.ents.map((x: any) => `${new Date(e.t).toISOString().slice(14, 19)} ch${e.ch} cid=${x.cid} clk=${x.clk} ${x.user}`));
    console.log(`[diag] +${i * 10}s alice-in-roster=${present} aliceSockets=${JSON.stringify(aliceWs)} bobInboundAwareness(since cut)=\n  ${aw.join('\n  ')}`);
  }
  await ctxA.close();
  await ctxB.close();
});
