import { describe, expect, it } from "vitest";
import {
  itemsWireToDelta,
  parseItemsWireDelta,
  wireLibSymbols,
  type KicadDelta,
} from "@pcbjam/shared";
import { nativeSnapshotThroughY } from "./wire-y-roundtrip";

function byUuid(delta: KicadDelta): KicadDelta {
  return {
    added: [...delta.added].sort((a, b) => a.uuid.localeCompare(b.uuid)),
    updated: [...delta.updated].sort((a, b) => a.uuid.localeCompare(b.uuid)),
    removed: [...delta.removed].sort(),
  };
}

const SNAPSHOT = JSON.stringify({
  added: [
    {
      sexpr:
        '(footprint "Device:R" (layer "F.Cu") (uuid "fp-1") ' +
        '(pad "1" smd (at 0 0) (size 1 1) (uuid "pad-1")))',
      parent: null,
    },
    {
      sexpr:
        '(lib_symbols (symbol "Device:R" (pin_names (offset 0)))) ' +
        '(symbol (lib_id "Device:R") (at 10 10) (uuid "sym-1"))',
      parent: null,
    },
  ],
  changed: [],
  removed: [],
});

describe("native snapshot → Y.Doc → native wire", () => {
  it("round-trips roots, nested identity, parents, bodies, and library definitions", () => {
    const beforeWire = parseItemsWireDelta(SNAPSHOT);
    const afterWire = parseItemsWireDelta(nativeSnapshotThroughY(SNAPSHOT));

    expect(byUuid(itemsWireToDelta(afterWire, {}))).toEqual(
      byUuid(itemsWireToDelta(beforeWire, {})),
    );
    expect(wireLibSymbols(afterWire)).toEqual(wireLibSymbols(beforeWire));
  });

  it("refuses a delta masquerading as the complete native snapshot contract", () => {
    expect(() =>
      nativeSnapshotThroughY(
        JSON.stringify({ added: [], changed: [], removed: ["item-1"] }),
      ),
    ).toThrow(/complete all-added snapshot/i);
  });
});
