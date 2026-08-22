import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  applyDeltaToY,
  fileToDoc,
  itemsWireToDelta,
  kicadItemsMap,
  parseItemsWireDelta,
  renderItem,
  scalar,
  sexprToItems,
  syncLayoutToY,
  yToDoc,
  type KicadItem,
} from "@pcbjam/shared";
import {
  bindKicadCollab,
  type KicadItemsBridge,
  type NativeProjectionFailure,
} from "./kicad-binding";
import { NativeItemsApplyError } from "./native-items-bridge";

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
  complete(nativeEmission?: string): void;
  fail(error: unknown): void;
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
  snapshotCalls = 0;
  destroyCalls = 0;
  private emit: ((json: string) => void) | null = null;
  private destroyed = false;

  constructor(text: string) {
    Object.assign(this.store, fileToDoc(text).items);
  }

  snapshotItems(): string {
    this.snapshotCalls += 1;
    const roots = Object.entries(this.store)
      .filter(([, item]) => item.parent === null)
      .map(([uuid]) => ({ sexpr: renderItem({ items: this.store }, uuid), parent: null }));
    return JSON.stringify({ added: roots, changed: [], removed: [] });
  }

  applyItems(json: string): Promise<void> {
    this.submitted.push(json);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.pending.push({
      json,
      complete: (nativeEmission?: string) => {
        this.applyToStore(json);
        if (nativeEmission !== undefined) {
          this.applyToStore(nativeEmission);
          this.emit?.(nativeEmission);
        }
        resolve();
      },
      fail: reject,
    });
    return completion;
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

  releaseOneWithNativeEmission(sexpr: string): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending native apply");
    next.complete(
      JSON.stringify({
        added: [],
        changed: [{ sexpr, parent: null }],
        removed: [],
      }),
    );
  }

  rejectOne(error: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending native apply");
    next.fail(error);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyCalls += 1;
    this.emit = null;
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

function setup(onProjectionFailure?: (failure: NativeProjectionFailure) => void): {
  a: Y.Doc;
  b: Y.Doc;
  binding: ReturnType<typeof bindKicadCollab>;
  editor: DeferredEditor;
} {
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
  const binding = bindKicadCollab(b, editor, { onProjectionFailure });
  binding.seed(undefined, { editorMatchesDoc: true });
  return { a, b, binding, editor };
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

  it("advances the shadow from the exact acknowledged wire without an ACK-time snapshot", async () => {
    const { a, editor } = setup();
    const baselineSnapshots = editor.snapshotCalls;

    setSegmentField(a, "width", "0.55");
    expect(editor.pending).toHaveLength(1);
    editor.releaseOne();
    await Promise.resolve();
    await Promise.resolve();

    expect(editor.snapshotCalls, "ACK must not destructively redefine the native base").toBe(
      baselineSnapshots,
    );
    expect(scalar(editor.store["seg-1"]!.body, "width")).toBe("0.55");
  });

  it("preserves then fail-stops a native normalization emitted before acknowledgement", async () => {
    const failures: NativeProjectionFailure[] = [];
    const { a, editor } = setup((failure) => failures.push(failure));

    // Native accepts the authored spelling, normalizes it during the queued
    // apply, emits that committed normalization, and only then ACKs. The
    // normalization is a native transition after the submitted wire; it must
    // cannot be ordered safely against the submitted wire. Preserve the
    // parseable normalization in Y, then retire this generation instead of
    // overwriting its shadow and projecting forever.
    setSegmentField(a, "width", "0.400");
    expect(editor.pending).toHaveLength(1);
    editor.releaseOneWithNativeEmission(
      `(segment (start 0 0) (end 10 10) (width 0.4) (layer "F.Cu") (uuid "seg-1"))`,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(scalar(yToDoc(a).items["seg-1"]!.body, "width")).toBe("0.4");
    expect(scalar(editor.store["seg-1"]!.body, "width")).toBe("0.4");
    expect(failures).toEqual([
      expect.objectContaining({
        kind: "native-emission-order",
        status: "emission-before-ack",
        recovery: "recreate-from-yjs",
      }),
    ]);
    expect(editor.destroyCalls).toBe(1);
    expect(editor.submitted, "ambiguous normalization must never echo").toHaveLength(1);
    expect(editor.pending).toHaveLength(0);
  });

  it("retries only an explicit no-mutation failure and retries the latest desired state", async () => {
    vi.useFakeTimers();
    try {
      const { a, editor } = setup();
      setSegmentField(a, "width", "0.4");
      editor.rejectOne(
        new NativeItemsApplyError("busy", true, "test-owner", "request-1"),
      );
      setSegmentField(a, "width", "0.9");
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(25);
      expect(editor.submitted).toHaveLength(2);
      expect(editor.pending).toHaveLength(1);
      editor.releaseOne();
      await Promise.resolve();
      await Promise.resolve();
      expect(scalar(editor.store["seg-1"]!.body, "width")).toBe("0.9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes unknown native state, detaches ingress, and never retries", async () => {
    vi.useFakeTimers();
    try {
      const failures: NativeProjectionFailure[] = [];
      const { a, editor } = setup((failure) => failures.push(failure));
      setSegmentField(a, "width", "0.4");
      editor.rejectOne(
        new NativeItemsApplyError("ack-timeout", false, "test-owner", "request-1"),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(failures).toEqual([
        expect.objectContaining({
          kind: "native-apply",
          status: "ack-timeout",
          recovery: "recreate-from-yjs",
        }),
      ]);
      expect(editor.destroyCalls).toBe(1);
      setSegmentField(a, "width", "0.8");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(editor.submitted, "terminal is absorbing").toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("P0: non-item native projection is explicit", () => {
  it("requires fresh-instance rehydration for a remote layout-only change", () => {
    const failures: NativeProjectionFailure[] = [];
    const { a, editor } = setup((failure) => failures.push(failure));
    const changed = fileToDoc(
      BASE.replace("(version 20241229)", '(version 20241229)\n  (paper "A3")'),
    );

    expect(syncLayoutToY(changed, a, "remote-layout")).toBe(true);
    expect(failures).toEqual([
      expect.objectContaining({
        kind: "non-item-structure",
        recovery: "recreate-from-yjs",
      }),
    ]);
    expect(editor.submitted, "an item-only bridge must not pretend layout was applied").toEqual([]);
    expect(editor.destroyCalls).toBe(1);
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
      const item = kicadItemsMap(a).get("seg-1")!;
      item.set("body", "not-a-slot-tree");
    }).not.toThrow();

    expect(editor.snapshotItems()).toBe(before);
  });
});
