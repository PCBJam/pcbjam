import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * ysync 0012 integrity regressions, browser tier (docs/features/ysync/0013,
 * from the 2026-09-11 e2e audit): the six 09-08 findings exercised through the
 * REAL KiCad WASM, the production connect → materialize → attach pair
 * (collab/browser-entry-integrity.ts mirrors WasmTool's ydoc load path) and
 * the real BroadcastChannel provider. Every case asserts the desired
 * invariant and was red on the pre-0012 tree (audit-26-09-11.md); the load
 * race pair is proven sensitive to #1's fix (0013 §3.1).
 *
 * Do not add test.fail(): setup/boot errors must never count as a
 * reproduction.
 */
const FP = '66666666-0000-0000-0000-000000000001';
const CHILD = '66666666-0000-0000-0000-0000000000cc';
const PCB = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (25 "Edge.Cuts" user))
  (setup) (net 0 "")
  (footprint "TestLib:R" (layer "F.Cu") (uuid "${FP}") (at 100 100) (attr smd)
    (property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "${CHILD}") (effects (font (size 1 1) (thickness 0.15))))))`;

test.beforeAll(() => execFileSync(process.execPath, ['collab/build-integrity.mjs'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' }));

async function boot(page: Page, html = 'pcbnew-collab.html') {
  await page.goto(`/kicad/${html}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    return w.Module?.kicadCollabSnapshotItems &&
      w.wxElementRegistry?.findAll({ visible: true }).some((e: any) => /Frame$/.test(e.typeName));
  }, null, { timeout: 120_000 });
  await page.addScriptTag({ path: path.resolve(__dirname, '../apps/kicad/collab-integrity.js') });
}

async function open(page: Page, text = PCB, ext = 'kicad_pcb') {
  const name = `integrity-${Date.now()}`;
  await page.evaluate(({ text, name, ext }) => {
    const w = window as any;
    w.FS.mkdirTree('/home/kicad/documents');
    const file = `/home/kicad/documents/${name}.${ext}`;
    w.FS.writeFile(file, text);
    w.Module.kicadOpenFile(file);
  }, { text, name, ext });
  await expect.poll(() => page.title(), { timeout: 30_000 }).toContain(name);
  await idle(page);
}

async function idle(page: Page) {
  await page.waitForFunction(() => !(window as any).Module.kicadCollabBusy(), null, { timeout: 15_000 });
}
const render = (page: Page): Promise<string> => page.evaluate(() => (window as any).integrity.render());
const model = (page: Page): Promise<string> => page.evaluate(() => (window as any).integrity.model());
const connect = (page: Page, room: string) => page.evaluate(r => (window as any).integrity.connect(r), room);
const attach = (page: Page, seed?: string, matches = false) => page.evaluate(({ seed, matches }) => (window as any).integrity.attach(seed, matches), { seed, matches });
const changeValue = (page: Page, value: string) => page.evaluate(({ id, value }) => (window as any).Module.kicadCollabTestSetFootprintField(id, 'Value', value), { id: FP, value });
const remove = (page: Page) => page.evaluate(id => (window as any).Module.kicadCollabTestRemoveItem(id), FP);
const undo = (page: Page) => page.evaluate(() => (window as any).Module.kicadCollabTestUndo());

async function pair(a: Page, b: Page) {
  const room = `integrity-${Date.now()}-${Math.random()}`;
  await boot(a); await open(a); await connect(a, room); await attach(a, PCB);
  await boot(b); await connect(b, room); await open(b, await render(b)); await attach(b, undefined, true);
  await idle(a); await idle(b);
}

test('ysync 0012 control: a native edit crosses tabs and a fresh Yjs materialization', async ({ page, context }) => {
  const peer = await context.newPage();
  await pair(page, peer);
  await changeValue(peer, 'control-remote');
  await expect.poll(() => render(page)).toContain('control-remote');
  await expect.poll(() => model(page)).toContain('control-remote');
  expect(await render(peer)).toContain('control-remote');
});

for (const operation of ['edit', 'delete'] as const) {
  test(`ysync 0012 #1: a peer ${operation} after materialization survives native open and attach`, async ({ page, context }, info) => {
    const peer = await context.newPage();
    const room = `load-${operation}-${Date.now()}`;
    await boot(peer); await open(peer); await connect(peer, room); await attach(peer, PCB);
    await boot(page); await connect(page, room);
    const cached = await render(page); // Same boundary as maybeConnectDocSession.
    if (operation === 'edit') await changeValue(peer, 'received-during-open');
    else await remove(peer);
    await expect.poll(async () => operation === 'edit'
      ? (await render(page)).includes('received-during-open')
      : !(await render(page)).includes(FP)).toBe(true);
    const before = await render(page);
    await open(page, cached); // Real native parser, stale immutable load bytes.
    await attach(page, undefined, true);
    await idle(page);
    const after = await render(page);
    await info.attach('load-boundary.json', { body: JSON.stringify({ cached, before, after, native: await model(page) }, null, 2), contentType: 'application/json' });
    if (operation === 'edit') expect(after).toContain('received-during-open');
    else expect(after).not.toContain(FP);
  });
}

