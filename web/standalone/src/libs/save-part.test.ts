import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSexpr } from '@pcbjam/shared';
import { ensureProviderLib, resetSavePartState, savePart, SavePartError, type PartPack, type SavePartDeps } from './save-part';
import type { LibInfo, LibsSource } from '@/wasm/libs/source';

const SYMBOL = `(kicad_symbol_lib (version 20241209) (generator "t")
  (symbol "R" (pin_numbers hide) (pin_names (offset 0) hide) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Vendor:Whatever" (at 0 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "R_0_1" (rectangle (start -1 -2) (end 1 2) (stroke (width 0.25) (type default)) (fill (type none))))
    (symbol "R_1_1" (pin passive line (at 0 3 270) (length 1) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))`;
const FOOTPRINT = '(footprint "R_0603" (version 20241229) (generator "t") (layer "F.Cu") (attr smd) (model "x.step") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
const SANITIZED = '(footprint "R_0603" (version 20241229) (generator "t") (layer "F.Cu") (attr smd) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
const bytes = (text: string) => new TextEncoder().encode(text);
const pack = (over: Partial<PartPack> = {}): PartPack => ({
  providerOrigin: 'https://www.eda.cn', providerId: 'eda-cn', partId: 'p1', displayName: 'R',
  symbol: { name: 'R', bytes: bytes(SYMBOL) }, footprint: { name: 'R_0603', bytes: bytes(FOOTPRINT) }, ...over,
});
const LIB: LibInfo = { id: 'lib-1', name: 'eda_cn', type: 'org' };

/** Fake deps recording every effect in order; `libs` is what the fresh listing answers. */
function fakeDeps(over: Partial<SavePartDeps> & { libs?: LibInfo[]; bootLibs?: LibInfo[]; tool?: string; createStatus?: number; saveOk?: boolean } = {}) {
  const calls: string[] = [];
  const saved: Array<{ libId: string; kind: string; name: string; body: string }> = [];
  const source = {
    listLibs: vi.fn(async () => over.bootLibs ?? []),
    saveItemBody: vi.fn(async (libId: string, kind: string, name: string, body: string) => { calls.push('room:' + kind); saved.push({ libId, kind, name, body }); return over.saveOk ?? true; }),
  } as unknown as LibsSource;
  const invalidate = vi.fn((kind: string) => { calls.push('invalidate:' + kind); });
  const deps: SavePartDeps = {
    editor: () => ({ source, tool: over.tool ?? 'eeschema', scope: 'team', projectId: 'proj' }),
    identity: () => ({ slug: 'alice' }),
    createLib: vi.fn(async () => { calls.push('create'); const status = over.createStatus ?? 201; return status === 201 ? { status, body: { id: LIB.id, name: 'eda_cn' } } : { status }; }),
    listLibs: vi.fn(async () => { calls.push('list'); return over.libs ?? [LIB]; }),
    putItem: vi.fn(async (_s, _p, _l, kind) => { calls.push('put:' + kind); return { ok: true, status: 200 }; }),
    validate: vi.fn(async (req) => { calls.push('validate:' + (req.kind ?? 'symbol')); return { text: req.kind === 'footprint' ? SANITIZED : req.text }; }),
    place: vi.fn(async () => { calls.push('place'); return { status: 'placed' as const }; }),
    addLib: vi.fn(async () => { calls.push('addLib'); return true; }),
    module: () => ({ kicadLibsInvalidate: invalidate }),
    libsMode: () => 'synced',
    uuid: () => '11111111-1111-4111-8111-111111111111',
    log: vi.fn(),
    ...over,
  };
  return { deps, calls, saved, source, invalidate };
}
const opts = () => ({ place: true, signal: new AbortController().signal });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof SavePartError ? e.code : 'plain:' + (e as Error).message; } };

