import { pcbUpdateActions, pcbUpdateNeedsApproval, sameChanges, type AgentUpdatePcbResult, type PcbUpdateLine } from '@pcbjam/shared';
import { engineTourDeps } from '@/overlay/tours/engine';
import type { TourDeps } from '@/overlay/tours/declarative';
import { lastHostOp } from '@/wasm/stall-watch';

/**
 * KiCad's Update PCB from Schematic on the open board, for a plugin or an agent (plugins 0025
 * §5.4), through the wasm binding `kicadUpdatePcbFromSchematic`. Always a dry run first. With
 * `dryRun` that is the answer. Otherwise, when the dry run would remove or rewire anything
 * (`pcbUpdateNeedsApproval`), the person approves it in the editor (`confirm`, the host's
 * dialog, never the caller's). The real run (one undo step) carries the change lines of the
 * dry run it follows: KiCad previews again in that same step and refuses (CHANGED) unless the
 * changes are exactly those, so nothing the person did not see slips in.
 *
 * One at a time per tab: a second call answers BUSY, so no run changes the board under a
 * dialog the person is reading. Approval holds only for exactly the lines shown, each as many
 * times; an editor build that does not report odd names gets every change asked.
 */

type UpdatePcbModule = {
  kicadUpdatePcbFromSchematic(json: string): string;
  kicadUpdatePcbStatus(operation: number): string;
};
type NativeUpdate = { status: 'done'; report: PcbUpdateLine[]; added: string[]; oddNames?: string[] };
type UpdateError = { error: string; code: string };

/** Asks the person to approve these changes in the editor; false = declined or stopped. */
export type ConfirmUpdatePcb = (changes: string[], signal: AbortSignal) => Promise<boolean>;

const REFUSED: Record<string, string> = {
  NO_EDITOR: 'Update PCB runs in the board editor: open the board first.',
  BUSY: 'The board editor is busy: try again in a moment.',
};

const failure = (error: unknown, fallback: string): UpdateError => {
  const e = error as Error & { code?: string };
  return { error: e?.message || fallback, code: typeof e?.code === 'string' ? e.code : 'FAILED' };
};

/** One native run, queued on KiCad's event loop; resolves with its report. */
async function runNative(
  mod: UpdatePcbModule,
  req: { dryRun: boolean; deleteUnused: boolean; expect?: string[] },
  opts: { timeoutMs: number; pollMs: number },
): Promise<NativeUpdate | UpdateError> {
  const receipt = JSON.parse(mod.kicadUpdatePcbFromSchematic(JSON.stringify(req))) as { ok: boolean; operation?: number; code?: string };
  if (!receipt.ok || typeof receipt.operation !== 'number') {
    const code = receipt.code ?? 'FAILED';
    return { error: REFUSED[code] ?? 'KiCad refused Update PCB', code };
  }
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const status = JSON.parse(mod.kicadUpdatePcbStatus(receipt.operation)) as { status: string; error?: string; code?: string };
    if (status.status === 'done') return status as NativeUpdate;
    if (status.status === 'error') return { error: status.error ?? 'Update PCB failed', code: status.code ?? 'FAILED' };
    if (status.status !== 'queued') return { error: 'Update PCB expired before it ran', code: 'FAILED' };
    if (Date.now() >= deadline) return { error: 'Update PCB did not finish in time', code: 'TIMEOUT' };
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

let running = false;

export async function updatePcb(
  req: { dryRun: boolean; deleteUnused: boolean },
  signal: AbortSignal,
  confirm: ConfirmUpdatePcb,
  opts: { deps?: TourDeps; timeoutMs?: number; pollMs?: number } = {},
): Promise<AgentUpdatePcbResult> {
  if (running) return { error: 'Another Update PCB is still running or waiting for your answer', code: 'BUSY' };
  running = true;
  Object.assign(lastHostOp, { op: req.dryRun ? 'Update PCB (preview)' : 'Update PCB', startedAt: Date.now(), endedAt: null });
  try {
    return await once(req, signal, confirm, opts);
  } finally {
    running = false;
    lastHostOp.endedAt = Date.now();
  }
}

async function once(
  req: { dryRun: boolean; deleteUnused: boolean },
  signal: AbortSignal,
  confirm: ConfirmUpdatePcb,
  opts: { deps?: TourDeps; timeoutMs?: number; pollMs?: number },
): Promise<AgentUpdatePcbResult> {
  const deps = opts.deps ?? engineTourDeps;
  const timing = { timeoutMs: opts.timeoutMs ?? 120_000, pollMs: opts.pollMs ?? 50 };
  const mod = (window as unknown as { Module?: Partial<UpdatePcbModule> }).Module;
  if (typeof mod?.kicadUpdatePcbFromSchematic !== 'function' || typeof mod.kicadUpdatePcbStatus !== 'function') {
    return { error: 'This editor build cannot run Update PCB. Reload PCBJam.', code: 'NO_EDITOR' };
  }
  const native = mod as UpdatePcbModule;
  if (deps.openBusy()) return { error: 'The board is still loading', code: 'BUSY' };
  if (deps.modalDialogOpen()) return { error: 'Close the open dialog first', code: 'BUSY' };
  try {
    let approved: string[] = [];
    // Every change of the run the person approved: after an approval, the run applies only
    // while the whole update is still exactly that one.
    let approvedRun: string[] | null = null;
    for (let round = 0; round < 3; round++) {
      if (signal.aborted) return { error: 'Update PCB cancelled', code: 'CANCELLED' };
      const preview = await runNative(native, { dryRun: true, deleteUnused: req.deleteUnused }, timing);
      if ('error' in preview) return preview;
      const needsApproval = pcbUpdateNeedsApproval(preview.report, preview.oddNames ?? null);
      if (req.dryRun) return { status: 'previewed', report: preview.report, needsApproval };
      const actions = pcbUpdateActions(preview.report);
      const asApproved = approvedRun === null || sameChanges(actions, approvedRun);
      // Changed since the approval, but not in what the dialog would show: this run ends.
      if (!asApproved && (!needsApproval.length || sameChanges(needsApproval, approved))) {
        return { error: 'The schematic changed while you approved the update; ask again', code: 'CHANGED' };
      }
      if (asApproved && (!needsApproval.length || sameChanges(needsApproval, approved))) {
        if (signal.aborted) return { error: 'Update PCB cancelled', code: 'CANCELLED' };
        const done = await runNative(native, { dryRun: false, deleteUnused: req.deleteUnused, expect: actions }, timing);
        if ('error' in done && done.code === 'CHANGED') continue;
        if ('error' in done) return done;
        return { status: 'applied', report: done.report, added: done.added, approved: needsApproval };
      }
      if (signal.aborted) return { error: 'Update PCB cancelled', code: 'CANCELLED' };
      if (!(await confirm(needsApproval, signal))) return { status: 'declined', needsApproval };
      approved = needsApproval;
      approvedRun = actions;
    }
    return { error: 'The schematic kept changing while you approved the update; ask again', code: 'CHANGED' };
  } catch (error) {
    return failure(error, 'Update PCB failed');
  }
}
