import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise ONLY the subscribe/debounce/restage orchestration: the room connect,
// the ydoc materialization, and the MEMFS write are all collaborators.
const { connectKicadDoc, restageTextFileAsOwner, ydocHasState, docToFile } =
  vi.hoisted(() => ({
    connectKicadDoc: vi.fn(),
    restageTextFileAsOwner: vi.fn(),
    ydocHasState: vi.fn(),
    docToFile: vi.fn(),
  }));

vi.mock("./index", () => ({ connectKicadDoc }));
vi.mock("../kicad-runner", () => ({ restageTextFileAsOwner }));
vi.mock("@pcbjam/shared", () => ({
  collabRoomId: (s: string, p: string, d: string) => `${s}:${p}:${d}`,
  ydocHasState,
  yToDoc: (doc: unknown) => doc,
  docToFile,
}));

import { startSiblingRestage, type SiblingPresence } from "./sibling-restage";

interface FakeSession {
  room: string;
  doc: {
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    text: string;
    emitRemote: (text?: string) => void;
  };
  provider: {
    destroy: ReturnType<typeof vi.fn>;
    awareness: { setLocalState: ReturnType<typeof vi.fn> };
  };
}

let sessions: FakeSession[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeSession(room: string): FakeSession {
  const handlers = new Set<() => void>();
  return {
    room,
    doc: {
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === "update") handlers.add(cb);
      }),
      destroy: vi.fn(),
      text: "(kicad_sch materialized)",
      emitRemote(text?: string) {
        if (text !== undefined) this.text = text;
        handlers.forEach((h) => h());
      },
    },
    provider: {
      destroy: vi.fn(),
      awareness: { setLocalState: vi.fn() },
    },
  };
}

function start(files: string[], presence?: SiblingPresence) {
  return startSiblingRestage({
    win: {} as never,
    slug: "proj",
    scopeId: "S",
    projectId: "P",
    files: files.map((path) => ({ path })),
    presence,
    provider: { kind: "none" } as never,
    log: () => {},
  });
}

