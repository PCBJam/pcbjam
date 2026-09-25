import { isReadOnlyCopy, shortSha, type WorkingCopyRef } from "@pcbjam/shared";

/**
 * Repository-aware editor decisions (git-integration 0005). Every input is
 * the boot payload's optional `copy` descriptor, so a backend without Git
 * (the GPL example backend) never triggers any of this.
 */

type CopyLike = Pick<WorkingCopyRef, "kind"> &
  Partial<Pick<WorkingCopyRef, "status" | "baseCommit" | "headCommit" | "targetBranch" | "follows" | "label">>;

/** A pinned copy (Inspect / View latest) is immutable: the editor is a viewer. */
export function copyForcesReadOnly(copy: CopyLike | null | undefined): boolean {
  return isReadOnlyCopy(copy);
}

/** A copy still being checked out (or failed) must not boot an editor. */
export function copyNotReady(copy: CopyLike | null | undefined): "materializing" | "failed" | null {
  if (!copy?.status || copy.status === "ready") return null;
  return copy.status;
}

/** The ref badge text of a repository view, null for editable copies. */
export function refBadgeText(copy: CopyLike | null | undefined): string | null {
  if (!copy || !isReadOnlyCopy(copy)) return null;
  const sha = shortSha(copy.headCommit ?? copy.baseCommit);
  if (copy.follows && copy.targetBranch) return `Following ${copy.targetBranch}${sha ? ` · ${sha}` : ""}`;
  if (copy.targetBranch) return `Viewing ${copy.targetBranch}${sha ? ` · ${sha}` : ""}`;
  return `Viewing ${sha || copy.label || "revision"}`;
}

/**
 * A branch-following view advances by generation bump (0004 fence); its
 * viewers reload onto the new commit instead of seeing the "copy updated"
 * banner — they had nothing to lose.
 */
export function fenceReloadsSilently(copy: CopyLike | null | undefined): boolean {
  return !!copy && isReadOnlyCopy(copy) && copy.follows === true;
}

/** Connected projects have a base commit on their copies; only they touch. */
export function isConnectedCopy(copy: CopyLike | null | undefined): boolean {
  return !!copy?.baseCommit;
}

export const GIT_TOUCH_INTERVAL_MS = 90_000;

/**
 * Activity-driven remote checks (R-§9): touch now and then every ~90 s while
 * the document is visible; nothing while hidden or after stop. Pure
 * scheduler (injectable timers and document) so it is unit-testable.
 */
export function startGitTouchLoop(
  touch: () => Promise<unknown>,
  opts: {
    doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  } = {},
): () => void {
  const doc = opts.doc ?? document;
  const interval = opts.intervalMs ?? GIT_TOUCH_INTERVAL_MS;
  const setT = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearT = opts.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  let stopped = false;
  const fire = () => {
    if (!stopped && doc.visibilityState === "visible") void touch().catch(() => undefined);
  };
  const arm = () => {
    if (timer === null && !stopped && doc.visibilityState === "visible") {
      fire();
      timer = setT(fire, interval);
    }
  };
  const disarm = () => {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  };
  const onVis = () => (doc.visibilityState === "visible" ? arm() : disarm());
  doc.addEventListener("visibilitychange", onVis);
  arm();
  return () => {
    stopped = true;
    disarm();
    doc.removeEventListener("visibilitychange", onVis);
  };
}
