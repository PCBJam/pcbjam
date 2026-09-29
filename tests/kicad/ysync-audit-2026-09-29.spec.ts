import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';

/** Desired invariants, intentionally NOT test.fail(): a boot/setup error is not a reproduction.
 * Real KiCad commits -> native wire -> production binding -> BroadcastChannel -> native parser.
 * See docs/features/ysync-review/2026-09-29-sync-e2e-audit.md for issue IDs and results.
 */
test.describe.configure({ timeout: 300_000 });
test.beforeAll(() => execFileSync(process.execPath, ['collab/build-sync-audit.mjs'], {
  cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
}));

const DIR = '/home/kicad/documents/';
const FP = '66666666-0000-0000-0000-000000000001';
const POLY = '66666666-0000-0000-0000-000000000002';
const GROUP = '66666666-0000-0000-0000-000000000003';
const POINT = '66666666-0000-0000-0000-000000000004';
const SYM = 'bbbbbbbb-2222-2222-2222-222222222222';
const GENERATOR = '4f22a815-3048-42b3-86fa-eb71720d35ae';
const PCB = `(kicad_pcb (version 20241229) (generator "pcbnew")
 (general (thickness 1.6)) (paper "A4") (title_block (title "Initial") (rev "1"))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (25 "Edge.Cuts" user))
 (setup) (net 0 "")
 (footprint "TestLib:R" (layer "F.Cu") (uuid "${FP}") (at 100 100) (attr smd)
  (property "Reference" "R1" (at 0 -4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R" (at 0 4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))))
 (gr_poly (pts (xy 50 50) (xy 60 50) (xy 60 60) (xy 50 60))
  (stroke (width 0.1) (type solid)) (fill none) (layer "F.SilkS") (uuid "${POLY}")))`;
const SCH = readFileSync(path.resolve(__dirname, 'fixtures-integrity/copied-symbol.kicad_sch'), 'utf8');
const addRoot = (file: string, root: string) => file.trim().slice(0, -1) + '\n' + root + '\n)';
const grouped = (tool: 'pcb' | 'sch') => addRoot(tool === 'pcb' ? PCB : SCH,
  `(group "Audit group" (uuid "${GROUP}") (members "${tool === 'pcb' ? FP : SYM}"))`);
const generatorBoard = readFileSync(path.resolve(__dirname, '../../kicad/qa/data/pcbnew/tuning_generators_load_save.kicad_pcb'), 'utf8');
const pointBoard = addRoot(PCB, `(point (at 110 100) (size 1) (layer "F.Cu") (uuid "${POINT}"))`);
const unique = (name: string) => `${name}-${Date.now()}-${Math.random()}`;

async function boot(page: Page, tool: 'pcb' | 'sch' = 'pcb') {
  page.setDefaultTimeout(30_000);
  await page.goto(`/kicad/${tool === 'pcb' ? 'pcbnew-collab' : 'eeschema'}.html`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    return w.Module?.kicadCollabSnapshotItems && w.wxElementRegistry?.findAll({ visible: true })
      .some((e: any) => /Frame$/.test(e.typeName));
  }, null, { timeout: 120_000 });
  await page.addScriptTag({ path: path.resolve(__dirname, '../apps/kicad/collab-sync-audit.js') });
  await page.evaluate(t => { (window as any).syncAudit.tool = t; }, tool);
}
async function idle(page: Page) {
  await page.waitForFunction(() => !(window as any).Module.kicadCollabBusy()
    && (window as any).syncAudit.pending === 0, null, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as any).syncAudit.errors)).toEqual([]);
}
async function open(page: Page, text: string, tool: 'pcb' | 'sch' = 'pcb', filename?: string) {
  const file = filename ?? `${unique('audit')}.kicad_${tool === 'pcb' ? 'pcb' : 'sch'}`;
  await page.evaluate(({ file, text, dir }) => {
    const w = window as any;
    w.FS.mkdirTree(dir); w.FS.writeFile(dir + file, text); w.Module.kicadOpenFile(dir + file);
  }, { file, text, dir: DIR });
  await expect.poll(() => page.title(), { timeout: 30_000 }).toContain(file.replace(/\.kicad_.*$/, ''));
  await idle(page);
}
const model = (p: Page): Promise<string> => p.evaluate(() => (window as any).syncAudit.model());
const render = (p: Page): Promise<string> => p.evaluate(() => (window as any).syncAudit.render());
const item = (p: Page, id: string, native = false): Promise<string> => p.evaluate(
  ({ id, native }) => (window as any).syncAudit.item(id, native), { id, native });
