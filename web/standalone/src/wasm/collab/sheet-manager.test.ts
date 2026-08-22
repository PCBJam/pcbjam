import { beforeEach, describe, expect, it, vi } from "vitest";

// The manager orchestrates connect/bind lifecycle; mock its collaborators so the test
// exercises ONLY the warm-pool + active-binding-swap logic (no yjs, no wasm bridge).
const { connectKicadDoc, bindKicadCollab, moduleItemsBridge } = vi.hoisted(() => ({
  connectKicadDoc: vi.fn(),
  bindKicadCollab: vi.fn(),
  moduleItemsBridge: vi.fn(),
}));

vi.mock("./index", () => ({ connectKicadDoc }));
vi.mock("./kicad-binding", () => ({ bindKicadCollab, moduleItemsBridge }));
vi.mock("@pcbjam/shared", () => ({
  collabRoomId: (s: string, p: string, d: string) => `${s}:${p}:${d}`,
}));

import { createSheetCollabManager } from "./sheet-manager";

interface FakeDoc {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  /** Simulate a remote update arriving over the (warm) provider while parked. */
  emitRemote: () => void;
}
interface FakeSession {
  room: string;
  doc: FakeDoc;
  provider: { destroy: ReturnType<typeof vi.fn> };
}
interface FakeBinding {
  seed: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  lastSeedOpts?: unknown;
}
interface FakeBridge {
  snapshotItems: ReturnType<typeof vi.fn>;
  applyItems: ReturnType<typeof vi.fn>;
  onItems: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

let sessions: FakeSession[];
let bindings: FakeBinding[];
let bridges: FakeBridge[];

function makeDoc(): FakeDoc {
  const handlers = new Set<() => void>();
  return {
    on: vi.fn((ev: string, cb: () => void) => {
      if (ev === "update") handlers.add(cb);
    }),
    off: vi.fn((_ev: string, cb: () => void) => {
      handlers.delete(cb);
    }),
    destroy: vi.fn(),
    emitRemote: () => handlers.forEach((h) => h()),
  };
}

function makeManager() {
  return createSheetCollabManager({
    mod: {} as never,
    win: {} as never,
    scopeId: "S",
    projectId: "P",
    provider: { kind: "none" } as never,
    seedDocForPath: () => undefined,
    log: () => {},
  });
}

beforeEach(() => {
  sessions = [];
  bindings = [];
  bridges = [];
  connectKicadDoc.mockReset();
  bindKicadCollab.mockReset();
  moduleItemsBridge.mockReset();

  connectKicadDoc.mockImplementation(async ({ room }: { room: string }) => {
    const session: FakeSession = { room, doc: makeDoc(), provider: { destroy: vi.fn() } };
    sessions.push(session);
    return session;
  });
  bindKicadCollab.mockImplementation(() => {
    const b: FakeBinding = {
      seed: vi.fn((_seedDoc: unknown, opts?: unknown) => {
        b.lastSeedOpts = opts;
      }),
      destroy: vi.fn(),
    };
    bindings.push(b);
    return b;
  });
  moduleItemsBridge.mockImplementation(() => {
    const bridge: FakeBridge = {
      snapshotItems: vi.fn(),
      applyItems: vi.fn(),
      onItems: vi.fn(),
      destroy: vi.fn(),
    };
    bridges.push(bridge);
    return bridge;
  });
});

describe("sheet-manager warm pool", () => {
  it("warms each sheet once and dedups re-warming", async () => {
    const m = makeManager();
    await m.connectAll(["a.kicad_sch", "b.kicad_sch"]);
    expect(connectKicadDoc).toHaveBeenCalledTimes(2);
    await m.connectAll(["a.kicad_sch"]); // already warm — no reconnect
    expect(connectKicadDoc).toHaveBeenCalledTimes(2);
  });

  it("first switch binds + seeds the active sheet", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    expect(bindKicadCollab).toHaveBeenCalledTimes(1);
    expect(bindings[0]!.seed).toHaveBeenCalledTimes(1);
    expect(m.active()?.sheetPath).toBe("a.kicad_sch");
  });

  it("switching detaches the old binding but keeps every provider warm", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    await m.switchTo("b.kicad_sch");

    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1); // old binding detached
    expect(bindKicadCollab).toHaveBeenCalledTimes(2); // new binding for b
    // No provider is torn down on a switch — that's the whole point of the warm pool.
    expect(sessions.every((s) => s.provider.destroy.mock.calls.length === 0)).toBe(true);
  });

  it("acquires a fresh native owner bridge for every sheet activation", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    await m.switchTo("b.kicad_sch");
    await m.switchTo("a.kicad_sch");

    expect(moduleItemsBridge).toHaveBeenCalledTimes(3);
    expect(new Set(bridges)).toHaveProperty("size", 3);
    expect(bindKicadCollab.mock.calls.map((call) => call[1])).toEqual(bridges);
  });

  it("re-warms each sheet exactly once across repeated switches", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    await m.switchTo("b.kicad_sch");
    await m.switchTo("a.kicad_sch");
    // a + b connected once each; the revisit reuses the warm room.
    expect(connectKicadDoc).toHaveBeenCalledTimes(2);
  });

  it("a clean revisit rebinds WITHOUT re-applying (baseline-only)", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    await m.switchTo("b.kicad_sch");
    await m.switchTo("a.kicad_sch"); // no remote change arrived while parked
    expect(bindings.at(-1)!.lastSeedOpts).toEqual({ editorMatchesDoc: true });
  });

  it("a remote edit while parked forces a catch-up adopt on revisit", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    const aDoc = sessions[0]!.doc;
    await m.switchTo("b.kicad_sch"); // parks a, starts its update watch
    aDoc.emitRemote(); // remote edit lands on the parked doc
    await m.switchTo("a.kicad_sch");
    expect(bindings.at(-1)!.lastSeedOpts).toEqual({ editorMatchesDoc: false });
  });

  it("onboard connects a mid-session sheet exactly once", async () => {
    const m = makeManager();
    await m.onboard("new.kicad_sch");
    await m.onboard("new.kicad_sch");
    expect(connectKicadDoc).toHaveBeenCalledTimes(1);
  });

  it("destroy tears down every provider and doc", async () => {
    const m = makeManager();
    await m.connectAll(["a.kicad_sch", "b.kicad_sch"]);
    await m.switchTo("a.kicad_sch");
    m.destroy();
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.provider.destroy).toHaveBeenCalledTimes(1);
      expect(s.doc.destroy).toHaveBeenCalledTimes(1);
    }
    expect(m.active()).toBeNull();
  });

  it("uses the pre-connected entry session (ydoc mode) instead of reconnecting", async () => {
    const entryDoc = makeDoc();
    const entrySession: FakeSession = {
      room: "S:P:root.kicad_sch",
      doc: entryDoc,
      provider: { destroy: vi.fn() },
    };
    const m = createSheetCollabManager({
      mod: {} as never,
      win: {} as never,
      scopeId: "S",
      projectId: "P",
      provider: { kind: "none" } as never,
      seedDocForPath: () => undefined,
      log: () => {},
      initial: {
        sheetPath: "root.kicad_sch",
        session: entrySession as never,
        editorMatchesDoc: true,
      },
    });
    await m.switchTo("root.kicad_sch");
    expect(connectKicadDoc).not.toHaveBeenCalled(); // entry room already connected
    // The ydoc-entry seed is baseline-only (its file was materialized from the doc).
    expect(bindings[0]!.lastSeedOpts).toEqual({ editorMatchesDoc: true });
  });
});

