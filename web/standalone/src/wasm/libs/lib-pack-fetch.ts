import { decodeLibPack, libPackKey, type LibPackPointer } from "@pcbjam/shared";

/**
 * The official-library pack on the client (libs 0026): a `fetch` for the sync stacks
 * that answers an origin's `…/libs/origins/<libId>/<versionId>/bundle` from one
 * pack download instead of a request per library. A first run (cold IDB)
 * presyncs every library, so the pack replaces ~380 bundle requests; a warm run
 * asks for no bundle and never downloads it.
 *
 * The pack is fetched once, on the first bundle request, and every concurrent
 * bundle request waits for it. A library missing from the pack (another
 * version, not official, built since) and any failure — no pack published yet,
 * a network error, a bad file — fall through to the per-library request, so
 * the pack only ever saves requests.
 */

const BUNDLE_URL = /\/libs\/origins\/([^/?]+)\/([^/?]+)\/bundle(?:\?|$)/;

export function withLibPack(
  baseFetch: typeof fetch,
  /** `<api>/api/scopes/<scope>/libs/origins` — the pack routes live under it. */
  originsBase: string,
  log: (msg: string) => void = () => {},
): typeof fetch {
  let pack: Promise<Map<string, Uint8Array> | null> | null = null;

  const loadPack = async (): Promise<Map<string, Uint8Array> | null> => {
    try {
      const p = await baseFetch(`${originsBase}/_pack`);
      if (!p.ok) {
        log(`[libpack] no pack (HTTP ${p.status}); per-library bundles`);
        return null;
      }
      const pointer = (await p.json()) as LibPackPointer;
      const t0 = performance.now();
      // Served with Content-Encoding: br — the browser hands us the pack decoded.
      const r = await baseFetch(`${originsBase}/_pack/${pointer.id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const map = decodeLibPack(new Uint8Array(await r.arrayBuffer()));
      log(
        `[libpack] ${map.size} libraries from one pack ` +
          `(${(pointer.bytes / 1e6).toFixed(1)} MB) in ${Math.round(performance.now() - t0)} ms`,
      );
      return map;
    } catch (err) {
      log(`[libpack] pack unavailable (${(err as Error).message}); per-library bundles`);
      return null;
    }
  };

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = BUNDLE_URL.exec(url);
    if (m && m[1] !== "_pack" && (init?.method ?? "GET").toUpperCase() === "GET") {
      const bundle = (await (pack ??= loadPack()))?.get(
        libPackKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)),
      );
      // A view into the pack's ArrayBuffer (never shared memory).
      if (bundle) return new Response(bundle as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/octet-stream" } });
    }
    return baseFetch(input, init);
  };
}
