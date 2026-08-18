import type { ProjectFile } from "@pcbjam/shared";

/**
 * Browser-local cache of REMOTE project-file bodies, keyed by the file's
 * server-authoritative version — so a warm load fetches only files that
 * actually changed instead of re-downloading the whole project
 * (docs/features/load-path-rework/0001, step 1).
 *
 * Validator, not TTL: an entry is served only when its stored validator equals
 * the one derived from the CURRENT project listing (`fileCacheValidator`), so
 * staleness is impossible as long as the listing is fresh — and the listing is
 * exactly what the editor just fetched to enumerate the files.
 *
 * The validator is `revision:updatedAt`, NOT revision alone: the backend's
 * resave job can swap a file's stored body for a semantically-equivalent
 * normalization WITHOUT advancing the client-visible revision
 * (writeProjectFile's `equivalentToStorageKey` path) — but every publish,
 * equivalent or not, touches `updatedAt`, so the pair changes whenever the
 * bytes can have.
 *
 * Ydoc-backed files use the `.ydoc` blob's content fingerprint instead
 * (`ydocTag`, load-path-rework: the ydoc-etag validator): while the room is
 * COLD its served bytes are a pure function of that blob, and the room's
 * last-close flush lands BEFORE the live marker is deleted, so a cold tag is
 * trustworthy. What we cache is the CONVERTED KiCad text — a warm load skips
 * the download AND the ydoc→s-expr conversion. The validator embeds
 * {@link YDOC_CONVERT_EPOCH} so shipping a converter change invalidates
 * every converted body at once. LIVE files stay uncacheable (bytes are
 * moving under an open room), as do plain files without a CAS revision.
 *
 * Raw IndexedDB, mirroring idb-project-store.ts: one out-of-line-keyed store,
 * key `projectId + NUL + path` so a project's entries form one contiguous key
 * range that can't capture another project's. Every operation is best-effort —
 * a missing/broken IndexedDB (private mode, node tests) degrades to plain
 * fetching, never to a failed load.
 */

const DB_NAME = "pcbjam-project-file-cache";
const DB_VERSION = 1;
const FILES = "files"; // key: projectId + SEP + path -> CacheRecord
const SEP = "\u0000"; // NUL: sorts below every id char (collision-proof ranges)
const MAX_CHAR = "\uffff"; // largest UTF-16 code unit -> key-range upper bound

interface CacheRecord {
  validator: string;
  bytes: Uint8Array;
  cachedAt: string;
}

/**
 * Bump when the client-side ydoc→KiCad-text conversion (`ydocUpdateToKicadDoc`
 * + `docToFile`) can produce different output for the same blob — cached
 * converted bodies are keyed under it.
 */
const YDOC_CONVERT_EPOCH = 1;

/**
 * The cache validator for a listed file, or null when the file is uncacheable:
 * live (bytes moving under an open room), ydoc-backed without a blob
 * fingerprint (older backend), or plain without a CAS revision.
 */
export function fileCacheValidator(meta: ProjectFile): string | null {
  if (meta.isLive) return null;
  if (meta.hasYdoc) {
    return meta.ydocTag ? `y${YDOC_CONVERT_EPOCH}:${meta.ydocTag}` : null;
  }
  if (!meta.revision || meta.revision <= 0) return null;
  return `${meta.revision}:${meta.updatedAt}`;
}

/** Is `validator` the ydoc-blob form (a converted-body entry is expected)? */
export function isYdocValidator(validator: string): boolean {
  return validator.startsWith(`y${YDOC_CONVERT_EPOCH}:`);
}

function hasIdb(): boolean {
  return typeof indexedDB !== "undefined";
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbP: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  return (dbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbP = null; // a later call may retry (e.g. transient quota/open failure)
      reject(req.error);
    };
  }));
}

function key(projectId: string, path: string): string {
  return `${projectId}${SEP}${path}`;
}
function rangeFor(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${projectId}${SEP}`, `${projectId}${SEP}${MAX_CHAR}`);
}

/** Cached bytes for (projectId, path) iff stored under exactly `validator`. */
export async function readCachedFileBytes(
  projectId: string,
  path: string,
  validator: string,
): Promise<Uint8Array | null> {
  if (!hasIdb()) return null;
  try {
    const db = await openDb();
    const rec = await reqDone<CacheRecord | undefined>(
      db.transaction(FILES, "readonly").objectStore(FILES).get(key(projectId, path)),
    );
    if (!rec || rec.validator !== validator) return null;
    return rec.bytes;
  } catch {
    return null;
  }
}

/** Best-effort store; failures (quota, private mode) are swallowed. */
export async function writeCachedFileBytes(
  projectId: string,
  path: string,
  validator: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(FILES, "readwrite");
    const rec: CacheRecord = { validator, bytes, cachedAt: new Date().toISOString() };
    tx.objectStore(FILES).put(rec, key(projectId, path));
    await txDone(tx);
  } catch {
    // best-effort
  }
}

/**
 * Drop this project's entries that the current listing no longer vouches for:
 * deleted paths and stale validators (superseded revisions, files that turned
 * ydoc-backed). Called after every fresh project listing, fire-and-forget.
 */
export async function pruneProjectFileCache(
  projectId: string,
  valid: ReadonlyMap<string, string>,
): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(FILES, "readwrite");
    const store = tx.objectStore(FILES);
    const prefixLen = projectId.length + SEP.length;
    await new Promise<void>((resolve, reject) => {
      const cur = store.openCursor(rangeFor(projectId));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const path = String(c.key).slice(prefixLen);
        const rec = c.value as CacheRecord;
        if (valid.get(path) !== rec.validator) c.delete();
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    await txDone(tx);
  } catch {
    // best-effort
  }
}
