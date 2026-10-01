import { beforeEach, describe, expect, it } from "vitest";
import { clearTourMemory, sessionTourMemory } from "./memory";

// sessionStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
};

describe("tour memory", () => {
  beforeEach(() => store.clear());

  it("round-trips per tour and forgets on a fresh start", () => {
    const a = sessionTourMemory("plugin:x:usb");
    expect(a.load()).toBeNull();
    a.save({ latched: ["intro", "tool"], baseline: ["j1"] });
    expect(sessionTourMemory("plugin:x:usb").load()).toEqual({ latched: ["intro", "tool"], baseline: ["j1"] });
    expect(sessionTourMemory("plugin:x:other").load()).toBeNull();
    clearTourMemory("plugin:x:usb");
    expect(a.load()).toBeNull();
  });

  it("ignores garbage and does not store a huge baseline", () => {
    store.set("pcbjam:tour-memory:t", "{not json");
    expect(sessionTourMemory("t").load()).toBeNull();
    store.set("pcbjam:tour-memory:t", JSON.stringify({ latched: [1, 2] }));
    expect(sessionTourMemory("t").load()).toBeNull();
    const big = Array.from({ length: 6000 }, (_, i) => `u${i}`);
    sessionTourMemory("t").save({ latched: ["a"], baseline: big });
    expect(sessionTourMemory("t").load()).toEqual({ latched: ["a"], baseline: null });
  });
});
