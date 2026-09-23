import { isWorkingCopyId, type WorkingCopyRef } from "@pcbjam/shared";

/**
 * The working copy this editor session is bound to (git-integration 0004,
 * R-§2): one tab = one copy, fixed at boot. The management app fills the
 * `?copy=<uuid>` URL parameter in from the user's remembered selection; the
 * boot payload then answers with the resolved copy (`copy`) and, when the
 * caller may pick, every selectable copy (`copies`).
 *
 * Two distinct facts live here:
 *  - {@link currentCopyId} — what the URL ASKS for. Sent as `copy=` on every
 *    project API call of the session (the backend resolves it; absent ⇒ the
 *    caller's selection or the default copy).
 *  - {@link copySegment} — the IDENTITY segment the backend answered with:
 *    null for the default copy (whose rooms, caches and storage keys are the
 *    legacy project identity), the copy id otherwise. Every room id and
 *    per-copy cache key derives from this, never from the URL.
 *
 * A backend without working copies (the GPL example backend) sends no `copy`;
 * everything then behaves as on the default copy.
 */

/** `?copy=<uuid>` from the URL; null when absent or malformed. */
export function currentCopyId(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("copy");
  return isWorkingCopyId(raw) ? raw : null;
}

interface CopyContext {
  ref: WorkingCopyRef | null;
  copies: WorkingCopyRef[];
}

let ctx: CopyContext = { ref: null, copies: [] };

/** Bind the session to the boot payload's copy (null ⇒ a backend without copies). */
export function setCopyContext(
  boot: { copy?: WorkingCopyRef; copies?: WorkingCopyRef[] } | null,
): void {
  ctx = { ref: boot?.copy ?? null, copies: boot?.copies ?? [] };
}

/** The bound copy as the backend described it; null on copy-less backends. */
export function currentCopyRef(): WorkingCopyRef | null {
  return ctx.ref;
}

/** Room-id / cache-key segment: null for the default copy (legacy identity). */
export function copySegment(): string | null {
  return ctx.ref && !ctx.ref.isDefault ? ctx.ref.id : null;
}

/** The generation every gateway `sub` presents (undefined ⇒ pre-generation backend). */
export function copyGeneration(): number | undefined {
  return ctx.ref?.generation;
}

/** Display label for a copy id (the popover's "written on …"). */
export function copyLabel(id: string): string {
  const hit = ctx.copies.find((c) => c.id === id) ?? (ctx.ref?.id === id ? ctx.ref : null);
  return hit?.label ?? id.slice(0, 8);
}

/**
 * The copy id every project API call of this session names (`copy=`): the
 * BOUND copy once boot answered (so a tab stays on the copy it opened on
 * even if the user's remembered selection changes elsewhere — R-§2), the
 * URL's request before that, nothing on a copy-less backend.
 */
export function sessionCopyId(): string | null {
  return ctx.ref?.id ?? currentCopyId();
}

/** Append the session's `copy=` (see {@link sessionCopyId}) to a project API URL. */
export function withCopyParam(url: string): string {
  const copy = sessionCopyId();
  if (!copy) return url;
  const u = new URL(url, "http://placeholder.invalid");
  if (u.searchParams.has("copy")) return url;
  u.searchParams.set("copy", copy);
  // Keep the caller's absolute/relative shape: only the query changed.
  return url.startsWith("http") ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

/**
 * Per-copy key for the browser-local caches shared across tabs (the
 * IndexedDB body cache): a non-default copy's bodies never alias the
 * default's. The default copy keeps the legacy `projectId` key.
 */
export function fileCacheProjectKey(projectId: string): string {
  const seg = copySegment();
  return seg ? `${projectId}:${seg}` : projectId;
}

/** The project-sync IDB namespace (kicad-runner): per copy for the same reason. */
export function projectSyncNamespace(
  scopeId: string,
  projectId: string,
  copyId: string | null | undefined,
): string {
  return copyId
    ? `project:${scopeId}:${projectId}:${copyId}`
    : `project:${scopeId}:${projectId}`;
}
