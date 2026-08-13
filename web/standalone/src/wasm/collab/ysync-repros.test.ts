import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  fileToDoc,
  itemsWireToDelta,
  kicadItemsMap,
  parseItemsWireDelta,
  renderItem,
  type KicadItem,
} from "@pcbjam/shared";

// Bug 07b exercises the REAL sheet-manager + REAL kicad-binding + REAL yjs; only
// the provider connect ("./index" → connectKicadDoc) is faked so the async gap
// between destroy(old binding) and bind(new room) can be held open.
const { connectKicadDoc } = vi.hoisted(() => ({ connectKicadDoc: vi.fn() }));
vi.mock("./index", () => ({ connectKicadDoc }));

import {
  bindKicadCollab,
  type KicadItemsBridge,
  type KicadItemsModule,
  type KicadItemsWindow,
} from "./kicad-binding";
import { createSheetCollabManager } from "./sheet-manager";
import type { ProviderConfig } from "./provider";

/**
 * Reproduction tests for the 2026-07-02 ysync review — runtime-binding bugs
 * (docs/features/ysync-review on the ysync-review worktree/branch).
 *
 * Convention: each repro asserts the CORRECT behavior and is marked `it.fails`
 * with a comment naming the bug doc. The suite stays green while the bug is
 * open; fixing the bug flips the test to "unexpected pass", which forces the
 * marker's removal — the repro then becomes the regression test.
 */

/**
 * A C++-FAITHFUL fake of the v2 items bridge. In the real wasm the
 * COLLAB_LISTENER — the only thing that turns local commits into emits — is
 * registered lazily by ensureBridge(), which is reached ONLY through the
 * snapshot entry points (pcbnew_embind.cpp:729 → :975/:998,
 * eeschema_embind.cpp:578 → :909/:957). The plain FakeEditor in
 * kicad-binding.test.ts cannot see that side effect (which is exactly why
 * bug 01 shipped); this fake models it: local edits EMIT only after
 * snapshotItems() has run at least once.
 */
class CppFaithfulEditor implements KicadItemsBridge {
  store: Record<string, KicadItem> = {};
  applied: string[] = []; // raw JSON of every applyItems call
  snapshotCalls = 0;
  /** The captured emit hook — fire directly to simulate a raw C++ emit. */
  emitCb: ((json: string) => void) | null = null;

  snapshotItems(): string {
    this.snapshotCalls++; // ensureBridge(): registers the C++ change listener
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
    this.emitCb = cb;
  }

