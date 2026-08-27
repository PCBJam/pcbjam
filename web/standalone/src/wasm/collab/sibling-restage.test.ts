import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise ONLY the subscribe/debounce/restage orchestration: the room connect,
// the ydoc materialization, and the MEMFS write are all collaborators.
const { connectKicadDoc, restageFile, ydocHasState } = vi.hoisted(() => ({
  connectKicadDoc: vi.fn(),
  restageFile: vi.fn(),
  ydocHasState: vi.fn(),
}));

vi.mock("./index", () => ({ connectKicadDoc }));
vi.mock("../kicad-runner", () => ({ restageFile }));
vi.mock("@pcbjam/shared", () => ({
  collabRoomId: (s: string, p: string, d: string) => `${s}:${p}:${d}`,
  ydocHasState,
  ydocIsHollow: () => false,
  yToDoc: (doc: unknown) => doc,
  docToFile: () => "(kicad_sch materialized)",
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
  };
}

let sessions: FakeSession[];

function makeSession(room: string): FakeSession {
  const handlers = new Set<() => void>();
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
    expect(restageFile).toHaveBeenCalledTimes(1);
    expect(restageFile.mock.calls[0]![2]).toBe("main.kicad_sch");
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
