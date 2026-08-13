import type { PresenceViewport } from "@pcbjam/shared";
import { clog } from "./debug";
import type { PresenceHandle, PresencePeer } from "./presence";
import type { ViewportState } from "./presence-kicad";
import { viewportRect } from "./presence-kicad";
import {
  observeOwnerJob,
  runGuardedOwnerExport,
  type GuardedOwnerExport,
} from "../owner-job";

/**
 * Follow-user controller (collab-presence 0008): mirror a peer's viewport
 * until the local user interacts.
 *
 * Follows an awareness CLIENT (a specific tab), not a user — a user's two
 * tabs can show different regions and "follow" means watching one screen.
 * On every roster change the leader's published world rect (presence wire
 * `viewport`) is applied through `kicadCollabFitViewport` (contain: the zoom
 * derives from OUR canvas, so different window sizes see the same region).
 *
 * Break-on-interact needs no extra input hooks: each applied fit remembers
 * its target, and every local `onViewport` echo is compared against it —
 * a matching echo (epsilon — the rect round-trips through the GAL matrix)
 * is our own fit landing; a deviating one means the user panned/zoomed/
 * jumped locally, so the follow ends. Same-tool, same-sheet only in v1:
 * an eeschema leader on another sheet pauses the fit (rect coordinates are
 * per-sheet); cross-tool follow is out of scope.
 *
 * Follow loops (A follows B, B follows A) are benign: neither side produces
 * a non-echo viewport change, so both simply idle.
 */

export interface FollowTarget {
  clientId: number;
  userId: string;
  name: string;
}

export interface FollowHandle {
  /** Start following a roster client; replaces any current follow. */
  follow(target: FollowTarget): void;
  /** Stop following (explicit UI action — Esc / click). */
  unfollow(): void;
  /** The current follow target, or null. */
  following(): FollowTarget | null;
  /** Fires with the new target (or null) on every follow state change. */
  subscribe(cb: (target: FollowTarget | null) => void): () => void;
  /** Feed every local onViewport emit here (echo suppression + break). */
  noteLocalViewport(vp: ViewportState): void;
  destroy(): void;
}

/** Relative tolerance for "this local viewport is our own fit's echo": the
 *  rect round-trips world→zoom→world through the GAL matrix, and the canvas
 *  aspect makes one axis overshoot (contain), so compare center and the
 *  CONTAINED axis loosely. */
const ECHO_REL_TOLERANCE = 0.02;

function isEcho(vp: ViewportState, target: PresenceViewport): boolean {
  const rect = viewportRect(vp);
  if (!rect) return true; // degenerate transform — never treat as user input

  // Scale-relative center comparison: a pan of >2% of the view is a break.
  const tolX = Math.max(rect.halfW, target.halfW) * ECHO_REL_TOLERANCE;
  const tolY = Math.max(rect.halfH, target.halfH) * ECHO_REL_TOLERANCE;
  if (Math.abs(rect.cx - target.cx) > tolX) return false;
  if (Math.abs(rect.cy - target.cy) > tolY) return false;

  // Contain-fit: exactly one axis matches the target's half-extent (the other
  // overshoots by the aspect difference). A zoom by the user changes BOTH away
  // from the target.
  const relW = Math.abs(rect.halfW - target.halfW) / target.halfW;
  const relH = Math.abs(rect.halfH - target.halfH) / target.halfH;
  return relW <= ECHO_REL_TOLERANCE || relH <= ECHO_REL_TOLERANCE;
}

export function createFollow(opts: {
  presence: PresenceHandle;
  /** Module.kicadCollabFitViewport, bound; absent on older wasm → no-op UI. */
  fit: GuardedOwnerExport<readonly [number, number, number, number], void>;
  /** The sheet THIS tab shows (eeschema); undefined for single-doc tools. */
  ownSheetPath?: () => string | undefined;
}): FollowHandle {
  const { presence, fit } = opts;

  let target: FollowTarget | null = null;
  /** The last rect we asked the canvas to fit — echoes match against this. */
  let applied: PresenceViewport | null = null;
  /** Grace: ignore break-checks until the first fit's echo arrived, else the
   *  stale pre-follow viewport emit would instantly end the follow. */
  let sawEcho = false;
  let fitGeneration = 0;
  let destroyed = false;

  const subscribers = new Set<(t: FollowTarget | null) => void>();
  const notify = () => {
    for (const cb of subscribers) cb(target);
  };

  const leaderState = (): PresencePeer | undefined =>
    presence.clients().find((c) => c.clientId === target?.clientId);

  const applyLeader = () => {
    if (!target) return;
    const leader = leaderState();
    if (!leader) {
      // Leader left the room — follow ends (their awareness state expired).
      clog("follow: leader left —", target.name);
      stop();
      return;
    }
    // v1: rect coordinates are per-document; pause while the leader is on a
    // different sheet than this canvas shows (eeschema warm-pool rooms).
    const ownSheet = opts.ownSheetPath?.();
    if (ownSheet !== undefined && leader.sheetPath !== undefined && leader.sheetPath !== ownSheet) {
      return;
    }
    const rect = leader.viewport;
    if (!rect) return;
    if (
      applied &&
      rect.cx === applied.cx &&
      rect.cy === applied.cy &&
      rect.halfW === applied.halfW &&
      rect.halfH === applied.halfH
    ) {
      return; // leader republished an unchanged viewport (e.g. selection edit)
    }
    applied = rect;
    sawEcho = false;
    const generation = ++fitGeneration;
    const leaderClientId = target.clientId;
    observeOwnerJob("fit followed viewport", () =>
      runGuardedOwnerExport(
        fit,
        [rect.cx, rect.cy, rect.halfW, rect.halfH] as const,
        () =>
          !destroyed &&
          fitGeneration === generation &&
          target?.clientId === leaderClientId,
      ),
    );
  };

  const stop = () => {
    if (!target) return;
    ++fitGeneration;
    target = null;
    applied = null;
    sawEcho = false;
    notify();
  };

  const unsubscribePresence = presence.subscribe(() => applyLeader());

  return {
    follow(t) {
      ++fitGeneration;
      target = t;
      applied = null;
      sawEcho = false;
      clog("follow: following", t.name, "client", t.clientId);
      notify();
      applyLeader();
    },
    unfollow: stop,
    following: () => target,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    noteLocalViewport(vp) {
      if (!target || !applied) return;
      if (isEcho(vp, applied)) {
        sawEcho = true;
        return;
      }
      if (!sawEcho) return; // pre-fit stale emit — the fit hasn't landed yet
      clog("follow: local input — stopped following", target.name);
      stop();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ++fitGeneration;
      unsubscribePresence();
      subscribers.clear();
      target = null;
    },
  };
}
