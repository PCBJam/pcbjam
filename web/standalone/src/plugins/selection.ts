/** Plugin platform `editor.select`: the editor side of the engine's kicadPluginSelectItems. */
interface SelectModule {
  kicadPluginSelectItems(uuidsJson: string): string | Promise<string>;
  kicadPluginSelectVersion(): number;
  kicadOpenFileBusy?(): boolean;
}
export interface SelectResult { selected: string[]; held: string[]; missing: string[] }
export const SELECT_MAX = 500;
const REFUSALS: Record<string, string> = {
  TOOL_ACTIVE: 'Finish or cancel the current editor tool before a plugin changes the selection',
  NO_EDITOR: 'The editor is not ready to change the selection',
  INVALID: 'Invalid selection request',
};

/** Null until an engine build that has the entry point is loaded (feature-detected, like placement). */
export function selectModule(): SelectModule | null {
  const mod = (window as unknown as { Module?: Partial<SelectModule> }).Module;
  try { return typeof mod?.kicadPluginSelectItems === 'function' && mod.kicadPluginSelectVersion?.() === 1 ? mod as SelectModule : null; }
  catch { return null; }
}

/**
 * Replace the local selection. Items a collaborator holds are never taken (`held`), unknown ids
 * come back as `missing`. Only uuids the caller asked for are ever returned: the engine's answer is
 * data from a native module and is not passed through to a plugin unchecked.
 */
export async function selectItems(ids: string[]): Promise<SelectResult> {
  const mod = selectModule();
  if (!mod) throw new Error('Selection is unavailable in this editor');
  if (ids.length > SELECT_MAX || ids.some(id => typeof id !== 'string' || !id || id.length > 64)) throw new Error(REFUSALS.INVALID);
  // A load suspends the engine mid-open; entering it now would touch a half-built document.
  if (mod.kicadOpenFileBusy?.()) throw new Error(REFUSALS.NO_EDITOR);
  let reply: unknown;
  try { reply = JSON.parse(await mod.kicadPluginSelectItems(JSON.stringify(ids))); }
  catch { throw new Error('The editor could not change the selection'); }
  const answer = reply as { ok?: unknown; error?: unknown; selected?: unknown; held?: unknown; missing?: unknown };
  if (answer?.ok !== true) throw new Error(REFUSALS[String(answer?.error)] ?? 'The editor could not change the selection');
  const asked = new Set(ids);
  const list = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && asked.has(id)))] : [];
  return { selected: list(answer.selected), held: list(answer.held), missing: list(answer.missing) };
}