describe("sheet-manager lifecycle hardening (findings C-1/C-4/C-5)", () => {
  it("releases a freshly-acquired owner if binding construction throws", async () => {
    const fatal = new Error("binding construction failed");
    bindKicadCollab.mockImplementationOnce(() => {
      throw fatal;
    });
    const m = makeManager();

    await expect(m.switchTo("a.kicad_sch")).resolves.toBeUndefined();
    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("a connect resolving after destroy() is torn down, not registered (C-1)", async () => {
    let release!: () => void;
    const late: FakeSession = {
      room: "late",
      doc: makeDoc(),
      provider: { destroy: vi.fn() },
    };
    connectKicadDoc.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res(late);
        }),
    );
    const m = makeManager();
    const warm = m.connectAll(["late.kicad_sch"]);
    m.destroy();
    release();
    await warm; // connectAll swallows the (deliberate) post-destroy failure
    expect(late.provider.destroy).toHaveBeenCalled();
    expect(late.doc.destroy).toHaveBeenCalled();
    expect(m.active()).toBeNull();
  });

  it("clears the host's per-sheet callbacks BEFORE the new room connects (C-4)", async () => {
    const events: string[] = [];
    const m = createSheetCollabManager({
      mod: {} as never,
      win: {} as never,
      scopeId: "S",
      projectId: "P",
      provider: { kind: "none" } as never,
      seedDocForPath: () => undefined,
      onActiveChange: (active) =>
        events.push(active ? `bind:${active.sheetPath}` : "clear"),
      log: () => {},
    });
    await m.switchTo("a.kicad_sch");
    expect(events).toEqual(["bind:a.kicad_sch"]);

    // Gate sheet b's connect so the pre-connect window is observable.
    let releaseB!: () => void;
    connectKicadDoc.mockImplementationOnce(
      ({ room }: { room: string }) =>
        new Promise((res) => {
          releaseB = () =>
            res({ room, doc: makeDoc(), provider: { destroy: vi.fn() } });
        }),
    );
    const sw = m.switchTo("b.kicad_sch");
    await new Promise((r) => setTimeout(r, 0)); // let doSwitch reach the connect await
    // The old sheet's presence/comments/follow/drift were cleared while b is
    // STILL CONNECTING — the bleed window is closed.
    expect(events).toEqual(["bind:a.kicad_sch", "clear"]);
    releaseB();
    await sw;
    expect(events).toEqual(["bind:a.kicad_sch", "clear", "bind:b.kicad_sch"]);
  });

  it("switchTo rejects SexprVersionError terminally — no retry, queue stays usable (C-5)", async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager();
      const skew = Object.assign(new Error("doc written by a newer encoding"), {
        name: "SexprVersionError",
      });
      bindKicadCollab.mockImplementationOnce(() => {
        throw skew;
      });
      await expect(m.switchTo("a.kicad_sch")).rejects.toBe(skew);

      // Terminal: no backoff timer was armed (the old behavior retried 2s→30s
      // forever and the returned promise never rejected).
      await vi.advanceTimersByTimeAsync(120_000);
      expect(bindKicadCollab).toHaveBeenCalledTimes(1);

      // The serialization queue is not poisoned: explicit navigation works.
      await m.switchTo("b.kicad_sch");
      expect(m.active()?.sheetPath).toBe("b.kicad_sch");
    } finally {
      vi.useRealTimers();
    }
  });
});
