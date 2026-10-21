import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLibIndex,
  decodeLibIndexTsv,
  encodeBundle,
  sha256Hex,
  type LibIndexFile,
  type LibIndexKind,
  type SyncManifest,
} from "@pcbjam/shared";
import { memStore, SyncStack, type LayerDescriptor, type LayerStore } from "@pcbjam/sync-client";
import { createLibIndexStore, memRowCache, type LibIndexCompute, type LibIndexRowCache } from "./lib-index-store";
import { installLibsProvider, type LibsSource } from "./source";
import { syncedLibsSource } from "./synced-source";

const API = "https://api.test";
const ORIGINS = `${API}/api/scopes/s/libs/origins`;
const enc = new TextEncoder();

const sym = (name: string, extra = "") =>
  `(kicad_symbol_lib (version 20251024) (symbol "${name}" (property "Value" "${name}") ${extra}))`;

/** One fake server holding any number of layers (url → bodies) plus the index routes. */
function fakeBackend() {
  const layers = new Map<string, Map<string, Uint8Array>>();
  const indexFiles = new Map<string, LibIndexFile>(); // `<lib>@<ver>` → file (per-version route)
  let packIndex: LibIndexFile[] | null = null;
  const hits: string[] = [];
  /** Bundle downloads held back until released (the cold run's slow pack). */
  const held = new Map<string, Promise<void>>();

  const manifestOf = async (url: string): Promise<SyncManifest> => {
    const m: SyncManifest = { version: 1, entries: {} };
    for (const [p, b] of layers.get(url) ?? []) m.entries[p] = { hash: await sha256Hex(b), size: b.length, mtime: 0 };
    return m;
  };
  const json = (obj: unknown) => ({ ok: true, status: 200, json: async () => structuredClone(obj) });

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    hits.push(url);
    if (url === `${ORIGINS}/_pack`) {
      return packIndex ? json({ id: "a".repeat(64), bytes: 1, libs: 1, builtAt: "", index: { bytes: 1, schema: 1 } }) : { ok: false, status: 404 };
    }
    if (url === `${ORIGINS}/_pack/${"a".repeat(64)}/index?schema=1`) {
      return json({ schema: 1, packId: "a".repeat(64), libs: packIndex });
    }
    const idx = /\/origins\/([^/]+)\/([^/]+)\/index\?schema=1$/.exec(url);
    if (idx) {
      const file = indexFiles.get(`${idx[1]}@${idx[2]}`);
      return file ? json(file) : { ok: false, status: 404 };
    }
    for (const base of layers.keys()) {
      if (url === `${base}/manifest`) return json(await manifestOf(base));
      if (url === `${base}/bundle`) {
        await held.get(base);
        const bytes = encodeBundle(await manifestOf(base), [...layers.get(base)!]);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
      }
      if (url.startsWith(`${base}/body/`) && init?.method === "PUT") {
        const path = decodeURIComponent(url.slice(`${base}/body/`.length));
        const body = new Uint8Array(init.body as ArrayBuffer | Uint8Array);
        layers.get(base)!.set(path, body);
        return json({ version: 2, hash: await sha256Hex(body), size: body.length });
      }
      if (url.startsWith(`${base}/body/`) && !init?.method) {
        const body = layers.get(base)!.get(decodeURIComponent(url.slice(`${base}/body/`.length)));
        return body ? { ok: true, status: 200, text: async () => new TextDecoder().decode(body) } : { ok: false, status: 404 };
      }
      if (url.startsWith(`${base}/body/`) && init?.method === "DELETE") {
        layers.get(base)!.delete(decodeURIComponent(url.slice(`${base}/body/`.length)));
        return json({ version: 3 });
      }
    }
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    hits,
    /** Hold `base`'s bundle until the returned release() is called. */
    holdBundle(base: string) {
      let release!: () => void;
      held.set(base, new Promise<void>((r) => (release = r)));
      return () => release();
    },
    layer(url: string, items: Record<string, string>) {
      layers.set(url, new Map(Object.entries(items).map(([p, t]) => [p, enc.encode(t)])));
    },
    serveIndex(libId: string, versionId: string, kind: LibIndexKind, items: Record<string, string>) {
      const { rows, bad } = buildLibIndex(kind, Object.entries(items));
      const file: LibIndexFile = { schema: 1, libId, versionId, kind, builtAt: "", rows, ...(bad.length ? { bad } : {}) };
      indexFiles.set(`${libId}@${versionId}`, file);
      return file;
    },
    servePack(files: LibIndexFile[]) {
      packIndex = files;
    },
  };
}

