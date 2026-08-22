import {
  libSymbolsFromLayout,
  type KicadDoc,
  type Slot,
} from "@pcbjam/shared";

/**
 * Canonical signature for the part of a KiCad document the item bridge cannot
 * hot-apply. Top-level UUID item references are deliberately ignored: their
 * presence, bodies and parent graph are projected by the acknowledged items
 * protocol. Everything else requires the native instance to have opened the
 * same structure, including root form, anonymous atoms, keyed layout groups
 * and embedded library definitions.
 *
 * Root head order is normalized because KiCad writers may reorder independent
 * global forms. Order *within* a repeated head group remains significant and
 * library definitions are keyed/sorted by their semantic library ID.
 */
export function nonItemProjectionSignature(doc: KicadDoc): string {
  const groups = new Map<string, Slot[]>();
  const atoms: Slot[] = [];

  for (const slot of doc.layout) {
    if ("item" in slot) continue;
    if ("atom" in slot) {
      atoms.push(slot);
      continue;
    }
    // Definitions have their own semantic-key map. Record that normalized map
    // below instead of retaining source/writer ordering in the layout group.
    if (slot.k === "lib_symbols") continue;
    const group = groups.get(slot.k) ?? [];
    group.push(slot);
    groups.set(slot.k, group);
  }

  const heads = [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const libraries = Object.entries(
    libSymbolsFromLayout(doc.layout, doc.items),
  ).sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify({ root: doc.root, atoms, heads, libraries });
}
