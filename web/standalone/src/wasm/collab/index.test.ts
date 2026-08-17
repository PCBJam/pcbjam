import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Exercise connectKicadDoc's deadline/abort/partial-cleanup (findings C-1/C-3)
// and attachKicadCollab's seed-throw teardown (C-2) against mocked
// collaborators — no sockets, no wasm.
const { connectProvider, bindKicadCollab, moduleItemsBridge } = vi.hoisted(() => ({
  connectProvider: vi.fn(),
  bindKicadCollab: vi.fn(),
  moduleItemsBridge: vi.fn(),
}));

vi.mock("./provider", () => ({ connectProvider }));
vi.mock("./kicad-binding", () => ({
  bindKicadCollab,
  moduleItemsBridge,
  SexprVersionError: class SexprVersionError extends Error {},
}));

import {
  attachKicadCollab,
  CollabConnectTimeoutError,
  connectKicadDoc,
} from "./index";

interface FakeProvider {
  whenSynced: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  awareness?: { setLocalState: ReturnType<typeof vi.fn> };
}

function makeProvider(opts?: { neverSync?: boolean }): FakeProvider {
  return {
    whenSynced: vi.fn(() =>
      opts?.neverSync ? new Promise<void>(() => {}) : Promise.resolve(),
    ),
    destroy: vi.fn(),
    awareness: { setLocalState: vi.fn() },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  connectProvider.mockReset();
  bindKicadCollab.mockReset();
  moduleItemsBridge.mockReset();
  moduleItemsBridge.mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connectKicadDoc — deadline + cancellation cover the whole path (C-3)", () => {
  it("connects normally within the deadline", async () => {
    const provider = makeProvider();
    connectProvider.mockResolvedValue(provider);
    const session = await connectKicadDoc({
      provider: { kind: "none" } as never,
      room: "r",
    });
    expect(session.provider).toBe(provider);
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it("times out a sync that never fires and destroys doc + provider", async () => {
    const provider = makeProvider({ neverSync: true });
    connectProvider.mockResolvedValue(provider);
    const attempt = connectKicadDoc({
      provider: { kind: "none" } as never,
      room: "r",
      timeoutMs: 30_000,
    });
    const outcome = expect(attempt).rejects.toBeInstanceOf(
      CollabConnectTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(provider.destroy).toHaveBeenCalled();
  });

  it("times out a stalled provider construction (lazy import hang)", async () => {
    // connectProvider never resolves — the shape of a stalled chunk fetch.
    connectProvider.mockReturnValue(new Promise(() => {}));
    const attempt = connectKicadDoc({
      provider: { kind: "none" } as never,
      room: "r",
      timeoutMs: 30_000,
    });
    const outcome = expect(attempt).rejects.toBeInstanceOf(
      CollabConnectTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it("destroys a provider whose construction resolves after the race was lost", async () => {
    const provider = makeProvider();
    let release!: () => void;
    connectProvider.mockReturnValue(
      new Promise((res) => {
        release = () => res(provider);
      }),
    );
    const attempt = connectKicadDoc({
      provider: { kind: "none" } as never,
      room: "r",
      timeoutMs: 1_000,
    });
    const outcome = expect(attempt).rejects.toBeInstanceOf(
      CollabConnectTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(provider.destroy).not.toHaveBeenCalled(); // not built yet
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.destroy).toHaveBeenCalled(); // late arrival self-destroys
  });

  it("an abort signal cancels the connect and destroys partials", async () => {
    const provider = makeProvider({ neverSync: true });
    connectProvider.mockResolvedValue(provider);
    const controller = new AbortController();
    const attempt = connectKicadDoc({
      provider: { kind: "none" } as never,
      room: "r",
      signal: controller.signal,
    });
    const outcome = expect(attempt).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await outcome;
    expect(provider.destroy).toHaveBeenCalled();
  });

  it("a pre-aborted signal refuses before building anything", async () => {
    const provider = makeProvider();
    connectProvider.mockResolvedValue(provider);
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectKicadDoc({
        provider: { kind: "none" } as never,
        room: "r",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(connectProvider).not.toHaveBeenCalled();
  });
});

describe("attachKicadCollab — a seed throw cannot leak the binding (C-2)", () => {
  it("destroys the partially-attached binding and rethrows", () => {
    const binding = {
      seed: vi.fn(() => {
        throw new Error("bridge trap during seed");
      }),
      destroy: vi.fn(),
      items: new Map(),
    };
    bindKicadCollab.mockReturnValue(binding);
    const session = { doc: new Y.Doc(), provider: makeProvider() };

    expect(() =>
      attachKicadCollab({} as never, {} as never, session as never),
    ).toThrow("bridge trap during seed");
    // The binding (global DOWN hook + doc observers) is torn down; the
    // SESSION is untouched — its owner decides what happens next.
    expect(binding.destroy).toHaveBeenCalledTimes(1);
    expect(session.provider.destroy).not.toHaveBeenCalled();
  });

  it("returns a working handle when seed succeeds", () => {
    const binding = { seed: vi.fn(), destroy: vi.fn(), items: new Map() };
    bindKicadCollab.mockReturnValue(binding);
    const session = { doc: new Y.Doc(), provider: makeProvider() };
    const handle = attachKicadCollab({} as never, {} as never, session as never);
    handle.destroy();
    expect(binding.destroy).toHaveBeenCalledTimes(1);
    expect(session.provider.destroy).toHaveBeenCalledTimes(1);
  });
});
