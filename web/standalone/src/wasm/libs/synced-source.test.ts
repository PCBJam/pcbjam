import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeBundle,
  encodeFrames,
  sha256Hex,
  SYNC_ACTION_HEADER,
  SYNC_ACTION_RELOAD,
  type ServerMsg,
  type SyncManifest,
} from "@pcbjam/shared";
import {
  memStore,
  type LayerStore,
  type RealtimeChannel,
} from "@pcbjam/sync-client";
import { syncedLibsSource, syncedScopeLibsSource } from "./synced-source";
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

  // Cutover simulation: `movedOnce` refuses the NEXT write with the 409 +
  // reload-action answer a room gives after it stopped being the namespace's
  // writer; `resolves` counts sync-stack resolutions (the retry re-resolves).
  const state = { movedOnce: false, resolves: 0 };

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/sync-stack")) {
      state.resolves += 1;
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
      const { paths } = JSON.parse(String(init?.body)) as { paths: string[] };
      return bin(
        encodeFrames(
          paths.map((p) => [p, bodies.get(p) ?? new Uint8Array()]),
        ),
      );
    }
    if (url.startsWith(`${ROOM}/body/`) && init?.method === "PUT") {
      if (state.movedOnce) {
        state.movedOnce = false;
        return {
          ok: false,
          status: 409,
          headers: {
            get: (h: string) => (h === SYNC_ACTION_HEADER ? SYNC_ACTION_RELOAD : null),
          },
        };
      }
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

  return { fetchImpl, channel, remotePut, state };
}

function makeSource(server: Awaited<ReturnType<typeof fakeServer>>) {
  return syncedLibsSource(LIB_ID, {
    apiBase: API,
    scope: "s",
    user: "u",
    fetchImpl: server.fetchImpl,
    storeFactory: () => memStore(),
    channelFactory: () => server.channel,
  });
}

describe("syncedLibsSource → editor reload bridge", () => {
  const reload = vi.fn();

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

  it("our own save does NOT trigger a reload (plugin already self-invalidates)", async () => {
    const server = await fakeServer({});
    const source = makeSource(server);
    await source.listItems(LIB_ID);

    const ok = await source.saveItemBody!(LIB_ID, "symbol", "Mine", "(body)");
    expect(ok).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
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
});

/**
 * syncedScopeLibsSource.syncState (standalone-load-ux 0002): warmth from the
 * LOCAL caches (peekNamespaces on the backend-named namespaces) + cold-byte
 * sums from the list envelope — no stack resolves, no bundle fetches.
 */
describe("cutover 409 → re-resolve + retry (load-path-rework 0002)", () => {
  it("saveItemBody retries once against the re-resolved room and succeeds", async () => {
    const server = await fakeServer({ "symbol/R": "(r)" });
    server.state.movedOnce = true;
    const movedLibs: string[] = [];
    const source = syncedLibsSource(LIB_ID, {
      apiBase: API,
      scope: "s",
      user: "u",
      fetchImpl: server.fetchImpl,
      storeFactory: () => memStore(),
      channelFactory: () => server.channel,
      onStackMoved: (id) => movedLibs.push(id),
    });

    const ok = await source.saveItemBody!(LIB_ID, "symbol", "Mine", "(body)");

    expect(ok).toBe(true);
    // The refusal invalidated the cached descriptor and re-resolved the stack.
    expect(movedLibs).toEqual([LIB_ID]);
    expect(server.state.resolves).toBe(2);
    source.dispose?.();
  });

  it("a persistent refusal fails the save after ONE retry", async () => {
    const server = await fakeServer({ "symbol/R": "(r)" });
    const alwaysMoved = ((input: unknown, init?: RequestInit) => {
      // Every write refuses; reads/resolves pass through.
      if (String(input).includes("/body/") && init?.method === "PUT") {
        server.state.movedOnce = true;
      }
      return (server.fetchImpl as (i: unknown, x?: RequestInit) => unknown)(
        input,
        init,
      );
    }) as typeof fetch;
    const source = syncedLibsSource(LIB_ID, {
      apiBase: API,
      scope: "s",
      user: "u",
      fetchImpl: alwaysMoved,
      storeFactory: () => memStore(),
      channelFactory: () => server.channel,
    });

    const ok = await source.saveItemBody!(LIB_ID, "symbol", "Mine", "(body)");

    expect(ok).toBe(false);
    expect(server.state.resolves).toBe(2); // initial + the one retry, no loop
    source.dispose?.();
  });
});

describe("boot preload (load-path-rework 0001 §6)", () => {
  it("serves listLibs locally (server's kind rule) and skips the stack resolve", async () => {
    const server = await fakeServer({ "symbol/R": "(r)" });
    const failingResolve = ((input: unknown, init?: RequestInit) => {
      if (String(input).includes("sync-stack")) {
        throw new Error("resolve must not be called with a preloaded stack");
      }
      return (server.fetchImpl as (i: unknown, x?: RequestInit) => unknown)(
        input,
        init,
      );
    }) as typeof fetch;
    const remoteStub = {
      listLibs: () => {
        throw new Error("remote listLibs must not be called");
      },
    } as unknown as LibsSource;

    const source = syncedScopeLibsSource(remoteStub, {
      apiBase: API,
      scope: "s",
      user: "u",
      fetchImpl: failingResolve,
      storeFactory: () => memStore(),
      channelFactory: () => server.channel,
      preloaded: {
        libs: [
          { id: LIB_ID, name: "My Lib", type: "org" },
          {
            id: "lib-sym",
            name: "Symbols Only",
            type: "origin",
            kindCounts: { symbol: 12 },
            sync: { namespace: "origin:lib-sym@v1", bytes: 42 },
          },
          {
            id: "lib-fp",
            name: "Footprints Only",
            type: "origin",
            kindCounts: { footprint: 7 },
          },
        ],
        stacks: {
          [LIB_ID]: {
            lib: { id: LIB_ID, name: "My Lib" },
            layers: [
              { namespace: `org:${LIB_ID}`, kind: "live", url: ROOM, writable: true },
            ],
          },
        },
      },
    });

    // Kind filter matches the server: org libs always; origins by kindCounts.
    const symbols = await source.listLibs!("symbol");
    expect(symbols.map((l) => l.id).sort()).toEqual([LIB_ID, "lib-sym"]);
    expect(symbols.find((l) => l.id === "lib-sym")!.sync).toEqual({
      namespace: "origin:lib-sym@v1",
      bytes: 42,
    });
    const footprints = await source.listLibs!("footprint");
    expect(footprints.map((l) => l.id).sort()).toEqual([LIB_ID, "lib-fp"]);

    // The preloaded stack answers the per-lib resolve: a save works with the
    // resolve endpoint hard-failing.
    const ok = await source.saveItemBody!(LIB_ID, "symbol", "Mine", "(body)");
    expect(ok).toBe(true);
    source.dispose?.();
  });
});

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
