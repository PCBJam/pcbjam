import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  duplicateSingletonHeadIndices,
  fileToDoc,
  itemsWireToDelta,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  renderItem,
  SEXPR_VERSION_CURRENT,
  sexprToItems,
  syncLayoutToY,
  ydocHasState,
  ydocIsHollow,
  ydocSexprVersion,
  yToDoc,
  type KicadItem,
} from "@pcbjam/shared";
import { bindKicadCollab, DOC_REVERTED_EVENT, SexprVersionError, type KicadItemsBridge } from "./kicad-binding";

/**
 * A fake editor implementing the v2 items bridge over an in-memory flattened
 * item store — the same semantics the Stage C C++ side will have: apply() is an
 * idempotent per-item upsert/remove that does NOT re-emit (s_applyingRemote
 * analogue); local edits mutate the store AND emit the items wire.
 */
class FakeEditor implements KicadItemsBridge {
  store: Record<string, KicadItem> = {};
  applied: string[] = []; // raw JSON of every applyItems call (echo assertions)
  private emit: ((json: string) => void) | null = null;

  snapshotItems(): string {
    const roots = Object.entries(this.store)
      .filter(([, it]) => it.parent === null)
      .map(([uuid]) => ({
        sexpr: renderItem({ items: this.store }, uuid),
        parent: null,
      }));
    return JSON.stringify({ added: roots, changed: [], removed: [] });
  }

  applyItems(json: string): void {
    this.applied.push(json);
    this.applyToStore(json); // no emit — remote applies must not echo
  }

  onItems(cb: (json: string) => void): void {
    this.emit = cb;
  }

  /** A local user edit: mutate the store, then emit (like OnModify → Format). */
  localUpsert(sexpr: string, parent: string | null = null, kind: "added" | "changed" = "changed"): void {
    const json = JSON.stringify({ [kind]: [{ sexpr, parent }] });
    this.applyToStore(json);
    this.emit?.(json);
  }

  localRemove(uuid: string): void {
    const json = JSON.stringify({ removed: [uuid] });
    this.applyToStore(json);
    this.emit?.(json);
  }

  private applyToStore(json: string): void {
    const delta = itemsWireToDelta(parseItemsWireDelta(json), this.store);
    for (const it of [...delta.added, ...delta.updated]) {
      const { uuid, ...item } = it;
      this.store[uuid] = item;
    }
    for (const uuid of delta.removed) delete this.store[uuid];
  }
}

/** Two Y.Docs joined by relaying updates (stand-in for any provider). */
function pair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "relay"));
  return { a, b };
}

const FP = `(footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
  (property "Reference" "R1" (at 0 -2) (uuid "fld-1"))
  (pad "1" smd (at 0 0) (uuid "pad-1")))`;

function seedEditor(ed: FakeEditor, sexpr: string): void {
  const { uuid, items } = sexprToItems(sexpr);
  void uuid;
  Object.assign(ed.store, items);
}