test('ysync 0012 #2: a local move preserves a remote value and both native models converge', async ({ page, context }, info) => {
  const peer = await context.newPage();
  await pair(page, peer);
  // Delay delivery of a REAL C++-serialized local flush, and entry to the REAL
  // C++ apply. This exposes the ordering permitted by runOnCoroutine's void
  // enqueue contract without depending on CPU speed or replacing the editor.
  await page.evaluate(() => {
    const w = window as any;
    const emit = w.kicadCollab.onItems;
    const apply = w.Module.kicadCollabApplyItems;
    w.integrity.heldLocal = [];
    w.integrity.heldRemote = [];
    w.kicadCollab.onItems = (json: string) => w.integrity.heldLocal.push(json);
    w.Module.kicadCollabApplyItems = (json: string) => w.integrity.heldRemote.push(json);
    w.integrity.release = () => {
      w.kicadCollab.onItems = emit;
      w.Module.kicadCollabApplyItems = apply;
      for (const json of w.integrity.heldLocal) emit(json);
      for (const json of w.integrity.heldRemote) apply(json);
    };
  });
  await page.evaluate(id => (window as any).Module.kicadCollabTestMoveBoardItem(id, 1_000_000, 0), FP);
  await page.waitForFunction(() => (window as any).integrity.heldLocal.length > 0);
  await changeValue(peer, 'concurrent-remote');
  await expect.poll(() => render(page)).toContain('concurrent-remote');
  await page.waitForFunction(() => (window as any).integrity.heldRemote.length > 0);
  const queues = await page.evaluate(() => ({ local: (window as any).integrity.heldLocal, remote: (window as any).integrity.heldRemote }));
  await page.evaluate(() => (window as any).integrity.release());
  await idle(page); await idle(peer);
  const actual = { y: await render(page), native: await model(page), peer: await model(peer) };
  await info.attach('deferred-apply.json', { body: JSON.stringify({ queues, actual }, null, 2), contentType: 'application/json' });
  expect(actual.y).toContain('concurrent-remote');
  expect(actual.y).toMatch(/\(at 101 100(?: 0)?\)/);
  expect(actual.native).toContain('concurrent-remote');
  expect(actual.native).toMatch(/\(at 101 100(?: 0)?\)/);
  expect(actual.peer).toContain('concurrent-remote');
});

// Gate transport delivery only; every packet is still sent over the browser's
// real BroadcastChannel, and the production provider handles it unchanged.
async function gateNetwork(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const Native = window.BroadcastChannel;
    w.networkGate = { hold: false, pending: [], release() {
      this.hold = false;
      for (const deliver of this.pending.splice(0)) deliver();
    } };
    w.BroadcastChannel = class extends Native {
      set onmessage(fn: any) {
        super.onmessage = e => {
          const deliver = () => fn(e);
          if (w.networkGate.hold) w.networkGate.pending.push(deliver);
          else deliver();
        };
      }
    };
  });
}

test('ysync 0012 #3: two offline native undos restore one layout reference', async ({ page, context }, info) => {
  const peer = await context.newPage();
  await gateNetwork(page); await gateNetwork(peer);
  await pair(page, peer);
  for (const p of [page, peer]) await p.evaluate(() => (window as any).networkGate.hold = true);
  // Both users own a native deletion undo record before either sees the other.
  for (const p of [page, peer]) { await remove(p); await expect.poll(() => render(p)).not.toContain(FP); }
  for (const p of [page, peer]) await p.evaluate(() => (window as any).networkGate.release());
  for (const p of [page, peer]) await idle(p);
  // Sync a marker as a transport fence before creating concurrent restorations.
  await page.evaluate(() => (window as any).integrity.doc.getMap('integrity-fence').set('deleted', true));
  await peer.waitForFunction(() => (window as any).integrity.doc.getMap('integrity-fence').get('deleted'));
  for (const p of [page, peer]) await p.evaluate(() => (window as any).networkGate.hold = true);
  for (const p of [page, peer]) { await undo(p); await expect.poll(() => render(p)).toContain(FP); }
  for (const p of [page, peer]) await p.evaluate(() => (window as any).networkGate.release());
  await page.evaluate(() => (window as any).integrity.doc.getMap('integrity-fence').set('undo-a', true));
  await peer.evaluate(() => (window as any).integrity.doc.getMap('integrity-fence').set('undo-b', true));
  await peer.waitForFunction(() => (window as any).integrity.doc.getMap('integrity-fence').get('undo-a'));
  await page.waitForFunction(() => (window as any).integrity.doc.getMap('integrity-fence').get('undo-b'));
  await expect.poll(async () => (await render(page)) === (await render(peer))).toBe(true);
  const text = await render(page);
  await info.attach('merged-roots.kicad_pcb', { body: text, contentType: 'text/plain' });
  expect(text.match(new RegExp(`\\(uuid "${FP}"\\)`, 'g'))).toHaveLength(1);
});

