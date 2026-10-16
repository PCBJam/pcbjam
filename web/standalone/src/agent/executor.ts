/**
 * The agent executor (ai-chat 0003 step 4): carries out what the AI chat's
 * schematic tools computed (`@pcbjam/shared` schematic-ops) in the OPEN editor,
 * with KiCad itself, never behind its back:
 *
 *   applyAgentEdit  one native commit (`kicadPluginEditItems`): KiCad parses every
 *                   item, the edit is one undo step ("PCBJam AI: …") and reaches
 *                   teammates through the commit listener like any edit
 *   placeAgentPart  KiCad's own Place Symbol (`kicadPlaceImportedItem`): the part
 *                   follows the cursor and the person clicks where it goes
 *   readParts       KiCad's live view of the shown sheet: its parts and its nets
 *   updatePcb       KiCad's Update PCB from Schematic on the open board
 *                   (`kicadUpdatePcbFromSchematic`): a dry run lists the changes; a real
 *                   run asks the person first when it would remove or rewire anything
 *
 * The edits arrive computed; nothing here builds KiCad text. Every refusal comes
 * back as `{error, code}` so the agent reads KiCad's reason and carries on. The
 * caller's signal is the chat turn's: Stop withdraws a queued edit or an armed
 * placement. First-party: the AI chat gates it (`aiChat`), not the plugin toggles.
 */
import { pcbUpdateActions, pcbUpdateNeedsApproval, type AgentUpdatePcbResult, type NetlistNet, type PcbUpdateLine, type SchematicEdit } from '@pcbjam/shared';
import { engineTourDeps } from '@/overlay/tours/engine';
import { parseSheetNets, parseSheetSymbols, type SheetSymbol, type TourDeps } from '@/overlay/tours/declarative';
import { applyEdit, editModule, validateEdit, type EditRequest } from '@/plugins/edits';
import { placeImportedItem, placementModule, validatePlacement } from '@/plugins/placement';

/** Every agent edit's undo step starts with this, so the person sees who made it. */
export const AGENT_UNDO_PREFIX = 'PCBJam AI: ';

export interface AgentError {
  error: string;
  code: string;
}
export type AgentApplyResult = { status: 'applied'; added: string[]; changed: string[]; removed: string[] } | AgentError;
export type AgentPlaceResult =
  | { status: 'placed'; ref: string; uuid: string; at: [number, number] }
  | { status: 'placed'; note: string }
  | { status: 'cancelled' }
  | AgentError;

/** A placed part as KiCad shows it, in `listParts`' terms (mm, y down). */
export interface AgentPart {
  ref: string;
  value: string;
  libId: string;
  footprint: string;
  uuid: string;
  at: [number, number];
  angle: number;
  mirror: string;
}
export type AgentReadResult = { parts: AgentPart[]; nets: NetlistNet[] } | AgentError;

/** Schematic units: 10 000 per mm. */
const mm = (iu: number | undefined) => Math.round(iu ?? 0) / 10000;

const failure = (error: unknown, fallback: string): AgentError => {
  const e = error as Error & { code?: string };
  return { error: e?.message || fallback, code: typeof e?.code === 'string' ? e.code : 'FAILED' };
};

/** `SchematicEdit` → the plugin edit request (definitions travel as a list). */
export function agentEditRequest(edit: SchematicEdit): EditRequest {
  const label = edit.label.startsWith(AGENT_UNDO_PREFIX) ? edit.label : AGENT_UNDO_PREFIX + edit.label;
  const libSymbols = Object.values(edit.libSymbols ?? {});
  return { label, upsert: edit.upsert, remove: edit.remove, ...(libSymbols.length ? { libSymbols } : {}) };
}

/** Applies `edit` as one native commit; resolves once it landed (or with KiCad's refusal). */
export async function applyAgentEdit(edit: SchematicEdit, signal: AbortSignal, tool = 'eeschema'): Promise<AgentApplyResult> {
  try {
    const mod = editModule();
    if (!mod) return { error: 'This editor build cannot apply edits natively. Reload PCBJam.', code: 'NO_EDITOR' };
    const request = agentEditRequest(edit);
    validateEdit(request, tool);
    return await applyEdit(mod, request, signal);
  } catch (error) {
    return failure(error, 'The edit failed');
  }
}

function sheetSymbols(deps: TourDeps): SheetSymbol[] {
  return parseSheetSymbols(deps.symbols()) ?? [];
}

const toPart = (s: SheetSymbol): AgentPart => ({
  ref: s.ref,
  value: s.value,
  libId: s.libId,
  footprint: s.footprint,
  uuid: s.uuid,
  at: [mm(s.x), mm(s.y)],
  angle: s.angle ?? 0,
  mirror: s.mirror ?? '',
});

/**
 * Arms KiCad's Place Symbol with `blob` (`placementBlob`: the definition and one
 * unannotated instance); resolves when the person clicks (the new part, found by
 * what the sheet gained) or presses Esc.
 */
