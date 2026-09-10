/**
 * Selection soft-lock policy (collab-presence 0007) — pure logic, no I/O.
 *
 * Lock rule: an item selected by any OTHER awareness client (the same user's
 * other tab included) is soft-locked locally — still selectable for
 * inspection, filtered from move/drag acquisition (enforced C++-side via the
 * fork's PCBJAM_REMOTE_LOCK query, fed from `remoteLocks`).
 *
 * Tiebreak rule (overlapping holds — both grabbed inside the awareness
 * propagation window): lowest `(user.id, clientID)` lexicographic KEEPS the
 * item; every losing client releases it (`contestedReleases` → the C++
 * `kicadCollabReleaseSelection` entry point). Pure and computable from
 * awareness state alone, so all clients agree with no coordination and no
 * oscillation. Known accepted bias: alphabetically-early users win.
 */

export interface LockIdentity {
  userId: string;
  clientId: number;
}

export interface LockClient extends LockIdentity {
  /** Display name for the infobar ("R5 is being edited by <name>"). */
  name: string;
  selection: string[];
}

/** True when `a` beats `b` in the deterministic (userId, clientId) order. */
export function beats(a: LockIdentity, b: LockIdentity): boolean {
  if (a.userId !== b.userId) return a.userId < b.userId;
  return a.clientId < b.clientId;
}

/**
 * The soft-lock set to feed the C++ query: every uuid held by another client,
 * EXCEPT uuids the local client holds and WINS — the winner must not be
 * blocked from moving its own item while the loser's release is in flight.
 * (Uuids the local client holds and LOSES stay locked: the release is about
 * to strip them anyway, and moving them meanwhile would fight the winner.)
 * Holder name = the winning holder when several clients hold the same uuid.
 */
export function remoteLocks(
  self: LockIdentity & { selection: string[] },
  others: LockClient[],
): Array<{ uuid: string; name: string }> {
  const ownHeld = new Set(self.selection);
  const byUuid = new Map<string, LockClient>();

  for (const client of others) {
    for (const uuid of client.selection) {
      const current = byUuid.get(uuid);
      if (!current || beats(client, current)) byUuid.set(uuid, client);
    }
  }

  const out: Array<{ uuid: string; name: string }> = [];
  for (const [uuid, holder] of byUuid) {
    if (ownHeld.has(uuid) && beats(self, holder)) continue;
    out.push({ uuid, name: holder.name });
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * The uuids the LOCAL client must release because a winning peer also holds
 * them, plus the (single) name to blame in the infobar — the strongest
 * winning holder when several are involved.
 */
export function contestedReleases(
  self: LockIdentity & { selection: string[] },
  others: LockClient[],
): { uuids: string[]; holder: string } | null {
  const uuids: string[] = [];
  let strongest: LockClient | null = null;

  for (const uuid of self.selection) {
    let winner: LockClient | null = null;
    for (const client of others) {
      if (!client.selection.includes(uuid)) continue;
      if (beats(client, self) && (!winner || beats(client, winner))) winner = client;
    }
    if (winner) {
      uuids.push(uuid);
      if (!strongest || beats(winner, strongest)) strongest = winner;
    }
  }

  return uuids.length && strongest ? { uuids, holder: strongest.name } : null;
}

/**
 * Commenter presence (comments-ux 0003 §5.2): a reviewer's selection is a
 * highlight, never a soft-lock — peers with `role: "commenter"` are left out
 * of the lock derivation. The role is server-verified (the sync worker drops
 * mismatching frames), so this is safe to trust.
 */
export function isLockingPeer(peer: { role?: string }): boolean {
  return peer.role !== "commenter";
}