describe('ensureProviderLib', () => {
  it('creates on first use and reads the mounted nickname from a fresh listing', async () => {
    const { deps } = fakeDeps({ libs: [{ ...LIB, name: 'eda_cn--team' }] });
    expect(await ensureProviderLib(deps, 'team', 'proj', 'eda_cn')).toEqual({ id: 'lib-1', nickname: 'eda_cn--team', created: true });
  });
  it('resolves an existing lib by name on 409, including a collision-suffixed nickname', async () => {
    const { deps } = fakeDeps({ createStatus: 409, libs: [{ id: 'other', name: 'eda_cn_x', type: 'org' }, { ...LIB, name: 'eda_cn--team' }] });
    expect(await ensureProviderLib(deps, 'team', 'proj', 'eda_cn')).toEqual({ id: 'lib-1', nickname: 'eda_cn--team', created: false });
    const exact = fakeDeps({ createStatus: 409, libs: [{ ...LIB, name: 'eda_cn--team' }, LIB] });
    expect((await ensureProviderLib(exact.deps, 'team', 'proj', 'eda_cn')).nickname).toBe('eda_cn');
  });
  it('maps 403 to NO_TEAM_WRITE and other failures to a plain error', async () => {
    expect(await code(ensureProviderLib(fakeDeps({ createStatus: 403 }).deps, 'team', 'proj', 'eda_cn'))).toBe('NO_TEAM_WRITE');
    expect(await code(ensureProviderLib(fakeDeps({ createStatus: 500 }).deps, 'team', 'proj', 'eda_cn'))).toMatch(/^plain:/);
    expect(await code(ensureProviderLib(fakeDeps({ createStatus: 409, libs: [] }).deps, 'team', 'proj', 'eda_cn'))).toMatch(/^plain:.*find/);
  });
});

