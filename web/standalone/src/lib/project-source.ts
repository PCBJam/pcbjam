import {
  DEMO_SCOPE,
  docToFile,
  isYdocResponse,
  type Project,
  type ProjectFile,
  type ProjectWithFiles,
  YDOC_CONTENT_TYPE,
  ydocUpdateToKicadDoc,
} from "@pcbjam/shared";
import {
  API_BASE_URL,
  LOCAL_PROJECTS_ENABLED,
  PROJECT_MANIFEST_URL,
  PROJECT_SOURCE_KIND,
  currentScope,
} from "./config";
import { client } from "./contract-client";
import { idbProjectStore, type LocalProjectStore } from "./idb-project-store";
import {
  fileCacheValidator,
  isYdocValidator,
  pruneProjectFileCache,
  readCachedFileBytes,
  writeCachedFileBytes,
} from "./project-file-cache";
import {
  SOURCE_DESCRIPTORS,
  type SourceDescriptor,
  deterministicUuid,
} from "./project-source-shared";

/**
 * Where the standalone gets its PROJECTS. Every source implements this one
 * interface (so they're swappable) and self-describes via `descriptor`:
 *   - remote   → REST backend over the @pcbjam/shared contract (remote-rw).
 *   - static   → read-only example gallery from a CDN, no backend (remote-ro);
 *                Save downloads to local (`uploadFileBytes` absent).
 *   - local    → this browser's IndexedDB (idb-project-store.ts), writable.
 * The configured PROJECT_SOURCE_KIND picks the remote/gallery source; when
 * LOCAL_PROJECTS_ENABLED, the local IDB store is layered on top (a composite
 * that routes per slug) so loaded folders + saved work coexist with the gallery.
 * See docs/features/demo-deploy/.
 */
export interface ProjectSource {
  /** What this source is + whether saves persist (surfaced in the UI). */
  readonly descriptor: SourceDescriptor;
  /** No write-back target — the editor should download saves to local. */
  readonly readOnly: boolean;
  listProjects(): Promise<Project[]>;
  getProject(slug: string): Promise<ProjectWithFiles>;
  /**
   * `meta` is the file's row from the CURRENT project listing, when the caller
   * has one. It lets a source serve the bytes from its local body cache when
   * the listed version vouches for them (project-file-cache.ts); without it
   * every call is a plain fetch. Purely an optimization — callers may omit it.
   */
  fetchFileBytes(
    slug: string,
    relPath: string,
    meta?: ProjectFile,
  ): Promise<Uint8Array>;
  /** Present only on writable sources; absent ⇒ read-only (download on save). */
  uploadFileBytes?(
    slug: string,
    relPath: string,
    bytes: Uint8Array,
  ): Promise<void>;
}

// --- remote (REST backend over the shared contract) ---------------------------

