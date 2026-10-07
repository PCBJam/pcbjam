import { afterEach, describe, expect, it, vi } from "vitest";
import { AIRLOCK_PATH, airlockUrl, safeReturnPath } from "./airlock";
import { createOomWatch, MAX_RETRIES, restartViaAirlock } from "./oom-watch";
import { isFirefox, joinCensus, takeCensus } from "./tab-census";

/** standalone-hardening 0009: airlock URLs, OOM recovery routing, tab census. */

const ORIGIN = "https://editor.pcbjam.com";
const EDITOR = `${ORIGIN}/p/acme/board/pcbnew?file=main.kicad_pcb#x`;

describe("airlock", () => {
  it("airlockUrl keeps the full same-origin path as `to`", () => {
    const u = new URL(airlockUrl(EDITOR));
    expect(u.origin).toBe(ORIGIN);
    expect(u.pathname).toBe(AIRLOCK_PATH);
    expect(u.searchParams.get("to")).toBe("/p/acme/board/pcbnew?file=main.kicad_pcb#x");
  });

  it("round-trips through safeReturnPath", () => {
    const to = new URL(airlockUrl(EDITOR)).searchParams.get("to");
    expect(safeReturnPath(to, ORIGIN)).toBe("/p/acme/board/pcbnew?file=main.kicad_pcb#x");
  });

  it.each([
    [null, "/"],
    ["https://evil.example/p/x", "/"],
    ["//evil.example/p/x", "/"],
    ["javascript:alert(1)", "/"],
    ["/recover?to=/recover", "/"],
    ["/recover.html", "/"],
    ["/recover/", "/"],
    ["/p/a/b?oomRetry=1", "/p/a/b?oomRetry=1"],
  ])("safeReturnPath(%s) → %s", (to, want) => {
    expect(safeReturnPath(to, ORIGIN)).toBe(want);
  });
});

/** A minimal Window double: location, history, listeners, localStorage. */
function fakeWin(href: string) {
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;
  const replace = vi.fn();
  const win = {
    location: { href, search: new URL(href).search, replace },
    history: { replaceState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  } as unknown as Window;
  return { win, storage, replace };
}

describe("oom-watch recovery goes through the airlock", () => {
  afterEach(() => vi.useRealTimers());

  it("a soft abort replaces the tab with /recover, retry bumped in `to`", () => {
    vi.useFakeTimers();
    const { win, storage, replace } = fakeWin(EDITOR);
    const oom = createOomWatch({ channelKey: "k", showExhaustedDialog: vi.fn(), win, storage });
    oom.start();
    oom.onAbort("Aborted(OOM)");
    expect(replace).toHaveBeenCalledTimes(1);
    const u = new URL(replace.mock.calls[0]![0] as string);
    expect(u.pathname).toBe("/recover");
    const back = new URL(u.searchParams.get("to")!, ORIGIN);
    expect(back.pathname).toBe("/p/acme/board/pcbnew");
    expect(back.searchParams.get("oomRetry")).toBe("1");
    expect(win.open).not.toHaveBeenCalled();
    oom.stop();
  });

  it("at the retry cap shows the dialog instead of navigating", () => {
    vi.useFakeTimers();
    const { win, storage, replace } = fakeWin(`${ORIGIN}/p/a/b?oomRetry=${MAX_RETRIES}`);
    const show = vi.fn();
    const oom = createOomWatch({ channelKey: "k", showExhaustedDialog: show, win, storage });
    oom.start();
    oom.onAbort("Aborted(OOM)");
    expect(show).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    oom.stop();
  });

  it("restartViaAirlock starts a fresh chain", () => {
    const { win, replace } = fakeWin(`${ORIGIN}/p/a/b?oomRetry=2&x=1`);
    restartViaAirlock(win);
    const u = new URL(replace.mock.calls[0]![0] as string);
    expect(u.pathname).toBe("/recover");
    expect(u.searchParams.get("to")).toBe("/p/a/b?x=1");
  });
});

describe("tab census", () => {
  it("lists other joined tabs, never the asker", async () => {
    const leaveA = joinCensus(() => ({ tool: "pcbnew", title: "board — PCB Editor", url: "u1" }), {
      tabId: "a",
    });
    const leaveB = joinCensus(() => ({ tool: "eeschema", title: "board — Schematic Editor", url: "u2" }), {
      tabId: "b",
    });
    try {
      const fromA = await takeCensus({ selfId: "a", timeoutMs: 100 });
      expect(fromA.map((t) => t.tabId)).toEqual(["b"]);
      const fromAirlock = await takeCensus({ timeoutMs: 100 });
      expect(fromAirlock.map((t) => t.tabId).sort()).toEqual(["a", "b"]);
    } finally {
      leaveA();
      leaveB();
    }
  });

  it("a tab that left no longer answers", async () => {
    const leave = joinCensus(() => ({ tool: "pcbnew", title: "t", url: "u" }), { tabId: "gone" });
    leave();
    expect(await takeCensus({ timeoutMs: 100 })).toEqual([]);
  });

  it("resolves empty without BroadcastChannel", async () => {
    expect(await takeCensus({ channelFactory: () => null, timeoutMs: 10 })).toEqual([]);
  });

  it("isFirefox reads the UA", () => {
    expect(isFirefox("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/131.0")).toBe(true);
    expect(isFirefox("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129.0 Safari/537.36")).toBe(false);
  });
});
