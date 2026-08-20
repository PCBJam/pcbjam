import { SyncStack, type SyncStackOptions } from "@pcbjam/sync-client";
import {
  fetchSyncStacks,
  type SyncStackDescriptor,
} from "@pcbjam/shared";

/**
 * Read-only source of 3D model bodies (`.wrl` / `.step`), addressed by the
 * KiCad-relative ref `"<lib>.3dshapes/<name>.<ext>"` (a footprint's `(model …)`
 * path with the `${KICAD*_3DMODEL_DIR}/` prefix stripped).
 *
 * Unlike symbols/footprints, models are never bulk-synced: each lib is an
 * r2-idb-sync **sparse** layer — only the (small) manifest syncs eagerly, and a
 * body is fetched exactly when a board references it, then cached in IDB. This
 * keeps the client cost proportional to what the user renders, not to the
 * ~GB-scale full set (docs/features/3d-models).
 */
export interface Model3dSource {
  /** One model body, IDB-cached; null when unknown/unavailable. */
  getModelBody(ref: string): Promise<Uint8Array | null>;
  /** Whether a ref exists in the set at all (manifest-only, no body fetch). */
  hasModel(ref: string): Promise<boolean>;
}

interface CdnModelsManifest {
  schema: number;
  tag: string;
  libs: Array<{ id: string; itemCount?: number }>;
}

/** Split "<lib>.3dshapes/<name>" → { lib, path: "model3d/<name>" }. */
function splitRef(ref: string): { lib: string; path: string } | null {
  const i = ref.indexOf(".3dshapes/");
  if (i <= 0) return null;
  const lib = ref.slice(0, i);
  const name = ref.slice(i + ".3dshapes/".length);
  if (!name || name.includes("/")) return null;
  return { lib, path: `model3d/${name}` };
}

/**
 * CDN-backed `Model3dSource`. Layout under the manifest's dir
 * (`<cdn>/libs/kicad-models/<tag>/`, see scripts/deploy/publish-models.ts):
 *   manifest.json        top index { schema, tag, libs:[{id,itemCount}] }
 *   <lib>/manifest       per-lib SyncManifest, entries "model3d/<name>.<ext>"
 * Bodies are content-addressed and shared across tags, one level up:
 *   <cdn>/libs/kicad-models/blobs/sha256/<hash>
 */
export function cdnModelsSource(
  manifestUrl: string,
  opts?: Pick<SyncStackOptions, "fetchImpl" | "storeFactory">,
): Model3dSource {
  const baseDir = manifestUrl.replace(/\/[^/]*$/, ""); // …/libs/kicad-models/<tag>
  const blobsBase = `${baseDir.replace(/\/[^/]*$/, "")}/blobs/sha256`;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  let manifestP: Promise<CdnModelsManifest> | null = null;
  const loadManifest = (): Promise<CdnModelsManifest> => {
    if (!manifestP) {
      // Never cache a rejection (mirrors cdn-source.ts): a transient failure
      // must not poison every later model read.
      manifestP = (async () => {
        const r = await fetchImpl(manifestUrl, { cache: "no-store" });
        if (!r.ok) throw new Error(`cdn models manifest ${r.status}: ${manifestUrl}`);
        return (await r.json()) as CdnModelsManifest;
      })().catch((e) => {
        manifestP = null;
        throw e;
      });
    }
    return manifestP;
  };

  // One lazily-opened sparse stack per lib (IDB store keyed by namespace, so a
  // lib's cached models persist and dedupe across sessions).
  const stacks = new Map<string, Promise<SyncStack | null>>();
  const openStack = (libId: string): Promise<SyncStack | null> => {
    let p = stacks.get(libId);
    if (!p) {
      p = (async () => {
        const m = await loadManifest();
        if (!m.libs.some((l) => l.id === libId)) return null; // unknown lib
        const stack = new SyncStack({
          layers: [
            {
              namespace: `kicad-models:${m.tag}:${libId}`,
              kind: "sparse",
              url: `${baseDir}/${encodeURIComponent(libId)}`,
              bodyUrlTemplate: `${blobsBase}/{hash}`,
            },
          ],
          ...opts,
        });
        await stack.open();
        return stack;
      })().catch((e) => {
        stacks.delete(libId); // a failed open must stay retryable
        throw e;
      });
      stacks.set(libId, p);
    }
    return p;
  };

  return {
    async getModelBody(ref: string): Promise<Uint8Array | null> {
      const split = splitRef(ref);
      if (!split) return null;
      try {
        const stack = await openStack(split.lib);
        return stack ? await stack.read(split.path) : null;
      } catch {
        return null; // missing models render as absent, never break the viewer
      }
    },
    async hasModel(ref: string): Promise<boolean> {
      const split = splitRef(ref);
      if (!split) return false;
      try {
        const stack = await openStack(split.lib);
        if (!stack) return false;
        return (await stack.list()).some((e) => e.path === split.path);
      } catch {
        return false;
      }
    },
  };
}