function encodePath(relPath: string): string {
  return relPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function remoteProjectSource(): ProjectSource {
  // The active scope is the URL's first segment (config.currentScope), read at
  // call time so a single source instance serves whatever scope is open.
  const projectsBase = () =>
    `${API_BASE_URL}/api/scopes/${encodeURIComponent(currentScope())}/projects`;
  const fileUrl = (slug: string, relPath: string) =>
    `${projectsBase()}/${encodeURIComponent(slug)}/files/${encodePath(relPath)}`;
  return {
    descriptor: SOURCE_DESCRIPTORS["remote-rw"],
    readOnly: false,
    async listProjects() {
      const res = await client.listProjects({ params: { scope: currentScope() } });
      if (res.status !== 200) throw new Error("failed to list projects");
      return res.body;
    },
    async getProject(slug) {
      const res = await client.getProject({
        params: { scope: currentScope(), project: slug },
      });
      if (res.status === 404) throw new Error("project not found");
      if (res.status !== 200) throw new Error("failed to load project");
      // Fresh listing = fresh cache truth: drop cached bodies this listing no
      // longer vouches for (deleted paths, superseded revisions). Best-effort.
      const valid = new Map<string, string>();
      for (const f of res.body.files) {
        const v = fileCacheValidator(f);
        if (v) valid.set(f.path, v);
      }
      void pruneProjectFileCache(res.body.project.id, valid);
      return res.body;
    },
    async fetchFileBytes(slug, relPath, meta) {
      // Serve from the browser-local body cache when the listing's version
      // vouches for it — a warm load then fetches only files that changed.
      const validator = meta ? fileCacheValidator(meta) : null;
      if (validator && meta) {
        const hit = await readCachedFileBytes(meta.projectId, relPath, validator);
        if (hit) return hit;
      }
      // credentials: session-cookie auth (see contract-client.ts). The static
      // gallery fetches below stay credential-less — a CDN's wildcard CORS
      // rejects credentialed requests.
      //
      // Accept a ydoc (backend-wire.ts): for a file whose collab room has been
      // opened, the backend would otherwise re-derive the KiCad text on EVERY
      // download — a Y -> KicadDoc traversal plus an s-expr build that measured
      // ~2.0 s on a ~2300-item board and exceeded the Workers CPU limit in
      // production. We hold the same converters, so we ask for the raw update
      // and do it here, where CPU is free. A backend that doesn't negotiate
      // simply answers with text and the branch below never fires.
      const res = await fetch(fileUrl(slug, relPath), {
        credentials: "include",
        headers: { accept: `${YDOC_CONTENT_TYPE}, */*` },
      });
      if (!res.ok) throw new Error(`download failed (${res.status}): ${relPath}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A converted ydoc body may be cached ONLY under the ydoc-form validator
      // (blob fingerprint) — never under `revision:updatedAt`, whose row does
      // not move with collab edits. This re-guards the listing's hasYdoc: a
      // room created between listing and fetch answers as ydoc while the
      // validator is still the revision form, and stays uncached.
      const cacheYdocBody =
        validator !== null && meta !== undefined && isYdocValidator(validator);
      if (!isYdocResponse(res)) {
        // Plain body: correct for either validator form — for a ydoc-form one
        // this is the server-materialized fallback of the same cold blob.
        if (validator && meta) {
          void writeCachedFileBytes(meta.projectId, relPath, validator, bytes);
        }
        return bytes;
      }
      try {
        const text = new TextEncoder().encode(
          docToFile(ydocUpdateToKicadDoc(bytes)),
        );
        // Cache the CONVERTED text: a warm load skips the download and the
        // (measured ~2s on big boards) ydoc→s-expr conversion both.
        if (cacheYdocBody && validator && meta) {
          void writeCachedFileBytes(meta.projectId, relPath, validator, text);
        }
        return text;
      } catch (err) {
        // A ydoc we can't convert must not make the file undownloadable: retry
        // without negotiating and let the backend materialize it as before.
        const plain = await fetch(fileUrl(slug, relPath), { credentials: "include" });
        if (!plain.ok) {
          throw new Error(`download failed (${plain.status}): ${relPath} (${String(err)})`);
        }
        const materialized = new Uint8Array(await plain.arrayBuffer());
        // Caching the fallback under the blob tag ends the double-fetch for
        // stale unconvertible ydocs — one per tag instead of two per load.
        if (cacheYdocBody && validator && meta && !isYdocResponse(plain)) {
          void writeCachedFileBytes(meta.projectId, relPath, validator, materialized);
        }
        return materialized;
      }
    },
    async uploadFileBytes(slug, relPath, bytes) {
      const name = relPath.split("/").pop() ?? relPath;
      const form = new FormData();
      // The form FIELD NAME carries the project-relative path (upsert by
      // (project, path)) — same convention as the management app's folder upload.
      form.append(relPath, new File([bytes as BlobPart], name));
      const res = await fetch(`${projectsBase()}/${encodeURIComponent(slug)}/files`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) throw new Error(`upload failed (${res.status}): ${relPath}`);
    },
  };
}

// --- static (read-only gallery: manifest + file bytes on a CDN) ---------------

interface StaticManifestFile {
  path: string;
  size?: number;
}
interface StaticManifestProject {
  slug: string;
  name: string;
  description?: string;
  files: StaticManifestFile[];
}
interface StaticManifest {
  schema: number;
  tag: string;
  builtAt?: string;
  projects: StaticManifestProject[];
}

function contentTypeFor(path: string): string {
  if (/\.(kicad_\w+|net|csv|pos|drl|gbr)$/i.test(path))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function staticProjectSource(manifestUrl: string): ProjectSource {
  // Directory that holds the manifest — file bytes live at <dir>/<slug>/<path>.
  const baseDir = manifestUrl.replace(/\/[^/]*$/, "");
  let manifestP: Promise<StaticManifest> | null = null;
  const load = () =>
    (manifestP ??= (async () => {
      const res = await fetch(manifestUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`gallery manifest ${res.status}: ${manifestUrl}`);
      return (await res.json()) as StaticManifest;
    })());

  const toProject = (p: StaticManifestProject, ts: string): Project => ({
    id: deterministicUuid(`project:${p.slug}`),
    // The curated gallery lives under the reserved `demo` scope.
    scope: DEMO_SCOPE,
    slug: p.slug,
    name: p.name,
    createdAt: ts,
    updatedAt: ts,
  });
  const toFile = (
    p: StaticManifestProject,
    f: StaticManifestFile,
    ts: string,
  ): ProjectFile => ({
    id: deterministicUuid(`file:${p.slug}/${f.path}`),
    projectId: deterministicUuid(`project:${p.slug}`),
    path: f.path,
    size: f.size ?? 0,
    contentType: contentTypeFor(f.path),
    createdAt: ts,
    updatedAt: ts,
  });

  const find = async (slug: string) => {
    const m = await load();
    const p = m.projects.find((x) => x.slug === slug);
    if (!p) throw new Error(`project not found: ${slug}`);
    return { m, p };
  };

  return {
    descriptor: SOURCE_DESCRIPTORS["remote-ro"],
    readOnly: true,
    async listProjects() {
      const m = await load();
      const ts = m.builtAt ?? new Date(0).toISOString();
      return m.projects.map((p) => toProject(p, ts));
    },
    async getProject(slug) {
      const { m, p } = await find(slug);
      const ts = m.builtAt ?? new Date(0).toISOString();
      return { project: toProject(p, ts), files: p.files.map((f) => toFile(p, f, ts)) };
    },
    async fetchFileBytes(slug, relPath) {
      const url = `${baseDir}/${encodeURIComponent(slug)}/${encodePath(relPath)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (${res.status}): ${relPath}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    // No uploadFileBytes ⇒ read-only; the editor downloads saves to local.
  };
}

// --- composite (local IDB layered over a remote/gallery source) ---------------

/**
 * Routes each call to the LOCAL store or the REMOTE/gallery `primary` by which
 * one owns the slug, so browser-saved projects and the read-only gallery share
 * one `/p/:slug` namespace. A locally-stored slug always wins (local list is
 * deduped). `descriptorFor(slug)` answers which kind a given project is, for the
 * UI; reads/writes fall through to `primary` for anything not in IDB.
 */
function compositeProjectSource(
  local: LocalProjectStore,
  primary: ProjectSource,
): ProjectSource {
  const route = async (slug: string): Promise<ProjectSource> =>
    (await local.hasProject(slug)) ? local : primary;
  return {
    descriptor: local.descriptor,
    readOnly: false,
    async listProjects() {
      const [a, b] = await Promise.all([
        local.listProjects(),
        primary.listProjects().catch(() => [] as Project[]),
      ]);
      const localSlugs = new Set(a.map((p) => p.slug));
      return [...a, ...b.filter((p) => !localSlugs.has(p.slug))];
    },
    getProject: (slug) => route(slug).then((s) => s.getProject(slug)),
    fetchFileBytes: (slug, p, meta) =>
      route(slug).then((s) => s.fetchFileBytes(slug, p, meta)),
    uploadFileBytes: async (slug, p, bytes) => {
      const s = await route(slug);
      if (s.uploadFileBytes) return s.uploadFileBytes(slug, p, bytes);
      // Read-only gallery project being edited → download (api.ts also guards).
      throw new ReadOnlyProjectError(slug);
    },
  };
}

/** Thrown by a composite write to a read-only project; api.ts maps it to a
 *  browser download (the gallery's save-to-local behavior). */
export class ReadOnlyProjectError extends Error {
  constructor(slug: string) {
    super(`project is read-only: ${slug}`);
    this.name = "ReadOnlyProjectError";
  }
}

// --- selection ----------------------------------------------------------------

let cachedPrimary: ProjectSource | null = null;
let cachedLocal: LocalProjectStore | null = null;
let cachedActive: ProjectSource | null = null;

function primarySource(): ProjectSource {
  if (cachedPrimary) return cachedPrimary;
  cachedPrimary =
    PROJECT_SOURCE_KIND === "static" && PROJECT_MANIFEST_URL
      ? staticProjectSource(PROJECT_MANIFEST_URL)
      : remoteProjectSource();
  return cachedPrimary;
}

/**
 * The browser-local IDB project store, when enabled for this deployment
 * (LOCAL_PROJECTS_ENABLED) — used by the home page to import folders + manage
 * saved projects. `null` when the feature is off (then loaded folders use the
 * in-page File System Access flow instead).
 */
export function localProjectStore(): LocalProjectStore | null {
  if (!LOCAL_PROJECTS_ENABLED) return null;
  return (cachedLocal ??= idbProjectStore());
}

/** The active project source for this deployment (memoized). When the local IDB
 *  store is enabled it's a composite over the configured remote/gallery source. */
export function projectSource(): ProjectSource {
  if (cachedActive) return cachedActive;
  const local = localProjectStore();
  cachedActive = local
    ? compositeProjectSource(local, primarySource())
    : primarySource();
  return cachedActive;
}

/** The configured remote/gallery list only (excludes browser-local projects) —
 *  the home page shows local + gallery as separate, clearly-labeled sections. */
export function listPrimaryProjects(): Promise<Project[]> {
  return primarySource().listProjects();
}

/** Which source kind owns `slug` — for showing/describing it in the UI. */
export async function descriptorForSlug(slug: string): Promise<SourceDescriptor> {
  const local = localProjectStore();
  if (local && (await local.hasProject(slug))) return local.descriptor;
  return primarySource().descriptor;
}