const origin = (lib: string, ver: string): LayerDescriptor => ({
  namespace: `origin:${lib}@${ver}`,
  kind: "static",
  url: `${ORIGINS}/${lib}/${ver}`,
});
const mirror = (lib: string): LayerDescriptor => ({
  namespace: `mirror:t:${lib}`,
  kind: "live",
  url: `${API}/parties/sync-room/mirror:t:${lib}`,
  writable: true,
});

async function openStack(backend: ReturnType<typeof fakeBackend>, layers: LayerDescriptor[], stores = new Map<string, LayerStore>()) {
  const stack = new SyncStack({
    layers,
    fetchImpl: backend.fetchImpl,
    realtime: "shared-only", // no sockets in tests
    storeFactory: (ns) => stores.get(ns) ?? stores.set(ns, memStore()).get(ns)!,
  });
  await stack.open();
  return stack;
}

/** Counts how many bodies the store had to parse. */
function countingCompute(): { compute: LibIndexCompute; parsed: string[] } {
  const parsed: string[] = [];
  const compute: LibIndexCompute = async (kind, items) => {
    parsed.push(...items.map(([p]) => p));
    const { rows, bad } = buildLibIndex(kind, items.map(([p, b]) => [p, new TextDecoder().decode(b)]));
    const byPath = new Map(rows.map(({ p, ...r }) => [p, r]));
    return items.map(([p]) => (bad.includes(p) ? null : (byPath.get(p) as never)));
  };
  return { compute, parsed };
}

describe("lib index store", () => {
  it("an origin layer is served from its version's index; a mirror override replaces a path and adds one", async () => {
    const b = fakeBackend();
    const originItems = { "symbol/R": sym("R"), "symbol/C": sym("C") };
    b.layer(`${ORIGINS}/L1/V1`, originItems);
    b.serveIndex("L1", "V1", "symbol", originItems);
    b.layer(mirror("L1").url, { "symbol/R": sym("R", `(property "LCSC" "C1")`), "symbol/Extra": sym("Extra") });

    const stack = await openStack(b, [origin("L1", "V1"), mirror("L1")]);
    const { compute, parsed } = countingCompute();
    const store = createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache(), compute });

    const idx = (await store.libIndex(stack, "symbol"))!;
    expect(idx.rows.map((r) => r.n)).toEqual(["C", "Extra", "R"]);
    expect(idx.rows.find((r) => r.n === "R")).toMatchObject({ fl: { LCSC: "C1" } });
    // Only the mirror's two bodies were parsed; the origin came from its index.
    expect(parsed.sort()).toEqual(["symbol/Extra", "symbol/R"]);
    expect(b.hits).toContain(`${ORIGINS}/L1/V1/index?schema=1`);
    expect(store.peek(stack, "symbol")).toBe(idx);
  });

  it("the official combined index is used before the per-version file", async () => {
    const b = fakeBackend();
    const items = { "symbol/R": sym("R") };
    b.layer(`${ORIGINS}/L1/V1`, items);
    b.servePack([b.serveIndex("L1", "V1", "symbol", items)]);
    const stack = await openStack(b, [origin("L1", "V1")]);
    const store = createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache() });
    expect((await store.libIndex(stack, "symbol"))!.rows).toEqual([{ n: "R" }]);
    expect(b.hits.some((u) => u.endsWith("/L1/V1/index?schema=1"))).toBe(false);
  });

  it("no server index (404): the layer is indexed in the browser", async () => {
    const b = fakeBackend();
    b.layer(`${ORIGINS}/L1/V1`, { "symbol/R": sym("R") });
    const stack = await openStack(b, [origin("L1", "V1")]);
    const { compute, parsed } = countingCompute();
    const store = createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache(), compute });
    expect((await store.libIndex(stack, "symbol"))!.rows).toEqual([{ n: "R" }]);
    expect(parsed).toEqual(["symbol/R"]);
  });

  it("parses by content hash: a hit is not parsed again; a change recomputes one row; a delete drops it", async () => {
    const b = fakeBackend();
    b.layer(mirror("T").url, { "symbol/A": sym("A"), "symbol/B": sym("B") });
    const rowCache: LibIndexRowCache = memRowCache();
    const stores = new Map<string, LayerStore>();
    const { compute, parsed } = countingCompute();

    const first = await openStack(b, [mirror("T")], stores);
    const s1 = createLibIndexStore({ fetchImpl: b.fetchImpl, rowCache, compute });
    expect((await s1.libIndex(first, "symbol"))!.rows.map((r) => r.n)).toEqual(["A", "B"]);
    expect(parsed).toHaveLength(2);

    // A new session (new store, same IndexedDB): nothing parsed.
    const s2 = createLibIndexStore({ fetchImpl: b.fetchImpl, rowCache, compute });
    const token = (await s2.libIndex(first, "symbol"))!.token;
    expect(parsed).toHaveLength(2);

    // Our own save: one row recomputed, and the token changes.
    await first.push("symbol/B", enc.encode(sym("B", `(property "Description" "new")`)));
    const after = (await s2.libIndex(first, "symbol"))!;
    expect(parsed.slice(2)).toEqual(["symbol/B"]);
    expect(after.rows.find((r) => r.n === "B")).toMatchObject({ d: "new" });
    expect(after.token).not.toBe(token);

    await first.delete("symbol/A");
    expect((await s2.libIndex(first, "symbol"))!.rows.map((r) => r.n)).toEqual(["B"]);
  });

  it("a body that won't index, or a server index with bad paths, gives null", async () => {
    const b = fakeBackend();
    b.layer(mirror("T").url, { "symbol/A": sym("A"), "symbol/Broken": "((" });
    const store = createLibIndexStore({ fetchImpl: b.fetchImpl, rowCache: memRowCache() });
    expect(await store.libIndex(await openStack(b, [mirror("T")]), "symbol")).toBeNull();

    const items = { "symbol/R": sym("R"), "symbol/Bad": "((" };
    b.layer(`${ORIGINS}/L2/V1`, items);
    b.serveIndex("L2", "V1", "symbol", items);
    const s2 = createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache() });
    expect(await s2.libIndex(await openStack(b, [origin("L2", "V1")]), "symbol")).toBeNull();
  });

  it("derived rows are resolved against their parent across layers", async () => {
    const b = fakeBackend();
    const items = { "symbol/R": `(kicad_symbol_lib (symbol "R" (symbol "R_2_1") (symbol "R_1_1" (pin passive line (at 0 0 0) (length 1) (number "1")))))` };
    b.layer(`${ORIGINS}/L1/V1`, items);
    b.serveIndex("L1", "V1", "symbol", items);
    b.layer(mirror("L1").url, { "symbol/R_Small": `(kicad_symbol_lib (symbol "R_Small" (extends "R")))` });
    const stack = await openStack(b, [origin("L1", "V1"), mirror("L1")]);
    const store = createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache() });
    const rows = (await store.libIndex(stack, "symbol"))!.rows;
    expect(rows.find((r) => r.n === "R_Small")).toEqual({ n: "R_Small", x: "R", v: "", u: 2, gp: 1, pc: 1 });
  });
});

