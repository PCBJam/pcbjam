import {
  LOCAL_SCOPE,
  type Project,
  type ProjectFile,
  type ProjectWithFiles,
} from "@pcbjam/shared";
import { SAVE_COMMITTED } from "@/wasm/save-flow";
import type { ProjectSource } from "./project-source";
import {
  SOURCE_DESCRIPTORS,
  deterministicUuid,
} from "./project-source-shared";

/**
 * A WRITABLE, browser-local ProjectSource backed by IndexedDB -- the demo's
 * "virtual project" store. Loading a folder imports a COPY here (the original
 * disk files are untouched); editor saves persist back to IDB and survive
 * reloads; the user exports with Download .zip / per-file. One active per
 * deployment via lib/project-source.ts, layered alongside a read-only gallery.
 *
 * Raw IndexedDB (no idb dependency) -- mirrors sync-client's store.ts. Two
 * out-of-line-keyed stores: PROJECTS keyed by slug, FILES keyed by
 * slug + SEP + path so a project's files form one contiguous key range. SEP is
 * NUL (), which sorts below every slug character, so one project's range
 * can never capture another's -- even prefix-colliding slugs like foo / foo-bar.
 */

const DB_NAME = "pcbjam-local-projects";
const DB_VERSION = 1;
const PROJECTS = "projects"; // key: slug -> ProjectRecord
const FILES = "files"; // key: slug + SEP + path -> FileRecord
const SEP = "\u0000"; // NUL: sorts below every slug char (collision-proof ranges)
const MAX_CHAR = "\uffff"; // largest UTF-16 code unit -> key-range upper bound