const connect = (p: Page, room: string) => p.evaluate(r => (window as any).syncAudit.connect(r), room);
const attach = (p: Page, seed: string, matches = false) => p.evaluate(
  ({ seed, matches }) => (window as any).syncAudit.attach(seed, matches), { seed, matches });
async function call(p: Page, name: string, ...args: unknown[]) {
  const accepted = await p.evaluate(({ name, args }) => (window as any).Module[name](...args), { name, args });
  expect(accepted, `native ${name} must accept the operation`).toBeTruthy();
}
async function fence(a: Page, b: Page) {
  // Drain native commit/flush work before sending the transport fence.
  await idle(a); await idle(b);
  const key = unique('fence');
  await a.evaluate(k => (window as any).syncAudit.doc.getMap('sync-audit-fence').set(k, true), key);
  await b.waitForFunction(k => (window as any).syncAudit.doc.getMap('sync-audit-fence').get(k), key);
  await idle(a); await idle(b);
}
async function pair(a: Page, b: Page, tool: 'pcb' | 'sch' = 'pcb', source = tool === 'pcb' ? PCB : SCH) {
  const room = unique('audit');
  await boot(a, tool); await open(a, source, tool);
  const canonical = await model(a); // Native parser/writer acceptance is a setup precondition.
  await connect(a, room); await attach(a, canonical);
  await boot(b, tool); await connect(b, room);
  const loaded = await render(b); await open(b, loaded, tool); await attach(b, loaded, true);
  await fence(a, b);
}
async function evidence(info: TestInfo, pages: Page[], extra: unknown = {}) {
  const states = [];
  for (const p of pages) {
    await idle(p);
    states.push(await p.evaluate(() => {
      const a = (window as any).syncAudit;
      return { doc: a.render(), native: a.model(), heldLocal: a.heldLocal, heldRemote: a.heldRemote,
        sheetEvents: a.sheetEvents, emitted: a.emitted, errors: a.errors };
    }));
  }
  await info.attach('sync-audit-evidence.json', {
    body: JSON.stringify({ extra, states }, null, 2), contentType: 'application/json',
  });
}
const xy = (text: string) => [...text.matchAll(/\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
const position = (text: string) => /\(at\s+([-\d.]+)\s+([-\d.]+)/.exec(text)?.slice(1).map(Number);
const members = (text: string) => (/\(members\s*([^)]*)\)/.exec(text)?.[1] ?? '').match(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/g) ?? [];

// A green control is required before interpreting the red regressions.
test('control: real native field edit crosses the production binding and transport', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer);
  await call(page, 'kicadCollabTestSetFootprintField', FP, 'Value', 'AUDIT-CONTROL');
  await expect.poll(() => item(peer, FP, true)).toContain('AUDIT-CONTROL');
  await fence(page, peer); await evidence(info, [page, peer]);
  expect(await item(peer, FP)).toContain('AUDIT-CONTROL');
});

test('SYNC-01: a concurrent vertex insertion must not retarget a stale vertex move', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer);
  expect(xy(await item(page, POLY, true))).toEqual([[50, 50], [60, 50], [60, 60], [50, 60]]);
  await page.evaluate(() => (window as any).syncAudit.hold());
  await call(page, 'kicadCollabTestAuditPolygon', POLY, JSON.stringify([[50, 50], [60, 50], [62, 62], [50, 60]].map(p => p.map(v => v * 1e6))));
  await page.waitForFunction(() => (window as any).syncAudit.heldLocal.length > 0);
  await call(peer, 'kicadCollabTestAuditPolygon', POLY, JSON.stringify([[50, 50], [55, 50], [60, 50], [60, 60], [50, 60]].map(p => p.map(v => v * 1e6))));
  await expect.poll(async () => xy(await item(page, POLY))).toHaveLength(5);
  await page.waitForFunction(() => (window as any).syncAudit.heldRemote.length > 0);
  await page.evaluate(() => (window as any).syncAudit.release());
  await fence(page, peer); await evidence(info, [page, peer]);
  const expected = [[50, 50], [55, 50], [60, 50], [62, 62], [50, 60]];
  expect.soft(xy(await item(page, POLY))).toEqual(expected);
  expect(xy(await item(peer, POLY, true))).toEqual(expected);
});

