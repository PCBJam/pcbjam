/**
 * Unit coverage for the 2026-09-29 sync audit fixes (proposal 21) that live in the
 * standalone binding / sheet manager. The browser-level scenarios are in
 * tests/kicad/ysync-audit-2026-09-29.spec.ts; these pin the TS mechanism.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  fileToDoc,
  itemsWireToDelta,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  renderItem,
  sexprToItems,
  type KicadItem,
  yToDoc,
} from "@pcbjam/shared";

// The sheet manager connects rooms through ./index; hand it plain in-memory docs.
const { connectKicadDoc } = vi.hoisted(() => ({ connectKicadDoc: vi.fn() }));
vi.mock("./index", () => ({ connectKicadDoc }));

import { bindKicadCollab, moduleItemsBridge, type KicadItemsWindow } from "./kicad-binding";
import { createSheetCollabManager } from "./sheet-manager";

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "relay"));
  return { a, b };
}

/**
 * An eeschema-like module: its snapshot and local emits carry the symbol's
 * `(lib_symbols …)` prelude like the real itemBlob does, and `hold` parks native
 * applies at the asynchronous boundary (the audit driver's hold/release).
 */
function schModule(symbol: string, def: string) {
  const store: Record<string, KicadItem> = { ...sexprToItems(symbol).items };
  let nativeDef = def;
  const win: KicadItemsWindow = {};
  let held: string[] | null = null;
  const blob = (id: string) => `(lib_symbols ${nativeDef}) ${renderItem({ items: store }, id)}`;
  const applyNow = (json: string) => {
    const resolved = win.kicadCollab?.resolveItems?.(json) ?? json;
    const wire = parseItemsWireDelta(resolved);
    const delta = itemsWireToDelta(wire, store);
    for (const { uuid, ...item } of [...delta.added, ...delta.updated]) store[uuid] = item;
    for (const w of [...wire.added, ...wire.changed]) {
      const m = /\(lib_symbols (\(symbol "[^"]+".*?\)\))\)/.exec(w.sexpr);
      if (m) nativeDef = m[1]!;
    }
  };
  const mod = {
    kicadCollabSnapshotItems: () =>
      JSON.stringify({
        added: Object.keys(store).map((id) => ({ sexpr: blob(id), parent: null })),
        changed: [],
        removed: [],
      }),
    kicadCollabApplyItems: (json: string) => (held ? held.push(json) : applyNow(json)),
  };
  return {
    bridge: moduleItemsBridge(mod, win),
    hold: () => void (held = []),
    release: () => {
      const q = held ?? [];
      held = null;
      q.forEach(applyNow);
    },
    /** A native edit of the symbol's instance (carries the editor's CURRENT definition). */
    local: (sexpr: string) => {
      Object.assign(store, sexprToItems(sexpr).items);
      win.kicadCollab?.onItems?.(JSON.stringify({ changed: [{ sexpr: `(lib_symbols ${nativeDef}) ${sexpr}`, parent: null }] }));
    },
    /** A native edit of the definition (Symbol Editor → update schematic). */
    editDef: (next: string, sexpr: string) => {
      nativeDef = next;
      win.kicadCollab?.onItems?.(JSON.stringify({ changed: [{ sexpr: `(lib_symbols ${next}) ${sexpr}`, parent: null }] }));
    },
    def: () => nativeDef,
  };
}

describe("SYNC-03: a stale item packet must not overwrite a newer library definition", () => {
  const at = (x: number) => `(symbol (lib_id "Device:R") (at ${x} 10 0) (uuid "sym-1"))`;
  const OLD = `(symbol "Device:R" (property "Description" "OLD"))`;
  const NEW = `(symbol "Device:R" (property "Description" "NEW"))`;
  const file = `(kicad_sch (version 20250114) (lib_symbols ${OLD}) ${at(10)})`;

  it("a move emitted before the editor applied the peer's definition keeps NEW in the doc", () => {
    const { a, b } = pair();
    const edA = schModule(at(10), OLD);
    const edB = schModule(at(10), OLD);
    bindKicadCollab(a, edA.bridge).seed(fileToDoc(file));
    bindKicadCollab(b, edB.bridge).seed();

    edA.hold(); // A's native apply of the peer's definition is still queued …
    edB.editDef(NEW, at(10));
    expect(kicadLibSymbolsMap(a).get("Device:R")).toContain("NEW");
    edA.local(at(30)); // … when A's move flushes, carrying A's OLD definition.

    expect(kicadLibSymbolsMap(a).get("Device:R")).toContain("NEW");
    expect(kicadLibSymbolsMap(b).get("Device:R")).toContain("NEW");
    edA.release();
    expect(edA.def()).toContain("NEW");
  });

  it("a definition the editor itself changed is still written", () => {
    const { a, b } = pair();
    const edA = schModule(at(10), OLD);
    const edB = schModule(at(10), OLD);
    bindKicadCollab(a, edA.bridge).seed(fileToDoc(file));
    bindKicadCollab(b, edB.bridge).seed();
    edA.editDef(NEW, at(10));
    expect(kicadLibSymbolsMap(b).get("Device:R")).toContain("NEW");
    expect(edB.def()).toContain("NEW");
  });
});

describe("SYNC-02: a global edit on a PARKED sheet keeps a peer's move of that symbol", () => {
  const sym = (x: number, value: string) =>
    `(symbol (lib_id "Device:R") (at ${x} 95.25 0) (property "Value" "${value}") (uuid "sub-sym"))`;
  const rootSym = `(symbol (lib_id "Device:R") (at 10 10 0) (uuid "root-sym"))`;
  const sheetFile = (body: string) => `(kicad_sch (version 20250114) ${body})`;

  it("the off-sheet write diffs against the parked screen's baseline, not the moved-on doc", async () => {
    const docs = new Map<string, Y.Doc>();
    connectKicadDoc.mockReset().mockImplementation(async ({ room }: { room: string }) => {
      const doc = new Y.Doc();
      docs.set(room, doc);
      return { doc, provider: { destroy: () => {} } };
    });
    // One native editor; its store holds whatever screen is shown (both roots here).
    const store: Record<string, KicadItem> = {
      ...sexprToItems(rootSym).items,
      ...sexprToItems(sym(127, "R")).items,
    };
    const win: KicadItemsWindow = {};
    const mod = {
      kicadCollabSnapshotItems: () =>
        JSON.stringify({
          added: Object.entries(store)
            .filter(([, it]) => it.parent === null)
            .map(([id]) => ({ sexpr: renderItem({ items: store }, id), parent: null })),
          changed: [],
          removed: [],
        }),
      kicadCollabApplyItems: (json: string) => {
        const resolved = win.kicadCollab?.resolveItems?.(json) ?? json;
        const delta = itemsWireToDelta(parseItemsWireDelta(resolved), store);
        for (const { uuid, ...item } of [...delta.added, ...delta.updated]) store[uuid] = item;
      },
    };
    const files: Record<string, string> = {
      "root.kicad_sch": sheetFile(rootSym),
      "sub.kicad_sch": sheetFile(sym(127, "R")),
    };
    const m = createSheetCollabManager({
      mod,
      win,
      scopeId: "S",
      projectId: "P",
      provider: { kind: "none" } as never,
      seedDocForPath: (p) => (files[p] ? fileToDoc(files[p]) : undefined),
      log: () => {},
    });
    await m.connectAll(["root.kicad_sch", "sub.kicad_sch"]);
    await m.switchTo("sub.kicad_sch"); // bound once → has a native baseline
    await m.switchTo("root.kicad_sch"); // sub parks
    const sub = docs.get("S:P:sub.kicad_sch")!;

    // A peer moves the sub symbol; the parked native screen never sees it.
    const moved = { uuid: "sub-sym", ...sexprToItems(sym(157, "R")).items["sub-sym"]! };
    applyDeltaToY(sub, { added: [], updated: [moved], removed: [] }, "peer");

    // A global edit (on the root view) changes the parked symbol's Value — the
    // native fragment still carries the OLD position.
    await m.writeOffSheet(
      "sub.kicad_sch",
      JSON.stringify({ added: [], changed: [{ sexpr: sym(127, "GLOBAL-EDIT"), parent: null }], removed: [] }),
    );

    const text = renderItem(yToDoc(sub), "sub-sym");
    expect(text).toContain("GLOBAL-EDIT");
    expect(text).toContain("(at 157 95.25");
    m.destroy();
  });
});
