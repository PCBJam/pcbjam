/** Plugin platform `board.geometry`: the editor side of the engine's kicadPluginBoardGeometry. */
interface GeometryModule {
  kicadPluginBoardGeometry(optionsJson: string, cursorJson: string, budgetMs: number, maxChars: number): string | Promise<string>;
  kicadPluginBoardGeometryVersion(): number;
  kicadOpenFileBusy?(): boolean;
}
export interface GeometryRequest { tracks: boolean; zones: boolean }
const REFUSALS: Record<string, string> = {
  // Same wording as a changed document: the plugin's recovery is the same, start again.
  CHANGED: 'Document changed: get its current revision and retry',
  BUSY: 'The editor is not ready to read the board',
  NO_BOARD: 'Board shapes are unavailable in this editor',
  NOT_PCB: 'Board shapes are unavailable in this editor',
};

/** Null until an engine build that has the entry point is loaded (feature-detected per call). */
export function geometryModule(): GeometryModule | null {
  const mod = (window as unknown as { Module?: Partial<GeometryModule> }).Module;
  try { return typeof mod?.kicadPluginBoardGeometry === 'function' && mod.kicadPluginBoardGeometryVersion?.() === 1 ? mod as GeometryModule : null; }
  catch { return null; }
}

/**
 * A slice reader over the engine's board walk, in the shape the plugin host's export session expects:
 * newline-delimited JSON text, at most `maxChars` per read. The engine bounds its own time per call
 * (it cannot be interrupted from here), so `budgetMs` is handed to it rather than measured here.
 * Only two booleans ever reach the engine; the cursor is the engine's own, passed back verbatim.
 */
export function openGeometry(request: GeometryRequest) {
  const options = JSON.stringify({ tracks: request.tracks === true, zones: request.zones === true });
  let cursor = '', buffer = '', finished = false;
  return {
    read: async (budgetMs: number, maxChars: number): Promise<{ text: string; done: boolean }> => {
      if (!finished && buffer.length < maxChars) {
        const mod = geometryModule();
        if (!mod) throw new Error(REFUSALS.NO_BOARD);
        // A load suspends the engine mid-open; the engine refuses too, this avoids entering it at all.
        if (mod.kicadOpenFileBusy?.()) throw new Error(REFUSALS.BUSY);
        const reply = await mod.kicadPluginBoardGeometry(options, cursor, Math.min(Math.max(budgetMs, 1), 50), Math.min(Math.max(maxChars, 1024), 4 * 1024 * 1024));
        const at = typeof reply === 'string' ? reply.indexOf('\n') : -1;
        let envelope: { ok?: unknown; error?: unknown; next?: unknown };
        try { envelope = JSON.parse((reply as string).slice(0, at)); }
        catch { throw new Error('The editor could not read the board'); }
        if (at < 0 || envelope?.ok !== true) throw new Error(REFUSALS[String(envelope?.error)] ?? 'The editor could not read the board');
        buffer += (reply as string).slice(at + 1);
        if (envelope.next === null) finished = true;
        else if (envelope.next && typeof envelope.next === 'object') cursor = JSON.stringify(envelope.next);
        else throw new Error('The editor could not read the board');
      }
      // Never split a surrogate pair across two slices.
      let cut = Math.min(maxChars, buffer.length);
      if (cut < buffer.length && cut > 0 && (buffer.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut--;
      const text = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return { text, done: finished && !buffer.length };
    },
  };
}
