/**
 * Read-only session resolution (read-only-viewer).
 *
 * A read-only session runs the editor as a pure viewer: chrome force-hidden,
 * no presence/drift, no save upload, the collab binding never seeds or pushes
 * local edits, and the wasm frame is locked via kicadSetReadOnly (zoom/pan
 * only). The signal is server-authoritative — the project GET's `access`
 * capability field ("read" for callers without write access) — with URL
 * overrides that can only NARROW it:
 *
 *   - `?mode=view`     — pure viewer (what `?readonly=1`, the older alias for
 *                        tests and authz-free GPL deployments, also means).
 *   - `?mode=comment`  — frame locked, comments still allowed: a member on a
 *                        phone who wants to review, not edit (mobile 0002).
 *   - `?mode=edit`     — "asked and answered": no narrowing. Inert on a
 *                        session the server already narrowed.
 *
 * There is deliberately no widening parameter: a URL must never widen a
 * server-granted capability, and the real enforcement lives in the sync
 * server + wasm gates anyway.
 */

import type { ProjectAccess } from "@pcbjam/shared";

/** The window surface the resolvers read — narrow, so tests can fake it. */
export interface ReadOnlyWindow {
  location: { search: string };
}

/** The live window when there is one (unit tests run in node and pass a fake). */
function defaultWin(): ReadOnlyWindow {
  return typeof window === "undefined" ? { location: { search: "" } } : window;
}

/** The client-side session shape a URL may ask for (never wider than `access`). */
export type SessionMode = "edit" | "comment" | "view";

/** The mode the URL asks for, or null when it says nothing (`?readonly=1`
 *  counts as `view`; an explicit `?mode=` wins over it). */
export function requestedMode(win: ReadOnlyWindow = defaultWin()): SessionMode | null {
  const params = new URLSearchParams(win.location.search);
  const mode = params.get("mode");
  if (mode === "view" || mode === "comment" || mode === "edit") return mode;
  const legacy = params.get("readonly");
  if (legacy === "1" || legacy === "true") return "view";
  return null;
}

export function resolveReadOnly(
  access: ProjectAccess | undefined,
  win: ReadOnlyWindow = defaultWin(),
): boolean {
  const mode = requestedMode(win);
  if (mode === "view" || mode === "comment") return true;
  // Absent ⇒ write: authz-free backends never emit the field. "comment"
  // (comments-ux 0003) is a read-only session that may write comments through
  // the comment-op route — the frame/collab lock is identical to "read".
  return access !== undefined && access !== "write";
}

/**
 * Comment capability of the session (comments-ux 0003): "write" sessions
 * comment straight into the ydoc, "comment" sessions through the REST
 * comment-op route, "read" sessions only look. A URL never widens a
 * server-granted capability; `?mode=comment` on a WRITER keeps their (already
 * granted) ydoc comment path while the frame is locked — that is a narrowing.
 */
export type CommentAccess = "none" | "comment" | "write";

export function resolveCommentAccess(
  access: ProjectAccess | undefined,
  readOnly: boolean,
  win: ReadOnlyWindow = defaultWin(),
): CommentAccess {
  if (!readOnly) return "write";
  if (access === "comment") return "comment";
  const writer = access === undefined || access === "write";
  if (writer && requestedMode(win) === "comment") return "write";
  return "none";
}

/** Can this session choose its own mode? Only a writer can be narrowed by the
 *  URL — everyone else is already at the server's ceiling. */
export function canChooseMode(access: ProjectAccess | undefined): boolean {
  return access === undefined || access === "write";
}
