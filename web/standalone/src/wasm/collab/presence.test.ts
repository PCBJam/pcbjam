import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { colorForUser, PRESENCE_COLORS, type PresenceUser } from "@pcbjam/shared";
import { connectAwarenessBroadcast } from "./awareness-bc";
import type { IdleMonitor, IdlePhase } from "./idle-policy";
import {
  createPresence,
  publishSkeleton,
  resetPresenceColorClaims,
  type PresenceHandle,
} from "./presence";

/**
 * Presence unit tests (collab-presence 0001): two Awareness instances relayed
 * over a real BroadcastChannel (node ≥18 has it globally) stand in for two
 * tabs. BC delivery is async — `settle()` lets a posted message round-trip.
 */

const settle = () => new Promise((r) => setTimeout(r, 50));

function user(id: string): PresenceUser {
  return { id, name: id, color: colorForUser(id) };
}

interface Client {
  awareness: Awareness;
  presence?: PresenceHandle;
  destroy(): void;
}

let clients: Client[] = [];
let channelSeq = 0;

function client(channel: string): Client {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const relay = connectAwarenessBroadcast(awareness, channel);
  const c: Client = {
    awareness,
    destroy() {
      this.presence?.destroy();
      relay.destroy();
      awareness.destroy();
      doc.destroy();
    },
  };
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients) c.destroy();
  clients = [];
  resetPresenceColorClaims();
  // Drain already-queued BroadcastChannel deliveries before vitest recycles
  // the module registry — a late message otherwise trips the vite-node module
  // proxy (flaky unhandled RangeError at the schema getter).
  await new Promise((r) => setTimeout(r, 20));
});

