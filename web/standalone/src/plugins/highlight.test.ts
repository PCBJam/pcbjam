import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHighlight, highlight } from './highlight';

const answer = { ok: true, highlighted: ['a'], missing: [], nets: ['GND'], missingNets: ['NOPE'] };

describe('plugin highlight', () => {
  afterEach(() => {
    clearHighlight();
    vi.useRealTimers();
    delete (globalThis as { Module?: unknown }).Module;
  });

  it('highlights, then clears itself after durationMs', () => {
    vi.useFakeTimers();
    const kicadPluginHighlight = vi.fn(() => JSON.stringify(answer));
    (globalThis as { Module?: unknown }).Module = { kicadPluginHighlight };
    expect(highlight({ ids: ['a'], nets: ['GND', 'NOPE'], durationMs: 2000 })).toEqual({ highlighted: ['a'], missing: [], nets: ['GND'], missingNets: ['NOPE'] });
    expect(kicadPluginHighlight).toHaveBeenLastCalledWith(JSON.stringify({ ids: ['a'], nets: ['GND', 'NOPE'] }));
    vi.advanceTimersByTime(1999);
    expect(kicadPluginHighlight).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(kicadPluginHighlight).toHaveBeenLastCalledWith(JSON.stringify({ ids: [], nets: [] }));
  });

  it('a new highlight replaces the timer; clearing twice calls the editor once', () => {
    vi.useFakeTimers();
    const kicadPluginHighlight = vi.fn(() => JSON.stringify(answer));
    (globalThis as { Module?: unknown }).Module = { kicadPluginHighlight };
    highlight({ ids: ['a'], nets: [], durationMs: 1000 });
    highlight({ ids: ['a'], nets: [], durationMs: 5000 });
    vi.advanceTimersByTime(1000);
    expect(kicadPluginHighlight).toHaveBeenCalledTimes(2);
    clearHighlight();
    clearHighlight();
    expect(kicadPluginHighlight).toHaveBeenCalledTimes(3);
  });

  it('refuses without the editor hook, and passes the editor refusal on', () => {
    expect(() => highlight({ ids: [], nets: [], durationMs: 1000 })).toThrow(/cannot highlight/);
    (globalThis as { Module?: unknown }).Module = { kicadPluginHighlight: () => JSON.stringify({ ok: false, error: 'NO_EDITOR' }) };
    expect(() => highlight({ ids: ['a'], nets: [], durationMs: 1000 })).toThrow(/not ready/);
  });
});
