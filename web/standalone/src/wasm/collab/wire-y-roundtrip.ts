import * as Y from "yjs";
import {
  applyDeltaToY,
  deltaToItemsWire,
  itemsWireToDelta,
  kicadItemsMap,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  upsertLibSymbolsToY,
  wireLibSymbols,
  yToItem,
  type KicadDelta,
  type KicadItem,
} from "@pcbjam/shared";

/**
 * Test/diagnostic reference path for the complete native items snapshot:
 * native wire → plain Slot graph → Y.Doc → new plain Slot graph → native wire.
 *
 * It intentionally constructs every output object from the Y.Doc readback. It
 * cannot accidentally pass by returning, aliasing, or rendering the input
 * objects. The browser roundtrip E2E feeds this result to a fresh KiCad Wasm
 * instance and asks the native writer to save it again.
 */
export function nativeSnapshotThroughY(json: string): string {
  const input = parseItemsWireDelta(json);
  if (input.changed.length !== 0 || input.removed.length !== 0) {
    throw new Error("nativeSnapshotThroughY requires a complete all-added snapshot");
  }

  const sourceDelta = itemsWireToDelta(input, {});
  const definitions = wireLibSymbols(input);
  const ydoc = new Y.Doc();
  try {
    ydoc.transact(() => {
      applyDeltaToY(ydoc, sourceDelta, "native-roundtrip");
      upsertLibSymbolsToY(ydoc, definitions, "native-roundtrip");
    }, "native-roundtrip");

    const view = Object.create(null) as Record<string, KicadItem>;
    kicadItemsMap(ydoc).forEach((item, uuid) => {
      view[uuid] = yToItem(item);
    });
    const allFromY: KicadDelta = {
      added: Object.entries(view).map(([uuid, item]) => ({ uuid, ...item })),
      updated: [],
      removed: [],
    };
    const libraries = kicadLibSymbolsMap(ydoc);
    return JSON.stringify(
      deltaToItemsWire(allFromY, view, (libId) => libraries.get(libId)),
    );
  } finally {
    ydoc.destroy();
  }
}