describe("presence over the BroadcastChannel awareness relay", () => {
  it("peers see each other's state; destroy removes it immediately", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    const b = client(channel);

    a.presence = createPresence({ awareness: a.awareness, user: user("alice"), tool: "pcbnew" });
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();

    expect(a.presence.peers().map((p) => p.user.id)).toEqual(["bob"]);
    expect(b.presence.peers().map((p) => p.user.id)).toEqual(["alice"]);
    expect(a.presence.peers()[0]!.cursor).toBeNull();

    // destroy() nulls the local state → relayed → bob leaves alice's roster
    // without waiting for the awareness timeout.
    b.presence.destroy();
    b.presence = undefined;
    await settle();
    expect(a.presence.peers()).toEqual([]);
  });

  it("a late-joining tab sees existing peers (join query)", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    a.presence = createPresence({ awareness: a.awareness, user: user("alice"), tool: "pcbnew" });
    await settle();

    const b = client(channel);
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();
    expect(b.presence.peers().map((p) => p.user.id)).toEqual(["alice"]);
  });

  it("dedupes the same user across tabs and hides own slug", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a1 = client(channel);
    const a2 = client(channel);
    const b = client(channel);
    a1.presence = createPresence({ awareness: a1.awareness, user: user("alice"), tool: "pcbnew" });
    a2.presence = createPresence({ awareness: a2.awareness, user: user("alice"), tool: "pcbnew" });
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();

    // bob sees ONE alice (two tabs, one person); alice's tabs don't see each other.
    expect(b.presence.peers().map((p) => p.user.id)).toEqual(["alice"]);
    expect(a1.presence.peers().map((p) => p.user.id)).toEqual(["bob"]);

    // clients() (0007 soft-locks) is per-CLIENT: no user dedupe, own-user
    // other tabs included — alice's first tab sees her second tab AND bob.
    expect(a1.presence!.clients().map((p) => p.user.id).sort()).toEqual(["alice", "bob"]);
    expect(a1.presence!.self()).toEqual({
      userId: "alice",
      clientId: a1.awareness.clientID,
    });
  });

  it("drops malformed peer states instead of crashing the roster", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    const b = client(channel);
    a.presence = createPresence({ awareness: a.awareness, user: user("alice"), tool: "pcbnew" });
    b.awareness.setLocalState({ some: "legacy-shape" });
    await settle();
    expect(a.presence.peers()).toEqual([]);
  });

  it("skeleton states mark parked-room users with their real sheet (0003)", async () => {
    // Two per-sheet rooms; alice is BOUND to root and PARKED in sub, bob is
    // bound to sub. Bob's roster (sub room) must show alice as being on root,
    // with no cursor/selection.
    const rootCh = `presence-test-${channelSeq++}`;
    const subCh = `presence-test-${channelSeq++}`;
    const aliceRoot = client(rootCh);
    const aliceSub = client(subCh);
    const bobSub = client(subCh);

    aliceRoot.presence = createPresence({
      awareness: aliceRoot.awareness,
      user: user("alice"),
      tool: "eeschema",
      sheetPath: "root.kicad_sch",
    });
    publishSkeleton(aliceSub.awareness, user("alice"), "eeschema", "root.kicad_sch");
    bobSub.presence = createPresence({
      awareness: bobSub.awareness,
      user: user("bob"),
      tool: "eeschema",
      sheetPath: "sub/child.kicad_sch",
    });
    await settle();

    const aliceSeenByBob = bobSub.presence.peers();
    expect(aliceSeenByBob.map((p) => p.user.id)).toEqual(["alice"]);
    expect(aliceSeenByBob[0]!.sheetPath).toBe("root.kicad_sch");
    expect(aliceSeenByBob[0]!.cursor).toBeNull();
    expect(aliceSeenByBob[0]!.selection).toEqual([]);

    // Alice navigates into sub: full presence rebinds there (overwriting the
    // skeleton) — bob now sees her on HIS sheet, cursor live again.
    aliceSub.presence = createPresence({
      awareness: aliceSub.awareness,
      user: user("alice"),
      tool: "eeschema",
      sheetPath: "sub/child.kicad_sch",
    });
    aliceSub.presence.setCursor({ x: 1, y: 2 });
    await settle();

    const after = bobSub.presence.peers();
    expect(after[0]!.sheetPath).toBe("sub/child.kicad_sch");
    expect(after[0]!.cursor).toEqual({ x: 1, y: 2 });
  });

  it("rebind away leaves no ghost cursor in the old room", async () => {
    // Alice bound in room1 with a live cursor; she navigates away: presence
    // destroy + skeleton must leave sheetPath pointing elsewhere, cursor null.
    const ch = `presence-test-${channelSeq++}`;
    const alice = client(ch);
    const bob = client(ch);
    alice.presence = createPresence({
      awareness: alice.awareness,
      user: user("alice"),
      tool: "eeschema",
      sheetPath: "root.kicad_sch",
    });
    alice.presence.setCursor({ x: 9, y: 9 });
    bob.presence = createPresence({
      awareness: bob.awareness,
      user: user("bob"),
      tool: "eeschema",
      sheetPath: "root.kicad_sch",
    });
    await settle();
    expect(bob.presence.peers()[0]!.cursor).toEqual({ x: 9, y: 9 });

    alice.presence.destroy();
    alice.presence = undefined;
    publishSkeleton(alice.awareness, user("alice"), "eeschema", "sub/child.kicad_sch");
    await settle();

    const ghost = bob.presence.peers();
    expect(ghost.map((p) => p.user.id)).toEqual(["alice"]);
    expect(ghost[0]!.cursor).toBeNull();
    expect(ghost[0]!.sheetPath).toBe("sub/child.kicad_sch");
  });

  it("subscribe fires on change and setters keep sibling fields intact", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    const b = client(channel);
    a.presence = createPresence({ awareness: a.awareness, user: user("alice"), tool: "pcbnew" });
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();

    let latest: string[] | null = null;
    const unsub = a.presence.subscribe((peers) => {
      latest = peers.map((p) => `${p.user.id}:${p.selection.join(",")}`);
    });

    b.presence.setSelection(["uuid-1"]);
    b.presence.setCursor({ x: 5, y: 7 });
    await settle();

    expect(latest).toEqual(["bob:uuid-1"]);
    const bob = a.presence.peers()[0]!;
    // setCursor must not have clobbered the selection set just before it.
    expect(bob.selection).toEqual(["uuid-1"]);
    expect(bob.cursor).toEqual({ x: 5, y: 7 });
    expect(PRESENCE_COLORS).toContain(bob.user.color);
    unsub();
  });

  it("assigns colors by arrival order (nth-in-room), not name hash", async () => {
    // Sequential joins: each client's relay settles (peer states arrived —
    // production attaches presence after the provider synced) before claiming.
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    await settle();
    a.presence = createPresence({ awareness: a.awareness, user: user("alice"), tool: "pcbnew" });
    await settle();

    const b = client(channel);
    await settle();
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();

    const c = client(channel);
    await settle();
    c.presence = createPresence({ awareness: c.awareness, user: user("carol"), tool: "pcbnew" });
    await settle();

    // First three arrivals take the first three palette slots, in order —
    // no birthday-problem collisions while the room fits the palette.
    const seen = c.presence.peers().map((p) => [p.user.id, p.user.color]);
    expect(seen).toContainEqual(["alice", PRESENCE_COLORS[0]]);
    expect(seen).toContainEqual(["bob", PRESENCE_COLORS[1]]);
    const carol = a.presence.peers().find((p) => p.user.id === "carol")!;
    expect(carol.user.color).toBe(PRESENCE_COLORS[2]);

    // colorOf resolves present users to their claimed color, absent users to
    // the hash fallback (offline comment authors).
    expect(a.presence.colorOf("bob")).toBe(PRESENCE_COLORS[1]);
    expect(a.presence.colorOf("alice")).toBe(PRESENCE_COLORS[0]);
    expect(a.presence.colorOf("nobody")).toBe(colorForUser("nobody"));
  });

  it("a second tab of the same user adopts the existing color", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a1 = client(channel);
    await settle();
    a1.presence = createPresence({ awareness: a1.awareness, user: user("alice"), tool: "pcbnew" });
    await settle();
    const b = client(channel);
    await settle();
    b.presence = createPresence({ awareness: b.awareness, user: user("bob"), tool: "pcbnew" });
    await settle();
    // The second alice tab simulates a separate browser: no local claim
    // memory, adopts the published color from the room.
    resetPresenceColorClaims();
    const a2 = client(channel);
    await settle();
    a2.presence = createPresence({ awareness: a2.awareness, user: user("alice"), tool: "pcbnew" });
    await settle();

    // bob sees ONE alice with ONE consistent color; bob keeps his own slot.
    const fromBob = b.presence.peers();
    expect(fromBob.map((p) => p.user.id)).toEqual(["alice"]);
    expect(fromBob[0]!.user.color).toBe(PRESENCE_COLORS[0]);
  });
});

