import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TourDeps } from '@/overlay/tours/declarative';
import { updatePcb } from './update-pcb';

const install = (mod: Record<string, unknown> | undefined) => {
  (globalThis as { window?: unknown }).window = { Module: mod };
};
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

const deps = (symbols: () => unknown[], nets: unknown[] = [], busy = false): TourDeps => ({
  symbols: () => JSON.stringify(symbols()),
  nets: () => JSON.stringify(nets),
  board: () => '{}',
  openBusy: () => busy,
  dialogOpen: () => false,
  anyDialogOpen: () => false,
  modalDialogOpen: () => false,
});

describe('updatePcb', () => {
  const add = { severity: 'action', text: "Add D1 (footprint 'LED_SMD:LED_0603_1608Metric')." };
  const remove = { severity: 'action', text: 'Remove unused footprint R9.' };

  const actions = (report: object[]) => (report as Array<{ severity: string; text: string }>).filter((l) => l.severity === 'action').map((l) => l.text);

  /**
   * A fake engine: each dry run reports `preview()`; the real run previews again and refuses
   * (CHANGED) unless the changes are the `expect` it was given, as the native hook does.
   */
  function updateEngine(preview: () => object[], oddNames: string[] | null = []) {
    const odd = oddNames ? { oddNames } : {}; // null: an older build that does not report them
    let operation = 0;
    const runs: boolean[] = [];
    const expects: unknown[] = [];
    const results = new Map<number, object>();
    const mod = {
      kicadUpdatePcbFromSchematic: vi.fn((json: string) => {
        const { dryRun, expect: seen } = JSON.parse(json) as { dryRun: boolean; expect?: string[] };
        runs.push(dryRun);
        operation++;
        if (!dryRun) expects.push(seen);
        results.set(operation, dryRun
          ? { status: 'done', report: preview(), added: [], ...odd }
          : JSON.stringify(seen) !== JSON.stringify(actions(preview()))
            ? { status: 'error', code: 'CHANGED', error: 'The update changed since it was previewed' }
            : { status: 'done', report: [{ severity: 'action', text: "Added D1 (footprint 'LED_SMD:LED_0603_1608Metric')." }], added: ['D1'], ...odd });
        return JSON.stringify({ ok: true, operation });
      }),
      kicadUpdatePcbStatus: vi.fn((id: number) => JSON.stringify(results.get(id) ?? { status: 'expired' })),
    };
    return { mod, runs, expects };
  }
  const signal = () => new AbortController().signal;
  const run = (req: { dryRun: boolean; deleteUnused?: boolean }, confirm = vi.fn(async () => true)) =>
    updatePcb({ deleteUnused: false, ...req }, signal(), confirm, { deps: deps(() => []), pollMs: 1 });

  it("previews: KiCad's report, and what would need the person's approval", async () => {
    const { mod, runs } = updateEngine(() => [add, remove]);
    install(mod);
    expect(await run({ dryRun: true })).toEqual({ status: 'previewed', report: [add, remove], needsApproval: ['Remove unused footprint R9.'] });
    expect(runs).toEqual([true]);
  });

  it('applies additions without asking: a dry run, then the real one naming its changes', async () => {
    const { mod, runs, expects } = updateEngine(() => [add]);
    install(mod);
    const confirm = vi.fn(async () => true);
    expect(await run({ dryRun: false }, confirm)).toMatchObject({ status: 'applied', added: ['D1'], approved: [] });
    expect(confirm).not.toHaveBeenCalled();
    expect(runs).toEqual([true, false]);
    expect(expects).toEqual([[add.text]]);
  });

  it('a change that slips in after the preview is refused by KiCad, previewed again and asked', async () => {
    let report = [add];
    const { mod, runs } = updateEngine(() => report);
    install(mod);
    mod.kicadUpdatePcbFromSchematic.mockImplementationOnce(((original) => (json: string) => {
      const out = original(json);
      report = [add, remove]; // a peer's schematic edit lands right after the first preview
      return out;
    })(mod.kicadUpdatePcbFromSchematic.getMockImplementation()!));
    const confirm = vi.fn(async () => true);
    expect(await run({ dryRun: false, deleteUnused: true }, confirm)).toMatchObject({ status: 'applied', approved: [remove.text] });
    expect(confirm).toHaveBeenCalledWith([remove.text], expect.any(AbortSignal));
    expect(runs).toEqual([true, false, true, true, false]);
  });

  it('asks for every change on an editor build that does not report odd names', async () => {
    const { mod } = updateEngine(() => [add], null);
    install(mod);
    expect(await run({ dryRun: true })).toMatchObject({ status: 'previewed', needsApproval: [add.text] });
  });

  it('one approved removal never lets a second, same-named one through', async () => {
    let report = [add, remove];
    const { mod, runs } = updateEngine(() => report);
    install(mod);
    const confirm = vi.fn(async () => {
      // Before the re-preview, a second footprint is now also "R9" and unused.
      if (confirm.mock.calls.length === 1) report = [add, remove, remove];
      return confirm.mock.calls.length === 1;
    });
    expect(await run({ dryRun: false, deleteUnused: true }, confirm)).toEqual({ status: 'declined', needsApproval: [remove.text, remove.text] });
    expect(confirm).toHaveBeenNthCalledWith(2, [remove.text, remove.text], expect.any(AbortSignal));
    expect(runs).toEqual([true, true]); // never applied
  });

  it('after an approval, applies only the exact update approved: a line that appeared since stops it', async () => {
    let report = [add, remove];
    const rename = { severity: 'action', text: 'Change U1 value from x to y.' }; // a safe line
    const { mod, runs } = updateEngine(() => report);
    install(mod);
    const confirm = vi.fn(async () => {
      report = [add, remove, rename];
      return true;
    });
    expect(await run({ dryRun: false, deleteUnused: true }, confirm)).toEqual({
      error: 'The schematic changed while you approved the update; ask again',
      code: 'CHANGED',
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runs).toEqual([true, true]); // never applied
  });

  it('a Stop during the preview shows no dialog', async () => {
    const { mod } = updateEngine(() => [add, remove]);
    install(mod);
    const stop = new AbortController();
    mod.kicadUpdatePcbFromSchematic.mockImplementationOnce(((original) => (json: string) => {
      stop.abort(); // the turn is stopped while KiCad previews
      return original(json);
    })(mod.kicadUpdatePcbFromSchematic.getMockImplementation()!));
    const confirm = vi.fn(async () => true);
    expect(await updatePcb({ dryRun: false, deleteUnused: true }, stop.signal, confirm, { deps: deps(() => []), pollMs: 1 })).toEqual({
      error: 'Update PCB cancelled',
      code: 'CANCELLED',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(await run({ dryRun: true })).toMatchObject({ status: 'previewed' }); // not stuck BUSY
  });

  it('runs one Update PCB at a time: a second one answers BUSY while the first waits for the person', async () => {
    const { mod } = updateEngine(() => [add, remove]);
    install(mod);
    let answer: (ok: boolean) => void = () => {};
    const first = run({ dryRun: false, deleteUnused: true }, vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; })));
    await vi.waitFor(() => expect(mod.kicadUpdatePcbFromSchematic).toHaveBeenCalled());
    expect(await run({ dryRun: true })).toEqual({ error: 'Another Update PCB is still running or waiting for your answer', code: 'BUSY' });
    answer(false);
    expect(await first).toMatchObject({ status: 'declined' });
    expect(await run({ dryRun: true })).toMatchObject({ status: 'previewed' });
  });

  it('asks for every change when a reference could disguise one (a space or a quote in it)', async () => {
    const { mod } = updateEngine(() => [add], ['R1 value from x']);
    install(mod);
    expect(await run({ dryRun: true })).toMatchObject({ status: 'previewed', needsApproval: [add.text] });
  });

  it('asks before a removal; declined, the board is never touched', async () => {
    const { mod, runs } = updateEngine(() => [add, remove]);
    install(mod);
    const confirm = vi.fn(async () => false);
    expect(await run({ dryRun: false, deleteUnused: true }, confirm)).toEqual({ status: 'declined', needsApproval: ['Remove unused footprint R9.'] });
    expect(confirm).toHaveBeenCalledWith(['Remove unused footprint R9.'], expect.any(AbortSignal));
    expect(runs).toEqual([true]);
  });

  it('approved, previews again right before applying, and asks again when something new appeared', async () => {
    let report = [add, remove];
    const { mod, runs } = updateEngine(() => report);
    install(mod);
    const swap = { severity: 'action', text: "Change R1 footprint from 'R_0603' to 'R_0805'." };
    const confirm = vi.fn(async () => {
      report = confirm.mock.calls.length === 1 ? [add, remove, swap] : report;
      return true;
    });
    expect(await run({ dryRun: false, deleteUnused: true }, confirm)).toMatchObject({ status: 'applied', approved: ['Remove unused footprint R9.', swap.text] });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(runs).toEqual([true, true, true, false]);
  });

  it("passes KiCad's refusals on, and needs an editor build that has the hook", async () => {
    install({
      kicadUpdatePcbFromSchematic: () => JSON.stringify({ ok: true, operation: 1 }),
      kicadUpdatePcbStatus: () => JSON.stringify({ status: 'error', code: 'NOT_ANNOTATED', error: 'annotate first' }),
    });
    expect(await run({ dryRun: true })).toEqual({ error: 'annotate first', code: 'NOT_ANNOTATED' });
    install({ kicadUpdatePcbFromSchematic: () => JSON.stringify({ ok: false, code: 'NO_EDITOR' }), kicadUpdatePcbStatus: () => '{}' });
    expect(await run({ dryRun: true })).toEqual({ error: 'Update PCB runs in the board editor: open the board first.', code: 'NO_EDITOR' });
    install({});
    expect(await run({ dryRun: true })).toMatchObject({ code: 'NO_EDITOR' });
  });
});
