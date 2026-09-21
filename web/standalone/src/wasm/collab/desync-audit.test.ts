import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  fileToDoc,
  itemsWireToDelta,
  kicadItemsMap,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  renderItem,
  seedDocToY,
  sexprToItems,
  syncLayoutToY,
  yToDoc,
  type KicadItem,
} from "@pcbjam/shared";

// The sheet manager connects rooms through ./index; hand it plain in-memory docs.
const { connectKicadDoc } = vi.hoisted(() => ({ connectKicadDoc: vi.fn() }));
vi.mock("./index", () => ({ connectKicadDoc }));

import { bindKicadCollab, moduleItemsBridge, type KicadItemsWindow } from "./kicad-binding";
import { createSheetCollabManager } from "./sheet-manager";

/**
 * A module that applies synchronously. `resolves` models the bridge contract
 * (ysync 0012 #2): the editor hands each payload back through
 * `window.kicadCollab.resolveItems` right before applying it — which is how the
 * binding learns the native model advanced. pl_editor skipped that call until
 * the 2026-09-21 audit (`resolves: false` keeps the old shape for reference).
 */
function synchronousModule(
  initial: string | string[],
  opts: { resolves: boolean } = { resolves: true },
) {
  const store: Record<string, KicadItem> = Object.assign(
    {},
    ...[initial].flat().map((sexpr) => sexprToItems(sexpr).items),
  );
  const win: KicadItemsWindow = {};
  const applied: string[] = [];
  const apply = (json: string) => {
    const delta = itemsWireToDelta(parseItemsWireDelta(json), store);
    for (const { uuid, ...item } of [...delta.added, ...delta.updated]) store[uuid] = item;
    for (const id of delta.removed) delete store[id];
  };
  const mod = {
    kicadCollabSnapshotItems: () => JSON.stringify({
      added: Object.entries(store).filter(([, it]) => it.parent === null)
        .map(([id]) => ({ sexpr: renderItem({ items: store }, id), parent: null })),
      changed: [], removed: [],
    }),
    kicadCollabApplyItems: (json: string) => {
      const resolved = opts.resolves ? (win.kicadCollab?.resolveItems?.(json) ?? json) : json;
      applied.push(resolved);
      apply(resolved);
    },
  };
  return {
    bridge: moduleItemsBridge(mod, win), applied, win, mod,
    local: (sexpr: string) => {
      const json = JSON.stringify({ changed: [{ sexpr, parent: null }] });
      apply(json);
      win.kicadCollab?.onItems?.(json);
    },
    item: (id: string) => store[id],
  };
}

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "relay"));
  return { a, b };
}

const text = (x: number) => `(tbtext "Hello" (pos ${x} 0) (uuid "text-1"))`;
const file = (paper: string, title = "T") => `(kicad_pcb (version 20241229) (paper "${paper}")
  (title_block (title "${title}"))
  (segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (uuid "seg-1")))`;