type Req = (op: string, lib: string, arg: string, kind?: string) => Promise<string | Uint8Array | null>;

describe("provider: list/index", () => {
  // Node has no window: stub the surface the provider touches.
  const win = { location: { search: "" }, dispatchEvent: () => true } as { location: { search: string }; dispatchEvent: () => boolean; kicadLibs?: { request: Req } };
  beforeEach(() => {
    win.location.search = "";
    delete win.kicadLibs;
    (globalThis as unknown as { window: unknown }).window = win;
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });
  function provider(source: LibsSource, opts?: Parameters<typeof installLibsProvider>[2]): Req {
    installLibsProvider(source, () => {}, opts);
    return win.kicadLibs!.request;
  }
  const rows = [{ n: "A" }, { n: "B" }];
  const result = { kind: "symbol" as const, token: "tok", rows };
  const base: LibsSource = {
    listLibs: async () => [],
    listItems: async () => [],
    getItemBody: async () => null,
  };

  it("answers TSV, pages, '~' when not ready, and the batch form", async () => {
    let ready = false;
    const request = provider({
      ...base,
      getLibIndex: async (id) => (id === "none" ? null : result),
      peekLibIndex: () => (ready ? result : undefined),
    });
    const tsv = (await request("list", "/mnt/pcbjam/L1", "index", "symbol")) as string;
    expect(decodeLibIndexTsv(tsv)).toEqual({ token: "tok", rows });
    expect(await request("list", "/mnt/pcbjam/L1", "index:0", "symbol")).toBe("~");
    ready = true;
    const page = decodeLibIndexTsv((await request("list", "/mnt/pcbjam/L1", "index:1", "symbol")) as string);
    expect(page).toEqual({ token: "tok", rows: [{ n: "B" }], page: { from: 1, total: 2 } });
    expect(await request("list", "/mnt/pcbjam/none", "index", "symbol")).toBeNull();
    expect(await request("list", "/mnt/pcbjam/L1", "index", "footprint")).toBeNull();

    const batch = (await request("index", "/mnt/pcbjam/", JSON.stringify(["/mnt/pcbjam/L1", "/mnt/pcbjam/none"]), "symbol")) as string;
    const frames = batch.split("\x1d").slice(1);
    expect(frames[0]!.startsWith("/mnt/pcbjam/L1\nv=tok")).toBe(true);
    expect(frames[1]).toBe("/mnt/pcbjam/none\n");
  });

  it("the enumerate gate doesn't hold an index request", async () => {
    const request = provider({ ...base, getLibIndex: async () => result }, { enumerateGate: () => new Promise(() => {}) });
    expect(await request("list", "/mnt/pcbjam/L1", "index", "symbol")).toContain("v=tok");
  });

  it("the footprint index op passes its argument to getFpIndex", async () => {
    const seen: Array<string | undefined> = [];
    const request = provider({ ...base, getFpIndex: async (arg) => (seen.push(arg), "=") });
    expect(await request("index", "/mnt/pcbjam/", `{"v":"x","projectLibs":[]}`, "footprint")).toBe("=");
    expect(seen).toEqual([`{"v":"x","projectLibs":[]}`]);
  });

  it("?libindex=0 answers null", async () => {
    const request = provider({ ...base, getLibIndex: async () => result });
    win.location.search = "?libindex=0";
    expect(await request("list", "/mnt/pcbjam/L1", "index", "symbol")).toBeNull();
    expect(await request("index", "/mnt/pcbjam/", `["/mnt/pcbjam/L1"]`, "symbol")).toBeNull();
  });
});