/**
 * 0009 C — comment-author seeded colors: the doc's existing comment authors
 * hold palette slots (deterministic first-appearance order), live claims
 * avoid them, an author rejoining adopts their own slot, and colorOf answers
 * offline authors from the seed instead of the hash.
 */
describe("comment-author color seeds (0009 C)", () => {
  const seedsOf = (entries: Array<[string, string]>) => () => new Map(entries);

  it("a joining user claims around the seeded authors' slots", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    a.presence = createPresence({
      awareness: a.awareness,
      user: user("alice"),
      tool: "pcbnew",
      seedColors: seedsOf([["old-author", PRESENCE_COLORS[0]!]]),
    });
    await settle();
    // Slot 0 belongs to old-author's pins → alice takes slot 1.
    expect(a.presence.colorOf("alice")).toBe(PRESENCE_COLORS[1]);
  });

  it("an author rejoining adopts their own comment slot", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    a.presence = createPresence({
      awareness: a.awareness,
      user: user("alice"),
      tool: "pcbnew",
      seedColors: seedsOf([
        ["bob", PRESENCE_COLORS[0]!],
        ["alice", PRESENCE_COLORS[1]!],
      ]),
    });
    await settle();
    expect(a.presence.colorOf("alice")).toBe(PRESENCE_COLORS[1]);
  });

  it("colorOf answers offline authors from the seed, not the hash", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    a.presence = createPresence({
      awareness: a.awareness,
      user: user("alice"),
      tool: "pcbnew",
      seedColors: seedsOf([["offline-bob", PRESENCE_COLORS[3]!]]),
    });
    await settle();
    expect(a.presence.colorOf("offline-bob")).toBe(PRESENCE_COLORS[3]);
    // A user with neither presence nor comments still hash-falls-back.
    expect(a.presence.colorOf("stranger")).toBe(colorForUser("stranger"));
  });

  it("a live peer's published color beats the seed", async () => {
    const channel = `presence-test-${channelSeq++}`;
    const a = client(channel);
    a.presence = createPresence({
      awareness: a.awareness,
      user: user("alice"),
      tool: "pcbnew",
    });
    await settle();
    const b = client(channel);
    await settle();
    b.presence = createPresence({
      awareness: b.awareness,
      user: user("bob"),
      tool: "pcbnew",
      // Stale seed claims alice sits on slot 5 — her live claim (slot 0) wins.
      seedColors: seedsOf([["alice", PRESENCE_COLORS[5]!]]),
    });
    await settle();
    expect(b.presence.colorOf("alice")).toBe(PRESENCE_COLORS[0]);
  });
});

