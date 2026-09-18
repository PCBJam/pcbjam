import { afterEach, describe, expect, it, vi } from 'vitest';
import { geometryModule, openGeometry } from './board-geometry';

afterEach(() => { delete (globalThis as any).window; });
const engine = (replies: Array<string | Promise<string>>, extra: Record<string, unknown> = {}) => {
  const kicadPluginBoardGeometry = vi.fn((..._args: unknown[]) => replies.shift()!);
  (globalThis as any).window = { Module: { kicadPluginBoardGeometry, kicadPluginBoardGeometryVersion: () => 1, ...extra } };
  return kicadPluginBoardGeometry;
};
const drain = async (cursor: ReturnType<typeof openGeometry>, max = 1 << 20) => {
  let text = '', reads = 0;
  for (;;) { const part = await cursor.read(8, max); expect(part.text.length).toBeLessThanOrEqual(max); text += part.text; reads++; if (part.done) return { text, reads }; if (reads > 1000) throw new Error('never finished'); }
};

describe('board geometry adapter', () => {
  it('is unavailable without a matching engine build', async () => {
    (globalThis as any).window = {}; expect(geometryModule()).toBeNull();
    (globalThis as any).window = { Module: { kicadPluginBoardGeometry: () => '', kicadPluginBoardGeometryVersion: () => 2 } }; expect(geometryModule()).toBeNull();
    await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/unavailable/);
  });
  it('sends two booleans and its own cursor, and joins the slices', async () => {
    const call = engine(['{"ok":true,"next":{"s":1,"i":3,"j":0,"t":9}}\n{"$":"board"}\n', Promise.resolve('{"ok":true,"next":null}\n{"$":"footprint"}\n')]);
    const out = await drain(openGeometry({ tracks: true, zones: 'yes' as unknown as boolean }));
    expect(out.text).toBe('{"$":"board"}\n{"$":"footprint"}\n');
    expect(call.mock.calls[0]).toEqual(['{"tracks":true,"zones":false}', '', 8, 1 << 20]);
    expect(call.mock.calls[1]![1]).toBe('{"s":1,"i":3,"j":0,"t":9}');
  });
  it('hands a large reply on in bounded pieces without cutting a surrogate pair', async () => {
    const body = '{"ref":"' + '😀'.repeat(900) + '"}\n';
    engine(['{"ok":true,"next":null}\n' + body]);
    const cursor = openGeometry({ tracks: false, zones: false });
    const first = await cursor.read(8, 1025);
    expect((first.text.charCodeAt(first.text.length - 1) & 0xfc00) === 0xd800).toBe(false);
    expect(first.done).toBe(false);
    expect(first.text + (await drain(cursor, 1025)).text).toBe(body);
  });
  it('clamps the budget and size it passes to the engine', async () => {
    const call = engine(['{"ok":true,"next":null}\n']);
    await openGeometry({ tracks: false, zones: false }).read(100000, 1 << 30);
    expect(call.mock.calls[0]!.slice(2)).toEqual([50, 4 * 1024 * 1024]);
  });
  it('maps refusals and garbage to plain errors and stays out of a loading engine', async () => {
    engine(['{"ok":false,"error":"CHANGED"}\n']); await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/Document changed/);
    engine(['{"ok":false,"error":"NOT_PCB"}\n']); await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/unavailable/);
    engine(['{"ok":false,"error":"<script>"}\n']); await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/^The editor could not read the board$/);
    engine(['no newline']); await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/could not read/);
    engine(['{"ok":true,"next":7}\n']); await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/could not read/);
    const busy = engine(['{"ok":true,"next":null}\n'], { kicadOpenFileBusy: () => true });
    await expect(openGeometry({ tracks: false, zones: false }).read(8, 1024)).rejects.toThrow(/not ready/);
    expect(busy).not.toHaveBeenCalled();
  });
});
