import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeBundle,
  encodeFrames,
  sha256Hex,
  type ServerMsg,
  type SyncManifest,
} from "@pcbjam/shared";
import {
  memStore,
  type LayerStore,
  type RealtimeChannel,
} from "@pcbjam/sync-client";
import {
  RELOAD_CHANGED_NAMES_MAX,
  syncedLibsSource,
  syncedScopeLibsSource,
} from "./synced-source";
import type { LibInfo, LibsSource } from "./source";

/**
 * The subscribe → editor-reload bridge (r2-idb-sync task E): a REMOTE change
 * event from the lib's live layer must call the wasm export
 * `Module.kicadLibsReload(kind, nickname)` (debounced), while our OWN saves —
 * which the stack also reports — must not.
 */

const API = "https://api.test";
const LIB_ID = "lib-1";
const ROOM = `${API}/parties/sync-room/org:${LIB_ID}`;

const enc = new TextEncoder();

/** In-memory live-layer server: manifest + bodies + PUT, plus a WS handle the
 *  test uses to push broadcast messages at the client. */
async function fakeServer(seed: Record<string, string>) {
  const bodies = new Map(Object.entries(seed).map(([p, t]) => [p, enc.encode(t)]));
  const manifest: SyncManifest = { version: 1, entries: {} };
  for (const [path, body] of bodies) {
    manifest.entries[path] = {
      hash: await sha256Hex(body),
      size: body.length,
      mtime: 0,
    };
  }

  let onMessage: ((m: ServerMsg) => void) | undefined;
  let nextPutGate: Promise<void> | null = null;
  let putCount = 0;
  const channel: RealtimeChannel = {
    onOpen: (cb) => cb(),
    onMessage: (cb) => {
      onMessage = cb;
    },
    send: () => {},
    close: () => {},
  };

  // json() clones: the layer keeps the manifest object it receives, so handing
  // out our live reference would leak later server-side mutations into the
  // client and defeat its hash-based change dedup.
  const json = (obj: unknown) => ({
    ok: true,
    json: async () => structuredClone(obj),
  });
  const bin = (bytes: Uint8Array) => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  });

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/sync-stack")) {
      return json({
        lib: { id: LIB_ID, name: "My Lib" },
        layers: [
          { namespace: `org:${LIB_ID}`, kind: "live", url: ROOM, writable: true },
        ],
      });
    }
    if (url === `${ROOM}/manifest`) return json(manifest);
    if (url === `${ROOM}/bundle`) {
      return bin(encodeBundle(manifest, [...bodies.entries()]));
    }
    if (url === `${ROOM}/bodies`) {
      const { entries } = JSON.parse(String(init?.body)) as {
        entries: Array<{ path: string; hash: string }>;
      };
      return bin(
        encodeFrames(
          entries.flatMap(({ path, hash }) => {
            const body = bodies.get(path);
            return body && manifest.entries[path]?.hash === hash
              ? [[path, body] as [string, Uint8Array]]
              : [];
          }),
        ),
      );
    }
    if (url.startsWith(`${ROOM}/body/`) && init?.method === "PUT") {
      putCount++;
      const gate = nextPutGate;
      nextPutGate = null;
      if (gate) await gate;
      const path = decodeURIComponent(url.slice(`${ROOM}/body/`.length));
      const body = new Uint8Array(init.body as ArrayBuffer | Uint8Array);
      bodies.set(path, body);
      manifest.version += 1;
      const hash = await sha256Hex(body);
      manifest.entries[path] = { hash, size: body.length, mtime: 0 };
      return json({ version: manifest.version, hash, size: body.length });
    }
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;

  /** Push a body server-side and broadcast the change to the client. */
  async function remotePut(path: string, text: string): Promise<void> {
    const body = enc.encode(text);
    bodies.set(path, body);
    manifest.version += 1;
    const hash = await sha256Hex(body);
    manifest.entries[path] = { hash, size: body.length, mtime: 0 };
    onMessage?.({
      t: "change",
      op: "put",
      path,
      hash,
      size: body.length,
      version: manifest.version,
    });
  }

  return {
    fetchImpl,
    channel,
    remotePut,
    holdNextPut(gate: Promise<void>) {
      nextPutGate = gate;
    },
    get putCount() {
      return putCount;
    },
  };
}

