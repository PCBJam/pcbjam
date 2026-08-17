import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "@pcbjam/shared";
// Real validator logic inside the mocked cache module — only the IDB-touching
// functions are replaced (the node test env has no IndexedDB anyway).
import { fileCacheValidator } from "./project-file-cache";

const PROJECT_ID = "0b7a4bfa-0000-5000-8000-0000000000aa";

const file = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  id: "0b7a4bfa-0000-5000-8000-0000000000ab",
  projectId: PROJECT_ID,
  path: "boards/main.kicad_pcb",
  size: 3,
  contentType: "text/plain",
  revision: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-15T12:00:00.000Z",
  ...over,
});

function cacheMock() {
  return {
    fileCacheValidator,
    readCachedFileBytes: vi.fn(async () => null as Uint8Array | null),
    writeCachedFileBytes: vi.fn(async () => {}),
    pruneProjectFileCache: vi.fn(async () => {}),
  };
}

// project-source reads config at import time; mock it fresh then dynamic-import
// (same pattern as project-source.test.ts, but selecting the REMOTE source).
async function loadRemote(cache: ReturnType<typeof cacheMock>, client?: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({
    API_BASE_URL: "http://localhost:3050",
    PROJECT_SOURCE_KIND: "remote",
    PROJECT_MANIFEST_URL: undefined,
    LOCAL_PROJECTS_ENABLED: false,
    userSlug: () => "test-user",
    currentScope: () => "team-a",
  }));
  vi.doMock("./project-file-cache", () => cache);
  if (client) vi.doMock("./contract-client", () => ({ client }));
  return (await import("./project-source")).projectSource;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const plainResponse = (bytes: Uint8Array) => ({
  ok: true,
  headers: { get: (h: string) => (h === "content-type" ? "text/plain" : null) },
  arrayBuffer: async () => bytes.buffer,
});

describe("remote source file-body cache", () => {
  it("serves a cache hit without touching the network", async () => {
    const cache = cacheMock();
    const cached = new Uint8Array([9, 9, 9]);
    cache.readCachedFileBytes.mockResolvedValue(cached);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const src = (await loadRemote(cache))();
    const meta = file();
    const got = await src.fetchFileBytes("proj", meta.path, meta);

    expect(got).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.readCachedFileBytes).toHaveBeenCalledWith(
      PROJECT_ID,
      meta.path,
      fileCacheValidator(meta),
    );
  });

  it("on a miss, fetches and stores under the listing's validator", async () => {
    const cache = cacheMock();
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal("fetch", vi.fn(async () => plainResponse(bytes)));

    const src = (await loadRemote(cache))();
    const meta = file();
    const got = await src.fetchFileBytes("proj", meta.path, meta);

    expect(Array.from(got)).toEqual([1, 2, 3]);
    expect(cache.writeCachedFileBytes).toHaveBeenCalledWith(
      PROJECT_ID,
      meta.path,
      fileCacheValidator(meta),
      got,
    );
  });

  it("never caches a ydoc-materialized response, even with cacheable meta", async () => {
    // Listing said no ydoc, but a room appeared between listing and fetch: the
    // server answers as a ydoc. The garbage update fails conversion → the
    // plain-retry fallback serves the bytes, and NOTHING is written to the
    // cache (those bytes move without a file-row change).
    const cache = cacheMock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (h: string) =>
            h === "content-type" ? "application/x-pcbjam-ydoc" : null,
        },
        arrayBuffer: async () => new Uint8Array([0xde, 0xad]).buffer,
      })
      .mockResolvedValueOnce(plainResponse(new Uint8Array([7])));
    vi.stubGlobal("fetch", fetchMock);

    const src = (await loadRemote(cache))();
    const got = await src.fetchFileBytes("proj", "a.kicad_sch", file());

    expect(Array.from(got)).toEqual([7]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.writeCachedFileBytes).not.toHaveBeenCalled();
  });

  it("skips the cache entirely when no listing meta is passed", async () => {
    const cache = cacheMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => plainResponse(new Uint8Array([5]))),
    );

    const src = (await loadRemote(cache))();
    await src.fetchFileBytes("proj", "x.txt");

    expect(cache.readCachedFileBytes).not.toHaveBeenCalled();
    expect(cache.writeCachedFileBytes).not.toHaveBeenCalled();
  });

  it("prunes to the fresh listing on getProject (cacheable rows only)", async () => {
    const cache = cacheMock();
    const cacheable = file();
    const collabOnly = file({
      path: "sheets/child.kicad_sch",
      revision: 0,
      hasYdoc: true,
    });
    const client = {
      getProject: vi.fn(async () => ({
        status: 200,
        body: {
          project: { id: PROJECT_ID, scopeId: "s", slug: "proj" },
          files: [cacheable, collabOnly],
        },
      })),
    };

    const src = (await loadRemote(cache, client))();
    await src.getProject("proj");

    expect(cache.pruneProjectFileCache).toHaveBeenCalledWith(
      PROJECT_ID,
      new Map([[cacheable.path, fileCacheValidator(cacheable)!]]),
    );
  });
});