// --- hidden-tab `away` (do-observability 0001 §B) ---------------------------

function fakeIdle(): IdleMonitor & { emit(p: IdlePhase): void } {
  let phase: IdlePhase = "active";
  const subs = new Set<(p: IdlePhase) => void>();
  return {
    phase: () => phase,
    subscribe(cb) {
      subs.add(cb);
      cb(phase);
      return () => subs.delete(cb);
    },
    destroy() {
      subs.clear();
    },
    emit(p) {
      phase = p;
      for (const cb of subs) cb(p);
    },
  };
}

describe("presence away flag", () => {
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    resetPresenceColorClaims();
  });

  it("publishes away:true past the hidden grace, clears it on return, and peers see it", async () => {
    const idle = fakeIdle();
    const a = client("away-room");
    const b = client("away-room");
    a.presence = createPresence({ awareness: a.awareness, user: user("A"), tool: "eeschema", idle });
    b.presence = createPresence({ awareness: b.awareness, user: user("B"), tool: "eeschema" });
    await settle();
    expect(a.awareness.getLocalState()).not.toHaveProperty("away");

    idle.emit("away");
    expect(a.awareness.getLocalState()).toMatchObject({ away: true });
    await settle();
    expect(b.presence.peers().find((p) => p.user.id === "A")?.away).toBe(true);

    // Suspended is still "not looking" — no extra frame, flag unchanged.
    const clockBefore = a.awareness.meta.get(a.awareness.clientID)!.clock;
    idle.emit("suspended");
    expect(a.awareness.meta.get(a.awareness.clientID)!.clock).toBe(clockBefore);

    idle.emit("active");
    expect(a.awareness.getLocalState()).not.toHaveProperty("away");
    await settle();
    expect(b.presence.peers().find((p) => p.user.id === "A")?.away).toBeUndefined();
  });

  it("destroy() unsubscribes from the monitor", () => {
    const idle = fakeIdle();
    const a = client("away-room-2");
    const handle = createPresence({ awareness: a.awareness, user: user("A"), tool: "eeschema", idle });
    handle.destroy();
    expect(() => idle.emit("away")).not.toThrow();
    expect(a.awareness.getLocalState()).toBeNull();
  });
});