test('SYNC-03: a pending native move must preserve a newer library definition', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer, 'sch');
  await page.evaluate(() => (window as any).syncAudit.hold());
  await call(page, 'kicadCollabTestMoveSchItem', SYM, 10_000, 0);
  await page.waitForFunction(() => (window as any).syncAudit.heldLocal.length > 0);
  await call(peer, 'kicadCollabTestAuditLibrary', SYM, 'AUDIT-NEW-LIBRARY');
  await expect.poll(() => render(page)).toContain('AUDIT-NEW-LIBRARY');
  await page.waitForFunction(() => (window as any).syncAudit.heldRemote.length > 0);
  await page.evaluate(() => (window as any).syncAudit.release());
  await fence(page, peer); await evidence(info, [page, peer]);
  expect.soft(position(await item(page, SYM))).toEqual([128, 95.25]);
  expect.soft(await render(page)).toContain('AUDIT-NEW-LIBRARY');
  expect(await model(peer)).toContain('AUDIT-NEW-LIBRARY');
});

for (const tool of ['pcb', 'sch'] as const) {
  test(`SYNC-04 ${tool}: adopting a group must resolve its existing native members`, async ({ page, context }, info) => {
    const peer = await context.newPage(); const room = unique('group');
    await boot(page, tool); await open(page, grouped(tool), tool);
    const canonical = await model(page);
    // Verify fixture really created a populated native group before touching collab.
    await connect(page, room); await attach(page, canonical, true);
    const expected = [tool === 'pcb' ? FP : SYM];
    expect(members(await item(page, GROUP, true))).toEqual(expected);
    await boot(peer, tool); await open(peer, tool === 'pcb' ? PCB : SCH, tool);
    const initial = await model(peer);
    await connect(peer, room); await attach(peer, initial);
    await fence(page, peer); await evidence(info, [page, peer]);
    expect.soft(members(await item(peer, GROUP))).toEqual(expected);
    expect(members(await item(peer, GROUP, true))).toEqual(expected);
  });
  test(`SYNC-04 ${tool}: replacing a remote member must preserve its native parent group`, async ({ page, context }, info) => {
    const peer = await context.newPage(); await pair(page, peer, tool, grouped(tool));
    const id = tool === 'pcb' ? FP : SYM;
    expect(members(await item(peer, GROUP, true))).toEqual([id]);
    await call(page, tool === 'pcb' ? 'kicadCollabTestMoveBoardItem' : 'kicadCollabTestMoveSchItem', id, tool === 'pcb' ? 1e6 : 1e4, 0);
    await expect.poll(async () => position(await item(peer, id, true))?.[0]).toBe(tool === 'pcb' ? 101 : 128);
    await fence(page, peer); await evidence(info, [page, peer]);
    expect(members(await item(peer, GROUP, true))).toEqual([id]);
  });
}

for (const kind of ['point', 'generated', 'group'] as const) {
  const source = kind === 'point' ? pointBoard : kind === 'generated' ? generatorBoard : grouped('pcb');
  const id = kind === 'point' ? POINT : kind === 'generated' ? GENERATOR : GROUP;
  test(`SYNC-05 ${kind}: native snapshot must include a root retained by the file writer`, async ({ page }, info) => {
    await boot(page); await open(page, source); const canonical = await model(page);
    expect(canonical).toContain(id); // Reject an unsupported/malformed fixture as setup failure.
    await connect(page, unique(kind)); await attach(page, canonical, true);
    const snapshot = await page.evaluate(() => (window as any).Module.kicadCollabSnapshotItems());
    await evidence(info, [page], { snapshot });
    const roots = JSON.parse(snapshot).added;
    expect(roots.some((r: any) => r.sexpr.includes(id)), `${kind} is in the native file but absent from the item bridge`).toBe(true);
  });
  if (kind !== 'group') {
    test(`SYNC-05 ${kind}: a remote root must materialize in native memory`, async ({ page, context }, info) => {
      const peer = await context.newPage(); const room = unique(kind);
      await boot(page); await open(page, source); const canonical = await model(page);
      expect(canonical).toContain(id);
      await connect(page, room); await attach(page, canonical, true);
      await boot(peer); await open(peer, PCB); await connect(peer, room); await attach(peer, await model(peer));
      await fence(page, peer); await evidence(info, [page, peer]);
      expect(await render(peer)).toContain(id); // Transport succeeded; inspect the actual parser result next.
      expect(await model(peer)).toContain(id);
    });
  }
}

