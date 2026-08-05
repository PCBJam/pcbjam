import { describe, expect, it, vi } from "vitest";
import { WasmMailbox } from "./mailbox";

describe("WasmMailbox", () => {
  it("delivers immediately when not busy and queue empty", async () => {
    const mb = new WasmMailbox({ kicadOpenFileBusy: () => false });
    await expect(mb.enqueue("a", () => 41 + 1)).resolves.toBe(42);
    expect(mb.pending()).toBe(0);
    expect(mb.delivered).toBe(1);
  });

  it("legacy wasm without the probe never defers", async () => {
    const mb = new WasmMailbox({});
    await expect(mb.enqueue("a", () => "ok")).resolves.toBe("ok");
  });

  it("defers while busy, delivers in FIFO order after settle", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const mb = new WasmMailbox({ kicadOpenFileBusy: () => busy });
      const order: string[] = [];
      const pa = mb.enqueue("a", () => (order.push("a"), "ra"));
      const pb = mb.enqueue("b", () => (order.push("b"), "rb"));
      expect(mb.pending()).toBe(2);
      expect(order).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      expect(order).toEqual([]); // still busy — nothing delivered

      busy = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(["a", "b"]);
      await expect(pa).resolves.toBe("ra");
      await expect(pb).resolves.toBe("rb");
      expect(mb.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing call rejects its promise without breaking the queue", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const mb = new WasmMailbox({ kicadOpenFileBusy: () => busy });
      const pa = mb.enqueue("boom", () => {
        throw new Error("boom");
      });
      const pb = mb.enqueue("b", () => "rb");
      // Attach the expectations BEFORE the drain fires, or the rejection is
      // briefly unhandled and vitest reports it as an error.
      const exA = expect(pa).rejects.toThrow("boom");
      const exB = expect(pb).resolves.toBe("rb");
      busy = false;
      await vi.advanceTimersByTimeAsync(50);
      await exA;
      await exB;
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-opened busy window mid-drain pauses delivery", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const mb = new WasmMailbox({ kicadOpenFileBusy: () => busy });
      const order: string[] = [];
      // Call "a" re-opens the busy window (an apply that triggers a reload).
      void mb.enqueue("a", () => {
        order.push("a");
        busy = true;
      });
      void mb.enqueue("b", () => order.push("b"));
      busy = false;
      await vi.advanceTimersByTimeAsync(30);
      expect(order).toEqual(["a"]); // b held back by the re-opened window
      busy = false;
      await vi.advanceTimersByTimeAsync(30);
      expect(order).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing probe counts as busy (wedged runtime defers, no delivery)", async () => {
    vi.useFakeTimers();
    try {
      let wedged = true;
      const mb = new WasmMailbox({
        kicadOpenFileBusy: () => {
          if (wedged) throw new Error("dead runtime");
          return false;
        },
      });
      const order: string[] = [];
      void mb.enqueue("a", () => order.push("a"));
      await vi.advanceTimersByTimeAsync(100);
      expect(order).toEqual([]);
      wedged = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose rejects all queued calls", async () => {
    vi.useFakeTimers();
    try {
      const mb = new WasmMailbox({ kicadOpenFileBusy: () => true });
      const pa = mb.enqueue("a", () => "never");
      const exA = expect(pa).rejects.toThrow("wasm died");
      mb.dispose(new Error("wasm died"));
      await exA;
      expect(mb.pending()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
