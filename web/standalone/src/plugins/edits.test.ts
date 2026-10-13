import { describe, expect, it, vi } from 'vitest';
import { applyEdit, editSize, validateEdit, type EditModule } from './edits';

const track = { sexpr: '(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "GND") (uuid "44444444-0000-0000-0000-000000000001"))' };
const wire = { sexpr: '(wire (pts (xy 0 0) (xy 1 0)) (uuid "77777777-0000-0000-0000-000000000001"))' };

/** A fake engine whose receipt answers `statuses` in turn. */
function engine(start: object, statuses: object[], cancel = true) {
  const queue = [...statuses];
  return {
    kicadPluginEditVersion: () => 1,
    kicadPluginEditItems: vi.fn((json: string) => (void json, JSON.stringify(start))),
    kicadPluginEditStatus: vi.fn(() => JSON.stringify(queue.length > 1 ? queue.shift() : queue[0])),
    kicadCancelPluginEdit: vi.fn(() => cancel),
  } satisfies EditModule;
}

describe('validateEdit', () => {
  it('accepts the item kinds of the open editor only', () => {
    expect(() => validateEdit({ label: 'x', upsert: [track], remove: [] }, 'pcbnew')).not.toThrow();
    expect(() => validateEdit({ label: 'x', upsert: [wire], remove: [] }, 'eeschema')).not.toThrow();
    expect(() => validateEdit({ label: 'x', upsert: [wire], remove: [] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => validateEdit({ label: 'x', upsert: [track], remove: [] }, 'eeschema')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => validateEdit({ label: 'x', upsert: [{ sexpr: '(kicad_pcb (segment))' }], remove: [] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => validateEdit({ label: 'x', upsert: [track], remove: [] }, 'pl_editor')).toThrow(expect.objectContaining({ code: 'NO_EDITOR' }));
  });

  it('bounds the item count and size, and takes libSymbols on schematics only', () => {
    expect(() => validateEdit({ label: 'x', upsert: [], remove: [] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => validateEdit({ label: 'x', upsert: Array(2001).fill(track), remove: [] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => validateEdit({ label: 'x', upsert: [{ sexpr: '(segment ' + 'x'.repeat(512 * 1024) + ')' }], remove: [] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => validateEdit({ label: 'x', upsert: [wire], remove: [], libSymbols: ['(symbol "L:C")'] }, 'eeschema')).not.toThrow();
    expect(() => validateEdit({ label: 'x', upsert: [track], remove: [], libSymbols: ['(symbol "L:C")'] }, 'pcbnew')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(editSize({ label: 'x', upsert: [track, track], remove: ['a'] })).toBe(3);
  });
});

describe('applyEdit', () => {
  it('resolves with what the commit added, changed and removed', async () => {
    const mod = engine({ ok: true, operation: 7 }, [{ status: 'queued' }, { status: 'applied', added: ['a'], changed: ['b'], removed: ['c'] }]);
    await expect(applyEdit(mod, { label: 'x', upsert: [track], remove: [] }, new AbortController().signal))
      .resolves.toEqual({ status: 'applied', added: ['a'], changed: ['b'], removed: ['c'] });
    expect(JSON.parse(mod.kicadPluginEditItems.mock.calls[0]![0])).toMatchObject({ label: 'x' });
  });

  it('rejects with the engine code, naming held items', async () => {
    const mod = engine({ ok: true, operation: 1 }, [{ status: 'error', code: 'HELD', ids: ['44444444-0000-0000-0000-000000000001'] }]);
    await expect(applyEdit(mod, { label: 'x', upsert: [track], remove: [] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'HELD', message: expect.stringContaining('44444444-0000-0000-0000-000000000001') });
    const refused = engine({ ok: false, code: 'BUSY' }, []);
    await expect(applyEdit(refused, { label: 'x', upsert: [track], remove: [] }, new AbortController().signal)).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('withdraws a queued edit when the plugin stops', async () => {
    const mod = engine({ ok: true, operation: 3 }, [{ status: 'queued' }]);
    const abort = new AbortController();
    const pending = applyEdit(mod, { label: 'x', upsert: [track], remove: [] }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mod.kicadCancelPluginEdit).toHaveBeenCalledWith(3);
  });
});
