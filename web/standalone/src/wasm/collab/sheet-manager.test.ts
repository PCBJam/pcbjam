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

let sessions: FakeSession[];
let bindings: FakeBinding[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

function makeSession(room: string): FakeSession {
  return { room, doc: makeDoc(), provider: { destroy: vi.fn() } };
}

function makeManager(
  onActiveChange?: Parameters<typeof createSheetCollabManager>[0]["onActiveChange"],
) {
  return createSheetCollabManager({
    mod: {} as never,
    win: {} as never,
    scopeId: "S",
    projectId: "P",
    provider: { kind: "none" } as never,
    seedDocForPath: () => undefined,
    log: () => {},
    onActiveChange,
  });
}

beforeEach(() => {
  vi.useRealTimers();
  sessions = [];
  bindings = [];
  connectKicadDoc.mockReset();
  bindKicadCollab.mockReset();
  moduleItemsBridge.mockReset();

  connectKicadDoc.mockImplementation(async ({ room }: { room: string }) => {
    const session = makeSession(room);
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
  moduleItemsBridge.mockImplementation(() => ({
    snapshotItems: vi.fn(),
    applyItems: vi.fn(),
    onItems: vi.fn(),
  }));
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

  it("rejects SexprVersionError without retrying or claiming an active binding", async () => {
    vi.useFakeTimers();
    const versionError = Object.assign(new Error("update required"), {
      name: "SexprVersionError",
    });
    bindKicadCollab.mockImplementationOnce(() => {
      throw versionError;
    });
    const m = makeManager();

    await expect(m.switchTo("newer.kicad_sch")).rejects.toBe(versionError);
    expect(m.active()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(bindKicadCollab).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // The rejected public attempt must not poison the private serial queue.
    await m.switchTo("supported.kicad_sch");
    expect(m.active()?.sheetPath).toBe("supported.kicad_sch");
  });

  it("absorbs terminal owner failure across a later navigation storm", async () => {
    vi.useFakeTimers();
    const terminal = Object.assign(
      new Error("[wx-scheduler] shutdown: application is dead"),
      { code: "WX_NATIVE_ENTRY_ABANDONED" },
    );
    bindKicadCollab.mockImplementationOnce(() => {
      const binding: FakeBinding = {
        seed: vi.fn().mockRejectedValue(terminal),
        destroy: vi.fn(),
      };
      bindings.push(binding);
      return binding;
    });
    const m = makeManager();

    await m.switchTo("terminal.kicad_sch");
    expect(bindKicadCollab).toHaveBeenCalledTimes(1);
    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(m.active()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        m.switchTo(`after-terminal-${index % 3}.kicad_sch`),
      ),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      bindKicadCollab,
      "later navigation events must not bind against the dead Module",
    ).toHaveBeenCalledTimes(1);
    expect(connectKicadDoc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      sessions[0]!.provider.destroy,
      "native retirement does not tear down the warm data room",
    ).not.toHaveBeenCalled();

    // A new manager is an exact new editor/resource lifetime, so the latch is
    // not process-global and cannot poison a replacement Module.
    const replacement = makeManager();
    await replacement.switchTo("replacement.kicad_sch");
    expect(bindKicadCollab).toHaveBeenCalledTimes(2);
    expect(replacement.active()?.sheetPath).toBe("replacement.kicad_sch");
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

  it("does not bind a navigation superseded during its room handshake", async () => {
    const a = deferred<FakeSession>();
    const b = deferred<FakeSession>();
    connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
      const session = makeSession(room);
      sessions.push(session);
      return room.endsWith("a.kicad_sch") ? a.promise : b.promise;
    });
    const m = makeManager();

    const switchA = m.switchTo("a.kicad_sch");
    await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(1));
    const switchB = m.switchTo("b.kicad_sch");

    a.resolve(sessions[0]!);
    await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(2));
    expect(bindKicadCollab).not.toHaveBeenCalled();

    b.resolve(sessions[1]!);
    await Promise.all([switchA, switchB]);
    expect(bindKicadCollab).toHaveBeenCalledTimes(1);
    expect(bindKicadCollab.mock.calls[0]![0]).toBe(sessions[1]!.doc);
    expect(m.active()?.sheetPath).toBe("b.kicad_sch");
  });

  it("makes an in-flight seed inert when newer navigation supersedes it", async () => {
    const aSeed = deferred<void>();
    const publications: Array<string | null> = [];
    let aSeedReleased = false;
    let aDestroyedBeforeSeedRelease = false;

    bindKicadCollab.mockImplementation(() => {
      const isA = bindings.length === 0;
      const b: FakeBinding = {
        seed: vi.fn(() => (isA ? aSeed.promise : Promise.resolve())),
        destroy: vi.fn(() => {
          if (isA && !aSeedReleased) aDestroyedBeforeSeedRelease = true;
        }),
      };
      bindings.push(b);
      return b;
    });

    const m = makeManager((active) => publications.push(active?.sheetPath ?? null));
    const switchA = m.switchTo("a.kicad_sch");
    await vi.waitFor(() => expect(bindings[0]?.seed).toHaveBeenCalledTimes(1));

    const switchB = m.switchTo("b.kicad_sch");
    await Promise.resolve();
    expect(m.active()).toBeNull();
    expect(publications).toEqual([]);

    // Release the obsolete seed so both public switch promises can settle.
    // The binding must already have become inert when switchTo(b) superseded it.
    aSeedReleased = true;
    aSeed.resolve();
    await Promise.all([switchA, switchB]);

    expect(aDestroyedBeforeSeedRelease).toBe(true);
    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(bindings[1]!.destroy).not.toHaveBeenCalled();
    expect(publications).toEqual(["b.kicad_sch"]);
    expect(m.active()?.sheetPath).toBe("b.kicad_sch");
  });

  it("destroys an in-flight seed exactly once without publishing it", async () => {
    const seed = deferred<void>();
    const publications: Array<string | null> = [];
    bindKicadCollab.mockImplementation(() => {
      const b: FakeBinding = {
        seed: vi.fn(() => seed.promise),
        destroy: vi.fn(),
      };
      bindings.push(b);
      return b;
    });

    const m = makeManager((active) => publications.push(active?.sheetPath ?? null));
    const switching = m.switchTo("a.kicad_sch");
    await vi.waitFor(() => expect(bindings[0]?.seed).toHaveBeenCalledTimes(1));

    m.destroy();
    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(m.active()).toBeNull();

    seed.resolve();
    await switching;

    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.provider.destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.doc.destroy).toHaveBeenCalledTimes(1);
    expect(publications).toEqual([null]);
    expect(m.active()).toBeNull();
  });

  it("re-warms each sheet exactly once across repeated switches", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    await m.switchTo("b.kicad_sch");
    await m.switchTo("a.kicad_sch");
    // a + b connected once each; the revisit reuses the warm room.
    expect(connectKicadDoc).toHaveBeenCalledTimes(2);
  });

  it("retires A synchronously while B's room handshake is stalled", async () => {
    const b = deferred<FakeSession>();
    const publications: Array<string | null> = [];
    connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
      const session = makeSession(room);
      sessions.push(session);
      return room.endsWith("b.kicad_sch") ? b.promise : Promise.resolve(session);
    });
    const m = makeManager((active) => publications.push(active?.sheetPath ?? null));
    await m.switchTo("a.kicad_sch");
    expect(publications).toEqual(["a.kicad_sch"]);
    await m.switchTo("a.kicad_sch");
    expect(publications).toEqual(["a.kicad_sch"]);

    const switching = m.switchTo("b.kicad_sch");
    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(m.active()).toBeNull();
    expect(publications).toEqual(["a.kicad_sch", null]);

    await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(2));
    b.resolve(sessions[1]!);
    await switching;
    expect(publications).toEqual(["a.kicad_sch", null, "b.kicad_sch"]);
  });

  it("passes one manager lifetime into every room connect and aborts it on destroy", async () => {
    const pending = deferred<FakeSession>();
    let connectSignal: AbortSignal | undefined;
    connectKicadDoc.mockImplementation((opts: { signal?: AbortSignal }) => {
      connectSignal = opts.signal;
      return pending.promise;
    });
    const m = makeManager();
    const warming = m.connectAll(["a.kicad_sch"]);
    await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(1));
    expect(connectSignal?.aborted).toBe(false);
    m.destroy();
    expect(connectSignal?.aborted).toBe(true);

    // The real connect rejects on this signal. Make the mock settle so the
    // public connectAll promise also proves it cannot remain stranded.
    pending.resolve(makeSession("S:P:a.kicad_sch"));
    await warming;
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

  it("retires each room resource even when earlier destructors throw", async () => {
    const m = makeManager();
    await m.switchTo("a.kicad_sch");
    bindings[0]!.destroy.mockImplementation(() => {
      throw new Error("binding teardown failed");
    });
    sessions[0]!.provider.destroy.mockImplementation(() => {
      throw new Error("provider teardown failed");
    });

    expect(() => m.destroy()).not.toThrow();
    expect(bindings[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.provider.destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.doc.destroy).toHaveBeenCalledTimes(1);
    expect(m.active()).toBeNull();
  });

  it("keeps room connects concurrent and rejects reverse completions after destroy", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<FakeSession>>>();
    let inFlight = 0;
    let maxInFlight = 0;
    connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
      const session = makeSession(room);
      const d = deferred<FakeSession>();
      sessions.push(session);
      pending.set(room, d);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return d.promise.finally(() => {
        inFlight--;
      });
    });
    const m = makeManager();

    const warming = m.connectAll(["a.kicad_sch", "b.kicad_sch"]);
    await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(2));
    expect(maxInFlight).toBeGreaterThan(1);
    m.destroy();

    // Finish in the opposite order. Neither stale session may enter the room
    // pool or survive manager teardown.
    pending.get("S:P:b.kicad_sch")!.resolve(sessions[1]!);
    pending.get("S:P:a.kicad_sch")!.resolve(sessions[0]!);
    await warming;

    for (const session of sessions) {
      expect(session.provider.destroy).toHaveBeenCalledTimes(1);
      expect(session.doc.destroy).toHaveBeenCalledTimes(1);
    }
    expect(bindKicadCollab).not.toHaveBeenCalled();
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
