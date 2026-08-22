import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  fileToDoc,
  itemsWireToDelta,
  parseItemsWireDelta,
  renderItem,
  scalar,
  sexprToItems,
  yToDoc,
  type KicadItem,
} from "@pcbjam/shared";
import { bindKicadCollab, type KicadItemsBridge } from "./kicad-binding";

const BASE = `(kicad_pcb
  (version 20241229)
  (segment
    (start 0 0)
    (end 10 10)
    (width 0.2)
    (layer "F.Cu")
    (uuid "seg-1")))`;

interface PendingApply {
  json: string;
  complete(): void;
}

/**
 * Models the real bridge contract more faithfully than the synchronous fake:
 * submitting an apply only queues native work.  The editor changes after a
 * later acknowledgement, which the test controls explicitly.
 */
class DeferredEditor implements KicadItemsBridge {
  store: Record<string, KicadItem> = {};
  readonly submitted: string[] = [];
  readonly pending: PendingApply[] = [];
  private emit: ((json: string) => void) | null = null;

  constructor(text: string) {
    Object.assign(this.store, fileToDoc(text).items);
  }

  snapshotItems(): string {
    const roots = Object.entries(this.store)
      .filter(([, item]) => item.parent === null)
      .map(([uuid]) => ({ sexpr: renderItem({ items: this.store }, uuid), parent: null }));
    return JSON.stringify({ added: roots, changed: [], removed: [] });
  }

  applyItems(json: string): void {
    this.submitted.push(json);
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    this.pending.push({
      json,
      complete: () => {
        this.applyToStore(json);
        resolve();
      },
    });
    // Current production types say void even though the JSPI scheduler may
    // return a Promise.  Returning it through the void boundary reproduces the
    // ignored-completion bug without changing production code in the red commit.
    return completion as unknown as void;
  }

  onItems(cb: (json: string) => void): void {
    this.emit = cb;
  }

  localUpsert(sexpr: string): void {
    const json = JSON.stringify({ added: [], changed: [{ sexpr, parent: null }], removed: [] });
    this.applyToStore(json);
    this.emit?.(json);
  }

  releaseOne(): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending native apply");
    next.complete();
  }

  private applyToStore(json: string): void {
    const delta = itemsWireToDelta(parseItemsWireDelta(json), this.store);
    for (const item of [...delta.added, ...delta.updated]) {
      const { uuid, ...value } = item;
      this.store[uuid] = value;
    }
    for (const uuid of delta.removed) delete this.store[uuid];
  }
}

function relayedPair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.on("update", (update: Uint8Array) => Y.applyUpdate(b, update, "relay-a"));
  b.on("update", (update: Uint8Array) => Y.applyUpdate(a, update, "relay-b"));
  return { a, b };
}

function setup(): { a: Y.Doc; b: Y.Doc; editor: DeferredEditor } {
  const { a, b } = relayedPair();
  const seed = fileToDoc(BASE);
  // Seed before binding, then copy the full initial state like provider sync.
  const seedDoc = new Y.Doc();
  const seedEditor = new DeferredEditor(BASE);
  const seedBinding = bindKicadCollab(seedDoc, seedEditor);
  seedBinding.seed(seed);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(seedDoc));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(seedDoc));
  seedBinding.destroy();
  seedDoc.destroy();

  const editor = new DeferredEditor(BASE);
  const binding = bindKicadCollab(b, editor);
  binding.seed(undefined, { editorMatchesDoc: true });
  return { a, b, editor };
}

function setSegmentField(ydoc: Y.Doc, head: string, atom: string): void {
  const item = yToDoc(ydoc).items["seg-1"]!;
  const body = item.body.map((slot) =>
    "k" in slot && slot.k === head ? { k: head, v: [{ atom }] } : slot,
  );
  applyDeltaToY(ydoc, {
    added: [],
    updated: [{ uuid: "seg-1", ...item, body }],
    removed: [],
  });
}

describe("P0: native projection is level-triggered and acknowledged", () => {
  it("coalesces a remote burst to one in-flight apply plus one latest follow-up", async () => {
    const { a, editor } = setup();

    for (let i = 1; i <= 100; i++) setSegmentField(a, "width", String(i));

    // Correct protocol: submitting the first request marks one in flight.  The
    // other 99 updates only advance desired state; they are not forgotten and
    // do not create an unbounded native FIFO.
    expect(editor.submitted).toHaveLength(1);
    expect(editor.pending).toHaveLength(1);

    editor.releaseOne();
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.submitted.length).toBeLessThanOrEqual(2);

    if (editor.pending.length > 0) editor.releaseOne();
    await Promise.resolve();
    expect(scalar(editor.store["seg-1"]!.body, "width")).toBe("100");
  });
});

describe("P0: native publications rebase from the acknowledged shadow", () => {
  it("a stale native root cannot roll back a disjoint newer Y field", () => {
    const { a, editor } = setup();

    // Y advances width, but native application is deliberately held.  Native
    // still contains width=0.2 when the user changes only the layer.
    setSegmentField(a, "width", "0.4");
    expect(editor.pending).toHaveLength(1);
    editor.localUpsert(
      `(segment (start 0 0) (end 10 10) (width 0.2) (layer "B.Cu") (uuid "seg-1"))`,
    );

    const merged = yToDoc(a).items["seg-1"]!.body;
    expect(scalar(merged, "width"), "newer remote field survives").toBe("0.4");
    expect(scalar(merged, "layer"), "local disjoint edit survives").toBe('"B.Cu"');
  });
});

describe("P1: malformed raw Y is contained", () => {
  it("does not throw through the provider transaction or mutate native", () => {
    const { a, editor } = setup();
    const before = editor.snapshotItems();

    expect(() => {
      const item = a.getMap<Y.Map<unknown>>("kdoc_items").get("seg-1")!;
      item.set("body", "not-a-slot-tree");
    }).not.toThrow();

    expect(editor.snapshotItems()).toBe(before);
  });
});
