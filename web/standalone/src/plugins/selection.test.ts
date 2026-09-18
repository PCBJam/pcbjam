import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectItems, selectModule, SELECT_MAX } from './selection';

const install = (mod: Record<string, unknown> | undefined) => { (globalThis as any).window = { Module: mod }; };
afterEach(() => { delete (globalThis as any).window; });
const engine = (reply: unknown, extra: Record<string, unknown> = {}) => {
  const kicadPluginSelectItems = vi.fn(() => typeof reply === 'string' ? reply : JSON.stringify(reply));
  install({ kicadPluginSelectItems, kicadPluginSelectVersion: () => 1, ...extra });
  return kicadPluginSelectItems;
};

describe('plugin selection adapter', () => {
  it('is unavailable without a matching engine build', async () => {
    install(undefined); expect(selectModule()).toBeNull();
    install({ kicadPluginSelectItems: () => '{}' }); expect(selectModule()).toBeNull();
    install({ kicadPluginSelectItems: () => '{}', kicadPluginSelectVersion: () => 2 }); expect(selectModule()).toBeNull();
    install({ kicadPluginSelectItems: () => '{}', kicadPluginSelectVersion: () => { throw new Error('gone'); } }); expect(selectModule()).toBeNull();
    await expect(selectItems(['a'])).rejects.toThrow(/unavailable/);
  });
  it('passes only a JSON id array in and only requested ids out', async () => {
    const call = engine({ ok: true, selected: ['a', 'a', 'intruder', 7], held: ['b', { uuid: 'b', name: 'Bob' }], missing: ['c'], name: 'Bob' });
    expect(await selectItems(['a', 'b', 'c'])).toEqual({ selected: ['a'], held: ['b'], missing: ['c'] });
    expect(call).toHaveBeenCalledWith('["a","b","c"]');
    engine({ ok: true });
    expect(await selectItems([])).toEqual({ selected: [], held: [], missing: [] });
  });
  it('awaits an engine call the JSPI scheduler deferred', async () => {
    install({ kicadPluginSelectItems: async () => JSON.stringify({ ok: true, selected: ['a'] }), kicadPluginSelectVersion: () => 1 });
    expect((await selectItems(['a'])).selected).toEqual(['a']);
  });
  it('refuses before entering the engine when it must not be entered', async () => {
    const busy = engine({ ok: true }, { kicadOpenFileBusy: () => true });
    await expect(selectItems(['a'])).rejects.toThrow(/not ready/);
    const call = engine({ ok: true });
    await expect(selectItems(Array.from({ length: SELECT_MAX + 1 }, (_, i) => 'id' + i))).rejects.toThrow(/Invalid/);
    await expect(selectItems(['x'.repeat(65)])).rejects.toThrow(/Invalid/);
    await expect(selectItems([''])).rejects.toThrow(/Invalid/);
    expect(busy).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it('turns engine refusals and garbage into plain errors', async () => {
    engine({ ok: false, error: 'TOOL_ACTIVE' }); await expect(selectItems(['a'])).rejects.toThrow(/current editor tool/);
    engine({ ok: false, error: '<img src=x onerror=alert(1)>' }); await expect(selectItems(['a'])).rejects.toThrow(/^The editor could not change the selection$/);
    engine('not json'); await expect(selectItems(['a'])).rejects.toThrow(/could not change/);
    engine('null'); await expect(selectItems(['a'])).rejects.toThrow(/could not change/);
  });
});
