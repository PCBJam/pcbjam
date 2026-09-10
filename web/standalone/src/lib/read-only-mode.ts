/**
 * Read-only session resolution (read-only-viewer).
 *
 * A read-only session runs the editor as a pure viewer: chrome force-hidden,
 * no presence/comments/drift, no save upload, the collab binding never seeds
 * or pushes local edits, and the wasm frame is locked via kicadSetReadOnly
 * (zoom/pan only). The signal is server-authoritative — the project GET's
 * `access` capability field ("read" for callers without write access) — with
 * a `?readonly=1` URL override for tests and authz-free GPL deployments
 * (house `?mobile=` pattern). There is deliberately no `?readonly=0`: a URL
 * parameter must never widen a server-granted capability, and the real
 * enforcement lives in the sync server + wasm gates anyway.
 */

import type { ProjectAccess } from "@pcbjam/shared";

/** The window surface resolveReadOnly reads — narrow, so tests can fake it. */
export interface ReadOnlyWindow {
  location: { search: string };
}

export function resolveReadOnly(
  access: ProjectAccess | undefined,
  win: ReadOnlyWindow = window,
): boolean {
  const param = new URLSearchParams(win.location.search).get("readonly");
  if (param === "1" || param === "true") return true;
  // Absent ⇒ write: authz-free backends never emit the field. "comment"
  // (comments-ux 0003) is a read-only session that may write comments through
  // the comment-op route — the frame/collab lock is identical to "read".
  return access !== undefined && access !== "write";
}

/**
 * Comment capability of the session (comments-ux 0003): "write" sessions
 * comment straight into the ydoc, "comment" sessions through the REST
 * comment-op route, "read" sessions only look. No URL override — a URL never
 * widens a server-granted capability.
 */
export type CommentAccess = "none" | "comment" | "write";

export function resolveCommentAccess(
  access: ProjectAccess | undefined,
  readOnly: boolean,
): CommentAccess {
  if (readOnly) return access === "comment" ? "comment" : "none";
  return "write";
}
