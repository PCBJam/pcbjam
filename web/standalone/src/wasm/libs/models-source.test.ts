import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  type SyncManifest,
  type SyncStackDescriptor,
} from "@pcbjam/shared";
import { memStore, type LayerStore } from "@pcbjam/sync-client";
import { cdnModelsSource, registryModelsSource } from "./models-source";

const MANIFEST_URL = "https://cdn.test/libs/kicad-models/9.0.9/manifest.json";
const BASE = "https://cdn.test/libs/kicad-models/9.0.9";
const BLOBS = "https://cdn.test/libs/kicad-models/blobs/sha256";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build the CDN layout the way publish-models.ts does: per-lib sparse manifest
 *  + content-addressed blobs — pinning the format with the REAL hash codec. */
async function fakeModelsCdn() {
  const bodies: Record<string, Uint8Array> = {
    "model3d/R_Axial.step": enc.encode("STEP R_Axial"),
    "model3d/R_Disc.wrl": enc.encode("#VRML V2.0 utf8 R_Disc"),
  };
  const entries: SyncManifest["entries"] = {};
  const blobs = new Map<string, Uint8Array>();
  for (const [path, body] of Object.entries(bodies)) {
    const hash = await sha256Hex(body);
    entries[path] = { hash, size: body.length, mtime: 0 };
    blobs.set(hash, body);
  }
  const libManifest: SyncManifest = { version: 1, entries };
  const top = {
    schema: 1,
    tag: "9.0.9",
    libs: [{ id: "Resistor_THT", itemCount: 2 }],
  };

  let manifestFetches = 0;
  let blobFetches = 0;
  const json = (obj: unknown) => ({ ok: true, json: async () => obj });
  const bin = (bytes: Uint8Array) => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  });
  const fetchImpl = (async (url: string) => {
    if (url === MANIFEST_URL) return json(top);
    if (url === `${BASE}/Resistor_THT/manifest`) {
      manifestFetches += 1;
      return json(libManifest);
    }
    if (url.startsWith(`${BLOBS}/`)) {
      const blob = blobs.get(url.slice(`${BLOBS}/`.length));
      if (blob) {
        blobFetches += 1;
        return bin(blob);
      }
    }
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    counters: {
      get manifestFetches() {
        return manifestFetches;
      },
      get blobFetches() {
        return blobFetches;
      },
    },
  };
}

function storeMap() {
  const stores = new Map<string, LayerStore>();
  return (ns: string): LayerStore => {
    let s = stores.get(ns);
    if (!s) stores.set(ns, (s = memStore()));
    return s;
  };
}

describe("cdnModelsSource", () => {
  it("fetches exactly the requested body (sparse), then serves from cache", async () => {
    const cdn = await fakeModelsCdn();
    const src = cdnModelsSource(MANIFEST_URL, {
      fetchImpl: cdn.fetchImpl,
      storeFactory: storeMap(),
    });

    const body = await src.getModelBody("Resistor_THT.3dshapes/R_Axial.step");
    expect(dec.decode(body!)).toBe("STEP R_Axial");
    expect(cdn.counters.blobFetches).toBe(1); // only the asked-for model

    await src.getModelBody("Resistor_THT.3dshapes/R_Axial.step");
    expect(cdn.counters.blobFetches).toBe(1); // cached
    expect(cdn.counters.manifestFetches).toBe(1); // lib opened once
  });

  it("returns null for unknown models/libs/refs without throwing", async () => {
    const cdn = await fakeModelsCdn();
    const src = cdnModelsSource(MANIFEST_URL, {
      fetchImpl: cdn.fetchImpl,
      storeFactory: storeMap(),
    });

    expect(await src.getModelBody("Resistor_THT.3dshapes/nope.step")).toBeNull();
    expect(await src.getModelBody("NoSuchLib.3dshapes/m.wrl")).toBeNull();
    expect(await src.getModelBody("not-a-model-ref")).toBeNull();
    expect(cdn.counters.blobFetches).toBe(0);
  });

  it("hasModel answers from the manifest without fetching bodies", async () => {
    const cdn = await fakeModelsCdn();
    const src = cdnModelsSource(MANIFEST_URL, {
      fetchImpl: cdn.fetchImpl,
      storeFactory: storeMap(),
    });

    expect(await src.hasModel("Resistor_THT.3dshapes/R_Disc.wrl")).toBe(true);
    expect(await src.hasModel("Resistor_THT.3dshapes/nope.wrl")).toBe(false);
    expect(cdn.counters.blobFetches).toBe(0);
  });
});

