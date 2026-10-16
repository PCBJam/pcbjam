import { describe, expect, it, vi } from 'vitest';
import { agentEditorFrame, parseAgentEditorToChat, type SchematicEdit } from '@pcbjam/shared';
import { attachEditorBridge, type BridgeExecutor, type BridgeSocket, type BridgeView } from './bridge';

const edit: SchematicEdit = { label: 'Place R1', upsert: [{ sexpr: '(symbol)' }], remove: [], libSymbols: {} };

/** A chat socket: what the panel sent, parsed, and a way to deliver frames to it. */
function socket() {
  const listeners = { message: new Set<(e: MessageEvent) => void>(), open: new Set<(e: MessageEvent) => void>(), close: new Set<(e: MessageEvent) => void>() };
  const sent: ReturnType<typeof parseAgentEditorToChat>[] = [];
  const s: BridgeSocket & { sent: typeof sent; deliver(frame: unknown): void; reopen(): void; drop(): void } = {
    sent,
    send: (text) => void sent.push(parseAgentEditorToChat(text)),
    addEventListener: (type, l) => void listeners[type].add(l),
    removeEventListener: (type, l) => void listeners[type].delete(l),
    deliver: (frame) => listeners.message.forEach((l) => l({ data: agentEditorFrame(frame as never) } as MessageEvent)),
    reopen: () => listeners.open.forEach((l) => l({} as MessageEvent)),
    drop: () => listeners.close.forEach((l) => l({} as MessageEvent)),
  };
  return s;
}