describe('savePart', () => {
  beforeEach(() => resetSavePartState());
  it('validates, writes symbol then footprint to the live source, indexes, mounts, places — in that order', async () => {
    const { deps, calls, saved } = fakeDeps();
    const result = await savePart(pack({ model3d: { name: 'm', bytes: bytes('x'), contentType: 'model/step' } }), opts(), deps);
    expect(result).toEqual({ libId: 'lib-1', libNickname: 'eda_cn', symbolLibId: 'eda_cn:R', footprintLibId: 'eda_cn:R_0603', placement: 'placed', skipped: ['model3d'] });
    expect(calls).toEqual(['validate:symbol', 'validate:footprint', 'create', 'list', 'room:symbol', 'room:footprint', 'put:symbol', 'put:footprint', 'addLib', 'place']);
    expect(saved.map((s) => [s.libId, s.kind, s.name])).toEqual([['lib-1', 'symbol', 'R'], ['lib-1', 'footprint', 'R_0603']]);
    expect(saved[1]!.body).toBe(SANITIZED);
    // The saved symbol carries the rewritten Footprint, and so does the clipboard that was placed.
    expect(saved[0]!.body).toContain('(property "Footprint" "eda_cn:R_0603"');
    expect(saved[0]!.body).not.toContain('Vendor:Whatever');
    const placedWith = (deps.place as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(placedWith).toContain('(lib_id "eda_cn:R")');
    expect(placedWith).toContain('"eda_cn:R_0603"');
    expect(parseSexpr(placedWith)).toHaveLength(2);
  });
  it('keeps the provider Footprint when the pack has no footprint, and reports both skipped kinds', async () => {
    const { deps, saved } = fakeDeps();
    const result = await savePart(pack({ footprint: undefined, spice: { name: 's', bytes: bytes('x') }, model3d: { name: 'm', bytes: bytes('x'), contentType: 'x' } }), opts(), deps);
    expect(result.footprintLibId).toBeUndefined();
    expect(result.skipped).toEqual(['model3d', 'spice']);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.body).toContain('Vendor:Whatever');
  });
  it('saves a footprint-only pack without placing', async () => {
    const { deps, calls } = fakeDeps();
    const result = await savePart(pack({ symbol: undefined }), opts(), deps);
    expect(result).toMatchObject({ footprintLibId: 'eda_cn:R_0603', skipped: [] });
    expect(result.symbolLibId).toBeUndefined();
    expect(result.placement).toBeUndefined();
    expect(calls).not.toContain('place');
  });
  it('in the PCB editor it saves and never places; with place:false likewise', async () => {
    const pcb = fakeDeps({ tool: 'pcbnew' });
    const result = await savePart(pack(), opts(), pcb.deps);
    expect('placement' in result).toBe(false);
    expect(pcb.calls).not.toContain('place');
    const noPlace = fakeDeps();
    expect((await savePart(pack(), { place: false, signal: new AbortController().signal }, noPlace.deps)).placement).toBeUndefined();
  });
  it('a lib mounted earlier this session is invalidated on the next save, not mounted twice', async () => {
    const { deps, calls } = fakeDeps();
    await savePart(pack(), opts(), deps);
    expect(calls).toContain('addLib');
    const again = fakeDeps({ createStatus: 409 });
    await savePart(pack(), opts(), again.deps);
    expect(again.calls).not.toContain('addLib');
    expect(again.calls.filter((c) => c.startsWith('invalidate'))).toHaveLength(2);
  });
  it('invalidates a lib the editor already has instead of mounting it again', async () => {
    const { deps, calls } = fakeDeps({ createStatus: 409, bootLibs: [LIB] });
    await savePart(pack(), opts(), deps);
    expect(calls.filter((c) => c.startsWith('invalidate'))).toEqual(['invalidate:symbol', 'invalidate:footprint']);
    expect(calls).not.toContain('addLib');
  });
  it('mounts a brand-new lib through a one-lib view, so the frozen boot listing does not matter', async () => {
    const { deps } = fakeDeps();
    await savePart(pack(), opts(), deps);
    const [shim, detail] = (deps.addLib as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(detail).toEqual({ op: 'add', libId: 'lib-1', name: 'eda_cn' });
    expect(await (shim as LibsSource).listLibs('footprint')).toEqual([{ id: 'lib-1', name: 'eda_cn', type: 'org' }]);
  });
  it('a refused room write is LIB_WRITE_FAILED and nothing is indexed or placed', async () => {
    const { deps, calls } = fakeDeps({ saveOk: false });
    expect(await code(savePart(pack(), opts(), deps))).toBe('LIB_WRITE_FAILED');
    expect(calls.filter((c) => c.startsWith('put') || c === 'place' || c === 'addLib')).toEqual([]);
  });
  it('a failed DB index is logged, not fatal; in remote mode the index pass is skipped', async () => {
    const { deps, calls } = fakeDeps({ putItem: vi.fn(async () => ({ ok: false, status: 500 })) });
    expect((await savePart(pack(), opts(), deps)).placement).toBe('placed');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('answered 500'));
    const remote = fakeDeps({ libsMode: () => 'other' });
    await savePart(pack(), opts(), remote.deps);
    expect(remote.calls.some((c) => c.startsWith('put'))).toBe(false);
    expect(calls).toContain('place');
  });
  it('a cancelled or failed placement leaves the library writes in place', async () => {
    const cancelled = fakeDeps({ place: vi.fn(async () => ({ status: 'cancelled' as const })) });
    expect((await savePart(pack(), opts(), cancelled.deps)).placement).toBe('cancelled');
    expect(cancelled.saved).toHaveLength(2);
    const failed = fakeDeps({ place: vi.fn(async () => { throw new Error('The editor is not ready for placement'); }) });
    expect(await code(savePart(pack(), opts(), failed.deps))).toBe('PLACEMENT_UNAVAILABLE');
    expect(failed.saved).toHaveLength(2);
  });
  it('refuses before any network when the editor, sign-in, contents or sizes are wrong', async () => {
    const noEditor = fakeDeps({ editor: () => null });
    expect(await code(savePart(pack(), opts(), noEditor.deps))).toBe('PLACEMENT_UNAVAILABLE');
    const anon = fakeDeps({ identity: () => null });
    expect(await code(savePart(pack(), opts(), anon.deps))).toBe('NOT_SIGNED_IN');
    const empty = fakeDeps();
    expect(await code(savePart(pack({ symbol: undefined, footprint: undefined }), opts(), empty.deps))).toBe('INVALID_SYMBOL');
    const huge = fakeDeps();
    expect(await code(savePart(pack({ footprint: { name: 'x', bytes: new Uint8Array(9 * 1024 * 1024) } }), opts(), huge.deps))).toBe('TOO_LARGE');
    const badUtf8 = fakeDeps();
    expect(await code(savePart(pack({ symbol: { name: 'R', bytes: new Uint8Array([0xff, 0xfe, 0x28]) } }), opts(), badUtf8.deps))).toBe('INVALID_SYMBOL');
    for (const d of [noEditor, anon, empty, huge, badUtf8]) expect(d.calls).toEqual([]);
  });
  it('maps validator failures to INVALID_SYMBOL / INVALID_FOOTPRINT / TOO_LARGE and writes nothing', async () => {
    const badSym = fakeDeps({ validate: vi.fn(async (req) => { if (!req.kind) throw new Error('Unsupported import: extends'); return { text: SANITIZED }; }) });
    expect(await code(savePart(pack(), opts(), badSym.deps))).toBe('INVALID_SYMBOL');
    expect(badSym.saved).toEqual([]);
    // A refused part never creates the provider library (no empty lib left behind).
    expect(badSym.deps.createLib).not.toHaveBeenCalled();
    const badFp = fakeDeps({ validate: vi.fn(async (req) => { if (req.kind === 'footprint') throw new Error('Unsupported footprint: net is not supported in pad'); return { text: req.text }; }) });
    expect(await code(savePart(pack(), opts(), badFp.deps))).toBe('INVALID_FOOTPRINT');
    expect(badFp.saved).toEqual([]);
    expect(badFp.deps.createLib).not.toHaveBeenCalled();
    const bigFp = fakeDeps({ validate: vi.fn(async (req) => { if (req.kind === 'footprint') throw new Error('Unsupported footprint: too large after removing embedded files'); return { text: req.text }; }) });
    expect(await code(savePart(pack(), opts(), bigFp.deps))).toBe('TOO_LARGE');
    const unresolvable = fakeDeps();
    expect(await code(savePart(pack({ symbol: { name: 'Missing', bytes: bytes(SYMBOL.replace('(symbol "R"', '(symbol "A"').replace('"R_0_1"', '"A_0_1"').replace('"R_1_1"', '"A_1_1"') + '(symbol "B")') } }), opts(), unresolvable.deps))).toBe('INVALID_SYMBOL');
  });
  it('an abort before the write leaves nothing written', async () => {
    const abort = new AbortController();
    const { deps, saved } = fakeDeps({ validate: vi.fn(async (req) => { abort.abort(); return { text: req.kind === 'footprint' ? SANITIZED : req.text }; }) });
    await expect(savePart(pack(), { place: true, signal: abort.signal }, deps)).rejects.toThrow();
    expect(saved).toEqual([]);
  });
  it('a collision-suffixed nickname rebuilds and re-validates the symbol under the mounted name', async () => {
    const { deps, calls, saved } = fakeDeps({ createStatus: 409, libs: [{ id: 'lib-2', name: 'eda_cn--2', type: 'org' }] });
    const result = await savePart(pack(), opts(), deps);
    expect(result).toMatchObject({ libId: 'lib-2', libNickname: 'eda_cn--2', symbolLibId: 'eda_cn--2:R', footprintLibId: 'eda_cn--2:R_0603' });
    expect(calls.slice(0, 5)).toEqual(['validate:symbol', 'validate:footprint', 'create', 'list', 'validate:symbol']);
    expect(saved[0]!.body).toContain('(property "Footprint" "eda_cn--2:R_0603"');
    expect((deps.place as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('(lib_id "eda_cn--2:R")');
  });
  it('onSaved fires once the part is stored, before the placement click, without the placement key', async () => {
    const seen: string[] = [];
    const { deps, calls } = fakeDeps({ place: vi.fn(async () => { seen.push('place'); calls.push('place'); return { status: 'placed' as const }; }) });
    const onSaved = vi.fn((r) => { seen.push('saved'); expect('placement' in r).toBe(false); });
    const result = await savePart(pack(), { ...opts(), onSaved }, deps);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ libId: 'lib-1', symbolLibId: 'eda_cn:R' });
    expect(seen).toEqual(['saved', 'place']);
    expect(result.placement).toBe('placed');
    // A throwing callback is logged and does not fail the save; a refused part never calls it.
    const throwing = fakeDeps();
    await expect(savePart(pack(), { ...opts(), onSaved: () => { throw new Error('boom'); } }, throwing.deps)).resolves.toMatchObject({ placement: 'placed' });
    const refused = fakeDeps({ saveOk: false });
    const never = vi.fn();
    expect(await code(savePart(pack(), { ...opts(), onSaved: never }, refused.deps))).toBe('LIB_WRITE_FAILED');
    expect(never).not.toHaveBeenCalled();
  });
});
