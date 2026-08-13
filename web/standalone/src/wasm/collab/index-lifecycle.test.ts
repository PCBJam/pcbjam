import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectProvider, bindKicadCollab, moduleItemsBridge, createReconciler } =
  vi.hoisted(() => ({
    connectProvider: vi.fn(),
    bindKicadCollab: vi.fn(),
    moduleItemsBridge: vi.fn(() => ({})),
    createReconciler: vi.fn(),
  }));

vi.mock("./provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider")>()),
  connectProvider,
}));
vi.mock("./kicad-binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kicad-binding")>()),
  bindKicadCollab,
  moduleItemsBridge,
}));
vi.mock("./reconciler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reconciler")>()),
  createReconciler,
}));

import * as Y from "yjs";
import {
  MAX_PROVIDER_SYNC_TIMEOUT_MS,
  ProviderSyncTimeoutError,
  attachKicadCollab,
  connectKicadDoc,
  startCollab,
} from "./index";
import {
  createKicadDocSessionOwner,
  destroyKicadDocSession,
} from "./doc-session-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("collaboration connection lifetime", () => {
  beforeEach(() => {
    vi.useRealTimers();
    connectProvider.mockReset();
    bindKicadCollab.mockReset();
    moduleItemsBridge.mockClear();
    createReconciler.mockReset();
  });

  it("times out an unsynced provider and destroys provider plus doc exactly once", async () => {
    vi.useFakeTimers();
    const destroyProvider = vi.fn();
    let waitSignal: AbortSignal | undefined;
    connectProvider.mockResolvedValue({
      destroy: destroyProvider,
      whenSynced: ({ signal }: { signal?: AbortSignal } = {}) => {
        waitSignal = signal;
        return new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const destroyDoc = vi.spyOn(Y.Doc.prototype, "destroy");

    const pending = connectKicadDoc({
      provider: { kind: "none" },
      room: "room-a",
      syncTimeoutMs: 25,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderSyncTimeoutError);
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(waitSignal?.aborted).toBe(true);
    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    destroyDoc.mockRestore();
  });

  it("destroys the document when a failing provider cleanup follows sync failure", async () => {
    const syncError = new Error("initial sync failed");
    const destroyProvider = vi.fn(() => {
      throw new Error("provider cleanup failed");
    });
    connectProvider.mockResolvedValue({
      destroy: destroyProvider,
      whenSynced: () => Promise.reject(syncError),
    });
    const destroyDoc = vi.spyOn(Y.Doc.prototype, "destroy");

    // Cleanup failure becomes the visible terminal error, but it cannot stop
    // retirement of the document half of the acquired session.
    await expect(
      connectKicadDoc({
        provider: { kind: "none" },
        room: "failed-cleanup",
      }),
    ).rejects.toThrow("provider cleanup failed");
    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    destroyDoc.mockRestore();
  });

  it("legacy handle retires provider and document when earlier destructors throw", async () => {
    const destroyProvider = vi.fn(() => {
      throw new Error("provider cleanup failed");
    });
    connectProvider.mockResolvedValue({
      destroy: destroyProvider,
      whenSynced: () => Promise.resolve(),
    });
    const destroyReconciler = vi.fn(() => {
      throw new Error("reconciler cleanup failed");
    });
    createReconciler.mockReturnValue({
      seed: () => Promise.resolve(),
      destroy: destroyReconciler,
      items: new Map(),
    });
    const destroyDoc = vi.spyOn(Y.Doc.prototype, "destroy");

    const handle = await startCollab({} as never, {} as never, {
      provider: { kind: "none" },
      room: "legacy-room",
    });
    expect(() => handle.destroy()).toThrow("provider cleanup failed");
    expect(destroyReconciler).toHaveBeenCalledTimes(1);
    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    destroyDoc.mockRestore();
  });

  it("rejects timer-clamping configuration before constructing a provider", async () => {
    await expect(
      connectKicadDoc({
        provider: { kind: "none" },
        room: "room-a",
        syncTimeoutMs: MAX_PROVIDER_SYNC_TIMEOUT_MS + 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(connectProvider).not.toHaveBeenCalled();
  });

  it("retires a binding, provider, and doc during a deferred seed", async () => {
    const seed = deferred<void>();
    const binding = {
      seed: vi.fn(() => seed.promise),
      destroy: vi.fn(),
      items: new Map(),
    };
    bindKicadCollab.mockReturnValue(binding);
    const provider = { destroy: vi.fn(), whenSynced: vi.fn() };
    const doc = new Y.Doc();
    const destroyDoc = vi.spyOn(doc, "destroy");
    const abort = new AbortController();

    const pending = attachKicadCollab(
      {} as never,
      {} as never,
      { doc, provider } as never,
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(binding.seed).toHaveBeenCalledTimes(1));
    abort.abort(new DOMException("unmounted", "AbortError"));
    expect(binding.destroy).toHaveBeenCalledTimes(1);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);

    seed.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(binding.destroy).toHaveBeenCalledTimes(1);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
  });

  it("destroys the raw session when binding creation refuses the document", async () => {
    const versionError = Object.assign(new Error("update required"), {
      name: "SexprVersionError",
    });
    bindKicadCollab.mockImplementationOnce(() => {
      throw versionError;
    });
    const provider = { destroy: vi.fn(), whenSynced: vi.fn() };
    const doc = new Y.Doc();
    const destroyDoc = vi.spyOn(doc, "destroy");

    await expect(
      attachKicadCollab({} as never, {} as never, { doc, provider } as never),
    ).rejects.toBe(versionError);

    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
  });

  it.each(["boot failure", "openResult=failed", "unmount before attach"])(
    "retires an adopted pre-connected session exactly once on %s",
    () => {
      const owner = createKicadDocSessionOwner();
      const session = {
        provider: { destroy: vi.fn() },
        doc: { destroy: vi.fn() },
      };

      expect(owner.adopt(session as never)).toBe(true);
      owner.destroy();
      owner.destroy();

      expect(session.provider.destroy).toHaveBeenCalledTimes(1);
      expect(session.doc.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("destroys a session which finishes connecting after unmount", () => {
    const owner = createKicadDocSessionOwner();
    const session = {
      provider: { destroy: vi.fn() },
      doc: { destroy: vi.fn() },
    };

    owner.destroy();
    expect(owner.adopt(session as never)).toBe(false);

    expect(session.provider.destroy).toHaveBeenCalledTimes(1);
    expect(session.doc.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases a session to its binding without double-destroying it", () => {
    const owner = createKicadDocSessionOwner();
    const session = {
      provider: { destroy: vi.fn() },
      doc: { destroy: vi.fn() },
    };

    expect(owner.adopt(session as never)).toBe(true);
    expect(owner.release(session as never)).toBe(session);
    owner.destroy();
    expect(session.provider.destroy).not.toHaveBeenCalled();
    expect(session.doc.destroy).not.toHaveBeenCalled();

    const impossibleLateSession = {
      provider: { destroy: vi.fn() },
      doc: { destroy: vi.fn() },
    };
    expect(owner.adopt(impossibleLateSession as never)).toBe(false);
    expect(impossibleLateSession.provider.destroy).toHaveBeenCalledTimes(1);
    expect(impossibleLateSession.doc.destroy).toHaveBeenCalledTimes(1);

    destroyKicadDocSession(session as never);
    owner.destroy();
    expect(session.provider.destroy).toHaveBeenCalledTimes(1);
    expect(session.doc.destroy).toHaveBeenCalledTimes(1);
  });

  it("includes stalled provider construction in the sync deadline and destroys a late result", async () => {
    vi.useFakeTimers();
    const construction = deferred<{
      destroy: ReturnType<typeof vi.fn>;
      whenSynced: ReturnType<typeof vi.fn>;
    }>();
    const provider = {
      destroy: vi.fn(),
      whenSynced: vi.fn(() => Promise.resolve()),
    };
    connectProvider.mockReturnValue(construction.promise);
    const destroyDoc = vi.spyOn(Y.Doc.prototype, "destroy");
    const pending = connectKicadDoc({
      provider: { kind: "none" },
      room: "stalled-constructor",
      syncTimeoutMs: 25,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderSyncTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    expect(provider.destroy).not.toHaveBeenCalled();

    construction.resolve(provider);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(provider.whenSynced).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    destroyDoc.mockRestore();
  });

  it("aborts stalled provider construction and cleans a late result", async () => {
    const construction = deferred<{
      destroy: ReturnType<typeof vi.fn>;
      whenSynced: ReturnType<typeof vi.fn>;
    }>();
    const provider = {
      destroy: vi.fn(),
      whenSynced: vi.fn(() => Promise.resolve()),
    };
    connectProvider.mockReturnValue(construction.promise);
    const abort = new AbortController();
    const pending = connectKicadDoc({
      provider: { kind: "none" },
      room: "aborted-constructor",
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    abort.abort(new DOMException("unmounted", "AbortError"));
    await rejected;
    construction.resolve(provider);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(provider.whenSynced).not.toHaveBeenCalled();
  });
});