function makeSource(
  server: Awaited<ReturnType<typeof fakeServer>>,
  log?: (message: string) => void,
) {
  return syncedLibsSource(LIB_ID, {
    apiBase: API,
    scope: "s",
    user: "u",
    log,
    fetchImpl: server.fetchImpl,
    storeFactory: () => memStore(),
    channelFactory: () => server.channel,
  });
}

describe("syncedLibsSource → editor reload bridge", () => {
  const reload = vi.fn();

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { Module?: unknown }).Module = { kicadLibsReload: reload };
  });

  afterEach(() => {
    vi.useRealTimers();
    reload.mockReset();
    delete (globalThis as { Module?: unknown }).Module;
  });

  it("a remote change calls kicadLibsReload once (debounced) with kind + name", async () => {
    const server = await fakeServer({ "symbol/SEED": "(kicad_symbol_lib)" });
    const source = makeSource(server);
    await source.listItems(LIB_ID); // open the stack

    await server.remotePut("symbol/A", "(kicad_symbol_lib A)");
    await server.remotePut("symbol/B", "(kicad_symbol_lib B)");
    expect(reload).not.toHaveBeenCalled(); // debounced, not immediate

    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(1); // burst coalesced
    expect(reload).toHaveBeenCalledWith("symbol", "My Lib");
  });

  it("drains sustained sub-debounce traffic at the oldest event's maximum latency", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/CONTINUOUS_0", "(kicad_symbol_lib)");
    for (let i = 1; i <= 6; i++) {
      // Every event is less than the 400 ms quiet period after its predecessor,
      // so a quiet-only debounce would postpone the reload forever.
      await vi.advanceTimersByTimeAsync(300);
      await server.remotePut(`symbol/CONTINUOUS_${i}`, "(kicad_symbol_lib)");
    }

    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(199);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("symbol", "My Lib");
  });

  it("bounds changed names and omits a non-exhaustive overflow notice", async () => {
    const dispatched: CustomEvent[] = [];
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: CustomEvent) => dispatched.push(event),
    };
    const usage = vi.fn().mockResolvedValue(1);
    const logs: string[] = [];
    (globalThis as { Module?: unknown }).Module = {
      kicadLibsReload: reload,
      kicadLibsSymbolUsage: usage,
    };
    try {
      const server = await fakeServer({});
      const source = makeSource(server, (message) => logs.push(message));
      await source.listItems(LIB_ID);

      for (let i = 0; i <= RELOAD_CHANGED_NAMES_MAX; i++) {
        await server.remotePut(`symbol/FLOOD_${i}`, "(kicad_symbol_lib)");
      }
      await vi.advanceTimersByTimeAsync(400);

      // Cache invalidation is whole-kind and still happens exactly once. The
      // optional per-name usage reads/event are suppressed because retaining or
      // emitting a partial list would violate the event's exhaustive contract.
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledWith("symbol", "My Lib");
      expect(usage).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(0);
      expect(logs).toContainEqual(
        expect.stringContaining(
          `more than ${RELOAD_CHANGED_NAMES_MAX} symbol names changed`,
        ),
      );
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("symbol and footprint changes reload their own kind", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/A", "(kicad_symbol_lib A)");
    await server.remotePut("footprint/F", "(footprint F)");
    await vi.advanceTimersByTimeAsync(500);

    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledWith("symbol", "My Lib");
    expect(reload).toHaveBeenCalledWith("footprint", "My Lib");
  });

  it("keeps one active reload and one pending level during a 1,000-message burst", async () => {
    const first = deferred<void>();
    reload.mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/FIRST", "(kicad_symbol_lib FIRST)");
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 1_000; i++) {
      await server.remotePut(
        `symbol/BURST_${i}`,
        `(kicad_symbol_lib BURST_${i})`,
      );
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(
      reload,
      "a parked owner must not receive one ticket per WebSocket message",
    ).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("retries owner backpressure with one fixed-rate timer", async () => {
    reload
      .mockRejectedValueOnce(
        Object.assign(new Error("full"), {
          code: "WX_MUTATOR_BACKPRESSURE",
          reason: "jobs",
          estimatedBytes: 24,
          maxBytes: 100,
        }),
      )
      .mockResolvedValue(undefined);
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/A", "(kicad_symbol_lib A)");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires terminal owner work for that Module without stopping realtime cache updates", async () => {
    const logs: string[] = [];
    reload.mockRejectedValueOnce(
      Object.assign(new Error("scheduler is dead"), {
        code: "WX_NATIVE_ENTRY_ABANDONED",
      }),
    );
    const server = await fakeServer({});
    const source = makeSource(server, (message) => logs.push(message));
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/FIRST", "(kicad_symbol_lib FIRST)");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    for (let i = 0; i < 1_000; i++) {
      await server.remotePut(
        `symbol/AFTER_TERMINAL_${i}`,
        `(kicad_symbol_lib AFTER_TERMINAL_${i})`,
      );
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(
      reload,
      "later WebSocket messages must not resurrect a dead Module owner",
    ).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      logs.filter((message) => message.includes("editor reload retired")),
    ).toHaveLength(1);
    expect(
      await source.getItemBody!(
        LIB_ID,
        "symbol",
        "AFTER_TERMINAL_999",
      ),
      "realtime data still belongs in the cache after native retirement",
    ).toBe("(kicad_symbol_lib AFTER_TERMINAL_999)");

    const nextModuleReload = vi.fn().mockResolvedValue(undefined);
    (globalThis as { Module?: unknown }).Module = {
      kicadLibsReload: nextModuleReload,
    };
    await server.remotePut("symbol/NEXT_MODULE", "(kicad_symbol_lib)");
    await vi.advanceTimersByTimeAsync(400);
    expect(nextModuleReload).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels quiet, max-latency, and backpressure timers", async () => {
    const pendingServer = await fakeServer({});
    const pendingSource = makeSource(pendingServer);
    await pendingSource.listItems(LIB_ID);
    await pendingServer.remotePut("symbol/PENDING", "(kicad_symbol_lib)");
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount(), "quiet + maximum latency").toBe(2);
    pendingSource.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload).not.toHaveBeenCalled();

    reload.mockRejectedValueOnce(
      Object.assign(new Error("full"), {
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "jobs",
        estimatedBytes: 24,
        maxBytes: 100,
      }),
    );
    const retryServer = await fakeServer({});
    const retrySource = makeSource(retryServer);
    await retrySource.listItems(LIB_ID);
    await retryServer.remotePut("symbol/RETRY", "(kicad_symbol_lib)");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount(), "one bounded retry").toBe(1);
    retrySource.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("our own save does NOT trigger a reload (plugin already self-invalidates)", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    const ok = await source.saveItemBody!(LIB_ID, "symbol", "Mine", "(body)");
    expect(ok).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not misclassify two overlapping same-path saves as remote", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    const first = source.saveItemBody!(LIB_ID, "symbol", "Mine", "(first)");
    const second = source.saveItemBody!(LIB_ID, "symbol", "Mine", "(second)");
    expect(await Promise.all([first, second])).toEqual([true, true]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a peer's same-path change while a local save is pending", async () => {
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const server = await fakeServer({});
    server.holdNextPut(putGate);
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    const saving = source.saveItemBody!(LIB_ID, "symbol", "Mine", "(local)");
    await vi.waitFor(() => expect(server.putCount).toBe(1));
    await server.remotePut("symbol/Mine", "(peer)");
    // The peer event entered while the local HTTP mutation was unresolved.
    // Release the acknowledgement so the layer can prove it is not our echo
    // and perform its authoritative same-path reconciliation.
    releasePut();
    expect(await saving).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    // Path-only suppression used to consume this peer event as our own save.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("symbol", "My Lib");

    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("announces used symbols via LIB_ITEM_UPDATED_EVENT after the reload", async () => {
    // The event goes to `window` — fake one for the node test env.
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (e: CustomEvent) =>
        dispatched.push({ type: e.type, detail: e.detail }),
    };
    // USED_R is placed in the (mock) schematic; NEW_C is not.
    const usage = vi.fn((_lib: string, name: string) =>
      name === "USED_R" ? 2 : 0,
    );
    let finishReload!: () => void;
    reload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishReload = resolve;
        }),
    );
    (globalThis as { Module?: unknown }).Module = {
      kicadLibsReload: reload,
      kicadLibsSymbolUsage: usage,
    };
    try {
      const server = await fakeServer({});
      const source = makeSource(server);
      await source.listItems(LIB_ID);

      await server.remotePut("symbol/USED_R", "(kicad_symbol_lib USED_R)");
      await server.remotePut("symbol/NEW_C", "(kicad_symbol_lib NEW_C)");
      await vi.advanceTimersByTimeAsync(500);

      expect(reload).toHaveBeenCalledTimes(1);
      expect(usage, "model reads wait for the reload owner to retire").not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(0);
      finishReload();
      await vi.advanceTimersByTimeAsync(0);
      expect(usage).toHaveBeenCalledWith("My Lib", "USED_R");
      expect(usage).toHaveBeenCalledWith("My Lib", "NEW_C");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.type).toBe("pcbjam:lib-item-updated");
      expect(dispatched[0]!.detail).toMatchObject({
        lib: "My Lib",
        kind: "symbol",
        usedNames: ["USED_R"],
      });
      const names = (dispatched[0]!.detail as { names: string[] }).names;
      expect([...names].sort()).toEqual(["NEW_C", "USED_R"]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("a change before the editor booted (no Module export) is a no-op", async () => {
    delete (globalThis as { Module?: unknown }).Module;
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/A", "(kicad_symbol_lib A)");
    await vi.advanceTimersByTimeAsync(500); // must not throw
    expect(reload).not.toHaveBeenCalled();
  });

  it("drops realtime changes from a disposed source lifetime", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    source.dispose?.();
    // Model a frame that the transport had already delivered while close was
    // taking effect. It belongs to the old source and must not reach WASM.
    await server.remotePut("symbol/LATE", "(kicad_symbol_lib LATE)");
    await vi.advanceTimersByTimeAsync(500);

    expect(reload).not.toHaveBeenCalled();
  });

  it("invalidates a reload ticket that was queued before disposal", async () => {
    const gate = deferred<void>();
    let isCurrent: (() => boolean) | undefined;
    const guarded = Object.assign(vi.fn(), {
      __wxGuardedCall: vi.fn(
        (_args: unknown[], guard: () => boolean) => {
          isCurrent = guard;
          return gate.promise;
        },
      ),
    });
    (globalThis as { Module?: unknown }).Module = {
      kicadLibsReload: guarded,
    };
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    await server.remotePut("symbol/A", "(kicad_symbol_lib A)");
    await vi.advanceTimersByTimeAsync(400);
    expect(isCurrent?.()).toBe(true);

    source.dispose?.();
    expect(isCurrent?.()).toBe(false);
    gate.resolve();
    await gate.promise;
  });
});

