import { peekNamespaces, SyncStack, type SyncStackOptions } from "@pcbjam/sync-client";
import { asyncMap } from "@/lib/async-map";
import type { LibInfo, LibItemInfo, LibsSource, LibsSyncState } from "./source";

/**
 * A read-only, no-backend `LibsSource` that serves the FULL default KiCad symbol
 * + footprint set from immutable CDN snapshots (the demo's libs). Each lib is a
 * version-pinned r2-idb-sync **static origin** (docs/features/r2-idb-sync): the
 * editor opens it as a one-layer `SyncStack` that fetches one `bundle` cold and
 * serves list/get from a per-lib IndexedDB cache after that (0 fetches warm,
 * works offline). No resolve endpoint — the layer descriptor is built locally
 * from the lib id + tag, so there's no backend in the loop.
 *
 * Layout under the manifest's directory (`<cdn>/libs/kicad/<tag>/`):
 *   manifest.json            top index: every lib (id, name, kind, itemCount)
 *   fp-index.json            footprint index: per-lib [name, uniquePadCount]
 *   sizes.json               per-lib bundle byte counts (consent dialog; may
 *                            be absent on tags published before it existed)
 *   <libId>/manifest         per-lib SyncManifest (GET .../manifest)
 *   <libId>/bundle           per-lib bundle: manifest + all bodies (cold init)
 * Item paths inside a lib follow the `"<kind>/<name>"` scheme.
 */

interface CdnLibEntry {
  id: string;
  name: string;
  kind: "symbol" | "footprint";
  itemCount?: number;
  description?: string | null;
}
interface CdnLibsManifest {
  schema: number;
  tag: string;
  libs: CdnLibEntry[];
}
interface CdnLibsSizes {
  schema: number;
  tag: string;
  libs: Record<string, number>;
}

