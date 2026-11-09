/**
 * KiCad's own highlight for a plugin (plugins 0025 §5.4, `editor.highlight`): items brightened
 * and nets highlighted by the wasm hook `kicadPluginHighlight`, which replaces whatever a
 * plugin highlighted before. It wears off after `durationMs`, or when `clearHighlight` runs
 * (the plugin stops, the file changes). Nothing in the document changes.
 */

type HighlightModule = { kicadPluginHighlight(json: string): string };
export type HighlightResult = { highlighted: string[]; missing: string[]; nets: string[]; missingNets: string[] };

let timer: ReturnType<typeof setTimeout> | undefined;

const highlightModule = (): HighlightModule | null => {
  const mod = (globalThis as { Module?: Partial<HighlightModule> }).Module;
  return typeof mod?.kicadPluginHighlight === 'function' ? (mod as HighlightModule) : null;
};

function run(ids: string[], nets: string[]): HighlightResult {
  const mod = highlightModule();
  if (!mod) throw new Error('This editor build cannot highlight. Reload PCBJam.');
  const answer = JSON.parse(mod.kicadPluginHighlight(JSON.stringify({ ids, nets }))) as
    | ({ ok: true } & HighlightResult)
    | { ok: false; error: string };
  if (!answer.ok) throw new Error(answer.error === 'NO_EDITOR' ? 'The editor is not ready' : 'Invalid highlight request');
  return { highlighted: answer.highlighted, missing: answer.missing, nets: answer.nets, missingNets: answer.missingNets };
}

export function highlight(request: { ids: string[]; nets: string[]; durationMs: number }): HighlightResult {
  clearTimeout(timer);
  timer = undefined;
  const result = run(request.ids, request.nets);
  if (request.ids.length || request.nets.length) timer = setTimeout(clearHighlight, request.durationMs);
  return result;
}

/** Takes a plugin's highlight back; a no-op when none is showing. */
export function clearHighlight(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  try {
    run([], []);
  } catch {
    // The editor went away with the highlight.
  }
}