describe("syncedScopeLibsSource source sequencing", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("keeps resolves concurrent and rejects an older reverse completion", async () => {
    const libs: LibInfo[] = [{ id: "a", name: "A" }];
    const remote: LibsSource = {
      listLibs: async () => libs,
      listItems: async () => [],
      getItemBody: async () => null,
    };
    const batches = [deferred<Response>(), deferred<Response>()];
    const openedNamespaces: string[] = [];
    let batchCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    const descriptor = (name: string) => ({
      lib: { id: "a", name },
      layers: [
        {
          namespace: name,
          kind: "live" as const,
          url: `${API}/${name}`,
          writable: true,
          channel: { url: `${API}/shared`, lib: "a" },
        },
      ],
    });
    const okJson = (value: unknown) =>
      ({ ok: true, status: 200, json: async () => value }) as Response;
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/sync-stacks")) {
        const call = batchCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await batches[call]!.promise;
        } finally {
          inFlight--;
        }
      }
      if (url.endsWith("/manifest")) {
        return okJson({ version: 0, entries: {} });
      }
      if (url.endsWith("/bundle")) {
        const bytes = encodeBundle({ version: 0, entries: {} }, []);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer,
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const src = syncedScopeLibsSource(remote, {
      apiBase: API,
      scope: "s",
      fetchImpl,
      storeFactory: () => memStore(),
      channelFactory: ({ namespace }) => {
        openedNamespaces.push(namespace);
        return {
          onOpen: () => {},
          onMessage: () => {},
          send: () => {},
          close: () => {},
        };
      },
    });

    const older = src.presync!({ concurrency: 1 });
    await vi.waitFor(() => expect(batchCalls).toBe(1));
    const newer = src.presync!({ concurrency: 1 });
    await vi.waitFor(() => expect(batchCalls).toBe(2));

    // Complete the newer request first. The old request remains in flight and
    // is allowed to finish, but it must not replace the descriptor cache.
    batches[1]!.resolve(okJson({ stacks: { a: descriptor("new") } }));
    await newer;
    batches[0]!.resolve(okJson({ stacks: { a: descriptor("old") } }));
    await older;

    expect(maxInFlight).toBeGreaterThan(1);
    expect(openedNamespaces).toEqual(["new"]);

    // Force a new per-lib source to read the cached winning descriptor. This
    // distinguishes commit order from the already-open stack's identity.
    src.dispose?.();
    await src.getAllItems!("a");
    expect(openedNamespaces).toEqual(["new", "new"]);
  });
});

