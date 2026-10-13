/**
 * Plugin edits (plugins 0023): a plugin's create / change / delete of items as ONE native KiCad
 * commit (`kicadPluginEditItems`). It lands on the undo stack and reaches collaborators through
 * the commit listener like any edit. The engine parses every item, as it does a collaborator's,
 * and refuses held items, unknown nets and a busy editor; here only sizes and item kinds are
 * checked before it runs, then the receipt is polled until the commit landed.
 */
import { EDIT_LIMITS } from '@pcbjam/plugin-platform/api';

export interface EditModule {
  kicadPluginEditItems(json: string): string;
  kicadPluginEditVersion?(): number;
  kicadPluginEditStatus?(operation: number): string;
  kicadCancelPluginEdit?(operation: number): boolean;
  kicadOpenFileBusy?(): boolean;
}
export interface EditRequest { label: string; upsert: { sexpr: string }[]; remove: string[]; libSymbols?: string[] }
export interface EditOutcome { status: 'applied'; added: string[]; changed: string[]; removed: string[] }

// Top-level item kinds each editor applies (0023 "What may be edited"); the engine checks again.
const KINDS: Record<string, RegExp> = {
  pcbnew: /^\s*\((segment|arc|via|zone|footprint|gr_line|gr_arc|gr_circle|gr_rect|gr_poly|gr_curve|gr_text|gr_text_box|dimension)[\s)]/,
  eeschema: /^\s*\((symbol|wire|bus|bus_entry|junction|no_connect|label|global_label|hierarchical_label|netclass_flag|text|text_box|polyline|rectangle|circle|arc|bezier)[\s)]/,
};
const MESSAGES: Record<string, string> = {
  HELD: 'A collaborator is working on some of these items',
  MISSING: 'Some items are not in this document',
  INVALID: 'The edit has an item this editor cannot apply',
  UNKNOWN_NET: 'An item names a net the board does not have (nets go by name, like (net "GND"))',
  BUSY: 'The editor is busy: finish the current tool first',
  READ_ONLY: 'This document is read-only',
  NO_EDITOR: 'The editor is not ready',
  TOO_LARGE: `An edit changes 1 to ${EDIT_LIMITS.items} items, at most ${EDIT_LIMITS.totalBytes / 1048576} MiB`,
};

export const editError = (code: string, detail = '') =>
  Object.assign(new Error((MESSAGES[code] ?? 'The plugin edit failed') + detail), { code });

export function editModule(): EditModule | null {
  const mod = (window as unknown as { Module?: Partial<EditModule> }).Module;
  return typeof mod?.kicadPluginEditItems === 'function' && mod.kicadPluginEditVersion?.() === 1 ? mod as EditModule : null;
}

/** How many items an edit touches; above `EDIT_LIMITS.confirmAbove` the user confirms it first. */
export const editSize = (edit: EditRequest) => edit.upsert.length + edit.remove.length;

/** Cheap checks before the native parser: sizes, and the item kinds this editor applies. */
export function validateEdit(edit: EditRequest, tool: string) {
  const kinds = KINDS[tool];
  if (!kinds) throw editError('NO_EDITOR');
  if (editSize(edit) < 1 || editSize(edit) > EDIT_LIMITS.items) throw editError('TOO_LARGE');
  let total = 0;
  for (const { sexpr } of edit.upsert) {
    if (sexpr.length > EDIT_LIMITS.itemBytes) throw editError('TOO_LARGE');
    if (!kinds.test(sexpr)) throw editError('INVALID', ': ' + sexpr.trim().slice(0, 40));
    total += sexpr.length;
  }
  for (const definition of edit.libSymbols ?? []) {
    if (tool !== 'eeschema' || !/^\s*\(symbol[\s)]/.test(definition)) throw editError('INVALID', ': libSymbols');
    total += definition.length;
  }
  if (total > EDIT_LIMITS.totalBytes) throw editError('TOO_LARGE');
}

/** Runs the edit natively and resolves once its commit landed. */
export async function applyEdit(mod: EditModule, edit: EditRequest, signal: AbortSignal): Promise<EditOutcome> {
  signal.throwIfAborted();
  if (!mod.kicadPluginEditStatus || !mod.kicadCancelPluginEdit) throw editError('NO_EDITOR');
  if (mod.kicadOpenFileBusy?.()) throw editError('BUSY');
  const started = JSON.parse(mod.kicadPluginEditItems(JSON.stringify(edit)));
  if (!started.ok || !Number.isSafeInteger(started.operation) || started.operation <= 0) throw editError(started.code ?? 'INVALID');
  const id: number = started.operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, outcome?: EditOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(outcome!);
    };
    // Only a queued edit can be withdrawn; one that started finishes and is one undo step.
    const withdraw = (code: string) => { if (mod.kicadCancelPluginEdit!(id)) finish(Object.assign(new Error(code === 'TIMEOUT' ? 'The editor did not apply the edit in time' : 'Plugin edit cancelled'), { code })); };
    const abort = () => withdraw('CANCELLED');
    const deadline = setTimeout(() => withdraw('TIMEOUT'), 30000);
    const poll = setInterval(() => {
      try {
        const result = JSON.parse(mod.kicadPluginEditStatus!(id));
        if (result.status === 'applied') finish(undefined, { status: 'applied', added: result.added, changed: result.changed, removed: result.removed });
        else if (result.status === 'error') finish(editError(result.code, result.ids?.length ? ': ' + result.ids.slice(0, 8).join(', ') : ''));
        else if (result.status === 'cancelled') finish(Object.assign(new Error('Plugin edit cancelled'), { code: 'CANCELLED' }));
        else if (result.status !== 'queued') finish(Object.assign(new Error('Plugin edit expired'), { code: 'EXPIRED' }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('The plugin edit failed'));
      }
    }, 25);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
