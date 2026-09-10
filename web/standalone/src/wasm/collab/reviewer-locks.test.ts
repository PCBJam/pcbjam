import { describe, expect, it } from "vitest";
import { isLockingPeer, remoteLocks, type LockClient } from "./lock-tiebreak";

/** Commenter presence (comments-ux 0003 §5.2): reviewers never soft-lock. */
describe("reviewer peers and soft-locks", () => {
  it("drops commenter peers from the lock derivation, keeps editors", () => {
    const peers = [
      { userId: "ed", clientId: 2, name: "Ed", selection: ["u1"], role: undefined },
      { userId: "rv", clientId: 3, name: "Rev", selection: ["u2", "u1"], role: "commenter" },
    ];
    const locking: LockClient[] = peers.filter(isLockingPeer).map(({ role: _r, ...c }) => c);
    expect(locking.map((c) => c.userId)).toEqual(["ed"]);
    const locks = remoteLocks({ userId: "me", clientId: 9, selection: [] }, locking);
    expect(locks.map((l) => l.uuid)).toEqual(["u1"]);
  });
});
