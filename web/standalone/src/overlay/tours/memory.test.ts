import { beforeEach, describe, expect, it } from "vitest";
import { clearTourMemory, storedTourMemory } from "./memory";

// localStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
};

describe("tour memory", () => {
  beforeEach(() => store.clear());

  it("round-trips per tour and forgets on a fresh start", () => {
    const a = storedTourMemory("plugin:x:p1:usb");
    expect(a.load()).toBeNull();
    a.save({ latched: ["intro", "tool"], baseline: ["j1"] });
    expect(storedTourMemory("plugin:x:p1:usb").load()).toEqual({ latched: ["intro", "tool"], baseline: ["j1"] });
    expect(storedTourMemory("plugin:x:p1:other").load()).toBeNull();
    expect(storedTourMemory("plugin:x:p2:usb").load()).toBeNull();
    clearTourMemory("plugin:x:p1:usb");
    expect(a.load()).toBeNull();
  });

  it("ignores garbage and does not store a huge baseline", () => {
    store.set("pcbjam:tours", "{not json");
    expect(storedTourMemory("t").load()).toBeNull();
    store.set("pcbjam:tours", JSON.stringify({ t: { at: 1, memory: { latched: [1, 2] } } }));
    expect(storedTourMemory("t").load()).toBeNull();
    const big = Array.from({ length: 2000 }, (_, i) => `u${i}`);
    storedTourMemory("t").save({ latched: ["a"], baseline: big });
    expect(storedTourMemory("t").load()).toEqual({ latched: ["a"], baseline: null });
  });
});
