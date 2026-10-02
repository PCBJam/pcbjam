import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "@pcbjam/shared";
// Real validator logic inside the mocked cache module — only the IDB-touching
// functions are replaced (the node test env has no IndexedDB anyway).
import { fileCacheValidator, isYdocValidator } from "./project-file-cache";

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
    isYdocValidator,
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

  it("ydoc + cold: caches the CONVERTED text under the blob-tag validator", async () => {
    const { fileToDoc, docToY, docToFile } = await import("@pcbjam/shared");
    const Y = await import("yjs");
    const kdoc = fileToDoc("(kicad_sch (version 20230121))");
    const ydoc = new Y.Doc();
    docToY(kdoc, ydoc);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();

    const cache = cacheMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: (h: string) =>
            h === "content-type" ? "application/x-pcbjam-ydoc" : null,
        },
        arrayBuffer: async () => update.buffer,
      })),
    );

    const src = (await loadRemote(cache))();
    const meta = file({ hasYdoc: true, ydocTag: "etag-77" });
    const got = await src.fetchFileBytes("proj", meta.path, meta);

    // The returned bytes are the client-side conversion of the update…
    expect(new TextDecoder().decode(got)).toBe(docToFile(kdoc));
    // …and exactly those bytes are cached under the y-form validator, so the
    // next warm load skips the download AND the conversion.
    const validator = fileCacheValidator(meta)!;
    expect(isYdocValidator(validator)).toBe(true);
    expect(cache.writeCachedFileBytes).toHaveBeenCalledWith(
      PROJECT_ID,
      meta.path,
      validator,
      got,
    );
  });

  it("ydoc + unconvertible: the plain fallback is cached once per blob tag", async () => {
    // The stale-v1-ydoc double-fetch: negotiation returns garbage, the client
    // re-fetches server-materialized text. Caching THAT under the blob tag
    // turns two fetches per load into two fetches per blob generation.
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
      .mockResolvedValueOnce(plainResponse(new Uint8Array([40, 41])));
    vi.stubGlobal("fetch", fetchMock);

    const src = (await loadRemote(cache))();
    const meta = file({ hasYdoc: true, ydocTag: "etag-stale" });
    const got = await src.fetchFileBytes("proj", meta.path, meta);

    expect(Array.from(got)).toEqual([40, 41]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.writeCachedFileBytes).toHaveBeenCalledWith(
      PROJECT_ID,
      meta.path,
      fileCacheValidator(meta)!,
      got,
    );
  });

  it("ydoc + LIVE: no cache read or write — bytes are moving", async () => {
    const cache = cacheMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => plainResponse(new Uint8Array([1]))),
    );
    const src = (await loadRemote(cache))();
    const meta = file({ hasYdoc: true, ydocTag: "e", isLive: true });
    await src.fetchFileBytes("proj", meta.path, meta);
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

describe("remote source CAS ancestry for bundle-staged files", () => {
  it("rememberBaseRevision sets the expected revision of the next PUT", async () => {
    // A file staged from the project sync namespace never passes through
    // fetchFileBytes; without rememberBaseRevision its first save would carry
    // expected revision 0 and 409 against the real row (assign-footprints
    // .kicad_pro conflict: "local base 0, server 1").
    const source = await loadRemote(cacheMock());
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "x-pcbjam-file-revision" ? "2" : null) },
      json: async () => ({ revision: 2 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const relPath = "Leonardo/Arduino Leonardo.kicad_pro";
    source().rememberBaseRevision?.("leo", relPath, 1);
    await source().uploadFileBytes!("leo", relPath, new Uint8Array([1]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as {
      method: string;
      headers: Record<string, string>;
    };
    expect(init.method).toBe("PUT");
    const revisionHeader = Object.entries(init.headers).find(
      ([k]) => k.toLowerCase().includes("revision"),
    );
    expect(revisionHeader?.[1]).toBe("1");
  });

  it("only a save KiCad wrote is marked as an editor save", async () => {
    // The backend skips its normalizing resave for marked bytes; a new-file
    // template (no option) must keep it.
    const source = await loadRemote(cacheMock());
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "x-pcbjam-file-revision" ? "1" : null) },
      json: async () => ({ revision: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await source().uploadFileBytes!("p", "a.kicad_sch", new Uint8Array([1]), undefined, { editorSave: true });
    await source().uploadFileBytes!("p", "b.kicad_sch", new Uint8Array([1]));
    const headersOf = (i: number) =>
      ((fetchMock.mock.calls[i] as unknown[])[1] as { headers: Record<string, string> }).headers;
    expect(headersOf(0)["x-pcbjam-file-source"]).toBe("editor-save");
    expect(headersOf(1)["x-pcbjam-file-source"]).toBeUndefined();
  });
});

describe("remote source: a sibling restage never moves the CAS base (proposal 21 S5a)", () => {
  const revHeader = (init: unknown) =>
    Object.entries((init as { headers: Record<string, string> }).headers).find(([k]) =>
      k.toLowerCase().includes("revision"),
    )?.[1];

  it("fetch with adoptAsBase:false records observed only; the next PUT still CASes the model's ancestry", async () => {
    // The editor loaded .kicad_pro at revision 1; a peer saved revision 2 and
    // files-watch restaged it into MEMFS. The native PROJECT_FILE was NOT
    // reloaded, so this tab's next save carries the OLD settings — it must
    // 409 against revision 2, never silently overwrite it.
    const source = await loadRemote(cacheMock());
    const relPath = "p/p.kicad_pro";
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => ({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) =>
          h === "x-pcbjam-file-revision" ? (init?.method === "PUT" ? "3" : "2") : h === "content-type" ? "text/plain" : null,
      },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
      json: async () => ({ revision: 3 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    source().rememberBaseRevision?.("p", relPath, 1);
    await source().fetchFileBytes("p", relPath, undefined, { adoptAsBase: false });
    expect(source().observedRevision?.("p", relPath)).toBe(2);
    await source().uploadFileBytes!("p", relPath, new Uint8Array([1]));
    expect(revHeader(fetchMock.mock.calls[1]![1])).toBe("1");
  });

  it("a default fetch still adopts its revision as the base (the model is built from it)", async () => {
    const source = await loadRemote(cacheMock());
    const relPath = "p/p.kicad_pro";
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => ({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) =>
          h === "x-pcbjam-file-revision" ? (init?.method === "PUT" ? "3" : "2") : h === "content-type" ? "text/plain" : null,
      },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
      json: async () => ({ revision: 3 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    source().rememberBaseRevision?.("p", relPath, 1);
    await source().fetchFileBytes("p", relPath);
    await source().uploadFileBytes!("p", relPath, new Uint8Array([1]));
    expect(revHeader(fetchMock.mock.calls[1]![1])).toBe("2");
  });
});