interface ProjectRecord {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
interface FileRecord {
  slug: string;
  path: string;
  size: number;
  bytes: Uint8Array;
}

export interface NewFile {
  path: string;
  bytes: Uint8Array;
}

/** A local project source plus the create/delete/rename/export management the
 *  read interface doesn't cover (home-page project management). */
export interface LocalProjectStore extends ProjectSource {
  hasProject(slug: string): Promise<boolean>;
  /**
   * Import/create a project from files; returns it with its slug. A slug is
   * derived from the name and deduped (`-2`, `-3`…) unless `opts.slug` pins an
   * explicit one — used by the gallery "move to local" shadow fork, which reuses
   * the gallery's slug so the composite source routes that `/p/:slug` to the
   * local copy (caller guarantees it isn't already taken).
   */
  createProject(
    name: string,
    files: NewFile[],
    opts?: { slug?: string },
  ): Promise<Project>;
  deleteProject(slug: string): Promise<void>;
  renameProject(slug: string, name: string): Promise<void>;
  /** All of a project's files with bytes, in one read transaction (for export). */
  readFiles(slug: string): Promise<NewFile[]>;
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
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS);
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fileKey(slug: string, path: string): string {
  return `${slug}${SEP}${path}`;
}
function rangeFor(slug: string): IDBKeyRange {
  return IDBKeyRange.bound(`${slug}${SEP}`, `${slug}${SEP}${MAX_CHAR}`);
}
function contentTypeFor(path: string): string {
  if (/\.(kicad_\w+|net|csv|pos|drl|gbr)$/i.test(path))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return base || "project";
}

function toProject(r: ProjectRecord): Project {
  return {
    id: deterministicUuid(`local:project:${r.slug}`),
    scope: LOCAL_SCOPE,
    slug: r.slug,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
function toFile(slug: string, r: FileRecord, ts: string): ProjectFile {
  return {
    id: deterministicUuid(`local:file:${slug}/${r.path}`),
    projectId: deterministicUuid(`local:project:${slug}`),
    path: r.path,
    size: r.size,
    contentType: contentTypeFor(r.path),
    createdAt: ts,
    updatedAt: ts,
  };
}

export function idbProjectStore(): LocalProjectStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());

  const getRecord = async (slug: string): Promise<ProjectRecord | null> => {
    const d = await db();
    const v = await reqDone(
      d.transaction(PROJECTS, "readonly").objectStore(PROJECTS).get(slug),
    );
    return (v as ProjectRecord | undefined) ?? null;
  };

  const touch = async (d: IDBDatabase, slug: string): Promise<void> => {
    // Bump updatedAt on save; tolerate a missing record (file added pre-meta).
    const rec = (await reqDone(
      d.transaction(PROJECTS, "readonly").objectStore(PROJECTS).get(slug),
    )) as ProjectRecord | undefined;
    if (!rec) return;
    const tx = d.transaction(PROJECTS, "readwrite");
    tx.objectStore(PROJECTS).put({ ...rec, updatedAt: nowIso() }, slug);
    await txDone(tx);
  };

  return {
    descriptor: SOURCE_DESCRIPTORS.local,
    readOnly: false,

    async listProjects(): Promise<Project[]> {
      const d = await db();
      const recs = (await reqDone(
        d.transaction(PROJECTS, "readonly").objectStore(PROJECTS).getAll(),
      )) as ProjectRecord[];
      return recs
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map(toProject);
    },

    async getProject(slug: string): Promise<ProjectWithFiles> {
      const rec = await getRecord(slug);
      if (!rec) throw new Error(`local project not found: ${slug}`);
      const d = await db();
      const files = (await reqDone(
        d.transaction(FILES, "readonly").objectStore(FILES).getAll(rangeFor(slug)),
      )) as FileRecord[];
      files.sort((a, b) => (a.path < b.path ? -1 : 1));
      return {
        project: toProject(rec),
        files: files.map((f) => toFile(slug, f, rec.updatedAt)),
      };
    },

    async fetchFileBytes(slug: string, relPath: string): Promise<Uint8Array> {
      const d = await db();
      const v = (await reqDone(
        d.transaction(FILES, "readonly").objectStore(FILES).get(fileKey(slug, relPath)),
      )) as FileRecord | undefined;
      if (!v) throw new Error(`local file not found: ${slug}/${relPath}`);
      return v.bytes;
    },

    async uploadFileBytes(slug, relPath, bytes) {
      const d = await db();
      const tx = d.transaction(FILES, "readwrite");
      const rec: FileRecord = { slug, path: relPath, size: bytes.length, bytes };
      tx.objectStore(FILES).put(rec, fileKey(slug, relPath));
      await txDone(tx);
      await touch(d, slug);
      return SAVE_COMMITTED;
    },

    async hasProject(slug: string): Promise<boolean> {
      return (await getRecord(slug)) !== null;
    },

    async createProject(
      name: string,
      files: NewFile[],
      opts?: { slug?: string },
    ): Promise<Project> {
      const d = await db();
      const existing = (await reqDone(
        d.transaction(PROJECTS, "readonly").objectStore(PROJECTS).getAllKeys(),
      )) as string[];
      const taken = new Set(existing);
      let slug: string;
      if (opts?.slug) {
        // Caller pins the slug (shadow fork) — use verbatim, no dedup.
        slug = opts.slug;
      } else {
        const baseSlug = slugify(name);
        slug = baseSlug;
        for (let i = 2; taken.has(slug); i++) slug = `${baseSlug}-${i}`;
      }

      const ts = nowIso();
      const rec: ProjectRecord = { slug, name, createdAt: ts, updatedAt: ts };
      const tx = d.transaction([PROJECTS, FILES], "readwrite");
      tx.objectStore(PROJECTS).put(rec, slug);
      const fos = tx.objectStore(FILES);
      for (const f of files) {
        fos.put(
          { slug, path: f.path, size: f.bytes.length, bytes: f.bytes } satisfies FileRecord,
          fileKey(slug, f.path),
        );
      }
      await txDone(tx);
      return toProject(rec);
    },

    async deleteProject(slug: string): Promise<void> {
      const d = await db();
      const keys = (await reqDone(
        d.transaction(FILES, "readonly").objectStore(FILES).getAllKeys(rangeFor(slug)),
      )) as string[];
      const tx = d.transaction([PROJECTS, FILES], "readwrite");
      tx.objectStore(PROJECTS).delete(slug);
      const fos = tx.objectStore(FILES);
      for (const k of keys) fos.delete(k);
      await txDone(tx);
    },

    async renameProject(slug: string, name: string): Promise<void> {
      const d = await db();
      const rec = await getRecord(slug);
      if (!rec) throw new Error(`local project not found: ${slug}`);
      const tx = d.transaction(PROJECTS, "readwrite");
      tx.objectStore(PROJECTS).put({ ...rec, name, updatedAt: nowIso() }, slug);
      await txDone(tx);
    },

    async readFiles(slug: string): Promise<NewFile[]> {
      const d = await db();
      const files = (await reqDone(
        d.transaction(FILES, "readonly").objectStore(FILES).getAll(rangeFor(slug)),
      )) as FileRecord[];
      files.sort((a, b) => (a.path < b.path ? -1 : 1));
      return files.map((f) => ({ path: f.path, bytes: f.bytes }));
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
