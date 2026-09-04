import type { Awareness } from "y-protocols/awareness";
import {
  colorForUser,
  PRESENCE_COLORS,
  presenceStateSchema,
  type PresenceState,
  type PresenceUser,
  type PresenceViewport,
} from "@pcbjam/shared";
import { clog } from "./debug";
import { idleMonitor, type IdleMonitor } from "./idle-policy";

/**
 * Room presence over Yjs awareness (collab-presence 0001): publish this
 * client's `PresenceState` into the room and expose the peers' states as a
 * subscribable roster. Ephemeral by design — the provider relays awareness,
 * nothing is persisted, and peers expire a silent client automatically.
 *
 * One handle per bound room. eeschema rebinds on sheet navigation (the sheet
 * manager tears this down and creates one on the new room), so a peer's
 * roster always reflects the room they'd collide with.
 */

/** A peer's validated presence state plus its awareness clientID. */
export interface PresencePeer extends PresenceState {
  clientId: number;
}

export interface PresenceHandle {
  /**
   * The OTHER users in the room: own client excluded, entries that fail the
   * wire schema dropped (older builds), and one entry per `user.id` (the same
   * user in two tabs is one person — keep the freshest state).
   */
  peers(): PresencePeer[];
  /**
   * Every OTHER awareness client in the room, validated but NOT deduped by
   * user — the same user's other tab is its own entry. Soft-locks (0007) key
   * on clients, not users: your own second tab must lock against you too.
   */
  clients(): PresencePeer[];
  /** This client's identity for tiebreaks: (user.id, awareness clientID). */
  self(): { userId: string; clientId: number };
  /** Fires with the new roster on every awareness change. Returns unsubscribe. */
  subscribe(cb: (peers: PresencePeer[]) => void): () => void;
  /** 0002: publish the local pointer's world position (null = off canvas). */
  setCursor(pos: { x: number; y: number } | null): void;
  /** 0002: publish the local selection's KIID strings. */
  setSelection(uuids: string[]): void;
  /** 0008: publish the visible world rect (center + half-extents, IU) for
   *  followers; null while unknown. */
  setViewport(rect: PresenceViewport | null): void;
  /** A user's current presence color: their published one if they're in the
   *  room, our claimed one for ourselves, else the palette-hash fallback
   *  (offline users, e.g. old comment authors). */
  colorOf(userId: string): string;
  /** Clear the local state and detach. The awareness instance itself belongs
   *  to the provider and stays alive (rebind re-uses it). */
  destroy(): void;
}

// ── nth-in-room color assignment ─────────────────────────────────────────────
//
// Colors are claimed by ARRIVAL ORDER, not name hash: each client takes the
// lowest palette index no other peer holds, so N ≤ palette-size editors always
// get distinct colors (a hash would collide birthday-problem-fast) and the
// best palette colors go first. Coordination-free: the claim is published in
// the awareness state; when two simultaneous joiners collide, the one with the
// HIGHER awareness clientID yields and re-claims (deterministic convergence).
// The claim is per-tab and sticky across room rebinds (eeschema sheet pool),
// so one user keeps one color everywhere in a session; a second tab of the
// same user ADOPTS the existing color instead of claiming a new one.

/** Cursor/viewport publish budget: bytes of published selection per second
 *  of high-frequency traffic. 128 KB/s ⇒ a 3000-item selection (~117 KB)
 *  publishes cursors at ~1 Hz; anything under ~6 KB (150 items) is not
 *  throttled at all (the wasm side already caps cursor emits at 20 Hz). */
const HF_BUDGET_BYTES_PER_SEC = 128 * 1024;
const HF_MAX_INTERVAL_MS = 2000;
/** Below this the wasm emit cadence (50 ms) already bounds the rate — publish
 *  synchronously, exactly as before. */
const HF_MIN_INTERVAL_MS = 50;

// Per-user claims in this JS context (one user per tab in production; the
// map keeps multi-client unit tests deterministic).
const g_claims = new Map<string, string>();

/** Test hook: forget all color claims. */
export function resetPresenceColorClaims(): void {
  g_claims.clear();
}

/** The session's claimed color for a user, if any — sibling rooms (skeletons,
 *  the 0006 project presence room) reuse it so one user is one color everywhere. */
export function claimedPresenceColor(userId: string): string | undefined {
  return g_claims.get(userId);
}

/** Least-used palette color among the OTHER users in `states` PLUS the doc's
 *  comment authors (0009 C — their pins hold palette slots too) — the lowest
 *  free slot while the room is smaller than the palette, fair reuse after. */
