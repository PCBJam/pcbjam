/**
 * Which schematic files does the OPENED root actually load? KiCad's eeschema
 * loads the root plus the transitive closure of its `(property "Sheetfile"
 * "child.kicad_sch")` references — and nothing else. Only those in-memory
 * sheets need collab rooms: a schematic outside the hierarchy is never loaded,
 * so this session can neither diverge from nor clobber it, and C++ sheet
 * navigation can only reach hierarchy members anyway.
 *
 * This matters for repo-as-project uploads: a repository with N boards holds
 * N×sheets `.kicad_sch` files, and warming a room for every one of them (the
 * pre-scoping behavior) opened dozens of sockets per session for schematics
 * the wasm never even parsed. Same reasoning as pcbnew's directory-scoped
 * sibling restage.
 *
 * Heuristic parser (regex over s-expr text) with a SAFE fallback: any file
 * that cannot be read stays in the set unexpanded, and the caller falls back
 * to all project sheets when the closure cannot be computed at all — the cost
 * of over-warming is sockets, the cost of under-warming would be missed
 * collab, so unknowns err toward inclusion.
 *
 * The reference grammar itself (`SHEETFILE_RE`, `resolveSheetRef`) lives in
 * @pcbjam/shared: the platform's file ops resolve the same references.
 */
import { resolveSheetRef, SHEETFILE_RE } from "@pcbjam/shared";

/**
 * The opened hierarchy: `rootPath` plus every transitively referenced sheet
 * that exists in the project. Returns them in discovery order (root first).
 */
export function resolveSheetHierarchy(
  rootPath: string,
  readText: (relPath: string) => string | null,
  allSheets: readonly string[],
): string[] {
  const known = new Set(allSheets);
  const visited = new Set<string>([rootPath]);
  const order: string[] = [rootPath];
  const queue: string[] = [rootPath];
  while (queue.length) {
    const parent = queue.shift()!;
    const text = readText(parent);
    if (text === null) continue; // unreadable: keep it warmed, don't expand
    for (const match of text.matchAll(SHEETFILE_RE)) {
      const child = resolveSheetRef(parent, match[1]!);
      // Only project members get rooms — a reference outside the file list
      // has nothing to collaborate on (missing file, external path).
      if (!known.has(child) || visited.has(child)) continue;
      visited.add(child);
      order.push(child);
      queue.push(child);
    }
  }
  return order;
}
