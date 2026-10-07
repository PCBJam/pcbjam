/**
 * Process airlock — standalone-hardening 0009.
 *
 * The editor is cross-origin isolated (COOP+COEP). Firefox keeps ONE content
 * process per site for such pages and a reload, `location.replace` or a new tab
 * all land back in it, so after an out-of-memory the editor restarts inside the
 * same exhausted process. `/recover` is a static page served WITHOUT COOP/COEP
 * (see deploy/demo/_headers): navigating there moves the tab to a normal
 * process, the isolated one exits once no isolated pcbjam page is left, and the
 * airlock then sends the tab back to a fresh process.
 *
 * Pure helpers shared by oom-watch (the way in) and recover-page (the way out).
 */

export const AIRLOCK_PATH = "/recover";

/** Firefox removed the isolated process ~7 s after its last tab left (manual
 *  `about:processes` check, 10/2026); 10 s leaves margin. Other browsers don't
 *  share the process the same way, so a short pause is enough. */
export const AIRLOCK_WAIT_FIREFOX_MS = 10_000;
export const AIRLOCK_WAIT_OTHER_MS = 2_000;

/** The airlock URL that returns to `editorHref` (same-origin path kept). */
export function airlockUrl(editorHref: string): string {
  const u = new URL(editorHref);
  const back = `${u.pathname}${u.search}${u.hash}`;
  return `${u.origin}${AIRLOCK_PATH}?to=${encodeURIComponent(back)}`;
}

/**
 * The path the airlock may return to: same origin only, never the airlock
 * itself (no loop, no open redirect). Falls back to "/".
 */
export function safeReturnPath(to: string | null, origin: string): string {
  if (!to) return "/";
  let u: URL;
  try {
    u = new URL(to, origin);
  } catch {
    return "/";
  }
  if (u.origin !== origin) return "/";
  if (u.pathname === AIRLOCK_PATH || u.pathname.startsWith(`${AIRLOCK_PATH}/`) || u.pathname.startsWith(`${AIRLOCK_PATH}.`)) {
    return "/";
  }
  return `${u.pathname}${u.search}${u.hash}`;
}