export function cdnLibsSource(
  manifestUrl: string,
  // Test seam: inject fetch + an in-memory store (SyncStack defaults to real
  // fetch + IndexedDB). Production passes nothing.
  opts?: Pick<SyncStackOptions, "fetchImpl" | "storeFactory">,
): LibsSource {
  const baseDir = manifestUrl.replace(/\/[^/]*$/, ""); // <cdn>/libs/kicad/<tag>
  const fetchImpl = opts?.fetchImpl ?? fetch;

  let manifestP: Promise<CdnLibsManifest> | null = null;
  let fpIndexP: Promise<string | null> | null = null;
  const fetchManifest = async (): Promise<CdnLibsManifest> => {
    // Retry with backoff. Firefox can fail a cross-origin fetch issued in the
    // first moments after navigation under COEP (the lazy path runs seconds
    // later and succeeds); a short retry rides past that window. The pre-sync
    // warm-up, which fires this earliest, is what surfaced it.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
      try {
        const r = await fetchImpl(manifestUrl, { cache: "no-store" });
        if (!r.ok)
          throw new Error(`cdn libs manifest ${r.status}: ${manifestUrl}`);
        return (await r.json()) as CdnLibsManifest;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
  const loadManifest = (): Promise<CdnLibsManifest> => {
    if (!manifestP) {
      // NEVER cache a rejection: a transient failure must not poison every later
      // listLibs/getItemBody — the next call retries from scratch.
      manifestP = fetchManifest().catch((e) => {
        manifestP = null;
        throw e;
      });
    }
    return manifestP;
  };

  // Per-lib bundle byte counts (sizes.json). Null when the tag predates the
  // file — syncState then reports sizesKnown: false. A resolved null is cached:
  // the consent gate reads this once, and a 404 is a stable answer.
  let sizesP: Promise<CdnLibsSizes | null> | null = null;
  const loadSizes = (): Promise<CdnLibsSizes | null> => {
    return (sizesP ??= (async () => {
      try {
        const r = await fetchImpl(`${baseDir}/sizes.json`, { cache: "no-store" });
        if (!r.ok) return null;
        return (await r.json()) as CdnLibsSizes;
      } catch {
        return null;
      }
    })());
  };

  // One lazily-opened SyncStack per lib (its IDB store is keyed by namespace, so
  // a lib is cached once and reused across opens).
  const stacks = new Map<string, Promise<SyncStack>>();
  const openStack = (libId: string): Promise<SyncStack> => {
    let p = stacks.get(libId);
    if (!p) {
      p = (async () => {
        const m = await loadManifest();
        const stack = new SyncStack({
          layers: [
            {
              namespace: `kicad:${m.tag}:${libId}`,
              kind: "static",
              url: `${baseDir}/${encodeURIComponent(libId)}`,
            },
          ],
          ...opts,
        });
        await stack.open();
        return stack;
      })().catch((e) => {
        // Don't cache a failed open (e.g. an early-boot fetch blip) — the lazy
        // path must be able to retry this lib instead of inheriting the failure.
        stacks.delete(libId);
        throw e;
      });
      stacks.set(libId, p);
    }
    return p;
  };

  return {
    async listLibs(kind?: string): Promise<LibInfo[]> {
      const m = await loadManifest();
      return m.libs
        .filter((l) => !kind || l.kind === kind)
        .map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description ?? null,
          type: "origin",
          itemCount: l.itemCount,
        }));
    },
    async listItems(libId: string): Promise<LibItemInfo[]> {
      const stack = await openStack(libId);
      return (await stack.list()).map((e) => splitPath(e.path));
    },
    async syncState(kind): Promise<LibsSyncState> {
      const m = await loadManifest();
      const libs = m.libs.filter((l) => !kind || l.kind === kind);
      const [sizes, peeked] = await Promise.all([
        loadSizes(),
        // Read-only probe (never downloads); same namespaces openStack uses,
        // same default "sync:" IDB prefix as the SyncStack it fronts.
        peekNamespaces(
          libs.map((l) => `kicad:${m.tag}:${l.id}`),
          opts?.storeFactory ? { storeFactory: opts.storeFactory } : undefined,
        ),
      ]);
      let warm = 0;
      let coldBytes = 0;
      for (const l of libs) {
        if (peeked.get(`kicad:${m.tag}:${l.id}`)) warm++;
        else coldBytes += sizes?.libs[l.id] ?? 0;
      }
      return { total: libs.length, warm, coldBytes, sizesKnown: sizes !== null };
    },
    async presync(opts): Promise<void> {
      const { kind, concurrency = 8, onProgress, signal } = opts ?? {};
      let m: CdnLibsManifest;
      try {
        m = await loadManifest();
      } catch {
        // Best-effort warm-up: a manifest hiccup here (e.g. the early-boot
        // Firefox/COEP fetch blip) is non-fatal — skip quietly and let the lazy
        // path fetch on demand (loadManifest no longer caches the failure).
        return;
      }
      const libs = m.libs.filter((l) => !kind || l.kind === kind);
      const total = libs.length;
      let done = 0;
      onProgress?.({ done, total, current: "" });
      // Concurrency-limited: each openStack cold-fetches one bundle into IDB
      // (warm ⇒ a cheap manifest diff). Tolerate per-lib failures so one bad lib
      // doesn't abort the warm-up. Progress is reported on COMPLETION only —
      // with several libs in flight there is no single "current" one.
      await asyncMap(
        libs,
        async (lib) => {
          if (signal?.aborted) return;
          try {
            await openStack(lib.id);
          } catch {
            // best-effort: the lib still loads lazily on demand
          }
          if (signal?.aborted) return;
          onProgress?.({ done: ++done, total, current: lib.name });
        },
        concurrency,
      );
    },
    async getAllItems(
      libId: string,
    ): Promise<Array<{ kind: string; name: string; body: Uint8Array }>> {
      // One bulk merged read of the whole lib (the IDB cache after cold bundle).
      // "Copy as-is": hand back the raw IDB bytes (no TextDecoder) so the provider
      // frames them and the bridge memcpy's them into wasm with no string/JSON
      // detour — the plugin slices them straight out of the wasm heap.
      const stack = await openStack(libId);
      return [...(await stack.readAll())].map(([path, bytes]) => {
        const { kind, name } = splitPath(path);
        return { kind, name, body: bytes };
      });
    },
    async getItemBody(
      libId: string,
      kind: string,
      name: string,
    ): Promise<string | null> {
      const stack = await openStack(libId);
      const bytes = await stack.read(`${kind}/${name}`);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async getFpIndex(): Promise<string | null> {
      // Published next to the top manifest (immutable, ~100 KB compressed) —
      // passed through as raw text; the WASM side parses it once and caches.
      // A missing index (tag predates fp-index publishing, or a fetch error)
      // resolves null and the editor falls back to per-lib lazy loads; null is
      // NOT cached so a transient failure retries on the next chooser use.
      if (!fpIndexP) {
        fpIndexP = (async () => {
          const r = await fetchImpl(`${baseDir}/fp-index.json`);
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`cdn fp-index ${r.status}`);
          return await r.text();
        })().catch(() => {
          fpIndexP = null;
          return null;
        });
      }
      return fpIndexP;
    },
    // Read-only: no saveItemBody / createLib (the demo's default libs are fixed).
  };
}

/** Decode a `"<kind>/<name>"` namespace path into editor item terms. */
function splitPath(path: string): LibItemInfo {
  const i = path.indexOf("/");
  return i < 0
    ? { kind: path, name: "" }
    : { kind: path.slice(0, i), name: path.slice(i + 1) };
}