describe("2026-09-21 desync audit", () => {
  it("pl_editor can move a remotely moved item back to its original position", () => {
    const { a, b } = pair();
    const edA = synchronousModule(text(0));
    const edB = synchronousModule(text(0));
    bindKicadCollab(a, edA.bridge).seed(fileToDoc(`(kicad_wks (version 20231120) ${text(0)})`));
    bindKicadCollab(b, edB.bridge).seed();
    edA.local(text(10));
    expect(edB.item("text-1")).toEqual(sexprToItems(text(10)).items["text-1"]);
    edB.local(text(0));
    expect(yToDoc(b).items["text-1"]).toEqual(edB.item("text-1"));
    expect(yToDoc(a).items["text-1"]).toEqual(edB.item("text-1"));
    expect(edA.item("text-1")).toEqual(edB.item("text-1"));
  });

  it("documents WHY: an editor that never resolves leaves the binding on the pre-apply baseline", () => {
    const { a, b } = pair();
    const edA = synchronousModule(text(0));
    const edB = synchronousModule(text(0), { resolves: false }); // pre-fix pl_editor
    bindKicadCollab(a, edA.bridge).seed(fileToDoc(`(kicad_wks (version 20231120) ${text(0)})`));
    bindKicadCollab(b, edB.bridge).seed();
    edA.local(text(10));
    edB.local(text(0));
    // The move back equals the stale baseline → swallowed. The fix is native
    // (pl_editor_embind.cpp resolves at apply time), pinned by the e2e spec.
    expect(yToDoc(b).items["text-1"]).not.toEqual(edB.item("text-1"));
  });

  it("a peer's ordinary save preserves the paper setting already received in Yjs", () => {
    const { a, b } = pair();
    const initial = fileToDoc(file("A4"));
    const item = renderItem(initial, "seg-1");
    const edA = synchronousModule(item);
    const edB = synchronousModule(item);
    bindKicadCollab(a, edA.bridge).seed(initial);
    bindKicadCollab(b, edB.bridge).seed(initial);
    syncLayoutToY(fileToDoc(file("A3")), a, "layout-save", initial);
    expect(docToFile(yToDoc(b))).toContain('(paper "A3")');
    // B's native editor still holds A4 (no native layout apply exists); its
    // ordinary save is diffed against the layout it loaded → writes nothing.
    expect(syncLayoutToY(initial, b, "layout-save", initial)).toBe(false);
    expect(docToFile(yToDoc(a))).toContain('(paper "A3")');
  });

  it("a save still lands the settings the user DID change, next to a peer's", () => {
    const { a, b } = pair();
    const initial = fileToDoc(file("A4"));
    seedDocToY(initial, a, "seed", "n");
    syncLayoutToY(fileToDoc(file("A3")), a, "layout-save", initial);
    // B (native still A4) retitles and saves.
    expect(syncLayoutToY(fileToDoc(file("A4", "Mine")), b, "layout-save", initial)).toBe(true);
    const merged = docToFile(yToDoc(a));
    expect(merged).toContain('(paper "A3")');
    expect(merged).toContain('(title "Mine")');
  });

  it("without a baseline the saved file stays authoritative (first-save fallback)", () => {
    const { a, b } = pair();
    const initial = fileToDoc(file("A4"));
    seedDocToY(initial, a, "seed", "n");
    expect(syncLayoutToY(fileToDoc(file("A3")), b, "layout-save")).toBe(true);
    expect(docToFile(yToDoc(a))).toContain('(paper "A3")');
  });

  it("a stale save does not write an untouched library definition over a newer one", () => {
    const sch = (value: string) => fileToDoc(`(kicad_sch (version 20250114)
      (lib_symbols (symbol "Device:R" (property "Value" "${value}")))
      (symbol (lib_id "Device:R") (at 10 10 0) (uuid "sym-1")))`);
    const { a, b } = pair();
    seedDocToY(sch("OLD"), a, "seed", "n");
    syncLayoutToY(sch("NEW"), a, "layout-save", sch("OLD"));
    expect(kicadLibSymbolsMap(b).get("Device:R")).toContain("NEW");
    syncLayoutToY(sch("OLD"), b, "layout-save", sch("OLD")); // B never touched it
    expect(kicadLibSymbolsMap(a).get("Device:R")).toContain("NEW");
  });

  it("a definition-only library change refreshes existing native instances", () => {
    const { a, b } = pair();
    const symbol = `(symbol (lib_id "Device:R") (at 10 10 0) (uuid "sym-1"))`;
    const other = `(symbol (lib_id "Device:C") (at 20 10 0) (uuid "sym-2"))`;
    const edA = synchronousModule([symbol, other]);
    const edB = synchronousModule([symbol, other]);
    bindKicadCollab(a, edA.bridge).seed();
    bindKicadCollab(b, edB.bridge).seed();
    edA.local(`(lib_symbols (symbol "Device:R" (property "Value" "NEW"))) ${symbol}`);
    expect(kicadLibSymbolsMap(b).get("Device:R")).toContain("NEW");
    // Exactly the instances using the definition, carrying it; nothing echoes back.
    expect(edB.applied).toHaveLength(1);
    const sent = parseItemsWireDelta(edB.applied[0]!);
    expect(sent.changed.map((w) => w.uuid)).toEqual(["sym-1"]);
    expect(sent.changed[0]!.sexpr).toContain('(lib_symbols (symbol "Device:R"');
    expect(sent.changed[0]!.sexpr).toContain("NEW");
    expect(edA.applied).toHaveLength(0);
  });

  it("a definition change arriving WITH its instance change applies once", () => {
    const { a, b } = pair();
    const at = (x: number) => `(symbol (lib_id "Device:R") (at ${x} 10 0) (uuid "sym-1"))`;
    const edA = synchronousModule(at(10));
    const edB = synchronousModule(at(10));
    bindKicadCollab(a, edA.bridge).seed();
    bindKicadCollab(b, edB.bridge).seed();
    edA.local(`(lib_symbols (symbol "Device:R" (property "Value" "NEW"))) ${at(30)}`);
    expect(edB.applied).toHaveLength(1);
  });

  it("a symbol stored under lib_name gets ITS definition on the wire", () => {
    const { a, b } = pair();
    const symbol = `(symbol (lib_name "R_1") (lib_id "Device:R") (at 10 10 0) (uuid "sym-1"))`;
    const edA = synchronousModule(symbol);
    const edB = synchronousModule(symbol);
    bindKicadCollab(a, edA.bridge).seed();
    bindKicadCollab(b, edB.bridge).seed();
    edA.local(`(lib_symbols (symbol "R_1" (property "Value" "LOCAL"))) ${symbol}`);
    expect(edB.applied).toHaveLength(1);
    expect(edB.applied[0]).toContain("LOCAL");
  });
});