test('SYNC-06a: saved remote page settings must reach the already-open native board', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer);
  await call(page, 'kicadCollabTestAuditSettings', JSON.stringify({ paper: 'A3', title: 'Remote title' }));
  await expect.poll(() => model(page)).toMatch(/\(paper\s+"A3"\)/);
  await page.evaluate(() => (window as any).syncAudit.saveLayout());
  await expect.poll(() => render(peer)).toContain('Remote title');
  await fence(page, peer); await evidence(info, [page, peer]);
  expect.soft(await model(peer)).toMatch(/\(paper\s+"A3"\)/);
  expect(await model(peer)).toContain('Remote title');
});

test('SYNC-06b: saving a local revision must preserve a peer title in the same title block', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer);
  await call(peer, 'kicadCollabTestAuditSettings', JSON.stringify({ title: 'Remote title' }));
  await expect.poll(() => model(peer)).toContain('Remote title');
  await peer.evaluate(() => (window as any).syncAudit.saveLayout());
  await expect.poll(() => render(page)).toContain('Remote title');
  await call(page, 'kicadCollabTestAuditSettings', JSON.stringify({ revision: '2' }));
  await expect.poll(() => model(page)).toMatch(/\(rev\s+"2"\)/);
  await page.evaluate(() => (window as any).syncAudit.saveLayout());
  await fence(page, peer); await evidence(info, [page, peer]);
  expect(await render(page)).toContain('Remote title');
});

test('SYNC-08: undoing a local move must preserve a later peer field edit', async ({ page, context }, info) => {
  const peer = await context.newPage(); await pair(page, peer);
  await call(page, 'kicadCollabTestMoveBoardItem', FP, 1e6, 0);
  await expect.poll(async () => position(await item(peer, FP, true))).toEqual([101, 100]);
  await call(peer, 'kicadCollabTestSetFootprintField', FP, 'Value', 'PEER-KEPT');
  await expect.poll(() => item(page, FP, true)).toContain('PEER-KEPT');
  await call(page, 'kicadCollabTestUndo');
  await expect.poll(async () => position(await item(page, FP, true))).toEqual([100, 100]);
  // Undo can run on the tool's own coroutine; wait for its document effect as well.
  await expect.soft.poll(async () => position(await item(page, FP)), { timeout: 10_000 }).toEqual([100, 100]);
  await fence(page, peer); await evidence(info, [page, peer]);
  expect.soft(await item(page, FP, true)).toContain('PEER-KEPT');
  expect(await item(peer, FP)).toContain('PEER-KEPT');
});

// Separate child FILES intentionally share an item UUID, as a copied sheet does.
const ROOT = '11111111-1111-1111-1111-111111111111';
function hierarchy() {
  const sheets = ['a', 'b'].map((n, i) => `(sheet (at ${40 + i * 40} 40) (size 30 20)
    (stroke (width 0) (type default)) (fill (color 0 0 0 0))
    (uuid "22222222-2222-2222-2222-22222222222${i}")
    (property "Sheetname" "Child ${n}" (at ${40 + i * 40} 39 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "${n}.kicad_sch" (at ${40 + i * 40} 61 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (instances (project "root" (path "/${ROOT}" (page "${i + 2}")))))`).join('\n');
  return `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${ROOT}")
    (paper "A4") (lib_symbols) ${sheets} (sheet_instances (path "/" (page "1"))))`;
}
async function navigate(page: Page, file: string) {
  expect(await page.evaluate(file => {
    const w = window as any;
    const sheet = JSON.parse(w.Module.kicadSheetsGetTree()).sheets.find((s: any) => s.file === file);
    if (!sheet) throw new Error(`Missing native sheet: ${file}`);
    return w.Module.kicadSheetsEnter(sheet.path);
  }, DIR + file)).toBe(true);
  await page.waitForFunction(file => (window as any).syncAudit.activePath === file, file);
  await idle(page);
}
async function setupSheets(page: Page, project: string) {
  await boot(page, 'sch');
  await page.evaluate(({ dir, sch }) => {
    const w = window as any; w.FS.mkdirTree(dir);
    w.FS.writeFile(dir + 'a.kicad_sch', sch);
    w.FS.writeFile(dir + 'b.kicad_sch', sch.replace('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002'));
  }, { dir: DIR, sch: SCH });
  await open(page, hierarchy(), 'sch', 'root.kicad_sch');
  await page.evaluate(project => (window as any).syncAudit.sheets(project,
    ['root.kicad_sch', 'a.kicad_sch', 'b.kicad_sch'], 'root.kicad_sch'), project);
  // Populate each room from an actual loaded native sheet, then park both.
  await navigate(page, 'a.kicad_sch'); await navigate(page, 'b.kicad_sch'); await navigate(page, 'root.kicad_sch');
  for (const file of ['a.kicad_sch', 'b.kicad_sch']) {
    expect(await page.evaluate(file => (window as any).syncAudit.nativeSheet(file), file)).toContain(SYM);
  }
  await page.evaluate(() => { (window as any).syncAudit.sheetEvents = []; });
}
const sheetText = (page: Page, file: string): Promise<string> => page.evaluate(f => (window as any).syncAudit.sheetText(f), file);

