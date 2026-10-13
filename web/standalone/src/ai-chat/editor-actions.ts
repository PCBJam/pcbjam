import { API_BASE_URL } from '@/lib/config';
import { pluginSheetAdapter } from '@/overlay/plugin-tours';
import { applyEdit, editModule, validateEdit, type EditRequest } from '@/plugins/edits';
import { placeImportedItem, placementModule } from '@/plugins/placement';
import { buildSymbolImport } from '@/wasm/import-item';

/**
 * AI chat editor actions (POC): what the agent asks the OPEN editor to do. Each
 * one is carried out by KiCad here, never written behind its back:
 *
 *   editor_list_symbols    KiCad's own list of the placed symbols on the shown sheet
 *   editor_remove_symbol   one native commit (pluginEdits): an undo step, sent to teammates
 *   editor_place_symbol    KiCad's Place Symbol tool (pluginPlacement): the part follows
 *                          the cursor and the person clicks where it goes
 *   editor_connect_pin     a label on the pin's end, one native commit
 *
 * The agent runs server-side; it sends these as browser-executed tool calls and
 * gets KiCad's answer back (applied, or the reason it was refused).
 */

export const EDITOR_TOOLS = new Set(['editor_list_symbols', 'editor_remove_symbol', 'editor_place_symbol', 'editor_connect_pin']);

export interface EditorContext { scope: string; project: string; file: string; tool: string; signal: AbortSignal }

interface SheetSymbol { uuid: string; libId: string; ref: string; value: string; angle: number; mirror: string; x: number; y: number }

/** Schematic units: 10 000 per mm. */
const MM = 10000;
const mm = (iu: number) => Math.round((iu / MM) * 100) / 100;

function sheetSymbols(): SheetSymbol[] {
  return pluginSheetAdapter().symbols() as SheetSymbol[];
}

