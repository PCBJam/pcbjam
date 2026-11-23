/**
 * pcbjam-private admin 0009: what the sync sockets (collab gateway, per-room
 * provider) need from the maintenance / minimum-build status. `lib/site-status`
 * fills these in at boot. This module imports nothing, so the collab bundles
 * the KiCad e2e harness builds from `wasm/collab` don't pull in the app's
 * config; with no hooks set (those bundles, tests) the sockets behave as before.
 */

/** Query parameter carrying the build on a sync handshake (`BUILD_QUERY_PARAM` in @pcbjam/shared/site-status). */
export const SYNC_BUILD_PARAM = "build";

export interface SyncSiteHooks {
  /** This tab's build, as the handshake carries it. */
  buildParam: string;
  /** A sync socket closed with this code. */
  noteClose(code: number | undefined): void;
  /** True while this tab is shut out: no point dialing. */
  held(): boolean;
  /** Run `fn` once dialing is allowed again; returns a cancel. */
  whenAllowed(fn: () => void): () => void;
}

let hooks: SyncSiteHooks | null = null;

export function setSyncSiteHooks(next: SyncSiteHooks): void {
  hooks = next;
}

/** The build value for a handshake URL, or null when status isn't running. */
export function syncBuildParam(): string | null {
  return hooks?.buildParam ?? null;
}

export function noteSyncSocketClose(code: number | undefined): void {
  hooks?.noteClose(code);
}

/** Sync sockets stay down while the maintenance (non-admin) or reload screen shows. */
export function syncHeld(): boolean {
  return hooks?.held() ?? false;
}

/** Run `fn` once sync sockets may connect (now, if they may). Returns a cancel. */
export function whenSyncAllowed(fn: () => void): () => void {
  if (!hooks) {
    fn();
    return () => undefined;
  }
  return hooks.whenAllowed(fn);
}
