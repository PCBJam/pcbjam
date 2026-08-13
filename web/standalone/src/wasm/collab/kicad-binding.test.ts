import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  docToFile,
  fileToDoc,
  itemsWireToDelta,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  renderItem,
  SEXPR_VERSION_CURRENT,
  sexprToItems,
  ydocHasState,
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

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

  it("seed → add → edit → remove propagates both ways; no self-echo", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed(); // A is first: seeds the doc
    await bindB.seed(); // B joins: adopts the doc

    // B's editor received the footprint subtree via adopt.
    expect(Object.keys(edB.store).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);

    // B edits the pad locally → A's editor sees it.
    edB.localUpsert(`(pad "1" smd (at 7 7) (uuid "pad-1"))`, "fp-1");
    await vi.waitFor(() => {
      expect(edA.store["pad-1"]!.body).toEqual(
        sexprToItems(`(pad "1" smd (at 7 7) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
      );
    });

    // A adds a free segment → B gets it.
    edA.localUpsert(`(segment (start 0 0) (end 1 1) (uuid "seg-1"))`, null, "added");
    await vi.waitFor(() => expect(edB.store["seg-1"]).toBeDefined());

    // A removes the footprint → cascades to B's whole subtree.
    edA.localRemove("fp-1");
    await vi.waitFor(() => expect(Object.keys(edB.store).sort()).toEqual(["seg-1"]));

    // Echo suppression: every applyItems an editor received came from the PEER's
    // edits (adopt + peer changes), never from its own emits bouncing back.
    for (const json of edA.applied) {
      const wire = parseItemsWireDelta(json);
      // A's own edits were seg-1 add + fp-1 remove; they must not appear.
      expect(wire.added.map((w) => w.sexpr).join()).not.toContain("seg-1");
      expect(wire.removed).not.toContain("fp-1");
    }
  });

  it("a remote apply does not bounce back to the originator", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed();
    await bindB.seed();
    const appliedOnB = edB.applied.length;

    edB.localUpsert(`(pad "1" smd (at 3 3) (uuid "pad-1"))`, "fp-1");
    // B's own edit: nothing new applied on B (only A receives an apply).
    await vi.waitFor(() => expect(edA.applied.length).toBeGreaterThan(0));
    expect(edB.applied.length).toBe(appliedOnB);
  });

  it("adopt removes divergent local-only roots (doc authority)", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed();

    // B cold-opened the same file unsaved → its local model has a DIFFERENT uuid.
    seedEditor(edB, `(footprint "lib:R" (layer "F.Cu") (uuid "fp-DIVERGENT") (at 10 10))`);
    await bindB.seed();

    expect(edB.store["fp-DIVERGENT"]).toBeUndefined(); // dropped
    expect(edB.store["fp-1"]).toBeDefined(); // adopted
  });

  it("seed(seedDoc) writes the FULL doc — file recoverable from the Y.Doc; peer adopts", async () => {
    const { a, edA, edB, bindA, bindB } = setup();
    const file = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15))
  (rect (uuid "r-1") (name "border") (start 0 0 ltcorner) (end 0 0 rbcorner))
)
`;
    const seedDoc = fileToDoc(file);
    // Editor A opened the same file: its model holds the same flattened items.
    Object.assign(edA.store, seedDoc.items);

    await bindA.seed(seedDoc); // empty room → file-seeds meta + layout + items
    await bindB.seed(); // joins → adopts

    // The peer's editor received the items via adopt.
    expect(edB.store["r-1"]).toBeDefined();
    // Lossless: the file is recoverable from the Y.Doc ALONE (ysync 0005/0007),
    // which the editor-snapshot seed (items only, no layout/meta) cannot do.
    expect(docToFile(yToDoc(a))).toBe(docToFile(seedDoc));
    // The file-seed must not have echoed an apply into the seeding editor.
    expect(edA.applied.length).toBe(0);
  });

  it("seed(seedDoc) on a populated room still ADOPTS (doc authority wins over the file)", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed(); // A seeds the room from its editor

    // B cold-opens a divergent copy of the file and offers it as seedDoc.
    const fileB = `(kicad_wks (version 20220228)
  (rect (uuid "fp-DIVERGENT") (name "border"))
)
`;
    const seedDocB = fileToDoc(fileB);
    Object.assign(edB.store, seedDocB.items);
    await bindB.seed(seedDocB);

    expect(edB.store["fp-DIVERGENT"]).toBeUndefined(); // dropped
    expect(edB.store["fp-1"]).toBeDefined(); // adopted
  });

  it("pre-seed remote state does NOT stream into the editor (adopt covers it)", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed(); // relays the full state into B's Y.Doc immediately

    // B has NOT seeded yet: the initial state sync must not have been applied
    // item-by-item (in the real app that's a redundant full blob apply into an
    // editor that already opened the file).
    expect(edB.applied.length).toBe(0);

    await bindB.seed(); // the adopt delivers the same state, once
    expect(Object.keys(edB.store).sort()).toEqual(["fld-1", "fp-1", "pad-1"]);
  });

  it("seed(editorMatchesDoc) skips the adopt apply but still binds both ways", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed(); // A seeds the room

    // B is the Y.Doc-load path: its editor opened the file materialized from
    // the doc, so its store ALREADY matches — no adopt apply must happen.
    seedEditor(edB, FP);
    await bindB.seed(undefined, { editorMatchesDoc: true });
    expect(edB.applied.length).toBe(0);

    // The binding is still live both ways after the apply-less seed.
    edA.localUpsert(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1");
    await vi.waitFor(() => {
      expect(edB.store["pad-1"]!.body).toEqual(
        sexprToItems(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
      );
    });
    edB.localUpsert(`(pad "1" smd (at 6 6) (uuid "pad-1"))`, "fp-1");
    await vi.waitFor(() => {
      expect(edA.store["pad-1"]!.body).toEqual(
        sexprToItems(`(pad "1" smd (at 6 6) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
      );
    });
  });

  it("destroy() detaches the editor from further remote changes", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed();
    await bindB.seed();

    bindB.destroy();
    edA.localUpsert(`(pad "1" smd (at 9 9) (uuid "pad-1"))`, "fp-1");

    // B's Y.Doc still received the update (provider-level), but its editor didn't.
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 0 0) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("adopt applies only the DIFFERENCE (opt 13) — identical items cost nothing", async () => {
    const { edA, edB, bindA, bindB } = setup();
    const SEG = `(segment (start 0 0) (end 1 1) (uuid "seg-1"))`;
    seedEditor(edA, FP);
    seedEditor(edA, SEG);
    await bindA.seed();

    // B's editor already holds the IDENTICAL footprint but not the segment.
    seedEditor(edB, FP);
    await bindB.seed();

    expect(edB.store["seg-1"]).toBeDefined(); // caught up
    expect(edB.applied).toHaveLength(1);
    const wire = parseItemsWireDelta(edB.applied[0]!);
    // Only the missing segment travelled — the matching footprint did not.
    expect(wire.added).toHaveLength(1);
    expect(wire.added[0]!.sexpr).toContain("seg-1");
    expect(wire.changed).toHaveLength(0);
    expect(wire.removed).toHaveLength(0);
  });

  it("adopt with a fully matching editor applies NOTHING (clean rebind)", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed();
    seedEditor(edB, FP);
    await bindB.seed();
    expect(edB.applied).toHaveLength(0);
  });

  it("adopt re-applies a differing item's DOC version, lifted to its root", async () => {
    const { edA, edB, bindA, bindB } = setup();
    seedEditor(edA, FP);
    await bindA.seed();

    // B holds the same footprint but its pad drifted (never-synced local state).
    seedEditor(edB, FP.replace(`(pad "1" smd (at 0 0)`, `(pad "1" smd (at 9 9)`));
    await bindB.seed();

    // Doc authority: B's editor converges on the doc's pad, via ONE root re-apply.
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 0 0) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
    expect(edB.applied).toHaveLength(1);
    const wire = parseItemsWireDelta(edB.applied[0]!);
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0]!.sexpr).toContain(`(uuid "fp-1")`); // the root, not the bare pad
  });

  it("reconciles a remote update that arrives during an awaited seed apply", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed();

    let releaseFirstApply!: () => void;
    let markFirstApplyEntered!: () => void;
    const firstApplyEntered = new Promise<void>((resolve) => {
      markFirstApplyEntered = resolve;
    });
    const firstApplyGate = new Promise<void>((resolve) => {
      releaseFirstApply = resolve;
    });
    let applyAttempts = 0;
    const delayedBridge: KicadItemsBridge = {
      snapshotItems: () => edB.snapshotItems(),
      applyItems: async (json) => {
        applyAttempts++;
        if (applyAttempts === 1) {
          markFirstApplyEntered();
          await firstApplyGate;
        }
        edB.applyItems(json);
      },
      onItems: (cb) => edB.onItems(cb),
    };

    const binding = bindKicadCollab(b, delayedBridge);
    const seed = binding.seed();
    await firstApplyEntered;

    // This transaction is newer than the adopt payload now parked in apply.
    // seed() must not publish a stale baseline when that old payload resumes.
    edA.localUpsert(`(pad "1" smd (at 8 8) (uuid "pad-1"))`, "fp-1");
    releaseFirstApply();
    await seed;

    expect(applyAttempts).toBeGreaterThanOrEqual(2);
    expect(edB.store["pad-1"]!.body).toEqual(
      sexprToItems(`(pad "1" smd (at 8 8) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
    );
  });

  it("repairs a rejected live delta from the authoritative Y.Doc", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed();

    let rejectNextApply = false;
    let applyAttempts = 0;
    const fallibleBridge: KicadItemsBridge = {
      snapshotItems: () => edB.snapshotItems(),
      applyItems: (json) => {
        applyAttempts++;
        if (rejectNextApply) {
          rejectNextApply = false;
          return Promise.reject(new Error("deterministic projection failure"));
        }
        edB.applyItems(json);
      },
      onItems: (cb) => edB.onItems(cb),
    };
    await bindKicadCollab(b, fallibleBridge).seed();
    const attemptsAfterSeed = applyAttempts;
    rejectNextApply = true;

    edA.localUpsert(`(pad "1" smd (at 4 4) (uuid "pad-1"))`, "fp-1");

    await vi.waitFor(() => {
      expect(edB.store["pad-1"]!.body).toEqual(
        sexprToItems(`(pad "1" smd (at 4 4) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
      );
    });
    // One rejected delta plus one successful full-authority repair.
    expect(applyAttempts - attemptsAfterSeed).toBeGreaterThanOrEqual(2);
  });

  it("coalesces a remote transaction storm while native projection is parked", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed();

    let parkNextApply = false;
    let releaseApply!: () => void;
    let markApplyEntered!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      markApplyEntered = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let applyAttempts = 0;
    const delayedBridge: KicadItemsBridge = {
      snapshotItems: () => edB.snapshotItems(),
      applyItems: async (json) => {
        applyAttempts++;
        if (parkNextApply) {
          parkNextApply = false;
          markApplyEntered();
          await applyGate;
        }
        edB.applyItems(json);
      },
      onItems: (cb) => edB.onItems(cb),
    };
    await bindKicadCollab(b, delayedBridge).seed();
    const attemptsAfterSeed = applyAttempts;

    parkNextApply = true;
    edA.localUpsert(`(pad "1" smd (at 1 1) (uuid "pad-1"))`, "fp-1");
    await applyEntered;

    for (let value = 2; value <= 1_001; value++) {
      edA.localUpsert(
        `(pad "1" smd (at ${value} ${value}) (uuid "pad-1"))`,
        "fp-1",
      );
    }
    releaseApply();

    await vi.waitFor(() => {
      expect(edB.store["pad-1"]!.body).toEqual(
        sexprToItems(
          `(pad "1" smd (at 1001 1001) (uuid "pad-1"))`,
          "fp-1",
        ).items["pad-1"]!.body,
      );
    });
    // One parked incremental apply and one authoritative catch-up are enough.
    // The 1,000 later transactions retain no per-event closure or wire body.
    expect(applyAttempts - attemptsAfterSeed).toBeLessThanOrEqual(3);
  });

  it("does not retry a terminal owner failure or accept later projections", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed();

    let applyAttempts = 0;
    let failure: Error | undefined;
    const bridge: KicadItemsBridge = {
      snapshotItems: () => edB.snapshotItems(),
      applyItems: (json) => {
        applyAttempts++;
        if (failure) return Promise.reject(failure);
        edB.applyItems(json);
      },
      onItems: (cb) => edB.onItems(cb),
    };
    const binding = bindKicadCollab(b, bridge);
    await binding.seed();
    vi.useFakeTimers();
    failure = new Error("[wx-scheduler] shutdown: application is dead");

    edA.localUpsert(`(pad "1" smd (at 12 12) (uuid "pad-1"))`, "fp-1");
    await flushMicrotasks();
    const attemptsAfterShutdown = applyAttempts;
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    edA.localUpsert(`(pad "1" smd (at 13 13) (uuid "pad-1"))`, "fp-1");
    await flushMicrotasks();
    expect(applyAttempts).toBe(attemptsAfterShutdown);
    binding.destroy();
  });

  it("bounds retries for an unknown permanent owner failure", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed();

    let fail = false;
    let applyAttempts = 0;
    const bridge: KicadItemsBridge = {
      snapshotItems: () => edB.snapshotItems(),
      applyItems: (json) => {
        applyAttempts++;
        if (fail) return Promise.reject(new Error("permanent projection failure"));
        edB.applyItems(json);
      },
      onItems: (cb) => edB.onItems(cb),
    };
    const binding = bindKicadCollab(b, bridge);
    await binding.seed();
    vi.useFakeTimers();
    fail = true;

    edA.localUpsert(`(pad "1" smd (at 14 14) (uuid "pad-1"))`, "fp-1");
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    const attemptsAtOpenCircuit = applyAttempts;
    expect(attemptsAtOpenCircuit).toBeLessThan(20);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(applyAttempts).toBe(attemptsAtOpenCircuit);
    edA.localUpsert(`(pad "1" smd (at 15 15) (uuid "pad-1"))`, "fp-1");
    await flushMicrotasks();
    expect(applyAttempts).toBeGreaterThan(attemptsAtOpenCircuit);
    expect(vi.getTimerCount()).toBe(1);
    binding.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lib_symbols flow through the binding (miss 08A)", () => {
  const DEF = `(symbol "Device:R" (property "Reference" "R" (at 2 0 90)))`;
  const INSTANCE = `(symbol (lib_id "Device:R") (at 100 50 0) (uuid "sym-1"))`;

  it("an emitted placement's definition is stored and re-rendered for the peer", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    await bindKicadCollab(a, edA).seed();
    await bindKicadCollab(b, edB).seed();

    // A places a symbol: the eeschema blob is multi-form (definition + instance).
    edA.localUpsert(`(lib_symbols ${DEF}) ${INSTANCE}`, null, "added");

    // B's editor received the instance WITH its definition prefixed (findLib's
    // first branch), even though B has never seen this symbol.
    await vi.waitFor(() => expect(edB.store["sym-1"]).toBeDefined());
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

  it("adopt of a doc holding a symbol carries the definition too", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    const edB = new FakeEditor();
    await bindKicadCollab(a, edA).seed();
    edA.localUpsert(`(lib_symbols ${DEF}) ${INSTANCE}`, null, "added");

    // B joins with an empty editor → adopts the doc.
    await bindKicadCollab(b, edB).seed();
    expect(edB.store["sym-1"]).toBeDefined();
    const wire = parseItemsWireDelta(edB.applied[0]!);
    const symWire = [...wire.added, ...wire.changed].find((w) => w.sexpr.includes("sym-1"));
    expect(symWire!.sexpr).toMatch(/^\(lib_symbols \(symbol "Device:R"/);
  });
});
describe("sexprVersion skew guard (ysync 0009 §5)", () => {
  it("binds a fresh (empty) room and a current-version doc", async () => {
    const { a, b } = pair();
    const edA = new FakeEditor();
    seedEditor(edA, FP);
    await bindKicadCollab(a, edA).seed(); // empty room: reads as v1, stamped CURRENT on write
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

  it("never seeds an empty room — neither from the file nor the snapshot", async () => {
    const { a } = pair();
    const viewer = new FakeEditor();
    const seedDoc = fileToDoc(WKS);
    // The viewer opened the file via the API fallback (room empty).
    Object.assign(viewer.store, seedDoc.items);

    await bindKicadCollab(a, viewer, { readOnly: true }).seed(seedDoc);

    // A writable binding would have file-seeded here; the viewer must not.
    expect(ydocHasState(a)).toBe(false);
    // And without a seedDoc, the editor-snapshot seed is skipped too.
    const { b } = pair();
    const viewer2 = new FakeEditor();
    seedEditor(viewer2, FP);
    await bindKicadCollab(b, viewer2, { readOnly: true }).seed();
    expect(ydocHasState(b)).toBe(false);
  });

  it("local edits never reach the doc (inert DOWN hook)", async () => {
    const { a, b } = pair();
    const writer = new FakeEditor();
    const viewer = new FakeEditor();
    seedEditor(writer, FP);
    await bindKicadCollab(a, writer).seed();

    const bindViewer = bindKicadCollab(b, viewer, { readOnly: true });
    await bindViewer.seed(); // adopts the writer's state
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

  it("remote edits still stream into the viewer (UP observer live)", async () => {
    const { a, b } = pair();
    const writer = new FakeEditor();
    const viewer = new FakeEditor();
    seedEditor(writer, FP);
    await bindKicadCollab(a, writer).seed();
    await bindKicadCollab(b, viewer, { readOnly: true }).seed();

    writer.localUpsert(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1");
    await vi.waitFor(() => {
      expect(viewer.store["pad-1"]!.body).toEqual(
        sexprToItems(`(pad "1" smd (at 5 5) (uuid "pad-1"))`, "fp-1").items["pad-1"]!.body,
      );
    });
  });

  it("a viewer parked on an empty room streams a late writer's seed in", async () => {
    const { a, b } = pair();
    const viewer = new FakeEditor();
    const writer = new FakeEditor();
    const seedDoc = fileToDoc(WKS);
    Object.assign(viewer.store, seedDoc.items);
    Object.assign(writer.store, seedDoc.items);

    // Viewer first (empty room, no seed), writer arrives later and file-seeds.
    await bindKicadCollab(a, viewer, { readOnly: true }).seed(seedDoc);
    await bindKicadCollab(b, writer).seed(seedDoc);

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

  it("dispatches once per nonce when the backend stamps a revert", async () => {
    const spy = withWindowSpy();
    try {
      const { a, b } = pair();
      const edA = new FakeEditor();
      seedEditor(edA, FP);
      await bindKicadCollab(a, edA).seed();

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

  it("a nonce present BEFORE binding does not fire (stale marker on open)", async () => {
    const spy = withWindowSpy();
    try {
      const doc = new Y.Doc();
      doc.getMap("kdoc_meta").set("revertNonce", "old-job");
      const ed = new FakeEditor();
      seedEditor(ed, FP);
      const binding = bindKicadCollab(doc, ed);
      await binding.seed();
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
