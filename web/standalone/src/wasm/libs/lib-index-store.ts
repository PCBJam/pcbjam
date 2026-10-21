import {
  indexFootprintItem,
  indexSymbolItem,
  LIB_INDEX_SCHEMA,
  mapLimit,
  resolveSymbolRows,
  type FootprintIndexRow,
  type LibIndexFile,
  type LibIndexKind,
  type LibIndexPack,
  type LibPackPointer,
  type SymbolIndexRow,
} from "@pcbjam/shared";
import type { LayerDescriptor, SyncStack } from "@pcbjam/sync-client";

/**
 * The client side of the library index (libs 0028 section 8.1): one library's
 * rows, merged across its sync layers the way bodies merge (top wins by path).
 *
 * - An ingested origin layer (static, `…/libs/origins/<lib>/<ver>`) takes its
 *   rows from the server: the official combined index next to the lib pack, or
 *   the version's own `…/index` file.
 * - Every other layer (team, user and mirror overrides, CDN snapshots, an origin
 *   whose index is missing) is indexed here from the bodies the stack already
 *   holds, by content hash, so an unchanged item is never parsed twice. The rows
 *   are kept in IndexedDB (`pcbjam-lib-index`), so a warm session parses nothing.
 *
 * A library whose index can't be had (a body that won't index, a stack that
 * won't answer) gets null, and the editor takes its parse path as before.
 */

export type LibIndexRow = SymbolIndexRow | FootprintIndexRow;

export interface LibIndexResult {
  kind: LibIndexKind;
  /** Changes whenever the rows do. */
  token: string;
  /** Path order; symbols are resolved against their parents (resolveSymbolRows). */
  rows: LibIndexRow[];
}

/** Persistent row cache: `<schema>|<namespace>|<path>` → the row and the entry hash it came from. */
export interface LibIndexRowCache {
  getMany(keys: string[]): Promise<Array<{ h: string; row: LibIndexRow } | undefined>>;
  putMany(entries: Array<[string, { h: string; row: LibIndexRow }]>): Promise<void>;
}

/** Index bodies into rows (null = the body won't index). */
export type LibIndexCompute = (
  kind: LibIndexKind,
  items: Array<[path: string, body: Uint8Array]>,
) => Promise<Array<LibIndexRow | null>>;

export interface LibIndexStore {
  /** The merged index of the library `stack` holds, or null when it can't be had. */
  libIndex(stack: SyncStack, kind: LibIndexKind): Promise<LibIndexResult | null>;
  /**
   * The answer `libIndex` would give, when it is already known and current:
   * a result, null (no index), or undefined (not computed yet).
   */
  peek(stack: SyncStack, kind: LibIndexKind): LibIndexResult | null | undefined;
}

export interface LibIndexStoreOptions {
  /**
   * `<api>/api/scopes/<scope>/libs/origins`: where the official combined index
   * is. Absent ⇒ origin layers are still read from their own `…/index`.
   */
  originsBase?: string;
  fetchImpl?: typeof fetch;
  rowCache?: LibIndexRowCache;
  compute?: LibIndexCompute;
  log?: (msg: string) => void;
}

const ORIGIN_LAYER_URL = /\/libs\/origins\/([^/?]+)\/([^/?]+)$/;
const BODY_READ_CONCURRENCY = 8;

/** FNV-1a, 32 bit, hex: a cheap change token. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Server rows of one layer: path → row, "bad" (a body the server couldn't index), or null (none). */
type ServerRows = Map<string, LibIndexRow> | "bad" | null;

function rowsOf(file: LibIndexFile): ServerRows {
  if (file.schema !== LIB_INDEX_SCHEMA || !Array.isArray(file.rows)) return null;
  if (file.bad?.length) return "bad";
  const map = new Map<string, LibIndexRow>();
  for (const { p, ...row } of file.rows) map.set(p, row as LibIndexRow);
  return map;
}

