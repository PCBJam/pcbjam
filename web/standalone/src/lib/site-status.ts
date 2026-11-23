import {
  MAINTENANCE_CLOSE_CODE,
  buildNumberAt,
  createSiteStatusClient,
  formatBuildHeader,
  installBuildHeader,
  siteViewBlocks,
  type BuildStamp,
  type SiteStatusClient,
} from "@pcbjam/shared/site-status";
import { API_BASE_URL, APP_GIT_SHA } from "@/lib/config";

/**
 * pcbjam-private admin 0009: this editor build and its view of the
 * maintenance window / minimum build. {@link startSiteStatus} runs once at
 * boot, before anything fetches: every API request then carries
 * `x-pcbjam-build`, every sync socket `?build=`, and the status client follows
 * the server's `x-pcbjam-status` hash. A backend without the feature ignores
 * all of it (no /api/status ⇒ the view stays "ok").
 */
const fromEnv = Number(import.meta.env.VITE_BUILD_NUMBER);

export const BUILD_STAMP: BuildStamp = {
  client: "editor",
  build: Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : buildNumberAt(new Date()),
  sha: APP_GIT_SHA && /^[0-9a-f]{7,}$/i.test(APP_GIT_SHA) ? APP_GIT_SHA.slice(0, 12) : null,
};

export const siteStatus: SiteStatusClient = createSiteStatusClient({
  apiBase: API_BASE_URL,
  stamp: BUILD_STAMP,
});

let started = false;

export function startSiteStatus(): void {
  if (started) return;
  started = true;
  installBuildHeader({ apiBase: API_BASE_URL, stamp: BUILD_STAMP, client: siteStatus });
  siteStatus.subscribe(releaseWaiters);
  siteStatus.start();
}

/** Set from a 4503 close until the status read it triggered has answered. */
let maintenanceHold = false;
const waiters = new Set<() => void>();

function releaseWaiters(): void {
  if (syncHeld()) return;
  const ready = [...waiters];
  waiters.clear();
  for (const fn of ready) fn();
}

/**
 * Sync sockets stay down while this tab is blocked: the maintenance screen
 * (not for admins) or the reload screen. Reconnecting then would only be
 * refused at the handshake, over and over.
 */
export function syncHeld(): boolean {
  return maintenanceHold || siteViewBlocks(siteStatus.getView());
}

/** Run `fn` once sync sockets may connect again (now, if they may). Returns a cancel. */
export function whenSyncAllowed(fn: () => void): () => void {
  if (!syncHeld()) {
    fn();
    return () => undefined;
  }
  waiters.add(fn);
  return () => void waiters.delete(fn);
}

/** The `build` value a sync socket URL carries. */
export function buildParamValue(): string {
  return formatBuildHeader(BUILD_STAMP);
}

/**
 * A sync socket closed. 4503 is a maintenance window; any other close may be
 * a refused handshake (the window, or a build below the minimum), so ask the
 * server (throttled inside the client).
 */
export function noteSyncSocketClose(code: number | undefined): void {
  if (!started) return;
  if (code === MAINTENANCE_CLOSE_CODE) {
    // Hold reconnects until the server says whether this tab is shut out.
    maintenanceHold = true;
    void siteStatus.refresh().finally(() => {
      maintenanceHold = false;
      releaseWaiters();
    });
  } else siteStatus.noteSocketTrouble();
}