const API = "https://api.test";
const LIB_ID = "lib-uuid-1";
const VERSION = "ver-uuid-1";
const ORIGIN_BASE = `${API}/api/scopes/s/libs/origins/${LIB_ID}/${VERSION}`;

/** The registry's serving shape: sparse origin layer over the public routes. */
async function fakeRegistry() {
  const bodies: Record<string, Uint8Array> = {
    "model3d/Clip.step": enc.encode("STEP Clip"),
    "model3d/Clip.wrl": enc.encode("#VRML Clip"),
  };
  const entries: SyncManifest["entries"] = {};
  for (const [path, body] of Object.entries(bodies)) {
    entries[path] = { hash: await sha256Hex(body), size: body.length, mtime: 0 };
  }
  const manifest: SyncManifest = { version: 1, entries };
  const descriptor: SyncStackDescriptor = {
    lib: { id: LIB_ID, name: "Battery" },
    layers: [
      {
        namespace: `origin:${LIB_ID}@${VERSION}`,
        kind: "sparse",
        url: ORIGIN_BASE,
        bodyUrlTemplate: `${ORIGIN_BASE}/body/{path}`,
      },
    ],
  };

  let listFetches = 0;
  let resolveFetches = 0;
  let bodyFetches = 0;
  const json = (obj: unknown) => ({ ok: true, json: async () => obj });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === `${API}/api/scopes/s/libs?kind=model3d`) {
      listFetches += 1;
      return json([{ id: LIB_ID, name: "Battery" }]);
    }
    if (url === `${API}/api/scopes/s/libs/sync-stacks`) {
      resolveFetches += 1;
      const { libIds } = JSON.parse(String(init?.body)) as { libIds: string[] };
      return json({
        stacks: Object.fromEntries(
          libIds.map((id) => [id, id === LIB_ID ? descriptor : null]),
        ),
      });
    }
    if (url === `${ORIGIN_BASE}/manifest`) return json(manifest);
    const m = url.match(new RegExp(`^${ORIGIN_BASE}/body/(.+)$`));
    if (m) {
      const body = bodies[decodeURIComponent(m[1]!)];
      if (body) {
        bodyFetches += 1;
        return { ok: true, arrayBuffer: async () => body.buffer };
      }
    }
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    descriptor,
    counters: {
      get listFetches() {
        return listFetches;
      },
      get resolveFetches() {
        return resolveFetches;
      },
      get bodyFetches() {
        return bodyFetches;
      },
    },
  };
}

describe("registryModelsSource", () => {
  it("preloaded boot: zero listing/resolve requests, bodies fetched sparsely", async () => {
    const reg = await fakeRegistry();
    const src = registryModelsSource(
      {
        apiBase: API,
        scope: "s",
        preloaded: {
          libs: [
            { id: LIB_ID, name: "Battery", kindCounts: { model3d: 2 } },
            // A footprint lib of the SAME name must be ignored by the model
            // index (kind is part of origin identity — near-1:1 name overlap).
            { id: "lib-fp", name: "Battery", kindCounts: { footprint: 9 } },
          ],
          stacks: { [LIB_ID]: reg.descriptor },
        },
      },
      { fetchImpl: reg.fetchImpl, storeFactory: storeMap() },
    );

    const body = await src.getModelBody("Battery.3dshapes/Clip.step");
    expect(dec.decode(body!)).toBe("STEP Clip");
    expect(reg.counters.listFetches).toBe(0);
    expect(reg.counters.resolveFetches).toBe(0);
    expect(reg.counters.bodyFetches).toBe(1); // only the asked-for model

    await src.getModelBody("Battery.3dshapes/Clip.step");
    expect(reg.counters.bodyFetches).toBe(1); // cached in the layer store
    expect(await src.hasModel("Battery.3dshapes/Clip.wrl")).toBe(true);
    expect(reg.counters.bodyFetches).toBe(1); // manifest-only answer
  });

  it("no preload: lists model3d libs and batch-resolves the stack, once each", async () => {
    const reg = await fakeRegistry();
    const src = registryModelsSource(
      { apiBase: API, scope: "s" },
      { fetchImpl: reg.fetchImpl, storeFactory: storeMap() },
    );

    const body = await src.getModelBody("Battery.3dshapes/Clip.wrl");
    expect(dec.decode(body!)).toBe("#VRML Clip");
    await src.getModelBody("Battery.3dshapes/Clip.step");
    expect(reg.counters.listFetches).toBe(1);
    expect(reg.counters.resolveFetches).toBe(1);

    expect(await src.getModelBody("NoSuchLib.3dshapes/m.wrl")).toBeNull();
    expect(await src.getModelBody("not-a-model-ref")).toBeNull();
  });
});