/** The subset of the boot payload registryModelsSource consumes. */
export interface RegistryModelsPreload {
  libs: Array<{
    id: string;
    name: string;
    kindCounts?: Record<string, number>;
  }>;
  stacks: Record<string, SyncStackDescriptor | null>;
}

/**
 * Registry-backed `Model3dSource`: the official 3D models as first-class
 * kind='model3d' origin libs served by the closed registry (chunked
 * packages3D ingest). The backend's sync-stack for a model lib is a single
 * read-only SPARSE layer over the public origin routes — exactly the client
 * machinery {@link cdnModelsSource} uses, so bodies fetch lazily per board
 * reference and cache in IDB under `origin:<libId>@<versionId>` (per-version
 * persistence for free).
 *
 * Model refs address libs by NAME (`(model "Battery.3dshapes/…")`): the index
 * comes from the boot payload's lib list (zero extra requests) filtered to
 * model3d, with a `GET /libs?kind=model3d` fallback for boots without the
 * preload; stacks come from the preloaded batch resolve, falling back to the
 * batch endpoint per lib.
 */
export function registryModelsSource(
  cfg: {
    apiBase: string;
    scope: string;
    preloaded?: RegistryModelsPreload;
  },
  opts?: Pick<SyncStackOptions, "fetchImpl" | "storeFactory">,
): Model3dSource {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const enc = encodeURIComponent;

  let indexP: Promise<Map<string, string>> | null = null;
  const loadIndex = (): Promise<Map<string, string>> => {
    if (!indexP) {
      // Never cache a rejection (cdn-source precedent): a transient failure
      // must not poison every later model read.
      indexP = (async () => {
        if (cfg.preloaded) {
          return new Map(
            cfg.preloaded.libs
              .filter((l) => (l.kindCounts?.["model3d"] ?? 0) > 0)
              .map((l) => [l.name, l.id]),
          );
        }
        const r = await fetchImpl(
          `${cfg.apiBase}/api/scopes/${enc(cfg.scope)}/libs?kind=model3d`,
          { credentials: "include" } as RequestInit,
        );
        if (!r.ok) throw new Error(`model3d lib listing ${r.status}`);
        const libs = (await r.json()) as Array<{ id: string; name: string }>;
        return new Map(libs.map((l) => [l.name, l.id]));
      })().catch((e) => {
        indexP = null;
        throw e;
      });
    }
    return indexP;
  };

  const stackDescs = new Map<string, SyncStackDescriptor | null>(
    Object.entries(cfg.preloaded?.stacks ?? {}),
  );
  const descFor = async (
    libId: string,
  ): Promise<SyncStackDescriptor | null> => {
    if (stackDescs.has(libId)) return stackDescs.get(libId) ?? null;
    const resolved = await fetchSyncStacks({
      url: `${cfg.apiBase}/api/scopes/${enc(cfg.scope)}/libs/sync-stacks`,
      libIds: [libId],
      fetchImpl,
    });
    const desc = resolved.get(libId) ?? null;
    stackDescs.set(libId, desc);
    return desc;
  };

  // One lazily-opened stack per lib NAME (what model refs address).
  const stacks = new Map<string, Promise<SyncStack | null>>();
  const openStack = (libName: string): Promise<SyncStack | null> => {
    let p = stacks.get(libName);
    if (!p) {
      p = (async () => {
        const libId = (await loadIndex()).get(libName);
        if (!libId) return null; // unknown lib
        const desc = await descFor(libId);
        if (!desc || desc.layers.length === 0) return null;
        const stack = new SyncStack({ layers: desc.layers, ...opts });
        await stack.open();
        return stack;
      })().catch((e) => {
        stacks.delete(libName); // a failed open must stay retryable
        throw e;
      });
      stacks.set(libName, p);
    }
    return p;
  };

  return {
    async getModelBody(ref: string): Promise<Uint8Array | null> {
      const split = splitRef(ref);
      if (!split) return null;
      try {
        const stack = await openStack(split.lib);
        return stack ? await stack.read(split.path) : null;
      } catch {
        return null; // missing models render as absent, never break the viewer
      }
    },
    async hasModel(ref: string): Promise<boolean> {
      const split = splitRef(ref);
      if (!split) return false;
      try {
        const stack = await openStack(split.lib);
        if (!stack) return false;
        return (await stack.list()).some((e) => e.path === split.path);
      } catch {
        return false;
      }
    },
  };
}