describe("cold run (libs 0028 phase 7)", () => {
  const win = { location: { search: "" } };
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = win;
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as { Module?: unknown }).Module;
  });

  it("names, index and bodies come from the server index while the bundle downloads; the open reconciles", async () => {
    const b = fakeBackend();
    const items = { "symbol/R": sym("R"), "symbol/C": sym("C") };
    b.layer(`${ORIGINS}/L1/V1`, items);
    b.servePack([b.serveIndex("L1", "V1", "symbol", items)]);
    // The team's mirror overrides R: the cold answers can't know that yet.
    b.layer(mirror("L1").url, { "symbol/R": sym("R", `(property "LCSC" "C1")`) });
    const release = b.holdBundle(`${ORIGINS}/L1/V1`);
    const invalidated: string[] = [];
    (globalThis as { Module?: unknown }).Module = { kicadLibsInvalidate: (kind: string, nick: string) => invalidated.push(`${kind}:${nick}`) };

    const stores = new Map<string, LayerStore>();
    const source = syncedLibsSource("L1", {
      apiBase: API,
      scope: "s",
      fetchImpl: b.fetchImpl,
      realtime: "shared-only",
      storeFactory: (ns) => stores.get(ns) ?? stores.set(ns, memStore()).get(ns)!,
      stackFor: () => ({ lib: { id: "L1", name: "Device" }, layers: [origin("L1", "V1"), mirror("L1")] }),
      libIndex: createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache() }),
    });

    expect((await source.listItems("L1")).map((i) => i.name)).toEqual(["C", "R"]);
    expect((await source.getLibIndex!("L1", "symbol"))!.rows.map((r) => r.n)).toEqual(["C", "R"]);
    expect(await source.getItemBody("L1", "symbol", "C")).toBe(sym("C"));
    expect(b.hits).toContain(`${ORIGINS}/L1/V1/body/${encodeURIComponent("symbol/C")}`);
    expect(invalidated).toEqual([]);

    // The bundle lands: the stack opens, and the override makes the library differ.
    release();
    await vi.waitFor(() => expect(invalidated).toEqual(["symbol:Device"]));
    // From now on the stack answers, overrides included.
    expect((await source.getLibIndex!("L1", "symbol"))!.rows.find((r) => r.n === "R")).toMatchObject({ fl: { LCSC: "C1" } });
  });

  it("a cached static layer takes the stack, as before", async () => {
    const b = fakeBackend();
    const items = { "symbol/R": sym("R") };
    b.layer(`${ORIGINS}/L1/V1`, items);
    b.serveIndex("L1", "V1", "symbol", items);
    const stores = new Map<string, LayerStore>();
    // A previous session cached the static layer.
    await openStack(b, [origin("L1", "V1")], stores);
    const release = b.holdBundle(`${ORIGINS}/L1/V1`);
    const source = syncedLibsSource("L1", {
      apiBase: API,
      scope: "s",
      fetchImpl: b.fetchImpl,
      realtime: "shared-only",
      storeFactory: (ns) => stores.get(ns) ?? stores.set(ns, memStore()).get(ns)!,
      stackFor: () => ({ lib: { id: "L1", name: "Device" }, layers: [origin("L1", "V1")] }),
      libIndex: createLibIndexStore({ originsBase: ORIGINS, fetchImpl: b.fetchImpl, rowCache: memRowCache() }),
    });
    expect((await source.listItems("L1")).map((i) => i.name)).toEqual(["R"]);
    expect(b.hits.some((u) => u.endsWith("/body/symbol%2FR"))).toBe(false);
    release();
  });
});