const view: BridgeView = { scope: 'acme', project: 'amp', copy: null, file: 'amp.kicad_sch', tool: 'eeschema' };
/** Where an exec is meant to run (the tab checks it, ai-chat 0006 A3). */
const where = { scope: 'acme', project: 'amp', copy: null };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('attachEditorBridge', () => {
  it('announces the file, again after a reconnect, and detaches', () => {
    const s = socket();
    const detach = attachEditorBridge(s, () => view, {} as BridgeExecutor);
    s.reopen();
    detach();
    expect(s.sent).toEqual([
      { type: 'pcbjam.editor.attach', ...{ scope: 'acme', project: 'amp', copy: null, file: 'amp.kicad_sch', tool: 'eeschema' } },
      { type: 'pcbjam.editor.attach', ...{ scope: 'acme', project: 'amp', copy: null, file: 'amp.kicad_sch', tool: 'eeschema' } },
      { type: 'pcbjam.editor.detach' },
    ]);
  });

  it('runs an exec with the executor and answers with its outcome', async () => {
    const s = socket();
    const apply = vi.fn(async () => ({ status: 'applied' as const, added: ['u1'], changed: [], removed: [] }));
    attachEditorBridge(s, () => view, { apply, place: vi.fn(), read: vi.fn() } as unknown as BridgeExecutor);
    s.deliver({ type: 'pcbjam.editor.exec', id: 'x1', ...where, file: 'amp.kicad_sch', op: 'apply', edit });
    await settle();
    expect(apply).toHaveBeenCalledWith(edit, expect.any(AbortSignal), 'eeschema');
    expect(s.sent.at(-1)).toEqual({ type: 'pcbjam.editor.result', id: 'x1', result: { status: 'applied', added: ['u1'], changed: [], removed: [] } });
  });

  it('a dropped connection withdraws what still runs (an open Update PCB card among it, ai-chat 0006 S12)', async () => {
    const s = socket();
    let seen: AbortSignal | null = null;
    const updatePcb = vi.fn((_req: unknown, signal: AbortSignal) => {
      seen = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'declined', needsApproval: [] })));
    });
    attachEditorBridge(s, () => ({ ...view, file: 'amp.kicad_pcb', tool: 'pcbnew' }), { updatePcb } as unknown as BridgeExecutor);
    s.deliver({ type: 'pcbjam.editor.exec', id: 'd1', ...where, file: 'amp.kicad_pcb', op: 'update_pcb', dryRun: false, deleteUnused: true });
    await settle();
    expect(seen!.aborted).toBe(false);
    s.drop();
    expect(seen!.aborted).toBe(true);
  });

  it('refuses an exec meant for another project or working copy, or from a host that does not say', async () => {
    const s = socket();
    const executor = { apply: vi.fn(), place: vi.fn(), read: vi.fn() } as unknown as BridgeExecutor;
    attachEditorBridge(s, () => view, executor);
    s.deliver({ type: 'pcbjam.editor.exec', id: 'y1', ...where, project: 'other', file: 'amp.kicad_sch', op: 'read' });
    s.deliver({ type: 'pcbjam.editor.exec', id: 'y2', ...where, copy: 'c2', file: 'amp.kicad_sch', op: 'read' });
    s.deliver({ type: 'pcbjam.editor.exec', id: 'y3', file: 'amp.kicad_sch', op: 'read' });
    await settle();
    expect(executor.read).not.toHaveBeenCalled();
    expect(s.sent.slice(-3).map((m) => (m as { result: { code: string } }).result.code)).toEqual(['OTHER_FILE', 'OTHER_FILE', 'OTHER_FILE']);
  });

  it('refuses an exec for a file it no longer shows, and in another editor', async () => {
    const s = socket();
    let shown = view;
    const executor = { apply: vi.fn(), place: vi.fn(), read: vi.fn() } as unknown as BridgeExecutor;
    attachEditorBridge(s, () => shown, executor);
    shown = { ...view, file: 'other.kicad_sch' };
    s.deliver({ type: 'pcbjam.editor.exec', id: 'x1', ...where, file: 'amp.kicad_sch', op: 'read' });
    shown = { ...view, file: 'amp.kicad_pcb', tool: 'pcbnew' };
    s.deliver({ type: 'pcbjam.editor.exec', id: 'x2', ...where, file: 'amp.kicad_pcb', op: 'read' });
    await settle();
    expect(s.sent.slice(-2)).toEqual([
      { type: 'pcbjam.editor.result', id: 'x1', result: { error: 'The editor now shows other.kicad_sch, not amp.kicad_sch.', code: 'OTHER_FILE' } },
      { type: 'pcbjam.editor.result', id: 'x2', result: { error: 'Open the schematic editor for this.', code: 'NO_EDITOR' } },
    ]);
    expect(executor.read).not.toHaveBeenCalled();
  });

  it("a cancel aborts that exec's signal; detaching aborts what still runs", async () => {
    const s = socket();
    const signals: AbortSignal[] = [];
    const place = vi.fn((_blob: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ error: 'Placement cancelled', code: 'CANCELLED' })));
    });
    const detach = attachEditorBridge(s, () => view, { apply: vi.fn(), place, read: vi.fn() } as unknown as BridgeExecutor);
    s.deliver({ type: 'pcbjam.editor.exec', id: 'x1', ...where, file: 'amp.kicad_sch', op: 'place', blob: { sexpr: '(lib_symbols)' } });
    s.deliver({ type: 'pcbjam.editor.exec', id: 'x2', ...where, file: 'amp.kicad_sch', op: 'place', blob: { sexpr: '(lib_symbols)' } });
    s.deliver({ type: 'pcbjam.editor.cancel', id: 'x1' });
    await settle();
    expect(signals.map((x) => x.aborted)).toEqual([true, false]);
    expect(s.sent.at(-1)).toEqual({ type: 'pcbjam.editor.result', id: 'x1', result: { error: 'Placement cancelled', code: 'CANCELLED' } });
    detach();
    expect(signals[1]!.aborted).toBe(true);
  });

  it('runs Update PCB on a board only, with the panel asking the person', async () => {
    const s = socket();
    let shown: BridgeView = { ...view, file: 'amp.kicad_pcb', tool: 'pcbnew' };
    const updatePcb = vi.fn(async () => ({ status: 'previewed' as const, report: [], needsApproval: [] }));
    const confirm = vi.fn(async () => true);
    attachEditorBridge(s, () => shown, { updatePcb } as unknown as BridgeExecutor, confirm);
    s.deliver({ type: 'pcbjam.editor.exec', id: 'u1', ...where, file: 'amp.kicad_pcb', op: 'update_pcb', dryRun: true, deleteUnused: false });
    await settle();
    expect(updatePcb).toHaveBeenCalledWith({ dryRun: true, deleteUnused: false }, expect.any(AbortSignal), confirm);
    expect(s.sent.at(-1)).toEqual({ type: 'pcbjam.editor.result', id: 'u1', result: { status: 'previewed', report: [], needsApproval: [] } });

    shown = { ...view, file: 'amp.kicad_pcb', tool: 'eeschema' };
    s.deliver({ type: 'pcbjam.editor.exec', id: 'u2', ...where, file: 'amp.kicad_pcb', op: 'update_pcb', dryRun: false, deleteUnused: false });
    await settle();
    expect(s.sent.at(-1)).toEqual({ type: 'pcbjam.editor.result', id: 'u2', result: { error: 'Update PCB runs in the board editor: open amp.kicad_pcb.', code: 'NO_EDITOR' } });
    expect(updatePcb).toHaveBeenCalledTimes(1);
  });
});
