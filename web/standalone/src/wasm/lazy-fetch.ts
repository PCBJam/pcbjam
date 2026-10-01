import { decodeFolder, PROJECT_FILE_REVISION_HEADER } from "@pcbjam/shared";

/**
 * The synchronous fetch behind a placeholder folder (lazy-dirs.ts): the fill
 * runs inside a filesystem call KiCad made, which cannot wait for a promise,
 * so this is a blocking XMLHttpRequest — one request for the whole folder
 * (`…/sync/folder`; the wire format is `decodeFolder` in @pcbjam/shared
 * sync-wire.ts, shared with the backend), and one per file for what that response left out or
 * when the backend has no such route. Binary bodies come through the
 * `x-user-defined` charset (a synchronous request cannot ask for an
 * ArrayBuffer on the main thread).
 */

export interface SyncFolderFetchOptions {
  /** `…/projects/<slug>/sync/folder` (the session's `copy=` already applied by `withParams`). */
  folderUrl: string;
  /** The per-file download URL of a project-relative path. */
  fileUrl: (relPath: string) => string;
  /** Adds the session's query parameters (working copy) to a URL. */
  withParams: (url: string) => string;
  /** The listing revision of each fetched row, for the save path's ancestry. */
  onRevision?: (relPath: string, revision: number) => void;
  log: (msg: string) => void;
  /** Test seam. */
  request?: (url: string) => { status: number; body: Uint8Array; header(name: string): string | null };
}

function blockingGet(url: string): { status: number; body: Uint8Array; header(name: string): string | null } {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.withCredentials = true;
  xhr.overrideMimeType("text/plain; charset=x-user-defined");
  xhr.send();
  const text = xhr.status >= 200 && xhr.status < 300 ? xhr.responseText : "";
  const body = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) body[i] = text.charCodeAt(i) & 0xff;
  return { status: xhr.status, body, header: (name) => xhr.getResponseHeader(name) };
}

export function makeSyncFolderFetch(
  opts: SyncFolderFetchOptions,
): (dir: string, paths: string[]) => Array<[string, Uint8Array]> {
  const get = opts.request ?? blockingGet;
  const one = (relPath: string): [string, Uint8Array] | null => {
    const res = get(opts.fileUrl(relPath));
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`download failed (${res.status}): ${relPath}`);
    const revision = Number(res.header(PROJECT_FILE_REVISION_HEADER));
    if (Number.isSafeInteger(revision) && revision > 0) opts.onRevision?.(relPath, revision);
    return [relPath, res.body];
  };
  return (dir, paths) => {
    const want = new Set(paths);
    const out: Array<[string, Uint8Array]> = [];
    const sep = opts.folderUrl.includes("?") ? "&" : "?";
    const res = get(opts.withParams(`${opts.folderUrl}${sep}dir=${encodeURIComponent(dir)}`));
    if (res.status >= 200 && res.status < 300) {
      const { files, revisions } = decodeFolder(res.body);
      for (const [path, body] of files) {
        if (!want.delete(path)) continue;
        const revision = revisions[path] ?? 0;
        if (revision > 0) opts.onRevision?.(path, revision);
        out.push([path, body]);
      }
    } else if (res.status !== 404) {
      throw new Error(`folder download failed (${res.status}): ${dir || "/"}`);
    } else {
      opts.log(`[lazy] no folder route on this backend — loading ${want.size} file(s) one by one`);
    }
    // Left out by the response's size cap, or a backend without the route.
    for (const path of want) {
      const got = one(path);
      if (got) out.push(got);
    }
    return out;
  };
}
