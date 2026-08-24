import { describe, expect, it } from "vitest";
import { encodeBundle, manifestDigest, type SyncManifest } from "@pcbjam/shared";
import { memStore } from "@pcbjam/sync-client";
import {
  stageViaProjectSync,
  type ProjectSyncConfig,
  type ToolFile,
} from "./kicad-runner";

/**
 * Plain files stage from the project sync namespace (one bundle GET cold);
 * ydoc-backed files, the target, and anything the namespace can't vouch for
 * stay on the per-file path — and ANY namespace failure falls back wholesale
 * (older backend without the routes = exactly the previous behavior).
 */

const enc = new TextEncoder();

function fakeSyncServer(bodies: Record<string, string>) {
  const manifest: SyncManifest = { version: 1, entries: {} };
  const frames: Array<[string, Uint8Array]> = [];
  for (const [path, text] of Object.entries(bodies)) {
    const b = enc.encode(text);
    manifest.entries[path] = { hash: `r1:u${b.length}`, size: b.length, mtime: 0 };
    frames.push([path, b]);
  }
  let bundleFetches = 0;
  let manifestFetches = 0;
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/sync/manifest")) {
      manifestFetches += 1;
      return Response.json(manifest);
    }
    if (url.endsWith("/sync/bundle")) {
      bundleFetches += 1;
      return new Response(encodeBundle(manifest, frames) as BodyInit);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    manifest,
    counters: {
      get bundleFetches() { return bundleFetches; },
      get manifestFetches() { return manifestFetches; },
    },
  };
}

function syncConfig(fetchImpl: typeof fetch): ProjectSyncConfig {
  const stores = new Map<string, ReturnType<typeof memStore>>();
  return {
    apiBase: "https://api.test",
    scope: "team",
    scopeId: "scope-1",
    projectId: "proj-1",
    fetchImpl,
    storeFactory: (ns) => stores.get(ns) ?? stores.set(ns, memStore()).get(ns)!,
  };
}

describe("stageViaProjectSync", () => {
  it("stages plain files from ONE bundle; special files stay per-file", async () => {
    const server = fakeSyncServer({
      "a.kicad_pcb": "(pcb)",
      "docs/readme.md": "hi",
    });
    const files: ToolFile[] = [
      { path: "a.kicad_pcb", revision: 1 },
      { path: "docs/readme.md", revision: 1 },
      { path: "root.kicad_sch", revision: 3, hasYdoc: true },
      { path: "live.kicad_sch", revision: 2, isLive: true },
      { path: "subsheet.kicad_sch", revision: 0 },
      { path: "target.kicad_pcb", revision: 5 },
    ];
    const stagedPaths: string[] = [];
    const rest = await stageViaProjectSync(
      {
        slug: "proj",
        files,
        targetPath: "target.kicad_pcb",
        projectSync: syncConfig(server.fetchImpl),
        log: () => {},
      },
      (path, bytes) => stagedPaths.push(`${path}:${bytes.length}`),
    );

    expect(stagedPaths.sort()).toEqual(["a.kicad_pcb:5", "docs/readme.md:2"]);
    expect(server.counters.bundleFetches).toBe(1);
    expect(rest.map((f) => f.path).sort()).toEqual([
      "live.kicad_sch",
      "root.kicad_sch",
      "subsheet.kicad_sch",
      "target.kicad_pcb",
    ]);
  });

  it("a file the namespace manifest missed falls back to per-file", async () => {
    // The listing knows b.txt, the namespace snapshot doesn't (raced write,
    // just-turned-ydoc): the per-file path must answer authoritatively.
    const server = fakeSyncServer({ "a.txt": "A" });
    const files: ToolFile[] = [
      { path: "a.txt", revision: 1 },
      { path: "b.txt", revision: 1 },
    ];
    const staged: string[] = [];
    const rest = await stageViaProjectSync(
      { slug: "p", files, projectSync: syncConfig(server.fetchImpl), log: () => {} },
      (path) => staged.push(path),
    );
    expect(staged).toEqual(["a.txt"]);
    expect(rest.map((f) => f.path)).toEqual(["b.txt"]);
  });

  it("any namespace failure falls back WHOLESALE to per-file staging", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 404 })) as typeof fetch; // older backend
    const files: ToolFile[] = [
      { path: "a.txt", revision: 1 },
      { path: "b.txt", revision: 1 },
    ];
    const staged: string[] = [];
    const rest = await stageViaProjectSync(
      { slug: "p", files, projectSync: syncConfig(fetchImpl), log: () => {} },
      (path) => staged.push(path),
    );
    expect(staged).toEqual([]);
    expect(rest).toEqual(files);
  });

  it("a boot digest makes the WARM restage zero-request (load-path 0001 §6)", async () => {
    const server = fakeSyncServer({ "a.txt": "A", "b.txt": "BB" });
    const files: ToolFile[] = [
      { path: "a.txt", revision: 1 },
      { path: "b.txt", revision: 1 },
    ];
    const config = syncConfig(server.fetchImpl); // shared stores across runs
    const cold: string[] = [];
    await stageViaProjectSync(
      { slug: "p", files, projectSync: config, log: () => {} },
      (p) => cold.push(p),
    );
    expect(cold.sort()).toEqual(["a.txt", "b.txt"]);
    expect(server.counters.bundleFetches).toBe(1);

    // Warm, with the boot payload's fresh digest: the stored snapshot is
    // affirmed without even the manifest GET.
    const digest = await manifestDigest(server.manifest);
    const warm: string[] = [];
    await stageViaProjectSync(
      { slug: "p", files, projectSync: { ...config, digest }, log: () => {} },
      (p) => warm.push(p),
    );
    expect(warm.sort()).toEqual(["a.txt", "b.txt"]);
    expect(server.counters.bundleFetches).toBe(1);
    expect(server.counters.manifestFetches).toBe(0);
  });

  it("no sync config means the whole set is per-file (demo/local sources)", async () => {
    const files: ToolFile[] = [{ path: "a.txt", revision: 1 }];
    const rest = await stageViaProjectSync(
      { slug: "p", files, projectSync: null, log: () => {} },
      () => {
        throw new Error("must not stage");
      },
    );
    expect(rest).toEqual(files);
  });
});

describe("stageViaProjectSync CAS ancestry", () => {
  it("reports the listing revision for every namespace-staged file", async () => {
    // A bundle-staged file bypasses fetchFileBytes, so the source would
    // otherwise publish its first save against revision 0 → 409 "local base 0,
    // server N" (the .kicad_pro assign-footprints conflict).
    const server = fakeSyncServer({ "a.kicad_pro": "(pro)", "b.txt": "B" });
    const files: ToolFile[] = [
      { path: "a.kicad_pro", revision: 1 },
      { path: "b.txt", revision: 4 },
      { path: "missing.txt", revision: 2 },
    ];
    const seen: Array<[string, number]> = [];
    await stageViaProjectSync(
      {
        slug: "p",
        files,
        projectSync: syncConfig(server.fetchImpl),
        log: () => {},
        onStagedRevision: (path, revision) => seen.push([path, revision]),
      },
      () => {},
    );
    expect(seen.sort()).toEqual([
      ["a.kicad_pro", 1],
      ["b.txt", 4],
    ]);
  });
});