test('SYNC-02: a global edit on a parked sheet must preserve its peer move', async ({ page, context }, info) => {
  const project = unique('sheets'); await setupSheets(page, project);
  const peer = await context.newPage(); await boot(peer, 'sch');
  const room = await page.evaluate(p => (window as any).syncAudit.room(p, 'a.kicad_sch'), project);
  await connect(peer, room); const loaded = await render(peer);
  await open(peer, loaded, 'sch', 'a.kicad_sch'); await attach(peer, loaded, true);
  await call(peer, 'kicadCollabTestMoveSchItem', SYM, 300_000, 0);
  await expect.poll(() => sheetText(page, 'a.kicad_sch')).toMatch(/\(at 157 95.25/);
  expect(await page.evaluate(() => (window as any).syncAudit.nativeSheet('a.kicad_sch'))).toMatch(/\(at\s+127\s+95.25/);
  await call(page, 'kicadCollabTestAuditFields', JSON.stringify([{ sheet: DIR + 'a.kicad_sch', uuid: SYM, value: 'GLOBAL-EDIT' }]));
  await expect.poll(() => sheetText(page, 'a.kicad_sch')).toContain('GLOBAL-EDIT');
  await idle(page); await idle(peer);
  await evidence(info, [page, peer], { childDoc: await sheetText(page, 'a.kicad_sch') });
  expect(position(await item(peer, SYM))).toEqual([157, 95.25]);
});

test('SYNC-07: one global commit must emit both copied sheets with the same item UUID', async ({ page }, info) => {
  await setupSheets(page, unique('copies'));
  await call(page, 'kicadCollabTestAuditFields', JSON.stringify(['a', 'b'].map(n => ({
    sheet: DIR + n + '.kicad_sch', uuid: SYM, value: 'GLOBAL-BOTH',
  }))));
  for (const file of ['a.kicad_sch', 'b.kicad_sch']) await expect.poll(
    () => page.evaluate(f => (window as any).syncAudit.nativeSheet(f), file)).toContain('GLOBAL-BOTH');
  await page.waitForFunction(() => (window as any).syncAudit.sheetEvents.length > 0);
  await idle(page);
  // At least one observed room must receive the commit before comparing both.
  await expect.poll(async () => (await sheetText(page, 'a.kicad_sch')).includes('GLOBAL-BOTH')
    || (await sheetText(page, 'b.kicad_sch')).includes('GLOBAL-BOTH')).toBe(true);
  const docs = { a: await sheetText(page, 'a.kicad_sch'), b: await sheetText(page, 'b.kicad_sch') };
  await evidence(info, [page], docs);
  const emittedPaths = await page.evaluate(() => (window as any).syncAudit.sheetEvents.map((e: any) => e.path).sort());
  expect.soft(emittedPaths).toEqual([DIR + 'a.kicad_sch', DIR + 'b.kicad_sch']);
  expect.soft(docs.a).toContain('GLOBAL-BOTH');
  expect(docs.b).toContain('GLOBAL-BOTH');
});
