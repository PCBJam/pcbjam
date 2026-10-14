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
 *
 * The edits arrive computed; nothing here builds KiCad text. Every refusal comes
 * back as `{error, code}` so the agent reads KiCad's reason and carries on. The
 * caller's signal is the chat turn's: Stop withdraws a queued edit or an armed
 * placement. First-party: the AI chat gates it (`aiChat`), not the plugin toggles.
 */
import type { NetlistNet, SchematicEdit } from '@pcbjam/shared';
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
