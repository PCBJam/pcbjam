import type {
  DriftReportBody,
  Project,
  ProjectFile,
  ProjectWithFiles,
} from "@pcbjam/shared";
import { useQuery } from "@tanstack/react-query";
import {
  API_BASE_URL,
  currentScope,
  libsSourceConfig,
  PROJECT_SOURCE_KIND,
} from "./config";
import { fetchBootPayload, type BootPayload } from "./boot-payload";
import { client } from "./contract-client";
import type { LibInfo } from "@/wasm/libs/source";
import { downloadBytes } from "./download";
import {
  ReadOnlyProjectError,
  descriptorForSlug,
  listPrimaryProjects,
  localProjectStore,
  projectSource,
} from "./project-source";
import type { SourceDescriptor } from "./project-source-shared";
import { SAVE_COMMITTED, type SaveOutcome } from "../wasm/save-flow";

/**
 * Project/file reads go through the active PROJECT SOURCE (lib/project-source.ts):
 * the @pcbjam/shared REST backend, the read-only static gallery (demo mode), or
 * the browser-local IndexedDB store — composited per slug. Libraries + collab
 * drift reporting are backend-only and stay on the contract client here.
 */

/** Remote/gallery projects (excludes browser-local ones — those have their own
 *  hook so the home page can list + manage them as a distinct section). */
export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => listPrimaryProjects(),
  });
}

/** Browser-local (IndexedDB) projects; empty when the local store is disabled. */
export function useLocalProjects() {
  return useQuery({
    queryKey: ["local-projects"],
    queryFn: (): Promise<Project[]> =>
      localProjectStore()?.listProjects() ?? Promise.resolve([]),
  });
}

/** The source kind that owns `slug` (local / remote-ro / remote-rw) — for the
 *  "where your edits go" chip on the project + editor views. */
export function useSourceDescriptor(slug: string) {
  return useQuery({
    queryKey: ["source-descriptor", slug],
    queryFn: (): Promise<SourceDescriptor> => descriptorForSlug(slug),
    enabled: !!slug,
  });
}

/**
 * Libraries the editor can browse, optionally filtered to a kind — sourced from
 * the ACTIVE libs source (lib/config `libsSourceConfig`), not the REST backend
 * directly. So the demo's read-only CDN/R2 set (VITE_LIBS_SOURCE=cdn) lists here
 * the same as a backend's libs would; "off" ⇒ none. Each lib deep-links to
 * /l/<id>/<tool> (LibToolPage), which boots the editor scoped to that one lib.
 */
export function useLibs(kind?: "symbol" | "footprint") {
  return useQuery({
    queryKey: ["libs", kind ?? "all"],
    queryFn: async (): Promise<LibInfo[]> => {
      const source = libsSourceConfig();
      return source ? source.listLibs(kind) : [];
    },
  });
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: ["project", slug],
    queryFn: () => projectSource().getProject(slug),
  });
}

/**
 * The tool page's project query, boot-endpoint first (load-path-rework 0001
 * §6): remote deployments try the ONE composed boot round-trip — its project
 * half is exactly the getProject shape, and the extras (identity, libs,
 * stacks, project sync digest) ride along for WasmTool. Any miss (older
 * backend, a local-store slug answering 404, the static gallery) falls back
 * to the active source's getProject with `boot: null`, which is exactly the
 * pre-boot behavior everywhere downstream.
 */
export function useProjectBoot(slug: string) {
  return useQuery({
    queryKey: ["project-boot", slug],
    queryFn: async (): Promise<{
      data: ProjectWithFiles & { access?: "read" | "write" };
      boot: BootPayload | null;
    }> => {
      if (PROJECT_SOURCE_KIND !== "static") {
        const boot = await fetchBootPayload(currentScope(), slug);
        if (boot) return { data: boot, boot };
      }
      return { data: await projectSource().getProject(slug), boot: null };
    },
  });
}

/**
 * File bytes from the active source (backend stream, or the static CDN
 * gallery). Pass the file's row from the current listing as `meta` when you
 * have it — it lets the remote source answer from its local body cache when
 * the listed version vouches for the bytes (project-file-cache.ts).
 */