  /** A local user edit: mutates the model; emits ONLY if the listener exists. */
  localUpsert(
    sexpr: string,
    parent: string | null = null,
    kind: "added" | "changed" = "changed",
  ): void {
    const json = JSON.stringify({ [kind]: [{ sexpr, parent }] });
    this.applyToStore(json);
    if (this.snapshotCalls > 0) this.emitCb?.(json);
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

const FILE = `(kicad_pcb
  (version 20241229)
  (footprint "lib:R" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (pad "1" smd (at 0 0) (uuid "pad-1")))
)`;

// ── Bug 01 — file-seed never registers the C++ change listener ───────────────
// 01-bug-first-tab-listener-never-registered.md: seed()'s file-seed branch
// (fresh room + seedDoc) runs docToY and returns WITHOUT bridge.snapshotItems(),
// so ensureBridge() never runs on the seeding tab — its local edits are never
// emitted (it receives peers' edits but cannot send). Every other seed branch
// calls snapshotItems() and is fine.

describe("bug 01 — first-ever tab (file-seed branch) never registers the C++ listener", () => {
  async function freshRoomFileSeed() {
    const { a, b } = pair();
    const edA = new CppFaithfulEditor();
    const edB = new CppFaithfulEditor();
    const bindA = bindKicadCollab(a, edA);
    const bindB = bindKicadCollab(b, edB);
    const seedDoc = fileToDoc(FILE);
    Object.assign(edA.store, seedDoc.items); // A's editor opened the same file
    await bindA.seed(seedDoc); // fresh room → the file-seed branch
    await bindB.seed(); // B joins → adopts the doc
    return { edA, edB };
  }

  it("the file-seed branch calls snapshotItems (the listener-registration contract)", async () => {
    const { edA } = await freshRoomFileSeed();
    // The one-line fix's contract: like the editorMatchesDoc branch, the
    // file-seed branch must call snapshotItems() for its SIDE EFFECTS
    // (ensureBridge listener registration + differ baseline).
    expect(edA.snapshotCalls).toBeGreaterThan(0);
  });

  it("a local edit on the seeding tab reaches the joining peer", async () => {
    const { edA, edB } = await freshRoomFileSeed();
    edA.localUpsert(`(segment (start 0 0) (end 1 1) (uuid "seg-new"))`, null, "added");
    // Regression cover for bug 01: without the listener registration the edit
    // was never emitted (the first-session "seeder can't send" hole).
    await vi.waitFor(() => expect(edB.store["seg-new"]).toBeDefined());
  });

  it("control: the ADOPTING peer's edits flow back (the asymmetry IS the bug)", async () => {
    const { edA, edB } = await freshRoomFileSeed();
    // B's adopt branch called snapshotItems() → B's listener exists → B→A works.
    edB.localUpsert(`(segment (start 2 2) (end 3 3) (uuid "seg-b"))`, null, "added");
    await vi.waitFor(() => expect(edA.store["seg-b"]).toBeDefined());
  });
});

// ── Bug 07a — destroy() leaves the DOWN hook attached ────────────────────────
// 07-bug-sheet-switch-stale-down-hook.md: KicadBinding.destroy() only
// unobserves the UP side (items.unobserveDeep); the DOWN hook registered via
// bridge.onItems() is never unregistered, so a C++ emit after destroy() still
// writes into the (now supposedly detached) doc.

describe("bug 07a — destroy() leaves the DOWN hook (onItems) attached", () => {
  it("an emit after destroy() must not write into the doc", async () => {
    const doc = new Y.Doc();
    const ed = new CppFaithfulEditor();
    const binding = bindKicadCollab(doc, ed);
    await binding.seed(); // empty room, empty editor — snapshot branch registers all hooks
    binding.destroy();

    // The C++ side keeps emitting through the captured hook (in the real app:
    // window.kicadCollab.onItems still points at this binding's closure).
    ed.emitCb?.(
      JSON.stringify({
        added: [{ sexpr: `(segment (start 9 9) (end 8 8) (uuid "seg-ghost"))`, parent: null }],
        changed: [],
        removed: [],
      }),
    );

    // CORRECT: a destroyed binding is inert both ways. TODAY: the stale hook
    // runs applyDeltaToY and the doc gains the item.
    expect(kicadItemsMap(doc).get("seg-ghost")).toBeUndefined();
  });
});

// ── Bug 07b — the sheet-switch gap routes edits into the OLD room ────────────
// 07-bug-sheet-switch-stale-down-hook.md: doSwitch destroys the old binding,
// then AWAITS ensureRoom (a full connect round-trip for a cold room) before
// bindKicadCollab re-registers onItems. In that gap window.kicadCollab.onItems
// still points at the old binding's closure — and C++ has already rebaselined
// to the new sheet, so a local edit emits a new-sheet diff into the OLD room.

describe("bug 07b — sheet-switch gap: stale onItems writes into the old sheet's room", () => {
  it("an emit during a cold-room switch gap must not land in the old doc", async () => {
    const docs: Y.Doc[] = [];
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    let connects = 0;
    connectKicadDoc.mockReset();
    connectKicadDoc.mockImplementation(async () => {
      const idx = connects++;
      if (idx === 1) await gateB; // sheet B's room is COLD: hold the connect open
      const doc = new Y.Doc();
      docs.push(doc);
      return { doc, provider: { destroy: () => {} } };
    });

    const win: KicadItemsWindow = {};
    const mod: KicadItemsModule = {
      // The editor's model is empty — seed()'s snapshot branch stays a no-op.
      kicadCollabSnapshotItems: async () =>
        JSON.stringify({ added: [], changed: [], removed: [] }),
      kicadCollabApplyItems: async () => {},
    };
    const m = createSheetCollabManager({
      mod,
      win,
      scopeId: "S",
      projectId: "P",
      provider: { kind: "none" } satisfies ProviderConfig,
      seedDocForPath: () => undefined,
      log: () => {},
    });

    await m.switchTo("a.kicad_sch"); // binds sheet A; onItems → A's closure
    const aDoc = docs[0]!;

    const switching = m.switchTo("b.kicad_sch"); // destroys A's binding, awaits the cold connect
    await vi.waitFor(() => expect(connects).toBe(2)); // we are inside the gap

    // C++ has already rebaselined to sheet B (OnSchSheetChanged fired before the
    // JS switch completed); a local edit in the gap emits a B-scoped diff —
    // through the STALE hook, which still writes into sheet A's doc.
    win.kicadCollab!.onItems!(
      JSON.stringify({
        added: [{ sexpr: `(wire (pts (xy 0 0) (xy 10 0)) (uuid "wire-b"))`, parent: null }],
        changed: [],
        removed: [],
      }),
    );

    releaseB();
    await switching;

    // CORRECT: the old sheet's room never receives the new sheet's items (no
    // cross-room contamination; peers on room A must not gain sheet B's wire).
    // TODAY: the stale closure applied it to aDoc.
    expect(kicadItemsMap(aDoc).get("wire-b")).toBeUndefined();

    m.destroy();
  });
});