function lowestFreeColor(
  states: Map<number, unknown>,
  ownClientId: number,
  ownUserId: string,
  seedColors?: ReadonlyMap<string, string>,
): string {
  const usage = new Array(PRESENCE_COLORS.length).fill(0);

  for (const [clientId, state] of states) {
    if (clientId === ownClientId) continue;
    const parsed = presenceStateSchema.safeParse(state);
    if (!parsed.success || parsed.data.user.id === ownUserId) continue;
    const idx = (PRESENCE_COLORS as readonly string[]).indexOf(parsed.data.user.color);
    if (idx >= 0) usage[idx]++;
  }
  if (seedColors) {
    for (const [author, color] of seedColors) {
      if (author === ownUserId) continue;
      const idx = (PRESENCE_COLORS as readonly string[]).indexOf(color);
      if (idx >= 0) usage[idx]++;
    }
  }

  const min = Math.min(...usage);
  return PRESENCE_COLORS[usage.indexOf(min)]!;
}

/**
 * Publish a SKELETON presence state into a room the user is connected to but
 * not looking at (eeschema warm pool, collab-presence 0003): identity + which
 * sheet they are actually on, no cursor/selection. Any sheet's roster can then
 * answer "who is in this schematic, and where". The bound room's full state is
 * owned by `createPresence` (which overwrites the skeleton on rebind).
 */
export function publishSkeleton(
  awareness: Awareness,
  user: PresenceUser,
  tool: string,
  sheetPath: string,
): void {
  const state: PresenceState = {
    // Skeletons reuse the claimed color so one user is one color on every
    // sheet's roster.
    user: { ...user, color: g_claims.get(user.id) ?? user.color },
    tool,
    sheetPath,
    cursor: null,
    selection: [],
    updatedAt: Date.now(),
  };
  awareness.setLocalState(state);
}