export function fetchFileBytes(
  slug: string,
  relPath: string,
  meta?: ProjectFile,
): Promise<Uint8Array> {
  return projectSource().fetchFileBytes(slug, relPath, meta);
}

/**
 * Persist a saved file. A writable source (the backend) uploads it; a read-only
 * source (the static demo gallery) has no upload target, so the save downloads
 * to the user's machine instead. The remote-vs-static choice is config-driven
 * (the active project source), so callers just call this.
 */
export async function uploadFileBytes(
  slug: string,
  relPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<SaveOutcome> {
  const source = projectSource();
  if (!source.uploadFileBytes) {
    downloadBytes(relPath, bytes);
    return SAVE_COMMITTED;
  }
  try {
    return await source.uploadFileBytes(slug, relPath, bytes, signal);
  } catch (e) {
    // Composite write to a read-only (gallery) project → fall back to download.
    if (e instanceof ReadOnlyProjectError) {
      downloadBytes(relPath, bytes);
      return SAVE_COMMITTED;
    }
    throw e;
  }
}

/**
 * Record a file's CAS ancestry when its bytes were staged WITHOUT going through
 * `fetchFileBytes` (project sync namespace bundle). See
 * ProjectSource.rememberBaseRevision.
 */
export function rememberFileBaseRevision(
  slug: string,
  relPath: string,
  revision: number,
): void {
  projectSource().rememberBaseRevision?.(slug, relPath, revision);
}

/** Observe the server revision after an ambiguous save; never rebases this model. */
export async function refreshFileRevision(
  slug: string,
  relPath: string,
): Promise<void> {
  await projectSource().refreshFileRevision?.(slug, relPath);
}

/**
 * Create a project file that a tool switch found missing (WasmTool's nav
 * hook): write `bytes` at `relPath` unless the file already exists on the
 * source — the hook's file list is a mount-time snapshot, and a collaborator
 * may have created the file since (never clobber it with an empty template).
 * Unlike `uploadFileBytes` there is deliberately NO download fallback: a
 * read-only source rejects (uploader absent, or the composite's per-slug
 * ReadOnlyProjectError) and the caller keeps the editor where it is.
 */
export async function createProjectFileIfMissing(
  slug: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const source = projectSource();
  if (!source.uploadFileBytes) throw new ReadOnlyProjectError(slug);
  const { files } = await source.getProject(slug);
  if (files.some((file) => file.path === relPath)) return;
  const outcome = await source.uploadFileBytes(slug, relPath, bytes);
  if (outcome.kind !== "committed") {
    throw new Error(outcome.message ?? `file creation did not commit: ${relPath}`);
  }
}

// --- collaboration drift reporting (ysync; backend-only) ---

/**
 * Report a detected ydoc/wasm drift (the editor's periodic, every-N-edits check).
 * Best-effort: a failed report must never disrupt editing, so callers ignore
 * rejections.
 */
export async function reportDrift(
  slug: string,
  body: DriftReportBody,
): Promise<void> {
  await client.reportDrift({
    params: { scope: currentScope(), project: slug },
    body,
  });
}

/**
 * Fire-and-forget drift report that survives the page closing — used by the
 * session-end (`beforeunload`) check. `sendBeacon` queues the POST past unload;
 * a keepalive `fetch` is the fallback when the beacon is rejected (too large).
 */
export function reportDriftBeacon(slug: string, body: DriftReportBody): void {
  const url = `${API_BASE_URL}/api/scopes/${encodeURIComponent(currentScope())}/projects/${encodeURIComponent(slug)}/drift`;
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  try {
    if (navigator.sendBeacon(url, blob)) return;
  } catch {
    /* fall through to keepalive fetch */
  }
  // credentials: parity with the beacon path (beacons carry same-site cookies).
  void fetch(url, {
    method: "POST",
    body: blob,
    keepalive: true,
    credentials: "include",
  }).catch(() => {});
}
