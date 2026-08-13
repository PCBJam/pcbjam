import { afterEach, describe, expect, it, vi } from "vitest";

const MANIFEST_URL = "https://cdn.pcbjam.com/content/2.7.7/manifest.json";
const MANIFEST = {
  schema: 1,
  tag: "2.7.7",
  builtAt: "2026-06-18T00:00:00.000Z",
  projects: [
    {
      slug: "demo-board",
      name: "Demo Board",
      description: "d",
      files: [
        { path: "demo.kicad_pcb", size: 100 },
        { path: "sub/x.kicad_sch", size: 5 },
      ],
    },
  ],
};

// project-source reads config at import time; mock it fresh then dynamic-import.
async function loadStatic() {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({
    API_BASE_URL: "http://localhost:3050",
    PROJECT_SOURCE_KIND: "static",
    PROJECT_MANIFEST_URL: MANIFEST_URL,
    // Local IDB store off ⇒ the active source is the plain static gallery
    // (no composite), which is what these read-only assertions cover.
    LOCAL_PROJECTS_ENABLED: false,
    // The contract client (imported transitively) reads these at module load.
    userSlug: () => "test-user",
    currentScope: () => "demo",
  }));
  return (await import("./project-source")).projectSource;
}

async function loadRemote() {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({
    API_BASE_URL: "http://localhost:3050",
    PROJECT_SOURCE_KIND: "remote",
    PROJECT_MANIFEST_URL: "",
    LOCAL_PROJECTS_ENABLED: false,
    userSlug: () => "test-user",
    currentScope: () => "team",
  }));
  return (await import("./project-source")).projectSource;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("static project source", () => {
  it("is read-only with no upload target (saves download to local)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = (await loadStatic())();
    expect(src.readOnly).toBe(true);
    expect(src.uploadFileBytes).toBeUndefined();
  });

  it("lists projects from the manifest with stable uuid ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => MANIFEST })),
    );
    const src = (await loadStatic())();
    const projects = await src.listProjects();
    expect(projects).toHaveLength(1);
    const p = projects[0]!;
    expect(p.slug).toBe("demo-board");
    expect(p.name).toBe("Demo Board");
    expect(p.id).toMatch(UUID_RE);
    // Deterministic: the same slug resolves to the same id across calls.
    expect((await src.listProjects())[0]!.id).toBe(p.id);
  });

  it("returns a project's file tree; throws for an unknown slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => MANIFEST })),
    );
    const src = (await loadStatic())();
    const pwf = await src.getProject("demo-board");
    expect(pwf.files.map((f) => f.path)).toEqual([
      "demo.kicad_pcb",
      "sub/x.kicad_sch",
    ]);
    expect(pwf.files[0]!.projectId).toBe(pwf.project.id);
    await expect(src.getProject("nope")).rejects.toThrow(/project not found/);
  });

  it("fetches bytes from <manifestDir>/<slug>/<path> and caches the manifest", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn(async (url: string, _opts?: RequestInit) =>
      url === MANIFEST_URL
        ? { ok: true, json: async () => MANIFEST }
        : { ok: true, arrayBuffer: async () => bytes.buffer },
    );
    vi.stubGlobal("fetch", fetchMock);
    const src = (await loadStatic())();
    await src.listProjects(); // loads the manifest once
    const got = await src.fetchFileBytes("demo-board", "sub/x.kicad_sch");
    expect(Array.from(got)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.pcbjam.com/content/2.7.7/demo-board/sub/x.kicad_sch",
    );
    // Manifest fetched exactly once (in-memory cached), uncached over the network.
    const manifestCalls = fetchMock.mock.calls.filter((c) => c[0] === MANIFEST_URL);
    expect(manifestCalls).toHaveLength(1);
    expect(manifestCalls[0]![1]).toEqual({ cache: "no-store" });
  });
});

