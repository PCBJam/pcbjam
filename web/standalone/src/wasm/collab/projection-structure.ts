import {
  libSymbolsFromLayout,
  type KicadDoc,
  type Slot,
} from "@pcbjam/shared";

/**
 * The native projection boundary has two deliberately separate parts.
 *
 * `hardSignature` cannot be changed by the item bridge at all. Library
 * definitions are kept as an exact map because a symbol-root wire can carry a
 * definition into native in a few audited cases; treating them as hard state
 * would reject those safe applies, while omitting them would silently bless
 * definition-only drift.
 */
export interface NonItemProjectionState {
  readonly hardSignature: string;
  readonly libraries: Readonly<Record<string, string>>;
}

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
export function nonItemProjectionState(doc: KicadDoc): NonItemProjectionState {
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

  return {
    hardSignature: JSON.stringify({ root: doc.root, atoms, heads }),
    libraries: Object.fromEntries(libraries),
  };
}

/**
 * Full exact diagnostic signature. Runtime admission uses the split state
 * above so it can distinguish an unconditionally-hard mismatch from a library
 * change proven to be carried by the same symbol-root projection.
 */
export function nonItemProjectionSignature(doc: KicadDoc): string {
  const state = nonItemProjectionState(doc);
  return JSON.stringify({
    hardSignature: state.hardSignature,
    libraries: Object.entries(state.libraries),
  });
}