describe("2026-09-21 desync audit — cross-sheet commits", () => {
  const rootSym = `(symbol (lib_id "Device:R") (at 10 10 0) (uuid "root-sym"))`;
  const subSym = (ref: string) =>
    `(symbol (lib_id "Device:R") (at 50 50 0) (property "Reference" "${ref}") (uuid "sub-sym"))`;
  const sheetFile = (body: string) => `(kicad_sch (version 20250114) ${body})`;

  async function setup() {
    const docs = new Map<string, Y.Doc>();
    connectKicadDoc.mockReset().mockImplementation(async ({ room }: { room: string }) => {
      const doc = new Y.Doc();
      docs.set(room, doc);
      return { doc, provider: { destroy: () => {} } };
    });
    // The editor shows root; the subsheet's room was seeded by an earlier visit.
    const ed = synchronousModule(rootSym);
    const files: Record<string, string> = {
      "root.kicad_sch": sheetFile(rootSym),
      "sub.kicad_sch": sheetFile(subSym("R?")),
    };
    const m = createSheetCollabManager({
      mod: ed.mod,
      win: ed.win,
      scopeId: "S",
      projectId: "P",
      provider: { kind: "none" } as never,
      seedDocForPath: (p) => (files[p] ? fileToDoc(files[p]) : undefined),
      log: () => {},
    });
    await m.connectAll(["root.kicad_sch", "sub.kicad_sch"]);
    seedDocToY(fileToDoc(files["sub.kicad_sch"]!), docs.get("S:P:sub.kicad_sch")!, "peer", "n");
    await m.switchTo("root.kicad_sch");
    return { m, ed, root: docs.get("S:P:root.kicad_sch")!, sub: docs.get("S:P:sub.kicad_sch")! };
  }

  const wire = (o: { changed?: string[]; removed?: string[] }) =>
    JSON.stringify({
      added: [],
      changed: (o.changed ?? []).map((sexpr) => ({ sexpr, parent: null })),
      removed: o.removed ?? [],
    });

  it("REPRO (pre-fix wire): a subsheet root on the shown sheet's hook lands in the ROOT room", async () => {
    const { ed, root, sub } = await setup();
    // What eeschema emitted before the fix: one envelope, no sheet, every dirty root.
    ed.win.kicadCollab!.onItems!(wire({ changed: [subSym("R7")] }));
    expect(Object.keys(yToDoc(root).items)).toContain("sub-sym"); // the corruption
    expect(docToFile(yToDoc(sub))).toContain('"R?"'); // …and the owner never hears of it
  });

  it("an off-sheet batch is written to the OWNING sheet's room only", async () => {
    const { m, root, sub } = await setup();
    await m.writeOffSheet("sub.kicad_sch", wire({ changed: [subSym("R7")] }));
    expect(docToFile(yToDoc(sub))).toContain('"R7"');
    expect(Object.keys(yToDoc(root).items)).toEqual(["root-sym"]);
  });

  it("an off-sheet removal reaches the owning room", async () => {
    const { m, root, sub } = await setup();
    await m.writeOffSheet("sub.kicad_sch", wire({ removed: ["sub-sym"] }));
    expect(Object.keys(yToDoc(sub).items)).toEqual([]);
    expect(Object.keys(yToDoc(root).items)).toEqual(["root-sym"]);
  });

  it("a never-seeded empty room is left for its first bind (no partial doc)", async () => {
    const { m } = await setup();
    const fresh = new Y.Doc();
    connectKicadDoc.mockImplementationOnce(async () => ({ doc: fresh, provider: { destroy: () => {} } }));
    await m.writeOffSheet("new.kicad_sch", wire({ changed: [subSym("R7")] }));
    expect(kicadItemsMap(fresh).size).toBe(0);
  });

  it("a batch that raced a navigation INTO its sheet goes through that sheet's binding", async () => {
    const { m, ed, sub } = await setup();
    await m.switchTo("sub.kicad_sch");
    const before = ed.applied.length;
    await m.writeOffSheet("sub.kicad_sch", wire({ changed: [subSym("R9")] }));
    expect(docToFile(yToDoc(sub))).toContain('"R9"');
    expect(ed.applied.length).toBe(before); // a local emit, not a remote apply
  });
});
