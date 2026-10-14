import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileToDoc, parseSexpr, placementBlob, placePartEdit, type Form } from '@pcbjam/shared';
import type { TourDeps } from '@/overlay/tours/declarative';
import { AGENT_UNDO_PREFIX, agentEditRequest, applyAgentEdit, placeAgentPart, readParts } from './executor';

// A synthetic sheet and symbol written for these tests.
const F = '(effects (font (size 1.27 1.27)))';
const DEF_R = `(symbol "Test:R" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) ${F}) (property "Value" "R" (at 0 0 90) ${F})
  (property "Footprint" "" (at 0 0 0) ${F}) (property "Datasheet" "~" (at 0 0 0) ${F})
  (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F}))
                  (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${F}) (number "2" ${F}))))`;
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "11111111-1111-4111-8111-111111111111") (paper "A4")
  (lib_symbols) (sheet_instances (path "/" (page "1"))))`;
const def = parseSexpr(DEF_R)[0] as Form;

const install = (mod: Record<string, unknown> | undefined) => {
  (globalThis as { window?: unknown }).window = { Module: mod };
};
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

/** A fake engine for plugin edits: `status` answers every poll. */
function editEngine(status: () => Record<string, unknown>, started: Record<string, unknown> = { ok: true, operation: 7 }) {
  return {
    kicadPluginEditItems: vi.fn((_json: string) => JSON.stringify(started)),
    kicadPluginEditVersion: () => 1,
    kicadPluginEditStatus: vi.fn(() => JSON.stringify(status())),
    kicadCancelPluginEdit: vi.fn(() => true),
  };
}

const deps = (symbols: () => unknown[], nets: unknown[] = [], busy = false): TourDeps => ({
  symbols: () => JSON.stringify(symbols()),
  nets: () => JSON.stringify(nets),
  board: () => '{}',
  openBusy: () => busy,
  dialogOpen: () => false,
  anyDialogOpen: () => false,
  modalDialogOpen: () => false,
});

describe('applyAgentEdit', () => {
  const { edit } = placePartEdit({ doc: fileToDoc(SHEET), parts: [{ libId: 'Test:R', def, value: '4.7k', at: [50.8, 50.8], nets: { '1': 'SDA' } }] });

  it('sends a schematic-ops edit as one native commit, labelled for the undo menu', async () => {
    const mod = editEngine(() => ({ status: 'applied', added: ['a'], changed: [], removed: [] }));
    install(mod);
    expect(await applyAgentEdit(edit, new AbortController().signal)).toEqual({ status: 'applied', added: ['a'], changed: [], removed: [] });
    const sent = JSON.parse(mod.kicadPluginEditItems.mock.calls[0]![0]);
    expect(sent.label).toBe(`${AGENT_UNDO_PREFIX}Place R1`);
    expect(sent.upsert).toHaveLength(2); // the symbol and its SDA label
    expect(sent.libSymbols).toEqual([expect.stringMatching(/^\(symbol "Test:R"/)]);
  });

  it('prefixes the label once and leaves out an empty definition list', () => {
    const request = agentEditRequest({ label: `${AGENT_UNDO_PREFIX}x`, upsert: [{ sexpr: '(wire)' }], remove: [], libSymbols: {} });
    expect(request).toEqual({ label: `${AGENT_UNDO_PREFIX}x`, upsert: [{ sexpr: '(wire)' }], remove: [] });
  });

  it("answers KiCad's refusal and an item this editor cannot take as {error, code}, never a throw", async () => {
    const held = editEngine(() => ({ status: 'error', code: 'HELD', ids: ['u1'] }));
    install(held);
    expect(await applyAgentEdit(edit, new AbortController().signal)).toEqual({ error: 'A collaborator is working on some of these items: u1', code: 'HELD' });

    const native = editEngine(() => ({ status: 'applied' }));
    install(native);
    const board = await applyAgentEdit({ label: 'x', upsert: [{ sexpr: '(segment (start 0 0) (end 1 1))' }], remove: [], libSymbols: {} }, new AbortController().signal);
    expect(board).toMatchObject({ code: 'INVALID' });
    expect(native.kicadPluginEditItems).not.toHaveBeenCalled();

    install(undefined);
    expect(await applyAgentEdit(edit, new AbortController().signal)).toMatchObject({ code: 'NO_EDITOR' });
  });

  it('Stop withdraws an edit still queued', async () => {
    vi.useFakeTimers();
    const mod = editEngine(() => ({ status: 'queued' }));
    install(mod);
    const stop = new AbortController();
    const result = applyAgentEdit(edit, stop.signal);
    await vi.advanceTimersByTimeAsync(100);
    stop.abort();
    expect(await result).toEqual({ error: 'Plugin edit cancelled', code: 'CANCELLED' });
    expect(mod.kicadCancelPluginEdit).toHaveBeenCalledWith(7);
  });
});

describe('placeAgentPart', () => {
  const blob = placementBlob({ def, libId: 'Test:R', value: '10k' });
  const R1 = { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', libId: 'Test:R', ref: 'R1', value: '1k', footprint: '', x: 508000, y: 508000 };
  const R2 = { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', libId: 'Test:R', ref: 'R2', value: '10k', footprint: '', x: 762000, y: 381000 };
  const placementEngine = (status: string) => ({
    kicadPlaceImportedItem: vi.fn(() => JSON.stringify({ ok: true, operation: 3 })),
    kicadPluginPlacementVersion: () => 1,
    kicadImportedItemStatus: vi.fn(() => JSON.stringify({ status })),
    kicadCancelImportedItem: vi.fn(() => true),
  });

  it('arms KiCad placement and answers with the part the sheet gained at the click', async () => {
    const mod = placementEngine('placed');
    install(mod);
    let sheet = [R1];
    mod.kicadPlaceImportedItem.mockImplementation(() => {
      sheet = [R1, R2];
      return JSON.stringify({ ok: true, operation: 3 });
    });
    const result = await placeAgentPart(blob, new AbortController().signal, { deps: deps(() => sheet) });
    expect(result).toEqual({ status: 'placed', ref: 'R2', uuid: R2.uuid, at: [76.2, 38.1] });
    expect(mod.kicadPlaceImportedItem).toHaveBeenCalledWith(blob.sexpr);
  });

  it('says cancelled on Esc, and refuses a malformed blob before KiCad sees it', async () => {
    install(placementEngine('cancelled'));
    expect(await placeAgentPart(blob, new AbortController().signal, { deps: deps(() => [R1]) })).toEqual({ status: 'cancelled' });

    const mod = placementEngine('placed');
    install(mod);
    expect(await placeAgentPart({ sexpr: '(symbol (lib_id "Test:R"))' }, new AbortController().signal, { deps: deps(() => []) })).toMatchObject({ code: 'INVALID' });
    expect(mod.kicadPlaceImportedItem).not.toHaveBeenCalled();
  });

  it('Stop disarms the placement', async () => {
    vi.useFakeTimers();
    const mod = placementEngine('placing');
    install(mod);
    const stop = new AbortController();
    const result = placeAgentPart(blob, stop.signal, { deps: deps(() => [R1]) });
    await vi.advanceTimersByTimeAsync(200);
    stop.abort();
    expect(await result).toEqual({ error: 'Placement cancelled', code: 'CANCELLED' });
    expect(mod.kicadCancelImportedItem).toHaveBeenCalledWith(3);
  });
});

describe('readParts', () => {
  const symbols = [
    { uuid: 'u-r1', libId: 'Test:R', ref: 'R1', value: '1k', footprint: 'R_0603', angle: 90, mirror: '', x: 508000, y: 254000 },
    { uuid: 'u-pwr', libId: 'power:GND', ref: '#PWR01', value: 'GND', footprint: '', x: 0, y: 0 },
  ];
  const nets = [{ net: '/SDA', pins: [{ uuid: 'u-r1', ref: 'R1', libId: 'Test:R', pin: '2', name: '', noConnect: false }] }];

  it("gives KiCad's live parts in mm (power symbols left out) and its nets in the netlist's shape", () => {
    expect(readParts(deps(() => symbols, nets))).toEqual({
      parts: [{ ref: 'R1', value: '1k', libId: 'Test:R', footprint: 'R_0603', uuid: 'u-r1', at: [50.8, 25.4], angle: 90, mirror: '' }],
      nets: [{ net: '/SDA', pins: [{ ref: 'R1', pin: '2' }] }],
    });
  });

  it('refuses while a file is loading', () => {
    expect(readParts(deps(() => symbols, nets, true))).toEqual({ error: 'The document is still loading', code: 'BUSY' });
  });
});
