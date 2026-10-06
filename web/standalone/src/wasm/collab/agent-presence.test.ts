import { describe, expect, it } from "vitest";
import { presenceKey } from "@pcbjam/shared";
import { isLockingPeer } from "./lock-tiebreak";

/**
 * AI agent presence (mcp 0004 §6): an agent shares its person's `user.id`
 * but is its own roster entry, and its selection is a pointer — a soft-lock
 * only while it is writing the selected items.
 */
describe("agent peers", () => {
  const user = { id: "alice" };

  it("an agent has its own presence key, distinct from its person's", () => {
    expect(presenceKey({ user })).toBe("alice");
    expect(presenceKey({ user, agent: { client: "oauth:c1" } })).toBe("alice#oauth:c1");
  });

  it("an agent's selection locks only while it edits", () => {
    expect(isLockingPeer({ agent: { editing: false } })).toBe(false);
    expect(isLockingPeer({ agent: {} })).toBe(false);
    expect(isLockingPeer({ agent: { editing: true } })).toBe(true);
    expect(isLockingPeer({})).toBe(true);
    expect(isLockingPeer({ role: "commenter" })).toBe(false);
  });
});
