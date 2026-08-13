import type { KicadDocSession } from "./index";

/** Destroy both halves of a provider-connected document session. */
export function destroyKicadDocSession(session: KicadDocSession): void {
  // A provider teardown must not be able to strand the Y.Doc. Callers which
  // own a raw (not-yet-attached) session use this as their single retirement
  // operation.
  try {
    session.provider.destroy();
  } finally {
    session.doc.destroy();
  }
}

/**
 * Exclusive owner for a pre-connected session while the editor is still
 * opening. `release()` is the one ownership handoff to a binding/manager.
 * Once destroyed, a session which arrives late is retired immediately.
 */
export function createKicadDocSessionOwner(): {
  adopt(session: KicadDocSession): boolean;
  release(session: KicadDocSession): KicadDocSession | undefined;
  destroy(): void;
} {
  let live = true;
  let owned: KicadDocSession | undefined;

  return {
    adopt(session) {
      if (!live) {
        destroyKicadDocSession(session);
        return false;
      }
      if (owned) {
        // This owner represents one document-open generation. Retire an
        // unexpected second result before surfacing the invariant failure.
        destroyKicadDocSession(session);
        throw new Error("document session owner already holds a session");
      }
      owned = session;
      return true;
    },
    release(session) {
      if (!live || owned !== session) return undefined;
      live = false;
      owned = undefined;
      return session;
    },
    destroy() {
      if (!live) return;
      live = false;
      const session = owned;
      owned = undefined;
      if (session) destroyKicadDocSession(session);
    },
  };
}
