import { parseSexpr, type SNode } from '@pcbjam/shared';

export interface PlacementModule {
  kicadPlaceImportedItem(text: string): string | Promise<string>;
  kicadOpenFileBusy?(): boolean;
}
export function placementModule(): PlacementModule | null {
  const mod = (window as unknown as { Module?: Partial<PlacementModule> }).Module;
  return typeof mod?.kicadPlaceImportedItem === 'function' ? mod as PlacementModule : null;
}

/** Structural guard before the native clipboard parser, not a full KiCad validator. */
export function validatePlacement(text: string, tool: string): void {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 512 * 1024 || /[\0\x01-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('Invalid clipboard text');
  let depth = 0, quoted = false, forms = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\') { i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '(') { depth++; forms++; if (depth > 48 || forms > 12000) throw new Error('Clipboard structure exceeds limits'); }
    if (c === ')' && --depth < 0) throw new Error('Unbalanced clipboard');
  }
  if (depth || quoted) throw new Error('Unbalanced clipboard');
  const nodes = parseSexpr(text);
  const list = (node: SNode | undefined, tag: string): node is SNode[] => Array.isArray(node) && node[0] === tag;
  if (tool === 'pcbnew') {
    if (nodes.length !== 1 || !list(nodes[0], 'footprint')) throw new Error('Board placement accepts one footprint');
    return;
  }
  if (tool !== 'eeschema' || nodes.length !== 2 || !list(nodes[0], 'lib_symbols') || !list(nodes[1], 'symbol')) throw new Error('Schematic placement requires lib_symbols and one symbol');
  const definitions = nodes[0].slice(1);
  if (!definitions.length || definitions.length > 8 || definitions.some(node => !list(node, 'symbol'))) throw new Error('Invalid symbol definitions');
  const instance = nodes[1];
  const libIds = instance.filter(node => list(node, 'lib_id')) as SNode[][];
  const uuids = instance.filter(node => list(node, 'uuid')) as SNode[][];
  if (libIds.length !== 1 || uuids.length !== 1 || libIds[0]?.length !== 2 || uuids[0]?.length !== 2 || typeof uuids[0]?.[1] !== 'string' || !/^"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"$/i.test(uuids[0][1])) throw new Error('A symbol needs one library ID and UUID');
  if (!definitions.some(node => Array.isArray(node) && node[1] === libIds[0]?.[1])) throw new Error('Symbol definition does not match its instance');
}
