import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise ONLY the subscribe/debounce/restage orchestration: the room connect,
// the ydoc materialization, and the MEMFS write are all collaborators.
const { connectKicadDoc, restageFile, ydocHasState, docToFile } = vi.hoisted(() => ({
  connectKicadDoc: vi.fn(),
  restageFile: vi.fn(),
  ydocHasState: vi.fn(),
  docToFile: vi.fn(
    (_doc: unknown, _opts?: { onMissingItem?: (u: string) => void }) =>
      "(kicad_sch materialized)",
  ),
}));

vi.mock("./index", () => ({ connectKicadDoc }));
vi.mock("../kicad-runner", () => ({ restageFile }));
vi.mock("@pcbjam/shared", () => ({
  collabRoomId: (s: string, p: string, d: string) => `${s}:${p}:${d}`,
  ydocHasState,
  ydocIsHollow: () => false,
  yToDoc: (doc: unknown) => doc,
  docToFile,
}));

import { startSiblingRestage, type SiblingPresence } from "./sibling-restage";

interface FakeSession {
  room: string;
  doc: {
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    emitRemote: () => void;
  };
  provider: {
    destroy: ReturnType<typeof vi.fn>;
    awareness: { setLocalState: ReturnType<typeof vi.fn> };
    onReset: ReturnType<typeof vi.fn>;
    /** Fire the gateway's `reset` (0004 §2.3). */
    emitReset: () => void;
  };
}

let sessions: FakeSession[];

function makeSession(room: string): FakeSession {
  const handlers = new Set<() => void>();
  const resets = new Set<() => void>();
  return {
    room,
    doc: {
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === "update") handlers.add(cb);
      }),
      destroy: vi.fn(),
      emitRemote: () => handlers.forEach((h) => h()),
    },
    provider: {
      destroy: vi.fn(),
      awareness: { setLocalState: vi.fn() },
      onReset: vi.fn((cb: () => void) => resets.add(cb)),
      emitReset: () => resets.forEach((h) => h()),
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
  restageFile.mockReset();
  ydocHasState.mockReset().mockReturnValue(true);
  docToFile.mockReset().mockReturnValue("(kicad_sch materialized)");
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

  it("watches as a PASSIVE PULL — never a participant, never a relay (0004 §2.2)", async () => {
    await start(["main.kicad_sch"]);
    expect(connectKicadDoc).toHaveBeenCalledWith(
      expect.objectContaining({ passive: true, passiveSync: true }),
    );
  });

  it("restages once on connect when the room already holds state", async () => {
    await start(["main.kicad_sch"]);
    expect(restageFile).toHaveBeenCalledTimes(1);
    expect(restageFile.mock.calls[0]![2]).toBe("main.kicad_sch");
  });

  it("restages leniently past dangling item refs, and warns (2026-08-31 corruption)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    docToFile.mockImplementation(
      (_doc: unknown, opts?: { onMissingItem?: (u: string) => void }) => {
        opts?.onMissingItem?.("ghost-1");
        return "(kicad_sch healed)";
      },
    );
    await start(["main.kicad_sch"]);
    expect(restageFile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangling item ref"));
    warn.mockRestore();
  });

  it("a restage failure is loud, not just debug-logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    docToFile.mockImplementation(() => {
      throw new Error("renderItem: cycle through item x");
    });
    await start(["main.kicad_sch"]);
    expect(restageFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("restage failed"),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("leaves the boot snapshot alone when the room is empty", async () => {
    ydocHasState.mockReturnValue(false);
    await start(["main.kicad_sch"]);
    expect(restageFile).not.toHaveBeenCalled();
  });

  it("debounces remote updates into one restage", async () => {
    await start(["main.kicad_sch"]);
    restageFile.mockClear();
    sessions[0]!.doc.emitRemote();
    sessions[0]!.doc.emitRemote();
    sessions[0]!.doc.emitRemote();
    expect(restageFile).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(restageFile).toHaveBeenCalledTimes(1);
  });

  it("destroy tears down providers and cancels pending restages", async () => {
    const handle = await start(["main.kicad_sch", "sub.kicad_sch"]);
    restageFile.mockClear();
    sessions[0]!.doc.emitRemote();
    handle.destroy();
    vi.runAllTimers();
    expect(restageFile).not.toHaveBeenCalled();
    for (const s of sessions) {
      expect(s.provider.destroy).toHaveBeenCalled();
      expect(s.doc.destroy).toHaveBeenCalled();
    }
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

    it("lingers after the peer leaves, flushes the pending restage, closes", async () => {
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.runAllTimersAsync();
      expect(sessions).toHaveLength(1);
      restageFile.mockClear();
      sessions[0]!.doc.emitRemote(); // debounced restage now pending
      presence.announce([]); // peer closes their tab
      await vi.advanceTimersByTimeAsync(60_000); // past linger + debounce
      expect(sessions[0]!.provider.destroy).toHaveBeenCalled();
      expect(sessions[0]!.doc.destroy).toHaveBeenCalled();
      expect(restageFile).toHaveBeenCalled(); // last edits reached MEMFS
      // Peer comes back: a fresh session dials again.
      presence.announce(["main.kicad_sch"]);
      await vi.runAllTimersAsync();
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
    });

    // C-6: a failed first dial must not latch forever — retry on backoff
    // while a peer still has the sheet open.
    it("retries a failed connect on backoff while the peer stays announced", async () => {
      connectKicadDoc
        .mockRejectedValueOnce(new Error("room down"))
        .mockImplementation(({ room }: { room: string }) => {
          const s = makeSession(room);
          sessions.push(s);
          return Promise.resolve(s);
        });
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.advanceTimersByTimeAsync(0);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);

      // Roster churn alone must NOT re-dial (anti-flood invariant kept).
      presence.announce(["main.kicad_sch"]);
      presence.announce(["main.kicad_sch"]);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);

      // The 1s backoff timer re-dials and succeeds.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
      expect(sessions).toHaveLength(1);
    });

    it("stops retrying once the peer leaves and the linger elapses", async () => {
      connectKicadDoc.mockRejectedValue(new Error("room down"));
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.advanceTimersByTimeAsync(0);
      expect(connectKicadDoc).toHaveBeenCalledTimes(1);

      // Backoff doubles: 1s → 2s while the peer stays.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(3);

      presence.announce([]); // peer leaves → linger releases the watch
      await vi.advanceTimersByTimeAsync(600_000);
      expect(connectKicadDoc).toHaveBeenCalledTimes(3); // no further dials
    });

    it("a reset drops the watch without flushing and re-dials while still wanted (0004 §2.3)", async () => {
      const presence = fakePresence(["main.kicad_sch"]);
      await start(["main.kicad_sch"], presence);
      await vi.runAllTimersAsync();
      expect(sessions.length).toBe(1);
      restageFile.mockClear();
      sessions[0]!.doc.emitRemote(); // a pending restage from the OLD epoch…
      sessions[0]!.provider.emitReset();
      await vi.runAllTimersAsync();
      // …is discarded, the old session torn down, a fresh one dialed.
      expect(sessions[0]!.provider.destroy).toHaveBeenCalled();
      expect(sessions[0]!.doc.destroy).toHaveBeenCalled();
      expect(sessions.length).toBe(2);
      // Only the fresh session's connect-time restage ran.
      expect(restageFile).toHaveBeenCalledTimes(1);
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
  });
});