describe("bindKicadCollab — two editors over relayed Y.Docs", () => {
  function setup() {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    const bindA = bindKicadCollab(a, edA);
    const bindB = bindKicadCollab(b, edB);
    return { a, b, edA, edB, bindA, bindB };
  }

  it("seed → add → edit → remove propagates both ways; no self-echo", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed(); // A is first: seeds the doc
    bindB.seed(); // B joins: adopts the doc

    // B's editor received the footprint subtree via adopt.
    expect(Object.keys(edB.store).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);

    // B edits the pad locally → A's editor sees it.
    edB.localUpsert(`(pad "1" smd (at 7 7) (uuid "pad-1"))`, "fp-1");
    expect(edA.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 7 7) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );

    // A adds a free segment → B gets it.
    edA.localUpsert(`(segment (start 0 0) (end 1 1) (uuid "seg-1"))`, null, "added");
    expect(edB.store["seg-1"]).toBeDefined();

    // A removes the footprint → cascades to B's whole subtree.
    edA.localRemove("fp-1");
    expect(Object.keys(edB.store).sort()).toEqual(["seg-1"]);

    // Echo suppression: every applyItems an editor received came from the PEER's
    // edits (adopt + peer changes), never from its own emits bouncing back.
    for (const json of edA.applied) {
      const wire = parseItemsWireDelta(json);
      // A's own edits were seg-1 add + fp-1 remove; they must not appear.
      expect(wire.added.map((w) => w.sexpr).join()).not.toContain("seg-1");
      expect(wire.removed).not.toContain("fp-1");
    }
  });

  it("stamps every apply envelope (adopt + remote change) with the binding's sheetPath", () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    const bindA = bindKicadCollab(a, edA, { sheetPath: "Arduino Mega 2560/root.kicad_sch" });
    const bindB = bindKicadCollab(b, edB, { sheetPath: "Arduino Mega 2560/root.kicad_sch" });
    seedEditor(edA, FP);
    bindA.seed();
    bindB.seed(); // adopt apply
    edA.localUpsert(`(segment (start 0 0) (end 1 1) (uuid "seg-1"))`, null, "added"); // remote apply
    expect(edB.applied.length).toBeGreaterThanOrEqual(2);
    for (const json of edB.applied) {
      expect((JSON.parse(json) as { sheet?: string }).sheet).toBe("Arduino Mega 2560/root.kicad_sch");
    }
    // Untagged binding (single-file tools) leaves the envelope alone.
    const { a: c, b: d } = pair();
    const edC = new FakeEditor();
    const edD = new FakeEditor();
    bindKicadCollab(c, edC).seed();
    seedEditor(edC, FP);
    bindKicadCollab(d, edD).seed();
    edC.localUpsert(`(segment (start 0 0) (end 1 1) (uuid "seg-2"))`, null, "added");
    for (const json of edD.applied) {
      expect("sheet" in (JSON.parse(json) as object)).toBe(false);
    }
  });

  it("a remote apply does not bounce back to the originator", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed();
    bindB.seed();
    const appliedOnB = edB.applied.length;

    edB.localUpsert(`(pad "1" smd (at 3 3) (uuid "pad-1"))`, "fp-1");
    // B's own edit: nothing new applied on B (only A receives an apply).
    expect(edB.applied.length).toBe(appliedOnB);
    expect(edA.applied.length).toBeGreaterThan(0);
  });

  it("adopt removes divergent local-only roots (doc authority)", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed();

    // B cold-opened the same file unsaved → its local model has a DIFFERENT uuid.
    seedEditor(edB, `(footprint "lib:R" (layer "F.Cu") (uuid "fp-DIVERGENT") (at 10 10))`);
    bindB.seed();

    expect(edB.store["fp-DIVERGENT"]).toBeUndefined(); // dropped
    expect(edB.store["fp-1"]).toBeDefined(); // adopted
  });

  it("seed(seedDoc) writes the FULL doc — file recoverable from the Y.Doc; peer adopts", () => {
    const { a, edA, edB, bindA, bindB } = setup();
    const file = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;
    const seedDoc = fileToDoc(file);
    // Editor A opened the same file: its model holds the same flattened items.
    Object.assign(edA.store, seedDoc.items);

    bindA.seed(seedDoc); // empty room → file-seeds meta + layout + items
    bindB.seed(); // joins → adopts

    // The peer's editor received the items via adopt.
    expect(edB.store["r-1"]).toBeDefined();
    // Lossless: the file is recoverable from the Y.Doc ALONE (ysync 0005/0007),
    // which the editor-snapshot seed (items only, no layout/meta) cannot do.
    expect(docToFile(yToDoc(a))).toBe(docToFile(seedDoc));
    // The file-seed must not have echoed an apply into the seeding editor.
    expect(edA.applied.length).toBe(0);
  });

  it("seed(seedDoc) on a populated room still ADOPTS (doc authority wins over the file)", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed(); // A seeds the room from its editor

    // B cold-opens a divergent copy of the file and offers it as seedDoc.
    const fileB = `(kicad_wks (version 20220228)
  (rect (uuid "fp-DIVERGENT") (name "border"))
)
`;
    const seedDocB = fileToDoc(fileB);
    Object.assign(edB.store, seedDocB.items);
    bindB.seed(seedDocB);

    expect(edB.store["fp-DIVERGENT"]).toBeUndefined(); // dropped
    expect(edB.store["fp-1"]).toBeDefined(); // adopted
  });

  it("a HOLLOW room (layout only from a save-all sync, never seeded) is file-seeded, NOT adopted", () => {
    // Save-all fired the layout sync into a room nobody had entered: the doc got
    // meta/layout but zero items and no seedNonce. Adopting it removed every
    // item on the subsheet the editor had just shown (arduino subsheet blank bug).
    const { a, edA, edB, bindA, bindB } = setup();
    const file = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;
    const seedDoc = fileToDoc(file);
    syncLayoutToY(seedDoc, a, "layout-save"); // the hollow footprint
    expect(ydocHasState(a)).toBe(true);
    expect(ydocIsHollow(a)).toBe(true);

    Object.assign(edA.store, seedDoc.items); // editor shows the file
    bindA.seed(seedDoc);

    expect(edA.applied.length).toBe(0); // nothing removed from the editor
    expect(edA.store["r-1"]).toBeDefined();
    expect(ydocIsHollow(a)).toBe(false); // healed: items + seed marker in the doc
    expect(docToFile(yToDoc(a))).toBe(docToFile(seedDoc));
    bindB.seed(); // a peer joining now adopts the real content
    expect(edB.store["r-1"]).toBeDefined();
  });

  it("a layout-only write racing a file seed converges to ONE header block (no double version)", () => {
    // Session 1 (old client) save-all wrote a layout-only doc; session 2 file-seeded
    // BEFORE that state arrived. Merged, the layout carried the header twice and
    // KiCad rejected the materialized sheet ("Expecting … Got version").
    const { a, b, edA, edB, bindA, bindB } = setup();
    const file = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;
    const seedDoc = fileToDoc(file);
    // Hold the relay: build the two histories independently, then merge.
    const hollow = new Y.Doc();
    syncLayoutToY(seedDoc, hollow, "layout-save");
    Object.assign(edA.store, seedDoc.items);
    bindA.seed(seedDoc); // A file-seeds an (apparently) empty room
    Y.applyUpdate(a, Y.encodeStateAsUpdate(hollow), "relay"); // the stale layout lands
    const text = docToFile(yToDoc(a));
    expect((text.match(/\(version /g) ?? []).length).toBe(1);
    expect(text).toBe(docToFile(seedDoc));
    // The doc itself was repaired (not just the render): B sees a single header.
    expect(duplicateSingletonHeadIndices(yToDoc(b).layout)).toEqual([]);
    bindB.seed();
    expect(edB.store["r-1"]).toBeDefined();
  });

  it("a seeded room that was legitimately emptied is still adopted (not mistaken for hollow)", () => {
    const { a, edA, edB, bindA, bindB } = setup();
    const file = `(kicad_wks (version 20220228) (generator "pl_editor")
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;
    const seedDoc = fileToDoc(file);
    Object.assign(edA.store, seedDoc.items);
    bindA.seed(seedDoc); // file-seeded → seed marker present
    edA.localRemove("r-1"); // the peer deletes everything on the sheet
    expect(ydocHasState(a)).toBe(true);
    expect(ydocIsHollow(a)).toBe(false); // seeded, merely empty
    Object.assign(edB.store, seedDoc.items); // B cold-opens the stale file
    bindB.seed(seedDoc);
    expect(edB.store["r-1"]).toBeUndefined(); // doc authority: the deletion wins
  });

  it("pre-seed remote state does NOT stream into the editor (adopt covers it)", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed(); // relays the full state into B's Y.Doc immediately

    // B has NOT seeded yet: the initial state sync must not have been applied
    // item-by-item (in the real app that's a redundant full blob apply into an
    // editor that already opened the file).
    expect(edB.applied.length).toBe(0);

    bindB.seed(); // the adopt delivers the same state, once
    expect(Object.keys(edB.store).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);
  });

  it("seed(editorMatchesDoc) skips the adopt apply but still binds both ways", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed(); // A seeds the room

    // B is the Y.Doc-load path: its editor opened the file materialized from
    // the doc, so its store ALREADY matches — no adopt apply must happen.
    seedEditor(edB, FP);
    bindB.seed(undefined, { editorMatchesDoc: true });
    expect(edB.applied.length).toBe(0);

    // The binding is still live both ways after the apply-less seed.
    edA.localUpsert(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1");
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
    edB.localUpsert(`(pad "1" smd (at 6 6) (uuid "pad-1"))`, "fp-1");
    expect(edA.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 6 6) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("destroy() detaches the editor from further remote changes", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed();
    bindB.seed();

    bindB.destroy();
    edA.localUpsert(`(pad "1" smd (at 9 9) (uuid "pad-1"))`, "fp-1");

    // B's Y.Doc still received the update (provider-level), but its editor didn't.
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 0 0) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("adopt applies only the DIFFERENCE (opt 13) — identical items cost nothing", () => {
    const { edA, edB, bindA, bindB } = setup();
    const SEG = `(segment (start 0 0) (end 1 1) (uuid "seg-1"))`;
    seedEditor(edA, FP);
    seedEditor(edA, SEG);
    bindA.seed();

    // B's editor already holds the IDENTICAL footprint but not the segment.
    seedEditor(edB, FP);
    bindB.seed();

    expect(edB.store["seg-1"]).toBeDefined(); // caught up
    expect(edB.applied).toHaveLength(1);
    const wire = parseItemsWireDelta(edB.applied[0]!);
    // Only the missing segment travelled — the matching footprint did not.
    expect(wire.added).toHaveLength(1);
    expect(wire.added[0]!.sexpr).toContain("seg-1");
    expect(wire.changed).toHaveLength(0);
    expect(wire.removed).toHaveLength(0);
  });

  it("adopt with a fully matching editor applies NOTHING (clean rebind)", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed();
    seedEditor(edB, FP);
    bindB.seed();
    expect(edB.applied).toHaveLength(0);
  });

  it("adopt re-applies a differing item's DOC version, lifted to its root", () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    bindA.seed();

    // B holds the same footprint but its pad drifted (never-synced local state).
    seedEditor(edB, FP.replace(`(pad "1" smd (at 0 0)`, `(pad "1" smd (at 9 9)`));
    bindB.seed();

    // Doc authority: B's editor converges on the doc's pad, via ONE root re-apply.
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 0 0) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
    expect(edB.applied).toHaveLength(1);
    const wire = parseItemsWireDelta(edB.applied[0]!);
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.sexpr).toContain(`(uuid "fp-1")`); // the root, not the bare pad
  });
});

describe("lib_symbols flow through the binding (miss 08A)", () => {
  const DEF = `(symbol "Device:R" (property "Reference" "R" (at 2 0 90)))`;
  const INSTANCE = `(symbol (lib_id "Device:R") (at 100 50 0) (uuid "sym-1"))`;

  it("an emitted placement's definition is stored and re-rendered for the peer", () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    bindKicadCollab(a, edA).seed();
    bindKicadCollab(b, edB).seed();

    // A places a symbol: the eeschema blob is multi-form (definition + instance).
    edA.localUpsert(`(lib_symbols ${DEF}) ${INSTANCE}`, null, "added");

    // B's editor received the instance WITH its definition prefixed (findLib's
    // first branch), even though B has never seen this symbol.
    expect(edB.store["sym-1"]).toBeDefined();
    const applied = edB.applied.map((j) => parseItemsWireDelta(j));
    const symWire = applied
      .flatMap((w) => [...w.added, ...w.changed])
      .find((w) => w.sexpr.includes("sym-1"));
    expect(symWire, "the symbol reached B").toBeTruthy();
    expect(symWire!.sexpr).toMatch(/^\(lib_symbols \(symbol "Device:R"/);

    // And the definition landed in the room's defs map on BOTH sides
    // (materialization injection is covered by the shared-lib tests — this
    // room was editor-snapshot-seeded, which carries no layout/meta).
    expect(kicadLibSymbolsMap(b).get("Device:R")).toContain(`"Device:R"`);
    expect(kicadLibSymbolsMap(a).get("Device:R")).toContain(`"Device:R"`);
  });

  it("adopt of a doc holding a symbol carries the definition too", () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    bindKicadCollab(a, edA).seed();
    edA.localUpsert(`(lib_symbols ${DEF}) ${INSTANCE}`, null, "added");

    // B joins with an empty editor → adopts the doc.
    bindKicadCollab(b, edB).seed();
    expect(edB.store["sym-1"]).toBeDefined();
    const wire = parseItemsWireDelta(edB.applied[0]!);
    const symWire = [...wire.added, ...wire.changed].find((w) => w.sexpr.includes("sym-1"));
    expect(symWire!.sexpr).toMatch(/^\(lib_symbols \(symbol "Device:R"/);
  });
});
describe("sexprVersion skew guard (ysync 0009 §5)", () => {
  it("binds a fresh (empty) room and a current-version doc", () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    seedEditor(edA, FP);
    bindKicadCollab(a, edA).seed(); // empty room: reads as v1, stamped CURRENT on write
    expect(ydocSexprVersion(a)).toBe(SEXPR_VERSION_CURRENT);
    expect(() => bindKicadCollab(b, new FakeEditor())).not.toThrow(); // peer joins the v2 doc
  });

  it("refuses to bind a doc written by a newer encoding (update required)", () => {
    const doc = new Y.Doc();
    doc.getMap("kdoc_meta").set("sexprVersion", SEXPR_VERSION_CURRENT + 1);
    expect(() => bindKicadCollab(doc, new FakeEditor())).toThrow(SexprVersionError);
    expect(() => bindKicadCollab(doc, new FakeEditor())).toThrow(/update required/);
  });
});

describe("bindKicadCollab — read-only viewer (read-only-viewer)", () => {
  const WKS = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;

  it("never seeds an empty room — neither from the file nor the snapshot", () => {
    const { a } = pair();
    const viewer = new FakeEditor();
    const seedDoc = fileToDoc(WKS);
    // The viewer opened the file via the API fallback (room empty).
    Object.assign(viewer.store, seedDoc.items);

    bindKicadCollab(a, viewer, { readOnly: true }).seed(seedDoc);

    // A writable binding would have file-seeded here; the viewer must not.
    expect(ydocHasState(a)).toBe(false);
    // And without a seedDoc, the editor-snapshot seed is skipped too.
    const { b } = pair();
    const viewer2 = new FakeEditor();
    seedEditor(viewer2, FP);
    bindKicadCollab(b, viewer2, { readOnly: true }).seed();
    expect(ydocHasState(b)).toBe(false);
  });

  it("local edits never reach the doc (inert DOWN hook)", () => {
    const { a, b } = pair();
    const writer = new FakeEditor();
    const viewer = new FakeEditor();
    seedEditor(writer, FP);
    bindKicadCollab(a, writer).seed();

    const bindViewer = bindKicadCollab(b, viewer, { readOnly: true });
    bindViewer.seed(); // adopts the writer's state
    expect(viewer.store["fp-1"]).toBeDefined();

    const appliedOnWriter = writer.applied.length;
    viewer.localUpsert(`(pad "1" smd (at 9 9) (uuid "pad-1"))`, "fp-1");
    // Nothing crossed: the writer's editor received no apply, and the shared
    // doc still holds the writer's pad geometry.
    expect(writer.applied.length).toBe(appliedOnWriter);
    expect(writer.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 0 0) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("remote edits still stream into the viewer (UP observer live)", () => {
    const { a, b } = pair();
    const writer = new FakeEditor();
    const viewer = new FakeEditor();
    seedEditor(writer, FP);
    bindKicadCollab(a, writer).seed();
    bindKicadCollab(b, viewer, { readOnly: true }).seed();

    writer.localUpsert(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1");
    expect(viewer.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("a viewer parked on an empty room streams a late writer's seed in", () => {
    const { a, b } = pair();
    const viewer = new FakeEditor();
    const writer = new FakeEditor();
    const seedDoc = fileToDoc(WKS);
    Object.assign(viewer.store, seedDoc.items);
    Object.assign(writer.store, seedDoc.items);

    // Viewer first (empty room, no seed), writer arrives later and file-seeds.
    bindKicadCollab(a, viewer, { readOnly: true }).seed(seedDoc);
    bindKicadCollab(b, writer).seed(seedDoc);

    // The writer's seed reached the viewer's doc; the room is authored by the
    // writer alone and stays file-recoverable.
    expect(ydocHasState(a)).toBe(true);
    expect(docToFile(yToDoc(a))).toBe(docToFile(seedDoc));
  });
});

describe("validity-revert marker → DOC_REVERTED_EVENT (kicad-validity 0001 B3)", () => {
  /** Stub the browser window just enough for the binding's dispatch. */
  function withWindowSpy(): { events: CustomEvent[]; restore: () => void } {
    const events: CustomEvent[] = [];
    const prev = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (e: Event) => {
        events.push(e as CustomEvent);
        return true;
      },
    };
    return {
      events,
      restore: () => {
        (globalThis as { window?: unknown }).window = prev;
      },
    };
  }

  it("dispatches once per nonce when the backend stamps a revert", () => {
    const spy = withWindowSpy();
    try {
      const { a, b } = pair();
      const edA = new FakeEditor();
      seedEditor(edA, FP);
      bindKicadCollab(a, edA).seed();

      // The "backend" writes the marker on the peer doc; it relays over.
      const meta = b.getMap("kdoc_meta");
      b.transact(() => {
        meta.set("revertNonce", "job-1");
        meta.set("revertReason", "unbalanced (");
        meta.set("revertedAt", "2026-07-14T00:00:00Z");
      });

      expect(spy.events).toHaveLength(1);
      expect(spy.events[0]!.type).toBe(DOC_REVERTED_EVENT);
      expect(spy.events[0]!.detail).toMatchObject({
        reason: "unbalanced (",
        at: "2026-07-14T00:00:00Z",
      });

      // Same nonce again (e.g. a reconnect replay) → silent.
      b.transact(() => meta.set("revertReason", "unbalanced ( again"));
      expect(spy.events).toHaveLength(1);

      // A NEW nonce → a second toast.
      b.transact(() => meta.set("revertNonce", "job-2"));
      expect(spy.events).toHaveLength(2);
    } finally {
      spy.restore();
    }
  });

  it("a nonce present BEFORE binding does not fire (stale marker on open)", () => {
    const spy = withWindowSpy();
    try {
      const doc = new Y.Doc();
      doc.getMap("kdoc_meta").set("revertNonce", "old-job");
      const ed = new FakeEditor();
      seedEditor(ed, FP);
      const binding = bindKicadCollab(doc, ed);
      binding.seed();
      expect(spy.events).toHaveLength(0);

      // …and after destroy() the observer is gone entirely.
      binding.destroy();
      doc.getMap("kdoc_meta").set("revertNonce", "post-destroy");
      expect(spy.events).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});

/**
 * A-4 deterministic same-item conflict reducer (findings group A; drift-trio
 * S4/S4b divergence rebuilt at unit tier, per the recorded plan: hold two known
 * same-item transactions, release them in a FIXED order, assert the Y.Docs
 * converge FIRST, then assert every native projection matches the doc).
 *
 * Whole-item Yjs LWW may legitimately lose one concurrent value but must still
 * converge — permanent editor divergence can only come from the bridge, and
 * this harness removes every timing variable the e2e trio has.
 */
describe("A-4 reducer — held-relay same-item conflicts converge deterministically", () => {
  /** Two Y.Docs whose relay is HELD: updates queue per direction and only
   * cross on an explicit release. clientIDs are pinned so LWW arbitration —
   * and therefore the winner — is deterministic run to run. */
  function heldPair(): {
    a: Y.Doc;
    b: Y.Doc;
    releaseAtoB: () => void;
    releaseBtoA: () => void;
    drain: () => void;
  } {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.clientID = 1;
    b.clientID = 2;
    const aToB: Uint8Array[] = [];
    const bToA: Uint8Array[] = [];
    a.on("update", (u: Uint8Array) => aToB.push(u));
    b.on("update", (u: Uint8Array) => bToA.push(u));
    const releaseAtoB = (): void => {
      while (aToB.length) Y.applyUpdate(b, aToB.shift()!, "relay");
    };
    const releaseBtoA = (): void => {
      while (bToA.length) Y.applyUpdate(a, bToA.shift()!, "relay");
    };
    // Applying a release can enqueue echo updates on the other lane (Yjs emits
    // "update" for applied remote content too); drain until both lanes are dry.
    const drain = (): void => {
      while (aToB.length || bToA.length) {
        releaseAtoB();
        releaseBtoA();
      }
    };
    return { a, b, releaseAtoB, releaseBtoA, drain };
  }

  const CONFLICT_FILE = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "target") (start 0 0 ltcorner) (end 0 0 rbcorner))
  (rect (uuid "r-2") (name "bystander") (start 1 1 ltcorner) (end 2 2 rbcorner))
)
`;
  const rectSexpr = (name: string): string =>
    `(rect (uuid "r-1") (name "${name}") (start 0 0 ltcorner) (end 0 0 rbcorner))`;

  function setupConverged() {
    const held = heldPair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    const bindA = bindKicadCollab(held.a, edA);
    const bindB = bindKicadCollab(held.b, edB);
    const seedDoc = fileToDoc(CONFLICT_FILE);
    Object.assign(edA.store, seedDoc.items);
    bindA.seed(seedDoc);
    held.drain(); // B's doc now holds the seed
    bindB.seed(); // adopt
    held.drain();
    // Precondition: fully converged before the conflict is staged.
    expect(docToFile(yToDoc(held.a))).toBe(docToFile(yToDoc(held.b)));
    expect(edB.store["r-1"]).toBeDefined();
    return { ...held, edA, edB, bindA, bindB };
  }

  /** Y-first convergence oracle, then native projections against the doc. */
  function assertConverged(t: ReturnType<typeof setupConverged>): string {
    const fileA = docToFile(yToDoc(t.a));
    const fileB = docToFile(yToDoc(t.b));
    // 1. The CRDT layer itself converged.
    expect(fileA).toBe(fileB);
    // 2. Each editor's native projection matches ITS OWN doc (bridge applied
    //    everything), hence both editors match each other.
    for (const [doc, ed] of [
      [t.a, t.edA],
      [t.b, t.edB],
    ] as const) {
      const docItems = yToDoc(doc).items;
      expect(Object.keys(ed.store).sort()).toEqual(Object.keys(docItems).sort());
      for (const uuid of Object.keys(docItems).filter((u) => docItems[u]!.parent === null)) {
        expect(renderItem({ items: ed.store }, uuid)).toBe(renderItem({ items: docItems }, uuid));
      }
    }
    return fileA;
  }

  it("value-vs-value: A→B then B→A release converges everywhere, one value wins", () => {
    const t = setupConverged();
    // Both actors commit a conflicting edit to the SAME item while the relay
    // is held — the exact S4b shape (two clients racing setValue).
    t.edA.localUpsert(rectSexpr("from-A"));
    t.edB.localUpsert(rectSexpr("from-B"));
    t.releaseAtoB();
    t.releaseBtoA();
    t.drain();
    const file = assertConverged(t);
    expect(/from-[AB]/.test(file)).toBe(true); // exactly one value survived
    expect(file.includes("from-A") && file.includes("from-B")).toBe(false);
  });

  it("value-vs-value: the REVERSE release order converges to the SAME winner", () => {
    const first = (() => {
      const t = setupConverged();
      t.edA.localUpsert(rectSexpr("from-A"));
      t.edB.localUpsert(rectSexpr("from-B"));
      t.releaseAtoB();
      t.releaseBtoA();
      t.drain();
      return assertConverged(t);
    })();
    const t = setupConverged();
    t.edA.localUpsert(rectSexpr("from-A"));
    t.edB.localUpsert(rectSexpr("from-B"));
    t.releaseBtoA(); // reversed
    t.releaseAtoB();
    t.drain();
    // Delivery order must not change the arbitration (CRDT order-independence
    // + pinned clientIDs): byte-identical converged file.
    expect(assertConverged(t)).toBe(first);
  });

  it("move-vs-delete on the same item converges everywhere", () => {
    const t = setupConverged();
    t.edA.localUpsert(rectSexpr("moved-by-A")); // stand-in for a move commit
    t.edB.localRemove("r-1");
    t.releaseAtoB();
    t.releaseBtoA();
    t.drain();
    const file = assertConverged(t);
    // Winner is CRDT policy, not asserted — but the outcome must be one of the
    // two staged states on every replica, never a mix.
    const present = file.includes("moved-by-A");
    const absent = !file.includes('"r-1"');
    expect(present || absent).toBe(true);
    expect(file.includes("bystander")).toBe(true); // the other item survives
  });

  it("conflict staged DURING a partially-released exchange still converges", () => {
    const t = setupConverged();
    // A's edit crosses to B first; B then edits the already-updated item while
    // its own answer is still held — the "edit arrived mid-apply" interleave
    // (bug-05 family) reduced to a deterministic schedule.
    t.edA.localUpsert(rectSexpr("from-A"));
    t.releaseAtoB();
    t.edB.localUpsert(rectSexpr("from-B-after-seeing-A"));
    t.releaseBtoA();
    t.drain();
    const file = assertConverged(t);
    // B's edit is causally AFTER A's — it must win outright on both replicas.
    expect(file.includes("from-B-after-seeing-A")).toBe(true);
  });
});