/** Roster fake: `announce` swaps the open-path set and fires subscribers. */
function fakePresence(initial: string[] = []) {
  let paths = initial;
  const subs = new Set<() => void>();
  return {
    peers: () => paths.map((sheetPath) => ({ state: { sheetPath } })),
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    announce(next: string[]) {
      paths = next;
      subs.forEach((cb) => cb());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sessions = [];
  connectKicadDoc.mockReset().mockImplementation(({ room }: { room: string }) => {
    const s = makeSession(room);
    sessions.push(s);
    return Promise.resolve(s);
  });
  restageTextFileAsOwner.mockReset().mockImplementation(
    (
      _win: unknown,
      _slug: string,
      _path: string,
      _text: string,
      _log: (message: string) => void,
      isCurrent?: () => boolean,
    ) => {
      if (isCurrent && !isCurrent()) {
        return Promise.reject(
          Object.assign(new Error("stale owner job"), {
            code: "WX_MUTATOR_STALE",
          }),
        );
      }
      return Promise.resolve();
    },
  );
  ydocHasState.mockReset().mockReturnValue(true);
  docToFile
    .mockReset()
    .mockImplementation((doc: { text: string }) => doc.text);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startSiblingRestage", () => {
  it("subscribes only the .kicad_sch siblings, as an invisible observer", async () => {
    await start(["main.kicad_pcb", "main.kicad_sch", "sub.kicad_sch", "a.kicad_wks"]);
    expect(sessions.map((s) => s.room)).toEqual([
      "S:P:main.kicad_sch",
      "S:P:sub.kicad_sch",
    ]);
    for (const s of sessions) {
      expect(s.provider.awareness.setLocalState).toHaveBeenCalledWith(null);
    }
  });

  it("restages once on connect when the room already holds state", async () => {
    await start(["main.kicad_sch"]);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
    expect(restageTextFileAsOwner.mock.calls[0]![2]).toBe("main.kicad_sch");
  });

  it("leaves the boot snapshot alone when the room is empty", async () => {
    ydocHasState.mockReturnValue(false);
    await start(["main.kicad_sch"]);
    expect(restageTextFileAsOwner).not.toHaveBeenCalled();
  });

  it("debounces remote updates into one restage", async () => {
    await start(["main.kicad_sch"]);
    restageTextFileAsOwner.mockClear();
    sessions[0]!.doc.emitRemote();
    sessions[0]!.doc.emitRemote();
    sessions[0]!.doc.emitRemote();
    expect(restageTextFileAsOwner).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
  });

  it("keeps one latest body while another owner is parked", async () => {
    type Ticket = {
      text: string;
      isCurrent?: () => boolean;
      resolve: () => void;
      reject: (error: Error & { code?: string }) => void;
    };
    const tickets: Ticket[] = [];
    const applied: string[] = [];
    let highWater = 0;

    // Model the real Promise gateway while an existing semantic owner is
    // parked: the submitted ticket cannot be admitted until releaseOwner().
    restageTextFileAsOwner.mockImplementation(
      (
        _win: unknown,
        _slug: string,
        _path: string,
        text: string,
        _log: (message: string) => void,
        isCurrent?: () => boolean,
      ) =>
        new Promise<void>((resolve, reject) => {
          tickets.push({ text, isCurrent, resolve, reject });
          highWater = Math.max(highWater, tickets.length);
        }),
    );

    const releaseOwner = () => {
      const ticket = tickets.shift();
      expect(ticket).toBeDefined();
      if (ticket!.isCurrent && !ticket!.isCurrent()) {
        ticket!.reject(
          Object.assign(new Error("stale owner job"), {
            code: "WX_MUTATOR_STALE",
          }),
        );
        return;
      }
      applied.push(ticket!.text);
      ticket!.resolve();
    };

    await start(["main.kicad_sch"]);
    expect(tickets).toHaveLength(1); // connect-time restage waits for the owner

    for (let i = 0; i < 1_000; i++) {
      sessions[0]!.doc.emitRemote(`body-${i}`);
    }
    await vi.advanceTimersByTimeAsync(400);

    // The owner gateway still has only the first ticket. All 1,000 WebSocket
    // updates occupy one replaceable latest-value slot in sibling-restage.
    expect(tickets).toHaveLength(1);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);

    releaseOwner(); // rejects the obsolete connect-time body at admission
    await vi.waitFor(() =>
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(2),
    );
    expect(tickets).toHaveLength(1);

    releaseOwner();
    await vi.waitFor(() => expect(tickets).toHaveLength(0));
    expect(applied).toEqual(["body-999"]);
    expect(highWater).toBe(1);
  });

  it.each([
    ["job capacity", { reason: "jobs", estimatedBytes: 24, maxBytes: 100 }],
    ["byte capacity", { reason: "bytes", estimatedBytes: 24, maxBytes: 100 }],
  ])(
    "retains and retries a body rejected by transient %s backpressure",
    async (_label, detail) => {
      let calls = 0;
      restageTextFileAsOwner.mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(
            Object.assign(new Error("owner queue full"), {
              code: "WX_MUTATOR_BACKPRESSURE",
              ...detail,
            }),
          );
        }
        return Promise.resolve();
      });

      await start(["main.kicad_sch"]);
      await Promise.resolve();
      await Promise.resolve();
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(2);
      expect(restageTextFileAsOwner.mock.calls[1]![3]).toBe(
        "(kicad_sch materialized)",
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rearms one retry with only the latest generation", async () => {
    let calls = 0;
    restageTextFileAsOwner.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          Object.assign(new Error("owner queue full"), {
            code: "WX_MUTATOR_BACKPRESSURE",
            reason: "jobs",
            estimatedBytes: 24,
            maxBytes: 100,
          }),
        );
      }
      return Promise.resolve();
    });

    await start(["main.kicad_sch"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    for (let i = 0; i < 1_000; i++) {
      sessions[0]!.doc.emitRemote(`body-${i}`);
    }
    await vi.advanceTimersByTimeAsync(400);

    // The generation change cancelled the connect-time retry at t=1000 and
    // rearmed the same single slot for the latest body at t=1400.
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(2);
    expect(restageTextFileAsOwner.mock.calls[1]![3]).toBe("body-999");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("submits at most once per retry interval while capacity remains full", async () => {
    restageTextFileAsOwner.mockRejectedValue(
      Object.assign(new Error("owner queue full"), {
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "jobs",
        estimatedBytes: 24,
        maxBytes: 100,
      }),
    );

    await start(["main.kicad_sch"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);

    for (let expected = 2; expected <= 5; expected++) {
      await vi.advanceTimersByTimeAsync(999);
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(expected);
      expect(vi.getTimerCount()).toBe(1);
    }
  });

  it.each([
    [
      "stale",
      Object.assign(new Error("stale owner job"), {
        code: "WX_MUTATOR_STALE",
      }),
    ],
    [
      "single native owner failure",
      Object.assign(new Error("native owner failed"), {
        code: "WX_NATIVE_OWNER_FAILED",
      }),
    ],
    [
      "intrinsically oversized",
      Object.assign(new Error("body cannot fit"), {
        code: "WX_MUTATOR_BACKPRESSURE",
        // Job capacity can win the scheduler's first check even though this
        // same body would still exceed the byte bound in an empty queue.
        reason: "jobs",
        estimatedBytes: 101,
        maxBytes: 100,
      }),
    ],
  ])("does not retry a %s rejection", async (_label, error) => {
    restageTextFileAsOwner.mockRejectedValue(error);

    await start(["main.kicad_sch"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
  });

  it("absorbs a terminal Module failure across a later WebSocket update storm", async () => {
    const terminal = Object.assign(
      new Error("[wx-scheduler] shutdown: application is dead"),
      { code: "WX_NATIVE_ENTRY_ABANDONED" },
    );
    restageTextFileAsOwner.mockRejectedValue(terminal);

    const handle = await start(["main.kicad_sch"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    for (let i = 0; i < 1_000; i++) {
      sessions[0]!.doc.emitRemote(`body-after-terminal-${i}`);
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      restageTextFileAsOwner,
      "later socket updates must not recreate a lane against the dead Module",
    ).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      sessions[0]!.provider.destroy,
      "terminal native projection does not stop the data/WebSocket lifetime",
    ).not.toHaveBeenCalled();
    expect(sessions[0]!.doc.text).toBe("body-after-terminal-999");

    handle.destroy();
    expect(sessions[0]!.provider.destroy).toHaveBeenCalledTimes(1);

    // A new handle represents a genuinely new editor Module lifetime.
    restageTextFileAsOwner.mockResolvedValue(undefined);
    await start(["replacement.kicad_sch"]);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(2);
  });

  it("destroy cancels a retained backpressure retry", async () => {
    restageTextFileAsOwner.mockRejectedValue(
      Object.assign(new Error("owner queue full"), {
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "bytes",
        estimatedBytes: 24,
        maxBytes: 100,
      }),
    );

    const handle = await start(["main.kicad_sch"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    handle.destroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
  });

  it("destroy tears down providers and cancels pending restages", async () => {
    const handle = await start(["main.kicad_sch", "sub.kicad_sch"]);
    restageTextFileAsOwner.mockClear();
    sessions[0]!.doc.emitRemote();
    handle.destroy();
    vi.runAllTimers();
    expect(restageTextFileAsOwner).not.toHaveBeenCalled();
    for (const s of sessions) {
      expect(s.provider.destroy).toHaveBeenCalled();
      expect(s.doc.destroy).toHaveBeenCalled();
    }
  });

  it("retires every document when an earlier provider destructor throws", async () => {
    const handle = await start(["main.kicad_sch", "sub.kicad_sch"]);
    sessions[0]!.provider.destroy.mockImplementation(() => {
      throw new Error("provider teardown failed");
    });

    expect(() => handle.destroy()).not.toThrow();
    for (const session of sessions) {
      expect(session.provider.destroy).toHaveBeenCalledTimes(1);
      expect(session.doc.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("also reconnects a failed eager fallback watch", async () => {
    let attempts = 0;
    connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error("initial provider unavailable"));
      }
      const session = makeSession(room);
      sessions.push(session);
      return Promise.resolve(session);
    });

    const handle = await start(["main.kicad_sch"]);
    expect(connectKicadDoc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(connectKicadDoc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectKicadDoc).toHaveBeenCalledTimes(2);
    expect(sessions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    handle.destroy();
  });

  describe("presence-scoped mode", () => {
    it("holds zero sockets while no peer announces a sheet", async () => {
      await start(["main.kicad_sch", "sub.kicad_sch"], fakePresence());
      expect(connectKicadDoc).not.toHaveBeenCalled();
    });

    it("connects only announced in-scope sheets, once", async () => {
      const presence = fakePresence();
      await start(["main.kicad_sch", "sub.kicad_sch"], presence);
      presence.announce(["main.kicad_sch", "other-dir.kicad_pcb"]);
      await vi.runAllTimersAsync();
      expect(sessions.map((s) => s.room)).toEqual(["S:P:main.kicad_sch"]);
      // A second announce of the same sheet (another peer joining) is a no-op.
      presence.announce(["main.kicad_sch"]);
      await vi.runAllTimersAsync();
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
    });

    it("retries an initial provider failure while the peer remains", async () => {
      let attempts = 0;
      connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new Error("initial provider unavailable"));
        }
        const session = makeSession(room);
        sessions.push(session);
        return Promise.resolve(session);
      });

      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
      expect(sessions).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
      handle.destroy();
    });

    it("keeps one reconnect slot across repeated roster notifications", async () => {
      connectKicadDoc.mockRejectedValue(new Error("provider unavailable"));
      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      for (let i = 0; i < 1_000; i++) {
        presence.announce(["main.kicad_sch"]);
      }
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      // Even actual leave/rejoin flaps cannot turn roster traffic into new
      // attempts. Each leave cancels the timer, and each rejoin rearms the
      // same slot at the retained absolute not-before edge.
      for (let i = 0; i < 1_000; i++) {
        presence.announce([]);
        presence.announce(["main.kicad_sch"]);
      }
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      for (let i = 0; i < 1_000; i++) {
        presence.announce(["main.kicad_sch"]);
      }
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      handle.destroy();
    });

    it("backs off repeated provider failures at a finite bounded rate", async () => {
      connectKicadDoc.mockRejectedValue(new Error("provider unavailable"));
      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);

      const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (let i = 0; i < delays.length; i++) {
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(delays[i]! - 1);
        expect(connectKicadDoc).toHaveBeenCalledTimes(i + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(connectKicadDoc).toHaveBeenCalledTimes(i + 2);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(vi.getTimerCount()).toBe(1);
      handle.destroy();
    });

    it("cancels a failed-connect retry as soon as the peer leaves", async () => {
      connectKicadDoc.mockRejectedValue(new Error("provider unavailable"));
      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      presence.announce([]);
      // Only the 30-second close linger remains. The provider-retry slot is
      // cancelled immediately when the path leaves the live roster.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      handle.destroy();
    });

    it("destroy cancels a failed-connect retry", async () => {
      connectKicadDoc.mockRejectedValue(new Error("provider unavailable"));
      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      handle.destroy();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
    });

    it("lingers after the peer leaves, flushes the pending restage, closes", async () => {
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.runAllTimersAsync();
      expect(sessions).toHaveLength(1);
      restageTextFileAsOwner.mockClear();
      sessions[0]!.doc.emitRemote(); // debounced restage now pending
      presence.announce([]); // peer closes their tab
      await vi.advanceTimersByTimeAsync(60_000); // past linger + debounce
      expect(sessions[0]!.provider.destroy).toHaveBeenCalled();
      expect(sessions[0]!.doc.destroy).toHaveBeenCalled();
      expect(restageTextFileAsOwner).toHaveBeenCalled(); // last edits reached MEMFS
      // Peer comes back: a fresh session dials again.
      presence.announce(["main.kicad_sch"]);
      await vi.runAllTimersAsync();
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
    });

    it("a rejoin during the linger keeps the existing session", async () => {
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.runAllTimersAsync();
      presence.announce([]); // leave…
      await vi.advanceTimersByTimeAsync(5_000); // …but rejoin within linger
      presence.announce(["main.kicad_sch"]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);
      expect(sessions[0]!.provider.destroy).not.toHaveBeenCalled();
    });

    it("rejects an obsolete reverse completion without serializing connects", async () => {
      const first = deferred<FakeSession>();
      const second = deferred<FakeSession>();
      let call = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      connectKicadDoc.mockImplementation(({ room }: { room: string }) => {
        const session = makeSession(room);
        const pending = call++ === 0 ? first : second;
        sessions.push(session);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return pending.promise.finally(() => {
          inFlight--;
        });
      });

      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(1));

      // Retire the first Watch before its handshake finishes, then create a
      // fresh Watch for the same path. Both handshakes are allowed to overlap.
      presence.announce([]);
      await vi.advanceTimersByTimeAsync(30_000);
      presence.announce(["main.kicad_sch"]);
      await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(2));
      expect(maxInFlight).toBeGreaterThan(1);

      // New wins first; old arrives last and must close without restaging.
      second.resolve(sessions[1]!);
      await vi.waitFor(() =>
        expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1),
      );
      first.resolve(sessions[0]!);
      await vi.waitFor(() =>
        expect(sessions[0]!.provider.destroy).toHaveBeenCalledTimes(1),
      );

      expect(restageTextFileAsOwner).toHaveBeenCalledTimes(1);
      expect(sessions[1]!.provider.destroy).not.toHaveBeenCalled();
      handle.destroy();
      expect(sessions[1]!.provider.destroy).toHaveBeenCalledTimes(1);
    });

    it("aborts the exact unfinished connect as soon as the peer leaves", async () => {
      let connectSignal: AbortSignal | undefined;
      connectKicadDoc.mockImplementation((opts: { signal?: AbortSignal }) => {
        connectSignal = opts.signal;
        return new Promise(() => {});
      });
      const presence = fakePresence(["main.kicad_sch"]);
      const handle = await start(["main.kicad_sch"], presence);
      await vi.waitFor(() => expect(connectKicadDoc).toHaveBeenCalledTimes(1));
      expect(connectSignal?.aborted).toBe(false);

      presence.announce([]);
      expect(connectSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      handle.destroy();
    });
  });
});