export function createLibIndexStore(opts: LibIndexStoreOptions = {}): LibIndexStore {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const rowCache = opts.rowCache ?? idbRowCache();
  const compute = opts.compute ?? computeLibIndexRows;
  const memRows = new Map<string, { h: string; row: LibIndexRow }>();

  // ---- server rows ----------------------------------------------------------

  let officialP: Promise<Map<string, LibIndexFile> | null> | null = null;
  const loadOfficial = (): Promise<Map<string, LibIndexFile> | null> =>
    (officialP ??= (async () => {
      if (!opts.originsBase) return null;
      try {
        const p = await fetchImpl(`${opts.originsBase}/_pack`);
        if (!p.ok) return null;
        const pointer = (await p.json()) as LibPackPointer;
        if (pointer.index?.schema !== LIB_INDEX_SCHEMA) return null;
        const t0 = performance.now();
        // Served with Content-Encoding: br; the browser hands it over decoded.
        const r = await fetchImpl(`${opts.originsBase}/_pack/${pointer.id}/index?schema=${LIB_INDEX_SCHEMA}`);
        if (!r.ok) return null;
        const pack = (await r.json()) as LibIndexPack;
        const map = new Map(pack.libs.map((f) => [`${f.libId}@${f.versionId}`, f]));
        log(`[libindex] official index: ${map.size} libraries in ${Math.round(performance.now() - t0)} ms`);
        return map;
      } catch (err) {
        log(`[libindex] official index unavailable (${(err as Error).message})`);
        officialP = null; // a network blip may retry later
        return null;
      }
    })());

  const serverRowsP = new Map<string, Promise<ServerRows>>();
  const serverRows = (d: LayerDescriptor): Promise<ServerRows> => {
    const m = d.kind === "static" ? ORIGIN_LAYER_URL.exec(d.url) : null;
    if (!m) return Promise.resolve(null);
    const key = `${d.namespace}|${d.digest ?? ""}`;
    let p = serverRowsP.get(key);
    if (!p) {
      p = (async (): Promise<ServerRows> => {
        const libVer = `${decodeURIComponent(m[1]!)}@${decodeURIComponent(m[2]!)}`;
        const official = (await loadOfficial())?.get(libVer);
        if (official) return rowsOf(official);
        const r = await fetchImpl(`${d.url}/index?schema=${LIB_INDEX_SCHEMA}`);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return rowsOf((await r.json()) as LibIndexFile);
      })().catch((err) => {
        log(`[libindex] ${d.namespace}: server index unavailable (${(err as Error).message})`);
        serverRowsP.delete(key);
        return null;
      });
      serverRowsP.set(key, p);
    }
    return p;
  };

  // ---- one library ----------------------------------------------------------

  interface Memo {
    sig: string;
    value?: LibIndexResult | null;
    promise: Promise<LibIndexResult | null>;
  }
  const memos = new WeakMap<SyncStack, Map<LibIndexKind, Memo>>();
  let uncacheable = 0;

  /** What the rows depend on: each layer's identity and its entries of `kind`. */
  function signature(layers: ReturnType<SyncStack["layerEntries"]>, kind: LibIndexKind): string {
    const prefix = `${kind}/`;
    let sig = "";
    for (const { descriptor, entries } of layers) {
      sig += `\n#${descriptor.namespace}|${descriptor.digest ?? ""}`;
      for (const [p, e] of Object.entries(entries)) {
        if (!p.startsWith(prefix)) continue;
        // An unpushed write has no hash yet: never reuse an answer built on it.
        sig += `\n${p}\t${e.hash || `!${++uncacheable}`}`;
      }
    }
    return sig;
  }

  async function build(stack: SyncStack, kind: LibIndexKind, layers: ReturnType<SyncStack["layerEntries"]>): Promise<LibIndexResult | null> {
    const prefix = `${kind}/`;
    // Top wins by path, as SyncStack.list()/read() merge.
    const winner = new Map<string, number>();
    layers.forEach(({ entries }, i) => {
      for (const p of Object.keys(entries)) if (p.startsWith(prefix)) winner.set(p, i);
    });
    // Server rows only for layers that still provide some path.
    const wins = new Set(winner.values());
    const server = await Promise.all(
      layers.map((l, i) => (wins.has(i) ? serverRows(l.descriptor) : Promise.resolve(null))),
    );
    if (server.includes("bad")) return null;

    const rows = new Map<string, LibIndexRow>();
    const missing: Array<{ path: string; key: string; h: string }> = [];
    for (const [path, i] of winner) {
      const fromServer = server[i];
      if (fromServer && fromServer !== "bad") {
        const row = fromServer.get(path);
        // The server index of an immutable version covers every item; a path
        // it lacks means the two disagree, so don't trust either.
        if (!row) return null;
        rows.set(path, row);
        continue;
      }
      const h = layers[i]!.entries[path]!.hash;
      missing.push({ path, key: `${LIB_INDEX_SCHEMA}|${layers[i]!.descriptor.namespace}|${path}`, h });
    }

    if (missing.length) {
      // Memory, then IndexedDB, then parse.
      const cached: Array<{ h: string; row: LibIndexRow } | undefined> = missing.map((m) => memRows.get(m.key));
      const fromDb = missing.filter((m, i) => m.h && !cached[i]);
      if (fromDb.length) {
        const got = await rowCache.getMany(fromDb.map((m) => m.key)).catch(() => fromDb.map(() => undefined));
        const byKey = new Map(fromDb.map((m, i) => [m.key, got[i]]));
        missing.forEach((m, i) => {
          if (!cached[i] && byKey.get(m.key)) cached[i] = byKey.get(m.key);
        });
      }
      const toParse = missing.filter((m, i) => !(m.h && cached[i]?.h === m.h));
      missing.forEach((m, i) => {
        const c = cached[i];
        if (m.h && c?.h === m.h) rows.set(m.path, c.row);
      });
      if (toParse.length) {
        const bodies = await mapLimit(toParse, BODY_READ_CONCURRENCY, (m) => stack.read(m.path));
        const items: Array<[string, Uint8Array]> = [];
        toParse.forEach((m, i) => {
          if (bodies[i]) items.push([m.path, bodies[i]!]);
        });
        if (items.length !== toParse.length) return null; // a body vanished mid-read
        const t0 = performance.now();
        const parsed = await compute(kind, items);
        if (parsed.some((r) => r === null)) return null;
        const writes: Array<[string, { h: string; row: LibIndexRow }]> = [];
        toParse.forEach((m, i) => {
          const row = parsed[i]!;
          rows.set(m.path, row);
          if (m.h) {
            memRows.set(m.key, { h: m.h, row });
            writes.push([m.key, { h: m.h, row }]);
          }
        });
        if (writes.length) void rowCache.putMany(writes).catch(() => {});
        if (toParse.length > 50) log(`[libindex] indexed ${toParse.length} ${kind}s in ${Math.round(performance.now() - t0)} ms`);
      }
    }

    const ordered = [...rows.keys()].sort().map((p) => rows.get(p)!);
    const out = kind === "symbol" ? resolveSymbolRows(ordered as SymbolIndexRow[]) : ordered;
    return { kind, token: fnv(JSON.stringify(out)), rows: out };
  }

  return {
    libIndex(stack, kind) {
      let layers: ReturnType<SyncStack["layerEntries"]>;
      try {
        layers = stack.layerEntries();
      } catch {
        return Promise.resolve(null);
      }
      const sig = signature(layers, kind);
      let byKind = memos.get(stack);
      if (!byKind) memos.set(stack, (byKind = new Map()));
      const memo = byKind.get(kind);
      if (memo?.sig === sig) return memo.promise;
      const next: Memo = {
        sig,
        promise: build(stack, kind, layers).catch((err) => {
          log(`[libindex] index failed: ${String(err)}`);
          return null;
        }),
      };
      next.promise.then((v) => {
        next.value = v;
      });
      byKind.set(kind, next);
      return next.promise;
    },
    peek(stack, kind) {
      const memo = memos.get(stack)?.get(kind);
      if (!memo || !("value" in memo)) return undefined;
      let layers: ReturnType<SyncStack["layerEntries"]>;
      try {
        layers = stack.layerEntries();
      } catch {
        return null;
      }
      return signature(layers, kind) === memo.sig ? memo.value : undefined;
    },
  };
}

