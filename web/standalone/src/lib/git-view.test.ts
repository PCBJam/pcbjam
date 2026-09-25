import { describe, expect, it, vi } from "vitest";
import {
  copyForcesReadOnly,
  copyNotReady,
  fenceReloadsSilently,
  isConnectedCopy,
  refBadgeText,
  startGitTouchLoop,
} from "./git-view";

const view = { kind: "pinned" as const, baseCommit: "abcdef1234", headCommit: "abcdef1234", label: "v1" };

describe("repository view decisions", () => {
  it("pinned copies are read-only; branch and default copies are not; absent copy is not", () => {
    expect(copyForcesReadOnly(view)).toBe(true);
    expect(copyForcesReadOnly({ kind: "branch" })).toBe(false);
    expect(copyForcesReadOnly({ kind: "default" })).toBe(false);
    expect(copyForcesReadOnly(null)).toBe(false);
  });

  it("only a non-ready status blocks the boot", () => {
    expect(copyNotReady({ kind: "branch", status: "materializing" })).toBe("materializing");
    expect(copyNotReady({ kind: "branch", status: "failed" })).toBe("failed");
    expect(copyNotReady({ kind: "branch", status: "ready" })).toBeNull();
    expect(copyNotReady({ kind: "branch" })).toBeNull();
  });

  it("badges a view by branch or commit; following views reload silently", () => {
    expect(refBadgeText({ ...view, targetBranch: "main", follows: true })).toBe("Following main · abcdef1");
    expect(refBadgeText(view)).toBe("Viewing abcdef1");
    expect(refBadgeText({ kind: "branch", baseCommit: "x" })).toBeNull();
    expect(fenceReloadsSilently({ ...view, follows: true })).toBe(true);
    expect(fenceReloadsSilently(view)).toBe(false);
    expect(fenceReloadsSilently({ kind: "branch", follows: true })).toBe(false);
  });

  it("connected = has a base commit", () => {
    expect(isConnectedCopy({ kind: "default", baseCommit: "a" })).toBe(true);
    expect(isConnectedCopy({ kind: "default" })).toBe(false);
  });
});

describe("git touch loop (R-§9 activity-driven checks)", () => {
  function fakeDoc(state: "visible" | "hidden") {
    const listeners = new Set<() => void>();
    return {
      visibilityState: state as DocumentVisibilityState,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      set(s: "visible" | "hidden") {
        this.visibilityState = s;
        for (const l of listeners) l();
      },
      listeners,
    };
  }

  it("touches on start and on each tick only while visible, and stops on stop", () => {
    const touch = vi.fn(() => Promise.resolve());
    const timers: { fn: () => void; cleared: boolean }[] = [];
    const doc = fakeDoc("visible");
    const stop = startGitTouchLoop(touch, {
      doc: doc as never,
      setTimer: (fn) => {
        const t = { fn, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => ((t as { cleared: boolean }).cleared = true),
    });
    expect(touch).toHaveBeenCalledTimes(1);
    timers[0]!.fn();
    expect(touch).toHaveBeenCalledTimes(2);

    doc.set("hidden");
    expect(timers[0]!.cleared).toBe(true);
    timers[0]!.fn(); // a late tick while hidden does nothing
    expect(touch).toHaveBeenCalledTimes(2);

    doc.set("visible"); // re-arms and touches at once
    expect(touch).toHaveBeenCalledTimes(3);
    expect(timers).toHaveLength(2);

    stop();
    expect(timers[1]!.cleared).toBe(true);
    expect(doc.listeners.size).toBe(0);
    timers[1]!.fn();
    expect(touch).toHaveBeenCalledTimes(3);
  });

  it("does not touch at all when started hidden", () => {
    const touch = vi.fn(() => Promise.resolve());
    const doc = fakeDoc("hidden");
    const stop = startGitTouchLoop(touch, { doc: doc as never, setTimer: () => 1, clearTimer: () => undefined });
    expect(touch).not.toHaveBeenCalled();
    stop();
  });
});