export function createPresence(opts: {
  awareness: Awareness;
  user: PresenceUser;
  tool: string;
  sheetPath?: string;
  /** The doc's comment-author palette assignments (0009 C, lazily read):
   *  claimed around, adopted for our own past comments, and the offline-
   *  author fallback in colorOf. Undefined ⇒ pre-0009 behavior. */
  seedColors?: () => ReadonlyMap<string, string>;
  /** Hidden-tab monitor (tests inject one; default: the page singleton). */
  idle?: IdleMonitor;
}): PresenceHandle {
  const { awareness } = opts;
  const seeds = () => opts.seedColors?.();

  // Nth-in-room color: adopt a same-user tab's color, else keep an earlier
  // claim (sticky across sheet rebinds), else our own comment-author slot
  // (the doc's pins already show us in it — cursor should match), else claim
  // the lowest palette slot free among live peers AND comment authors.
  let claimed = g_claims.get(opts.user.id) ?? null;
  if (!claimed) {
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const parsed = presenceStateSchema.safeParse(raw);
      if (parsed.success && parsed.data.user.id === opts.user.id) {
        claimed = parsed.data.user.color;
        break;
      }
    }
  }
  if (!claimed) claimed = seeds()?.get(opts.user.id) ?? null;
  if (!claimed) {
    claimed = lowestFreeColor(
      awareness.getStates(),
      awareness.clientID,
      opts.user.id,
      seeds(),
    );
  }
  g_claims.set(opts.user.id, claimed);

  const user: PresenceUser = { ...opts.user, color: claimed };

  const patch = (fields: Partial<PresenceState>) => {
    const current = (awareness.getLocalState() ?? {}) as Partial<PresenceState>;
    awareness.setLocalState({ ...current, ...fields, updatedAt: Date.now() });
  };

  // Select-all lag (findings Y-4): awareness ships the WHOLE state on every
  // change, so with a large selection each 20 Hz cursor/viewport tick
  // re-sends the selection (3000 items ≈ 117 KB per tick). Rate the
  // high-frequency fields by payload size: the bigger the published
  // selection, the longer the trailing interval between cursor/viewport
  // publishes (a small selection is unthrottled; select-all ≈ 1 Hz).
  let selectionBytes = 2;
  let hfTimer: ReturnType<typeof setTimeout> | undefined;
  let hfPending: Partial<PresenceState> = {};
  let hfLastAt = 0;
  const hfInterval = () => Math.min(HF_MAX_INTERVAL_MS, (selectionBytes / HF_BUDGET_BYTES_PER_SEC) * 1000);
  const patchHighFrequency = (fields: Partial<PresenceState>) => {
    hfPending = { ...hfPending, ...fields };
    const wait = hfInterval();
    if (wait < HF_MIN_INTERVAL_MS) {
      hfPending = {};
      patch(fields);
      return;
    }
    if (hfTimer) return;
    const due = Math.max(0, hfLastAt + wait - Date.now());
    hfTimer = setTimeout(() => {
      hfTimer = undefined;
      hfLastAt = Date.now();
      const p = hfPending;
      hfPending = {};
      patch(p);
    }, due);
  };

  patch({
    user,
    tool: opts.tool,
    ...(opts.sheetPath !== undefined ? { sheetPath: opts.sheetPath } : {}),
    cursor: null,
    selection: [],
  });
  clog("presence: published local state for", user.id, "color", user.color);

  // Simultaneous-join collision: if a DIFFERENT user with a LOWER clientID
  // holds our color, we yield and re-claim the lowest free slot — exactly one
  // side of any collision yields, so this converges without coordination.
  // Same-user tabs converge the other way: adopt the lower clientID's color.
  //
  // Re-entrancy guard: patch() fires the awareness 'change' event
  // SYNCHRONOUSLY on the local instance, which re-enters this resolver — with
  // two stale conflicting states in view (e.g. mid-propagation same-user
  // tabs) the adopt/re-claim branches can ping-pong until the stack blows.
  // Patches made HERE don't need immediate re-resolution; the next genuine
  // (async) awareness delivery re-runs the resolver with fresher states.
  let resolvingCollision = false;
  const resolveCollision = () => {
    if (resolvingCollision) return;
    resolvingCollision = true;
    try {
      resolveCollisionOnce();
    } finally {
      resolvingCollision = false;
    }
  };
  const resolveCollisionOnce = () => {
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const parsed = presenceStateSchema.safeParse(raw);
      if (!parsed.success) continue;

      if (parsed.data.user.id === user.id) {
        if (parsed.data.user.color !== user.color && clientId < awareness.clientID) {
          user.color = parsed.data.user.color;
          g_claims.set(user.id, user.color);
          patch({ user: { ...user } });
          clog("presence: adopted same-user color", user.color);
          return;
        }
        continue;
      }

      if (parsed.data.user.color === user.color && clientId < awareness.clientID) {
        user.color = lowestFreeColor(
          awareness.getStates(),
          awareness.clientID,
          user.id,
          seeds(),
        );
        g_claims.set(user.id, user.color);
        patch({ user: { ...user } });
        clog("presence: color collision — re-claimed", user.color);
        return;
      }
    }
  };

  // Parsed-clients memo: peers()/clients() are both read on every awareness
  // change by the bridge, and each zod parse of a big selection is costly.
  // States only change through awareness events, so one parse per change.
  let clientsMemo: PresencePeer[] | null = null;
  function clients(): PresencePeer[] {
    if (clientsMemo) return clientsMemo;
    const out: PresencePeer[] = [];
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const parsed = presenceStateSchema.safeParse(raw);
      if (!parsed.success) continue;
      out.push({ ...parsed.data, clientId });
    }
    clientsMemo = out.sort((a, b) => a.clientId - b.clientId);
    return clientsMemo;
  }

  function peers(): PresencePeer[] {
    const byUser = new Map<string, PresencePeer>();
    for (const peer of clients()) {
      // Another tab of the SAME user isn't a peer — the roster shows other people.
      if (peer.user.id === user.id) continue;
      const existing = byUser.get(peer.user.id);
      if (!existing || peer.updatedAt > existing.updatedAt) {
        byUser.set(peer.user.id, peer);
      }
    }
    return [...byUser.values()].sort((a, b) => a.user.id.localeCompare(b.user.id));
  }

  const subscribers = new Set<(peers: PresencePeer[]) => void>();
  const onChange = () => {
    clientsMemo = null;
    resolveCollision();
    if (!subscribers.size) return;
    const snapshot = peers();
    for (const cb of subscribers) cb(snapshot);
  };
  awareness.on("change", onChange);

  // Best-effort fast removal on tab close/navigation: broadcasting the null
  // state lets peers drop us immediately instead of waiting out the awareness
  // timeout. Guarded — unit tests run in node.
  const onPageHide = () => awareness.setLocalState(null);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  // Hidden-tab policy (do-observability 0001 §B): one `away` frame when the
  // tab has been hidden past the grace, one clear when it is back. While
  // suspended the socket is down, so the flag only travels on resume.
  const setAway = (away: boolean) => {
    const current = (awareness.getLocalState() ?? {}) as Partial<PresenceState>;
    if (!!current.away === away) return;
    const { away: _drop, ...rest } = current;
    awareness.setLocalState({
      ...rest,
      ...(away ? { away: true } : {}),
      updatedAt: Date.now(),
    });
  };
  const unsubscribeIdle = (opts.idle ?? idleMonitor()).subscribe((phase) =>
    setAway(phase !== "active"),
  );

  let destroyed = false;
  return {
    peers,
    clients,
    self() {
      return { userId: user.id, clientId: awareness.clientID };
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    setCursor(pos) {
      patchHighFrequency({ cursor: pos });
    },
    setSelection(uuids) {
      selectionBytes = JSON.stringify(uuids).length;
      patch({ selection: uuids });
    },
    setViewport(rect) {
      patchHighFrequency({ viewport: rect });
    },
    colorOf(userId) {
      if (userId === user.id) return user.color;
      for (const [clientId, raw] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const parsed = presenceStateSchema.safeParse(raw);
        if (parsed.success && parsed.data.user.id === userId) {
          return parsed.data.user.color;
        }
      }
      // Offline users: their comment-author slot (0009 C) beats the hash —
      // deterministic, and lowestFreeColor keeps live claims off it.
      return seeds()?.get(userId) ?? colorForUser(userId);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
      unsubscribeIdle();
      awareness.off("change", onChange);
      subscribers.clear();
      if (hfTimer) clearTimeout(hfTimer);
      hfTimer = undefined;
      awareness.setLocalState(null);
    },
  };
}
