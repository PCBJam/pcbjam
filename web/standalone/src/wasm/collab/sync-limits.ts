/**
 * What a collab room can carry, and the notices when the editor holds more (fonts 0001).
 *
 * A room syncs over websocket messages of at most 32 MiB: the sync worker (workerd, as on
 * Cloudflare) closes a socket that sends a bigger one. The gateway used to resend such a
 * change on every reconnect, forever, so the change never arrived and the tab stayed busy.
 * Now it refuses to send it ({@link SYNC_TOO_LARGE_EVENT}). Embedded files, the one large
 * thing an editor adds on its own, stay within EMBEDDED_FILES_ROOM_BUDGET
 * ({@link EMBEDDED_TOO_LARGE_EVENT}).
 */

/** The sync worker's websocket message limit (Cloudflare Workers: 32 MiB). */
export const GATEWAY_FRAME_LIMIT = 32 * 1024 * 1024;

/** A document's embedded files were not written to its room: past the budget. */
export const EMBEDDED_TOO_LARGE_EVENT = "pcbjam:embedded-too-large";

export interface EmbeddedTooLargeDetail {
  /** The document, as the session names it (project-relative path). */
  docPath: string;
  /** What the embedded files would have weighed in the room. */
  bytes: number;
  budget: number;
}

/** A change to a document was too large to send: its room gets nothing more from this tab. */
export const SYNC_TOO_LARGE_EVENT = "pcbjam:sync-too-large";

export interface SyncTooLargeDetail {
  docPath: string;
  bytes: number;
  limit: number;
}

function emit<T>(type: string, detail: T): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<T>(type, { detail }));
}

export function notifyEmbeddedTooLarge(detail: EmbeddedTooLargeDetail): void {
  emit(EMBEDDED_TOO_LARGE_EVENT, detail);
}

export function notifySyncTooLarge(detail: SyncTooLargeDetail): void {
  emit(SYNC_TOO_LARGE_EVENT, detail);
}

/** "58 MB", "1.5 MB" (MiB, as the limits are). */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const fileName = (docPath: string) => docPath.split("/").pop() || docPath;

export function embeddedTooLargeMessage(d: EmbeddedTooLargeDetail): string {
  const setup = d.docPath.endsWith(".kicad_pcb") ? "Board Setup" : "Schematic Setup";
  return (
    `The embedded files of ${fileName(d.docPath)} take up ${megabytes(d.bytes)}, and a shared ` +
    `document holds at most ${megabytes(d.budget)}, so they were not saved or shared. Remove ` +
    `some in ${setup} > Embedded Files.`
  );
}

export function syncTooLargeMessage(d: SyncTooLargeDetail): string {
  return (
    `A change to ${fileName(d.docPath)} is too large to sync (${megabytes(d.bytes)}; the limit ` +
    `is ${megabytes(d.limit)}), so nothing you change in it from now on is saved or shared. ` +
    `Reload the page to discard the change.`
  );
}