test('ysync 0012 #3: a disconnected losing seeder cannot leave a duplicate file', async ({ page, context }, info) => {
  const loser = await context.newPage();
  await gateNetwork(page); await gateNetwork(loser);
  const room = `disconnected-seed-${Date.now()}`;
  for (const p of [page, loser]) {
    await boot(p); await open(p);
    await p.evaluate(() => (window as any).networkGate.hold = true);
    await connect(p, room);
  }
  // Fix only tie-breaking IDs, before either document has ever been written.
  await page.evaluate(() => (window as any).integrity.doc.clientID = 2);
  await loser.evaluate(() => (window as any).integrity.doc.clientID = 1);
  await attach(loser, PCB); await attach(page, PCB);
  await page.waitForFunction(() => (window as any).networkGate.pending.length > 0);
  await loser.close(); // Its nonce observer can no longer retract its inserts.
  await page.evaluate(() => (window as any).networkGate.release());
  await idle(page);
  const text = await render(page);
  await info.attach('disconnected-seed.kicad_pcb', { body: text, contentType: 'text/plain' });
  expect(text.match(new RegExp(`\\(uuid "${FP}"\\)`, 'g'))).toHaveLength(1);
});

test('ysync 0012 #6: roots imported through native apply survive snapshot-seeding and deletion', async ({ page }, info) => {
  const first = 'bbbbbbbb-2222-2222-2222-222222222222';
  const second = 'bbbbbbbb-2222-2222-2222-222222222223';
  const pin = 'cccccccc-0000-0000-0000-000000000001';
  // KiCad file-open deduplicates IDs globally. Its per-root collab importer
  // parses each blob independently; exercise THAT accepted input boundary.
  // This demonstrates native bridge exposure, not an ordinary UI paste repro.
  const source = readFileSync(path.resolve(__dirname, 'fixtures-integrity/copied-symbol.kicad_sch'), 'utf8');
  const root = source.slice(source.indexOf('\t(symbol (lib_id'), source.indexOf('\t(sheet_instances'));
  const defs = source.slice(source.indexOf('\t(lib_symbols'), source.indexOf('\t(symbol (lib_id'));
  await boot(page, 'eeschema.html'); await open(page, source.replace(root, ''), 'kicad_sch');
  await page.evaluate(({ defs, root, first, second }) => {
    (window as any).Module.kicadCollabApplyItems(JSON.stringify({
      added: [
        { sexpr: defs + root, parent: null },
        { sexpr: defs + root.replace(first, second).replace('(at 127 95.25 0)', '(at 150 95.25 0)'), parent: null },
      ], changed: [], removed: [],
    }));
  }, { defs, root, first, second });
  await idle(page);
  const snapshot = await page.evaluate(() => (window as any).Module.kicadCollabSnapshotItems());
  const parsed = JSON.parse(snapshot);
  const roots = parsed.added.filter((entry: any) => entry.sexpr.includes('(lib_id'));
  expect(roots).toHaveLength(2);
  await info.attach('native-snapshot.json', { body: snapshot, contentType: 'application/json' });
  expect(roots.every((entry: any) => entry.sexpr.includes(pin)), 'native writer must actually retain the colliding child UUID').toBe(true);
  await connect(page, `child-collision-${Date.now()}`);
  await attach(page); // Actual supported editor-snapshot seed, ONE native batch.
  // Snapshot-only seeding deliberately supplies items only. Give the readback
  // oracle the document kind so a missing-root setup error cannot mask a lost
  // child. This metadata write neither inserts nor repairs item references.
  await page.evaluate(() => (window as any).integrity.doc.getMap('kdoc_meta').set('root', 'kicad_sch'));
  const beforeDelete = await page.evaluate(id => {
    const a = (window as any).integrity;
    return a.shared.renderItem(a.shared.yToDoc(a.doc), id);
  }, first);
  expect(beforeDelete).toContain(pin);
  await page.evaluate(id => (window as any).Module.kicadCollabTestRemoveItem(id), second);
  await page.waitForFunction(id => !(window as any).integrity.doc.getMap('kdoc_items').has(id), second);
  const native = await page.evaluate(() => {
    const w = window as any;
    const out = '/home/kicad/documents/child-dump.kicad_sch';
    w.Module.kicadSaveSchematic(out);
    return w.FS.readFile(out, { encoding: 'utf8' });
  });
  expect(native).toContain(first);
  expect(native).toContain(pin); // Deleting the other root preserved this child natively.
  const result = await page.evaluate(id => {
    const a = (window as any).integrity;
    try { return { rendered: a.shared.renderItem(a.shared.yToDoc(a.doc), id), error: null }; }
    catch (err) { return { error: String(err) }; }
  }, first);
  await info.attach('child-collision.json', { body: JSON.stringify({ snapshot: parsed, native, result }, null, 2), contentType: 'application/json' });
  expect(result.error).toBeNull();
  expect(result.rendered).toContain(pin);
});