export async function placeAgentPart(
  blob: { sexpr: string },
  signal: AbortSignal,
  opts: { tool?: string; deps?: TourDeps; settleMs?: number } = {},
): Promise<AgentPlaceResult> {
  const deps = opts.deps ?? engineTourDeps;
  try {
    validatePlacement(blob.sexpr, opts.tool ?? 'eeschema');
  } catch (error) {
    return { error: (error as Error).message, code: 'INVALID' };
  }
  try {
    const mod = placementModule();
    if (!mod) return { error: 'This editor build cannot place parts. Reload PCBJam.', code: 'NO_EDITOR' };
    if (mod.kicadOpenFileBusy?.()) return { error: 'The editor is busy: finish the current tool first', code: 'BUSY' };
    const before = new Set(sheetSymbols(deps).map((s) => s.uuid));
    const { status } = await placeImportedItem(mod, blob.sexpr, signal);
    if (status === 'cancelled') return { status: 'cancelled' };
    // The commit lands just before the receipt flips; the sheet list can trail it briefly.
    const settle = Date.now() + (opts.settleMs ?? 2000);
    for (;;) {
      const placed = sheetSymbols(deps).find((s) => !before.has(s.uuid) && !s.ref.startsWith('#'));
      if (placed) return { status: 'placed', ref: placed.ref, uuid: placed.uuid, at: [mm(placed.x), mm(placed.y)] };
      if (Date.now() >= settle) return { status: 'placed', note: 'Placed, but it does not show in the sheet list yet.' };
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (error) {
    const e = error as Error;
    return signal.aborted ? { error: 'Placement cancelled', code: 'CANCELLED' } : failure(e, 'Placement failed');
  }
}

/** The shown sheet as KiCad has it now: parts (power symbols left out) and nets. */
export function readParts(deps: TourDeps = engineTourDeps): AgentReadResult {
  // As the plugins' sheet reads: an engine read while a file opens answers an empty sheet,
  // and one under a modal dialog runs inside its nested event loop.
  if (deps.openBusy()) return { error: 'The document is still loading', code: 'BUSY' };
  if (deps.modalDialogOpen()) return { error: 'Close the open dialog first', code: 'BUSY' };
  try {
    const parts = sheetSymbols(deps).filter((s) => !s.ref.startsWith('#')).map(toPart);
    const nets = (parseSheetNets(deps.nets()) ?? []).map((n) => ({
      net: n.net,
      pins: n.pins.map((p) => ({ ref: p.ref, pin: p.pin, ...(p.name ? { name: p.name } : {}) })),
    }));
    return { parts, nets };
  } catch (error) {
    return failure(error, 'Could not read the sheet');
  }
}

type UpdatePcbModule = {
  kicadUpdatePcbFromSchematic(json: string): string;
  kicadUpdatePcbStatus(operation: number): string;
};
type NativeUpdate = { status: 'done'; report: PcbUpdateLine[]; added: string[]; oddNames?: string[] };

/** Asks the person to approve these changes (the chat panel's card); false = declined or stopped. */
export type ConfirmUpdatePcb = (changes: string[], signal: AbortSignal) => Promise<boolean>;

const UPDATE_REFUSED: Record<string, string> = {
  NO_EDITOR: 'Update PCB runs in the board editor: open the board first.',
  BUSY: 'The board editor is busy: try again in a moment.',
};

/** One native run, queued on KiCad's event loop; resolves with its report. */
async function runNativeUpdate(
  mod: UpdatePcbModule,
  req: { dryRun: boolean; deleteUnused: boolean; expect?: string[] },
  opts: { timeoutMs: number; pollMs: number },
): Promise<NativeUpdate | AgentError> {
  const receipt = JSON.parse(mod.kicadUpdatePcbFromSchematic(JSON.stringify(req))) as { ok: boolean; operation?: number; code?: string };
  if (!receipt.ok || typeof receipt.operation !== 'number') {
    const code = receipt.code ?? 'FAILED';
    return { error: UPDATE_REFUSED[code] ?? 'KiCad refused Update PCB', code };
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

/**
 * KiCad's Update PCB from Schematic on the open board. Always a dry run first. With
 * `dryRun` that is the answer; otherwise, when the dry run would remove or rewire anything
 * (`pcbUpdateNeedsApproval`), the person approves it in the chat panel. The real run (one
 * undo step, "Update Netlist") carries the change lines of the dry run it follows: KiCad
 * previews again in that same step and refuses (CHANGED) unless the changes are exactly
 * those, so nothing the person did not see slips in; then it is previewed and asked again.
 * The signal is the chat turn's: Stop declines.
 */
export async function updatePcb(
  req: { dryRun: boolean; deleteUnused: boolean },
  signal: AbortSignal,
  confirm: ConfirmUpdatePcb,
  opts: { deps?: TourDeps; timeoutMs?: number; pollMs?: number } = {},
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
    for (let round = 0; round < 3; round++) {
      if (signal.aborted) return { error: 'Update PCB cancelled', code: 'CANCELLED' };
      const preview = await runNativeUpdate(native, { dryRun: true, deleteUnused: req.deleteUnused }, timing);
      if ('error' in preview) return preview;
      const needsApproval = pcbUpdateNeedsApproval(preview.report, preview.oddNames ?? []);
      if (req.dryRun) return { status: 'previewed', report: preview.report, needsApproval };
      if (needsApproval.every((change) => approved.includes(change))) {
        if (signal.aborted) return { error: 'Update PCB cancelled', code: 'CANCELLED' };
        const expect = pcbUpdateActions(preview.report);
        const done = await runNativeUpdate(native, { dryRun: false, deleteUnused: req.deleteUnused, expect }, timing);
        if ('error' in done && done.code === 'CHANGED') continue;
        if ('error' in done) return done;
        return { status: 'applied', report: done.report, added: done.added, approved: needsApproval };
      }
      if (!(await confirm(needsApproval, signal))) return { status: 'declined', needsApproval };
      approved = needsApproval;
    }
    return { error: 'The schematic kept changing while you approved the update; ask again', code: 'CHANGED' };
  } catch (error) {
    return failure(error, 'Update PCB failed');
  }
}
