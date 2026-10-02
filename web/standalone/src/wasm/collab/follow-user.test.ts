import { describe, expect, it, vi } from "vitest";
import type { PresencePeer } from "./presence";
import type { ViewportState } from "./presence-kicad";
import { createFollow, type FollowTarget } from "./follow-user";

/**
 * Follow-user controller units (collab-presence 0008): apply/republish
 * dedupe, echo suppression, break-on-interact, leader-left, sheet gating.
 * The presence handle is faked — only clients() + subscribe are used.
 */

const LEADER: FollowTarget = { clientId: 7, userId: "u-lead", name: "lead" };

function peer(over: Partial<PresencePeer> = {}): PresencePeer {
  return {
    clientId: 7,
    user: { id: "u-lead", name: "lead", color: "#ef4444" },
    tool: "pcbnew",
    cursor: null,
    selection: [],
    viewport: { cx: 100, cy: 200, halfW: 50, halfH: 40 },
    updatedAt: 1,
    ...over,
  } as PresencePeer;
}

function fakePresence(initial: PresencePeer[]) {
  let clients = initial;
  const subs = new Set<() => void>();
  return {
    handle: {
      clients: () => clients,
      subscribe(cb: () => void) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    } as unknown as import("./presence").PresenceHandle,
    update(next: PresencePeer[]) {
      clients = next;
      for (const cb of subs) cb();
    },
  };
}

/** A local onViewport emit whose world rect equals `rect` on a canvas of
 *  aspect w:h (contain fit: the wider axis overshoots). */
function echoFor(
  rect: { cx: number; cy: number; halfW: number; halfH: number },
  w = 1000,
  h = 800,
): ViewportState {
  const scale = Math.min(w / (2 * rect.halfW), h / (2 * rect.halfH));
  return { cx: rect.cx, cy: rect.cy, scale, w, h };
}

describe("createFollow", () => {
  it("applies the leader's viewport on follow and on change, deduping republish", () => {
    const p = fakePresence([peer()]);
    const fit = vi.fn();
    const follow = createFollow({ presence: p.handle, fit });

    follow.follow(LEADER);
    expect(fit).toHaveBeenCalledWith(100, 200, 50, 40);

    // Republished but UNCHANGED viewport (e.g. a selection edit) → no re-fit.
    p.update([peer()]);
    expect(fit).toHaveBeenCalledTimes(1);

    p.update([peer({ viewport: { cx: 110, cy: 200, halfW: 50, halfH: 40 } })]);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit).toHaveBeenLastCalledWith(110, 200, 50, 40);
  });

  it("suppresses the fit's own echo, breaks on a deviating local viewport", () => {
    const p = fakePresence([peer()]);
    const fit = vi.fn();
    const follow = createFollow({ presence: p.handle, fit });
    follow.follow(LEADER);

    const rect = { cx: 100, cy: 200, halfW: 50, halfH: 40 };
    follow.noteLocalViewport(echoFor(rect));
    expect(follow.following()).toEqual(LEADER);

    // User pans far away → follow ends.
    follow.noteLocalViewport(echoFor({ ...rect, cx: 500 }));
    expect(follow.following()).toBeNull();
  });

  it("ignores a stale pre-echo local viewport (the fit hasn't landed yet)", () => {
    const p = fakePresence([peer()]);
    const fit = vi.fn();
    const follow = createFollow({ presence: p.handle, fit });
    follow.follow(LEADER);

    // The canvas still shows the pre-follow region — not a user break.
    follow.noteLocalViewport(echoFor({ cx: 9999, cy: 9999, halfW: 10, halfH: 10 }));
    expect(follow.following()).toEqual(LEADER);
  });

  it("a user zoom breaks the follow even at the same center", () => {
    const p = fakePresence([peer()]);
    const follow = createFollow({ presence: p.handle, fit: vi.fn() });
    follow.follow(LEADER);

    const rect = { cx: 100, cy: 200, halfW: 50, halfH: 40 };
    follow.noteLocalViewport(echoFor(rect));
    // Zoom-in: both half-extents shrink well past the tolerance.
    follow.noteLocalViewport(echoFor({ ...rect, halfW: 25, halfH: 20 }));
    expect(follow.following()).toBeNull();
  });

  it("a canvas resize that shifts the view refits instead of ending the follow", () => {
    // CI flake 2026-10-02: KiCad's "created by an older version" bar appeared
    // above the canvas after the fit had landed; the canvas shrank, the view
    // centre moved, and that read as the user panning.
    const p = fakePresence([peer()]);
    const fit = vi.fn();
    const follow = createFollow({ presence: p.handle, fit });
    const rect = { cx: 100, cy: 200, halfW: 50, halfH: 40 };
    follow.noteLocalViewport(echoFor({ cx: 0, cy: 0, halfW: 500, halfH: 400 })); // before the follow
    follow.follow(LEADER);
    follow.noteLocalViewport(echoFor(rect)); // the fit landed
    expect(fit).toHaveBeenCalledTimes(1);

    // The bar appears: the canvas is 40 px shorter and the centre moved down.
    const scale = echoFor(rect).scale;
    follow.noteLocalViewport({ cx: 100, cy: 200 + 20 / scale, scale, w: 1000, h: 760 });
    expect(follow.following()).toEqual(LEADER);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit).toHaveBeenLastCalledWith(100, 200, 50, 40);

    // The refit lands on the new canvas; a real pan after that still breaks.
    follow.noteLocalViewport(echoFor(rect, 1000, 760));
    expect(follow.following()).toEqual(LEADER);
    follow.noteLocalViewport({ ...echoFor(rect, 1000, 760), cx: 160 });
    expect(follow.following()).toBeNull();
  });

  it("unfollows when the leader leaves the room", () => {
    const p = fakePresence([peer()]);
    const follow = createFollow({ presence: p.handle, fit: vi.fn() });
    follow.follow(LEADER);

    p.update([]);
    expect(follow.following()).toBeNull();
  });

  it("pauses (does not fit) while an eeschema leader is on another sheet", () => {
    const p = fakePresence([peer({ sheetPath: "sub.kicad_sch" })]);
    const fit = vi.fn();
    const follow = createFollow({
      presence: p.handle,
      fit,
      ownSheetPath: () => "demo.kicad_sch",
    });
    follow.follow(LEADER);
    expect(fit).not.toHaveBeenCalled();

    // Leader returns to our sheet → fit resumes.
    p.update([peer({ sheetPath: "demo.kicad_sch" })]);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on follow and unfollow", () => {
    const p = fakePresence([peer()]);
    const follow = createFollow({ presence: p.handle, fit: vi.fn() });
    const seen: Array<FollowTarget | null> = [];
    follow.subscribe((t) => seen.push(t));

    follow.follow(LEADER);
    follow.unfollow();
    expect(seen).toEqual([LEADER, null]);
  });
});
