import { encodeBundle, type ScopeMirrorList } from "@pcbjam/shared";

/**
 * The scope's overlay list on the client (libs 0030): a `fetch` for the sync
 * stacks that answers an EMPTY team overlay's
 * `…/parties/sync-room/scope:<sid>/libs/mirror:<sid>:<lib>/bundle` locally,
 * instead of one request per origin library. A cold load opens every library
 * of the team's stack, and almost every overlay is empty: on staging that was
 * ~400 requests, each one creating a room core (the room allows 512).
 *
 * | the list says                 | the wrapper                                |
 * |-------------------------------|--------------------------------------------|
 * | `ns` in `mirrors`             | real request (it has content)              |
 * | `ns` in `dirty`               | real request                               |
 * | absent, and `complete`        | the empty v0 bundle, answered locally      |
 * | no list, not complete, error  | real request (the behavior before 0030)    |
 *
 * The list comes from the boot payload (`mirrors`). When boot left it out (its
 * time cap fired, or an older backend), the wrapper fetches it once, from the
 * scope room, on the first overlay bundle request; concurrent requests wait
 * for that one fetch. Only `mirror:` overlays of the room's own scope are
 * affected: `org:` and `mirror-direct:` libraries keep their own request.
 *
 * The locally answered namespace then rests on the room's registry snapshot,
 * which confirms "empty" with no manifest GET (sync-client `registrySaysEmpty`)
 * and syncs it if a teammate wrote there in the meantime.
 */

/** The boot payload's `mirrors` field. */
export interface PreloadedMirrorList extends ScopeMirrorList {
  scopeId: string;
}

const OVERLAY_BUNDLE_URL =
  /\/parties\/sync-room\/scope(?::|%3A)([^/?]+)\/libs\/([^/?]+)\/bundle(?:\?|$)/;

const EMPTY_BUNDLE = encodeBundle({ version: 0, entries: {} }, []);

interface Verdicts {
  complete: boolean;
  fetchThese: Set<string>;
}

function verdicts(list: ScopeMirrorList): Verdicts {
  return {
    complete: list.complete === true,
    fetchThese: new Set([...list.mirrors.map((m) => m.ns), ...list.dirty]),
  };
}

function isMirrorList(v: unknown): v is ScopeMirrorList {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.complete === "boolean" &&
    Array.isArray(o.mirrors) &&
    o.mirrors.every((m) => typeof (m as { ns?: unknown } | null)?.ns === "string") &&
    Array.isArray(o.dirty) &&
    o.dirty.every((d) => typeof d === "string")
  );
}

/** `?mirrorlist=0` turns the overlay list off for a session (one bundle
 *  request per overlay, as before), like `?libpack=0` for the pack. */
export function mirrorListEnabled(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): boolean {
  return new URLSearchParams(search).get("mirrorlist") !== "0";
}

export function withMirrorList(
  baseFetch: typeof fetch,
  opts: {
    /** The boot payload's list, when it carried one. */
    preloaded?: PreloadedMirrorList | null;
    log?: (msg: string) => void;
  } = {},
): typeof fetch {
  const log = opts.log ?? (() => {});
  const lists = new Map<string, Promise<Verdicts | null>>();
  if (opts.preloaded && isMirrorList(opts.preloaded)) {
    lists.set(opts.preloaded.scopeId, Promise.resolve(verdicts(opts.preloaded)));
  }
  let answered = 0;

  const loadList = async (roomUrl: string): Promise<Verdicts | null> => {
    try {
      const res = await baseFetch(`${roomUrl}/mirrors`, { credentials: "include" });
      if (!res.ok) {
        log(`[mirrorlist] no overlay list (HTTP ${res.status}); per-library overlay bundles`);
        return null;
      }
      const body: unknown = await res.json();
      if (!isMirrorList(body)) {
        log("[mirrorlist] malformed overlay list; per-library overlay bundles");
        return null;
      }
      return verdicts(body);
    } catch (err) {
      log(`[mirrorlist] overlay list unavailable (${(err as Error).message}); per-library overlay bundles`);
      return null;
    }
  };

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const m = method === "GET" ? OVERLAY_BUNDLE_URL.exec(url) : null;
    if (m) {
      let scopeId: string | null = null;
      let ns: string | null = null;
      try {
        scopeId = decodeURIComponent(m[1]!);
        ns = decodeURIComponent(m[2]!);
      } catch {
        // Not a URL we produced: leave it alone.
      }
      if (scopeId && ns?.startsWith(`mirror:${scopeId}:`)) {
        let list = lists.get(scopeId);
        if (!list) {
          const roomUrl = url.slice(0, m.index + m[0].indexOf("/libs/"));
          list = loadList(roomUrl);
          lists.set(scopeId, list);
        }
        const v = await list;
        if (v?.complete && !v.fetchThese.has(ns)) {
          if (answered++ === 0) log("[mirrorlist] answering empty team overlays locally");
          return new Response(EMPTY_BUNDLE.slice(), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
      }
    }
    return baseFetch(input, init);
  };
}