describe("remote project source save revisions", () => {
  const project = {
    id: "00000000-0000-4000-8000-000000000001",
    scope: "team",
    slug: "demo",
    name: "Demo",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const file = {
    id: "00000000-0000-4000-8000-000000000002",
    projectId: project.id,
    path: "board.kicad_pcb",
    size: 1,
    contentType: "text/plain",
    revision: 4,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  it("does not use a listed revision as the write base", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          seen.push(new Headers(init.headers).get("x-pcbjam-file-revision")!);
          return new Response(JSON.stringify({ ...file, revision: 1 }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-pcbjam-file-revision": "1",
            },
          });
        }
        return new Response(JSON.stringify({ project, files: [file] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const source = (await loadRemote())();
    await source.getProject("demo");
    await source.uploadFileBytes!("demo", file.path, new Uint8Array([1]));
    expect(seen).toEqual(["0"]);
  });

  it("uses a loaded body's revision and advances it only after acknowledged commits", async () => {
    const seen: string[] = [];
    let saves = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "PUT") {
          return new Response(new Uint8Array([1]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "x-pcbjam-file-revision": "4",
            },
          });
        }
        seen.push(new Headers(init.headers).get("x-pcbjam-file-revision")!);
        const revision = ++saves + 4;
        return new Response(JSON.stringify({ ...file, revision }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const source = (await loadRemote())();
    await source.fetchFileBytes("demo", file.path);
    expect(await source.uploadFileBytes!("demo", file.path, new Uint8Array([2]))).toEqual({
      kind: "committed",
    });
    await source.uploadFileBytes!("demo", file.path, new Uint8Array([3]));
    expect(seen).toEqual(["4", "5"]);
  });

  it("keeps conflict and refreshed revisions observed-only", async () => {
    const seen: string[] = [];
    let bodyLoaded = false;
    let conflicts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          seen.push(new Headers(init.headers).get("x-pcbjam-file-revision")!);
          const revision = ++conflicts + 6;
          return new Response(
            JSON.stringify({ current: { ...file, revision }, expectedRevision: 4 }),
            {
              status: 409,
              headers: {
                "content-type": "application/json",
                "x-pcbjam-file-revision": String(revision),
              },
            },
          );
        }
        if (!bodyLoaded) {
          bodyLoaded = true;
          return new Response(new Uint8Array([1]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "x-pcbjam-file-revision": "4",
            },
          });
        }
        return new Response(JSON.stringify([{ ...file, revision: 9 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const source = (await loadRemote())();
    await source.fetchFileBytes("demo", file.path);
    const conflict = await source.uploadFileBytes!(
      "demo",
      file.path,
      new Uint8Array([2]),
    );
    expect(conflict).toMatchObject({ kind: "conflict" });
    await source.refreshFileRevision!("demo", file.path);
    await source.uploadFileBytes!("demo", file.path, new Uint8Array([3]));
    expect(seen).toEqual(["4", "4"]);
  });

  it("returns unknown for transport loss and non-prepublication server errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const source = (await loadRemote())();
    expect(
      await source.uploadFileBytes!("demo", file.path, new Uint8Array([1])),
    ).toMatchObject({ kind: "unknown" });
  });

  it("returns not-committed only for a response known to precede publication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 428 })));
    const source = (await loadRemote())();
    expect(
      await source.uploadFileBytes!("demo", file.path, new Uint8Array([1])),
    ).toEqual({ kind: "not-committed", message: `Save failed (428): ${file.path}` });
  });

  it("accepts a success revision header and rejects inconsistent acknowledgements", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response("not json", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-pcbjam-file-revision": "1",
            },
          });
        }
        return new Response(JSON.stringify({ ...file, revision: 3 }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-pcbjam-file-revision": "2",
          },
        });
      }),
    );
    const source = (await loadRemote())();
    expect(
      await source.uploadFileBytes!("demo", file.path, new Uint8Array([1])),
    ).toEqual({ kind: "committed" });
    expect(
      await source.uploadFileBytes!("demo", file.path, new Uint8Array([2])),
    ).toMatchObject({ kind: "unknown" });
  });
});
