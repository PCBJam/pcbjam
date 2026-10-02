import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTourEntry, TOURS_CHARS_MAX, TOURS_KEPT, updateTourEntry } from "./tour-store";

// localStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem"> }).localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
};

describe("tour store", () => {
  beforeEach(() => {
    store.clear();
    vi.useRealTimers();
  });

  it("merges status and memory per tour; null forgets the memory", () => {
    expect(readTourEntry("a")).toBeNull();
    updateTourEntry("a", { status: "active" });
    updateTourEntry("a", { memory: { latched: ["intro"], baseline: null } });
    expect(readTourEntry("a")).toMatchObject({ status: "active", memory: { latched: ["intro"], baseline: null } });
    updateTourEntry("a", { memory: null });
    expect(readTourEntry("a")?.memory).toBeUndefined();
    expect(readTourEntry("a")?.status).toBe("active");
    expect(readTourEntry("b")).toBeNull();
  });

  it("keeps the most recently used tours", () => {
    vi.useFakeTimers();
    for (let i = 0; i <= TOURS_KEPT; i++) {
      vi.setSystemTime(1000 + i);
      updateTourEntry(`t${i}`, { status: "active" });
    }
    expect(readTourEntry("t0")).toBeNull(); // the oldest went
    expect(readTourEntry("t1")?.status).toBe("active");
    expect(readTourEntry(`t${TOURS_KEPT}`)?.status).toBe("active");
  });

  it("stays within its size budget, never dropping the tour just written", () => {
    vi.useFakeTimers();
    const baseline = Array.from({ length: 1000 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(1000 + i);
      updateTourEntry(`big${i}`, { memory: { latched: [], baseline } });
    }
    expect((store.get("pcbjam:tours") ?? "").length).toBeLessThanOrEqual(TOURS_CHARS_MAX);
    expect(readTourEntry("big11")?.memory?.baseline).toHaveLength(1000);
    expect(readTourEntry("big0")).toBeNull();
  });

  it("ignores garbage and blocked storage", () => {
    store.set("pcbjam:tours", "{not json");
    expect(readTourEntry("a")).toBeNull();
    updateTourEntry("a", { status: "done" }); // starts over from an empty store
    expect(readTourEntry("a")?.status).toBe("done");
    store.set("pcbjam:tours", JSON.stringify([1, 2]));
    expect(readTourEntry("a")).toBeNull();
    const saved = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      expect(readTourEntry("a")).toBeNull();
      expect(() => updateTourEntry("a", { status: "active" })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: saved });
    }
  });
});
