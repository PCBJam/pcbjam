import {
  USER_HEADER,
  type ProjectWithFiles,
  type SyncManifest,
  type SyncStackDescriptor,
} from "@pcbjam/shared";
import { API_BASE_URL, userSlug } from "./config";
import { fileCacheValidator, pruneProjectFileCache } from "./project-file-cache";

/**
 * The ONE editor boot round-trip (load-path-rework 0001 §6):
 * `GET /api/scopes/:scope/projects/:project/boot` composes everything the
 * editor otherwise collects across four serial API calls — identity, the
 * project + files + access, the visible-lib DTOs, the batch-resolved sync
 * stacks, and the project sync-namespace manifest with its digest. Every
 * piece is OPTIONAL downstream: an absent payload (older backend, demo
 * gallery, local store) leaves each consumer on its individual endpoint,
 * so this can only ever remove requests, never break a boot.
 */

/** Wire lib DTO — the `GET /libs` shape, structurally (no contract import). */
export interface BootLibDto {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  itemCount?: number;
  sync?: { namespace: string; bytes: number | null } | null;
}

export interface BootPayload extends ProjectWithFiles {
  me: unknown;
  access?: "read" | "write";
  libs: BootLibDto[];
  stacks: Record<string, SyncStackDescriptor | null>;
  projectSync: { manifest: SyncManifest; digest: string };
}

/** Null on ANY failure (404 = older backend / non-boot source) — callers fall
 *  back to the individual endpoints. */
export async function fetchBootPayload(
  scope: string,
  slug: string,
): Promise<BootPayload | null> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/scopes/${encodeURIComponent(scope)}/projects/${encodeURIComponent(slug)}/boot`,
      { credentials: "include", headers: { [USER_HEADER]: userSlug() } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as BootPayload;
    if (!body?.project || !Array.isArray(body.files)) return null;
    // Fresh listing = fresh cache truth (same prune the remote source's
    // getProject performs) — the boot payload replaces that call.
    const valid = new Map<string, string>();
    for (const f of body.files) {
      const v = fileCacheValidator(f);
      if (v) valid.set(f.path, v);
    }
    void pruneProjectFileCache(body.project.id, valid);
    return body;
  } catch {
    return null;
  }
}