/**
 * syncedScopeLibsSource.syncState (standalone-load-ux 0002): warmth from the
 * LOCAL caches (peekNamespaces on the backend-named namespaces) + cold-byte
 * sums from the list envelope — no stack resolves, no bundle fetches.
 */
describe("syncedScopeLibsSource.syncState", () => {
  function scoped(libs: LibInfo[]) {
    const remote: LibsSource = {
      listLibs: async () => libs,
      listItems: async () => [],
      getItemBody: async () => null,
    };
    const stores = new Map<string, LayerStore>();
    const storeFactory = (ns: string): LayerStore => {
      let s = stores.get(ns);
      if (!s) stores.set(ns, (s = memStore()));
      return s;
    };
    const src = syncedScopeLibsSource(remote, {
      apiBase: API,
      scope: "s",
      storeFactory,
    });
    return { src, storeFactory };
  }

  /** Seed a namespace's store so the peek sees it warm. */
  async function warmUp(storeFactory: (ns: string) => LayerStore, ns: string) {
    await storeFactory(ns).setManifest({
      version: 1,
      entries: { "symbol/R": { hash: "h", size: 5, mtime: 0 } },
    });
  }

  it("counts local warmth + sums the cold libs' envelope bytes", async () => {
    const { src, storeFactory } = scoped([
      { id: "a", name: "A", sync: { namespace: "origin:a@v1", bytes: 1000 } },
      { id: "b", name: "B", sync: { namespace: "origin:b@v1", bytes: 2000 } },
      { id: "c", name: "C", sync: { namespace: "origin:c@v1", bytes: 4000 } },
    ]);
    await warmUp(storeFactory, "origin:a@v1");
    expect(await src.syncState!("symbol")).toEqual({
      total: 3,
      warm: 1,
      coldBytes: 6000,
      sizesKnown: true,
    });
  });

  it("a cold lib without a byte figure degrades to sizesKnown: false", async () => {
    const { src, storeFactory } = scoped([
      { id: "a", name: "A", sync: { namespace: "origin:a@v1", bytes: 1000 } },
      // live org layer: namespace but no stamped size
      { id: "u", name: "User", type: "user", sync: { namespace: "org:u", bytes: null } },
    ]);
    expect(await src.syncState!()).toEqual({
      total: 2,
      warm: 0,
      coldBytes: 1000,
      sizesKnown: false,
    });
    // …but once the unknown-size lib is the WARM one, sizes are known again.
    await warmUp(storeFactory, "org:u");
    expect(await src.syncState!()).toEqual({
      total: 2,
      warm: 1,
      coldBytes: 1000,
      sizesKnown: true,
    });
  });

  it("returns null (unknown) when the backend names no namespaces at all", async () => {
    const { src } = scoped([{ id: "a", name: "A" }]); // pre-`sync`-field backend
    expect(await src.syncState!()).toBeNull();
  });

  it("probing never initializes a cold cache", async () => {
    const { src, storeFactory } = scoped([
      { id: "a", name: "A", sync: { namespace: "origin:a@v1", bytes: 1000 } },
    ]);
    await src.syncState!();
    expect(await storeFactory("origin:a@v1").getManifest()).toBeNull();
  });
});