function findSymbol(ref: string): SheetSymbol {
  const hit = sheetSymbols().find((s) => s.ref.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw new Error(`There is no ${ref} on this sheet.`);
  return hit;
}

async function nativeEdit(edit: EditRequest, ctx: EditorContext) {
  const mod = editModule();
  if (!mod) throw new Error('This editor build cannot apply edits natively. Reload PCBJam.');
  validateEdit(edit, ctx.tool);
  return applyEdit(mod, edit, ctx.signal);
}

// --- library symbol definitions, from the sheet itself -------------------------

function blockEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** The sheet's embedded library symbols (`(lib_symbols …)`), by full lib id. */
async function embeddedSymbols(ctx: EditorContext): Promise<Map<string, string>> {
  const path = ctx.file.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${API_BASE_URL}/api/scopes/${encodeURIComponent(ctx.scope)}/projects/${encodeURIComponent(ctx.project)}/files/${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Could not read ${ctx.file} (HTTP ${res.status}).`);
  const text = await res.text();
  const out = new Map<string, string>();
  const start = text.indexOf('(lib_symbols');
  if (start < 0) return out;
  const section = text.slice(start, blockEnd(text, start) + 1);
  for (const m of section.matchAll(/\(symbol\s+"([^"]+)"/g)) {
    if (/_\d+_\d+$/.test(m[1]!) || out.has(m[1]!)) continue;
    out.set(m[1]!, section.slice(m.index!, blockEnd(section, m.index!) + 1));
  }
  return out;
}

/** Pin connection points of a library symbol, mm, library axes (y up). */
function libPins(def: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const re = /\(pin\s+\S+\s+\S+\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)[^)]*\)[\s\S]*?\(number\s+"([^"]*)"/g;
  for (const m of def.matchAll(re)) out.set(m[3]!, { x: Number(m[1]), y: Number(m[2]) });
  return out;
}

// --- the actions -----------------------------------------------------------------

async function listSymbols() {
  return {
    symbols: sheetSymbols()
      .filter((s) => !s.ref.startsWith('#'))
      .map((s) => ({ ref: s.ref, value: s.value, libId: s.libId, at: [mm(s.x), mm(s.y)] })),
  };
}

async function removeSymbol(input: { ref?: string }, ctx: EditorContext) {
  if (!input.ref) throw new Error('Which part? Give its reference, e.g. R4.');
  const symbol = findSymbol(input.ref);
  await nativeEdit({ label: `PCBJam AI: remove ${symbol.ref}`, upsert: [], remove: [symbol.uuid] }, ctx);
  return { removed: symbol.ref, value: symbol.value, undo: 'One undo step in the editor (Ctrl+Z).' };
}

async function placeSymbol(input: { value?: string; lib_id?: string }, ctx: EditorContext) {
  const defs = await embeddedSymbols(ctx);
  const libId = input.lib_id ?? [...defs.keys()].find((id) => /:R$/.test(id));
  const def = libId ? defs.get(libId) : undefined;
  if (!libId || !def) {
    throw new Error(`The sheet has no ${input.lib_id ?? 'resistor'} symbol to place. Symbols it has: ${[...defs.keys()].join(', ')}`);
  }
  const [nick, name] = [libId.slice(0, libId.indexOf(':')), libId.slice(libId.indexOf(':') + 1)];
  const libText = `(kicad_symbol_lib (version 20231120) (generator "pcbjam_ai") ${def.replace(/^\(symbol\s+"[^"]*"/, `(symbol "${name}"`)})`;
  let { sexpr } = buildSymbolImport(libText, name, nick, 0, 0);
  if (input.value) {
    // Only the placed symbol's Value, not the library definition's.
    const at = sexpr.indexOf('\n(symbol (lib_id');
    sexpr = sexpr.slice(0, at) + sexpr.slice(at).replace(/\(property "Value" "(?:[^"\\]|\\.)*"/, `(property "Value" "${input.value.replace(/"/g, '')}"`);
  }

  const mod = placementModule();
  if (!mod || mod.kicadOpenFileBusy?.()) throw new Error('The editor is not ready for placement.');
  const before = new Set(sheetSymbols().map((s) => s.uuid));
  const { status } = await placeImportedItem(mod, sexpr, ctx.signal);
  if (status === 'cancelled') return { status: 'cancelled', note: 'The user pressed Esc instead of placing it.' };
  // The commit lands just before the status flips; give the sheet list a moment to catch up.
  for (let i = 0; i < 40; i++) {
    const placed = sheetSymbols().find((s) => !before.has(s.uuid));
    if (placed) {
      return { placed: placed.ref, value: placed.value, libId: placed.libId, at: [mm(placed.x), mm(placed.y)], pins: [...libPins(def).keys()], undo: 'One undo step in the editor (Ctrl+Z).' };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { status: 'placed', note: 'Placed, but it does not show in the sheet list yet.' };
}

async function connectPin(input: { ref?: string; pin?: string; net?: string }, ctx: EditorContext) {
  if (!input.ref || !input.pin || !input.net) throw new Error('Give ref, pin and net, e.g. R5, 1, +3V3.');
  const symbol = findSymbol(input.ref);
  if (symbol.angle !== 0 || symbol.mirror) throw new Error(`${symbol.ref} is rotated or mirrored; this prototype only connects symbols at 0°.`);
  const def = (await embeddedSymbols(ctx)).get(symbol.libId);
  const pin = def ? libPins(def).get(input.pin) : undefined;
  if (!pin) throw new Error(`${symbol.ref} has no pin ${input.pin}.`);
  // Library y points up, the sheet's down.
  const x = mm(symbol.x) + pin.x;
  const y = mm(symbol.y) - pin.y;
  const net = input.net.replace(/"/g, '');
  const label = `(label "${net}" (at ${+x.toFixed(4)} ${+y.toFixed(4)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${crypto.randomUUID()}"))`;
  await nativeEdit({ label: `PCBJam AI: connect ${symbol.ref}.${input.pin} to ${net}`, upsert: [{ sexpr: label }], remove: [] }, ctx);
  return { connected: `${symbol.ref}.${input.pin}`, net, at: [x, y], undo: 'One undo step in the editor (Ctrl+Z).' };
}

/** Runs one action; failures come back as `{error}` so the agent reads KiCad's reason and carries on. */
export async function runEditorTool(name: string, input: unknown, ctx: EditorContext): Promise<unknown> {
  if (ctx.tool !== 'eeschema') return { error: 'Open the schematic editor for this.' };
  const args = (input ?? {}) as Record<string, string | undefined>;
  try {
    switch (name) {
      case 'editor_list_symbols': return await listSymbols();
      case 'editor_remove_symbol': return await removeSymbol(args, ctx);
      case 'editor_place_symbol': return await placeSymbol(args, ctx);
      case 'editor_connect_pin': return await connectPin(args, ctx);
      default: return { error: `Unknown editor action ${name}.` };
    }
  } catch (error) {
    const e = error as Error & { code?: string };
    return { error: e.message, ...(e.code ? { code: e.code } : {}) };
  }
}
