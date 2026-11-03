import { describe, expect, it, vi } from 'vitest';
import { createPartCopyBridge, type PartCopyDeps, type SaveModalRequest } from './part-copy';
import type { LibInfo, LibsSource } from '@/wasm/libs/source';

const DEVICE: LibInfo = { id: 'dev-id', name: 'Device', type: 'origin' };
const OTHER: LibInfo = { id: 'other-id', name: 'Theirs', type: 'org' };
const TEAM: LibInfo = { id: 'team-id', name: 'acme', type: 'org' };

type Route = (body: Record<string, unknown> | undefined, path: string) => { status: number; body: unknown };

/**
 * Fake deps recording every effect in order. `routes` answers by path suffix;
 * `items` is what the page's copy of the team library can read (grows as copies land).
 */
function fakeDeps(over: {
  routes?: Record<string, Route>;
  libs?: LibInfo[];
  items?: Array<{ kind: string; name: string }>;
  libScoped?: boolean;
  confirm?: boolean;
} = {}) {
  const calls: string[] = [];
  const items = over.items ?? [];
  const source = {
    listLibs: vi.fn(async () => over.libs ?? [DEVICE, OTHER, TEAM]),
    listItems: vi.fn(async () => items),
    getItemBody: vi.fn(async (_id: string, kind: string, name: string) =>
      items.some((i) => i.kind === kind && i.name === name) ? `(symbol "${name}")` : null,
    ),
  } as unknown as LibsSource;
  const modals: SaveModalRequest[] = [];
  const notices: Array<{ state: string; message: string; link?: { href: string } }> = [];
  const mod = {
    kicadLibsInvalidate: vi.fn((kind: string, lib: string) => { calls.push(`invalidate:${kind}:${lib}`); }),
    kicadSymbolEditorOpenCopy: vi.fn((...a: string[]) => { calls.push(`open:${a.join(',')}`); return true; }),
    kicadFootprintEditorOpenCopy: vi.fn((...a: string[]) => { calls.push(`openfp:${a.join(',')}`); return true; }),
  };
  const routes: Record<string, Route> = {
    '/part-copy-target': () => ({ status: 200, body: { canCopy: true, libId: TEAM.id, lib: 'acme' } }),
    ...over.routes,
  };
  const deps: PartCopyDeps = {
    editor: () => ({ source, tool: 'eeschema', scope: 'acme', projectId: 'proj' }),
    libScoped: () => over.libScoped ?? false,
    fetch: vi.fn(async (path: string, init: { method: string; body?: unknown }) => {
      const key = Object.keys(routes).find((k) => path.endsWith(k) || path.includes(k));
      const body = init.body as Record<string, unknown> | undefined;
      calls.push(`${init.method} ${path.slice(path.lastIndexOf('/') + 1)}${body?.preview ? ' preview' : body?.body ? ' body' : ''}`);
      if (!key) return { status: 404, body: { message: 'no route' } };
      return routes[key]!(body, path);
    }),
    module: () => mod,
    addLib: vi.fn(async (_s, detail) => { calls.push(`addLib:${detail.name}`); return true; }),
    confirmSave: vi.fn(async (req) => { modals.push(req); return over.confirm ?? true; }),
    notify: (n) => { notices.push(n); },
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { deps, calls, items, modals, notices, mod };
}

const saved = (name: string, created = false) => ({ status: 200, body: { state: 'saved', target: { libId: TEAM.id, lib: 'acme', name, created }, replaced: false } });

describe('libs 0031 part copy: banner notice', () => {
  it('names the owner and offers the copy to members', async () => {
    const { deps } = fakeDeps();
    const bridge = createPartCopyBridge(deps);
    await bridge.prime();
    expect(bridge.notice('symbol', 'Device', 'R')).toEqual({
      message: 'Device is read-only for you (it belongs to KiCad).',
      button: 'Copy to "acme" library',
    });
    expect(bridge.notice('symbol', 'Theirs', 'X')?.message).toContain('belongs to another team');
  });

  it('has no button for someone who may not copy into the team', async () => {
    const { deps } = fakeDeps({ routes: { '/part-copy-target': () => ({ status: 200, body: { canCopy: false, libId: null, lib: 'acme' } }) } });
    const bridge = createPartCopyBridge(deps);
    await bridge.prime();
    const n = bridge.notice('footprint', 'Device', 'R');
    expect(n?.button).toBeUndefined();
    expect(n?.message).toContain('Only members of acme can copy footprints');
  });
});

describe('libs 0031 part copy: banner button', () => {
  it('waits for the transfer, reloads the team library once the copy is there, then opens it', async () => {
    let polls = 0;
    const f = fakeDeps({
      routes: {
        '/copy-to-team': () => ({ status: 202, body: { state: 'copying', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false }, operation: { id: 'op1' } } }),
        '/transfer/op1': () => {
          polls++;
          if (polls === 2) f.items.push({ kind: 'symbol', name: 'R' });
          return { status: 200, body: { operation: { status: polls < 2 ? 'running' : 'succeeded', error: null } } };
        },
      },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('symbol', 'Device', 'R');
    await vi.waitFor(() => expect(f.calls).toContain('open:Device,R,acme,R'));
    expect(f.calls.slice(-3)).toEqual(['GET op1', 'invalidate:symbol:acme', 'open:Device,R,acme,R']);
    expect(f.notices.at(-1)).toMatchObject({ state: 'done', message: expect.stringContaining('Copied Device:R to "acme"') });
  });

  it('a library busy with another copy is waited for, then asked again', async () => {
    let asked = 0;
    const f = fakeDeps({
      items: [{ kind: 'symbol', name: 'R' }],
      routes: {
        '/copy-to-team': () =>
          ++asked === 1
            ? { status: 409, body: { code: 'library-busy', operationId: 'other', message: 'busy' } }
            : { status: 200, body: { state: 'existing', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false } } },
        '/transfer/other': () => ({ status: 200, body: { operation: { status: 'succeeded', error: null } } }),
      },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('symbol', 'Device', 'R');
    await vi.waitFor(() => expect(f.calls).toContain('open:Device,R,acme,R'));
    expect(f.calls.filter((c) => c.startsWith('POST') || c.startsWith('GET other'))).toEqual(['POST copy-to-team', 'GET other', 'POST copy-to-team']);
    expect(f.notices.at(-1)?.message).toContain('Opened your earlier copy');
  });

  it('a new team library is added to the session instead of reloaded', async () => {
    const f = fakeDeps({
      libs: [DEVICE],
      routes: { '/copy-to-team': () => ({ status: 200, body: { state: 'existing', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: true } } }) },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('symbol', 'Device', 'R');
    await vi.waitFor(() => expect(f.calls).toContain('open:Device,R,acme,R'));
    expect(f.calls).toContain('addLib:acme');
    expect(f.calls).not.toContain('invalidate:symbol:acme');
  });

  it('a library added this session reloads on the next copy instead of being added again', async () => {
    const f = fakeDeps({
      libs: [DEVICE],
      items: [{ kind: 'symbol', name: 'R' }],
      routes: { '/copy-to-team': () => ({ status: 200, body: { state: 'existing', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false } } }) },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('symbol', 'Device', 'R');
    await vi.waitFor(() => expect(f.calls).toContain('open:Device,R,acme,R'));
    expect(f.calls.filter((c) => c.startsWith('addLib') || c.startsWith('invalidate'))).toEqual(['addLib:acme']);

    const answer = await bridge.save({ kind: 'symbol', saveAll: false, rows: [{ lib: 'Device', name: 'R', readOnly: true, body: '(kicad_symbol_lib)' }] });
    expect(answer?.action).toBe('save');
    expect(f.calls.filter((c) => c.startsWith('addLib') || c.startsWith('invalidate'))).toEqual(['addLib:acme', 'invalidate:symbol:acme']);
  });

  it('a one-library editor links to the copy instead of opening it', async () => {
    const f = fakeDeps({
      libScoped: true,
      routes: { '/copy-to-team': () => ({ status: 200, body: { state: 'existing', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false } } }) },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('footprint', 'Device', 'R');
    await vi.waitFor(() => expect(f.notices.at(-1)?.state).toBe('done'));
    expect(f.notices.at(-1)?.link?.href).toBe('/acme/libs/team-id?tool=footprint_editor');
    expect(f.calls.some((c) => c.startsWith('openfp') || c.startsWith('invalidate'))).toBe(false);
  });

  it('a refusal is reported, nothing opens', async () => {
    const f = fakeDeps({ routes: { '/copy-to-team': () => ({ status: 403, body: { message: 'only the team\'s members can copy parts into its libraries' } }) } });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    bridge.copy('symbol', 'Device', 'R');
    await vi.waitFor(() => expect(f.notices.at(-1)?.state).toBe('error'));
    expect(f.notices.at(-1)?.message).toContain("only the team's members");
    expect(f.calls.some((c) => c.startsWith('open'))).toBe(false);
  });
});

describe('libs 0031 part copy: save modal', () => {
  const request = {
    kind: 'symbol' as const,
    saveAll: true,
    rows: [
      { lib: 'Device', name: 'R', readOnly: true, body: '(kicad_symbol_lib (symbol "R"))' },
      { lib: 'acme', name: 'LDO', readOnly: false },
    ],
  };

  it('lists every part with where it goes, writes the copies and reloads their library before answering', async () => {
    const f = fakeDeps({
      items: [{ kind: 'symbol', name: 'R_Device' }],
      routes: {
        '/copy-to-team': (body) =>
          body?.preview
            ? { status: 200, body: { state: 'preview', target: { libId: TEAM.id, lib: 'acme', name: 'R_Device', created: false }, earlier: false } }
            : saved('R_Device'),
      },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    const answer = await bridge.save(request);
    expect(f.modals[0]!.rows).toEqual([
      { lib: 'Device', name: 'R', readOnly: true, target: { libId: TEAM.id, lib: 'acme', name: 'R_Device', created: false, earlier: false } },
      { lib: 'acme', name: 'LDO', readOnly: false },
    ]);
    expect(answer).toEqual({ action: 'save', copied: [{ lib: 'Device', name: 'R', targetLib: 'acme', targetName: 'R_Device', open: true }] });
    expect(f.calls.filter((c) => !c.startsWith('GET part-copy-target'))).toEqual([
      'POST copy-to-team preview',
      'POST copy-to-team body',
      'invalidate:symbol:acme',
    ]);
  });

  it('Cancel writes nothing', async () => {
    const f = fakeDeps({
      confirm: false,
      routes: { '/copy-to-team': () => ({ status: 200, body: { state: 'preview', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false }, earlier: true } }) },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    expect(await bridge.save(request)).toEqual({ action: 'cancel' });
    expect(f.calls.some((c) => c.endsWith(' body'))).toBe(false);
    expect(f.modals[0]!.rows[0]!.target?.earlier).toBe(true);
  });

  it('a part that can\'t be copied shows why in its row', async () => {
    const f = fakeDeps({ confirm: false, routes: { '/copy-to-team': () => ({ status: 403, body: { message: 'only members' } }) } });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    await bridge.save(request);
    expect(f.modals[0]!.rows[0]).toEqual({ lib: 'Device', name: 'R', readOnly: true, error: 'only members' });
  });

  it('a one-library editor keeps the copy closed and links to it', async () => {
    const f = fakeDeps({
      libScoped: true,
      routes: {
        '/copy-to-team': (body) =>
          body?.preview ? { status: 200, body: { state: 'preview', target: { libId: TEAM.id, lib: 'acme', name: 'R', created: false } } } : saved('R'),
      },
    });
    const bridge = createPartCopyBridge(f.deps);
    await bridge.prime();
    const answer = await bridge.save({ ...request, saveAll: false, rows: [request.rows[0]!] });
    expect(answer).toEqual({ action: 'save', copied: [{ lib: 'Device', name: 'R', targetLib: 'acme', targetName: 'R', open: false }] });
    expect(f.calls.some((c) => c.startsWith('invalidate'))).toBe(false);
    expect(f.notices.at(-1)?.link?.href).toBe('/acme/libs/team-id?tool=symbol_editor');
  });
});