// ---- computing rows ----------------------------------------------------------

/** Above this many bodies the parse goes to a worker; the full set must never block the tab. */
const WORKER_THRESHOLD = 200;

const dec = new TextDecoder();

function computeInline(kind: LibIndexKind, items: Array<[string, Uint8Array]>): Array<LibIndexRow | null> {
  return items.map(([path, body]) => {
    const name = path.slice(path.indexOf("/") + 1);
    const text = dec.decode(body);
    return kind === "symbol" ? indexSymbolItem(name, text) : indexFootprintItem(name, text);
  });
}

let workerP: Promise<Worker | null> | null = null;
let workerSeq = 0;
const workerWaiters = new Map<number, (rows: Array<LibIndexRow | null>) => void>();

function libIndexWorker(): Promise<Worker | null> {
  return (workerP ??= (async () => {
    if (typeof Worker === "undefined") return null;
    try {
      // Inline (a blob URL): the editor may run from another origin than its page.
      const { default: LibIndexWorker } = await import("./lib-index.worker?worker&inline");
      const worker = new LibIndexWorker();
      worker.onmessage = (e: MessageEvent<{ id: number; rows: Array<LibIndexRow | null> }>) => {
        workerWaiters.get(e.data.id)?.(e.data.rows);
        workerWaiters.delete(e.data.id);
      };
      return worker;
    } catch {
      return null;
    }
  })());
}

/** Default compute: inline for a few bodies, a worker for many. */
export const computeLibIndexRows: LibIndexCompute = async (kind, items) => {
  if (items.length <= WORKER_THRESHOLD) return computeInline(kind, items);
  const worker = await libIndexWorker();
  if (!worker) return computeInline(kind, items);
  const id = ++workerSeq;
  return new Promise((resolve) => {
    workerWaiters.set(id, resolve);
    worker.postMessage({ id, kind, items });
  });
};

// ---- row caches --------------------------------------------------------------

export function memRowCache(): LibIndexRowCache {
  const map = new Map<string, { h: string; row: LibIndexRow }>();
  return {
    getMany: async (keys) => keys.map((k) => map.get(k)),
    putMany: async (entries) => {
      for (const [k, v] of entries) map.set(k, v);
    },
  };
}

const IDB_NAME = "pcbjam-lib-index";
const IDB_STORE = "rows";

/** IndexedDB row cache; degrades to nothing cached when IndexedDB is unavailable. */
export function idbRowCache(): LibIndexRowCache {
  let dbP: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> =>
    (dbP ??= new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    }));
  return {
    async getMany(keys) {
      const db = await open();
      if (!db) return keys.map(() => undefined);
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const out: Array<{ h: string; row: LibIndexRow } | undefined> = new Array(keys.length);
        keys.forEach((k, i) => {
          const r = store.get(k);
          r.onsuccess = () => {
            out[i] = r.result as { h: string; row: LibIndexRow } | undefined;
          };
        });
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(keys.map(() => undefined));
        tx.onabort = () => resolve(keys.map(() => undefined));
      });
    },
    async putMany(entries) {
      const db = await open();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        for (const [k, v] of entries) store.put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    },
  };
}
