import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "@pcbjam/shared";

// resolveWasmBase/Meta read WASM_ROOT / WASM_MANIFEST_FILE from config at import
// time, so each case mocks config fresh then dynamically imports the module.
async function loadModule(cfg: {
  WASM_ROOT: string;
  WASM_MANIFEST_FILE: string | null;
}) {
  vi.resetModules();
  vi.doMock("@/lib/config", () => cfg);
  return await import("./wasm-assets");
}

const PCBNEW = "pcbnew" as Tool;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveWasmBase", () => {
  it("uses an explicit override verbatim (trailing slash stripped), no fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolveWasmBase } = await loadModule({
      WASM_ROOT: "/wasm",
      WASM_MANIFEST_FILE: "manifest-1.json",
    });
    expect(await resolveWasmBase(PCBNEW, "https://cdn.example/wasm/pcbnew/9/")).toBe(
      "https://cdn.example/wasm/pcbnew/9",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the flat root when no manifest is configured (dev), no fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolveWasmBase } = await loadModule({
      WASM_ROOT: "/wasm",
      WASM_MANIFEST_FILE: null,
    });
    expect(await resolveWasmBase(PCBNEW)).toBe("/wasm");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the tool's BUNDLE folder from the manifest (pcbnew → kicad_editor)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        schema: 2,
        tag: "2.7.7",
        tools: { kicad_editor: "2.7.5", gerbview: "2.7.1" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolveWasmBase } = await loadModule({
      WASM_ROOT: "https://cdn.pcbjam.com/wasm",
      WASM_MANIFEST_FILE: "manifest-2.7.7.json",
    });
    expect(await resolveWasmBase(PCBNEW)).toBe(
      "https://cdn.pcbjam.com/wasm/kicad_editor/2.7.5",
    );
    // Manifest is fetched uncached, and only ONCE across calls (in-memory cached).
    expect(await resolveWasmBase("gerbview" as Tool)).toBe(
      "https://cdn.pcbjam.com/wasm/gerbview/2.7.1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.pcbjam.com/wasm/manifest-2.7.7.json",
      { cache: "no-store" },
    );
  });

  it("throws when the manifest omits the tool's bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ tools: {} }) })),
    );
    const { resolveWasmBase } = await loadModule({
      WASM_ROOT: "https://cdn.pcbjam.com/wasm",
      WASM_MANIFEST_FILE: "manifest-2.7.7.json",
    });
    await expect(resolveWasmBase(PCBNEW)).rejects.toThrow(
      /no WASM version for "kicad_editor"/,
    );
  });

  it("throws when the manifest fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const { resolveWasmBase } = await loadModule({
      WASM_ROOT: "https://cdn.pcbjam.com/wasm",
      WASM_MANIFEST_FILE: "manifest-2.7.7.json",
    });
    await expect(resolveWasmBase(PCBNEW)).rejects.toThrow(/WASM manifest 404/);
  });
});

describe("resolveWasmMeta", () => {
  it("carries the bundle's version + sizes from a schema-2 manifest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          schema: 2,
          tag: "2.7.7",
          tools: { kicad_editor: "2.7.5" },
          sizes: {
            kicad_editor: { wasm: 350_000_000, wasmStored: 90_000_000, totalStored: 95_000_000 },
          },
        }),
      })),
    );
    const { resolveWasmMeta } = await loadModule({
      WASM_ROOT: "https://cdn.pcbjam.com/wasm",
      WASM_MANIFEST_FILE: "manifest-2.7.7.json",
    });
    expect(await resolveWasmMeta(PCBNEW)).toEqual({
      base: "https://cdn.pcbjam.com/wasm/kicad_editor/2.7.5",
      bundle: "kicad_editor",
      ver: "2.7.5",
      sizes: { wasm: 350_000_000, wasmStored: 90_000_000, totalStored: 95_000_000 },
    });
  });

  it("has null ver/sizes for schema-1 manifests, overrides and flat dev roots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ schema: 1, tag: "2.7.7", tools: { kicad_editor: "2.7.5" } }),
      })),
    );
    const { resolveWasmMeta } = await loadModule({
      WASM_ROOT: "https://cdn.pcbjam.com/wasm",
      WASM_MANIFEST_FILE: "manifest-2.7.7.json",
    });
    // schema 1: version resolves, sizes absent
    expect((await resolveWasmMeta(PCBNEW)).sizes).toBeNull();
    // override / flat: no version → the consent gate never runs there
    expect(await resolveWasmMeta(PCBNEW, "https://x/y")).toMatchObject({
      ver: null,
      sizes: null,
    });
    const flat = await loadModule({ WASM_ROOT: "/wasm", WASM_MANIFEST_FILE: null });
    expect(await flat.resolveWasmMeta(PCBNEW)).toMatchObject({ ver: null, sizes: null });
  });
});

describe("download-completion marker", () => {
  function stubLocalStorage() {
    const map = new Map<string, string>();
    const ls = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
    vi.stubGlobal("localStorage", ls);
    return map;
  }

  it("marks + reads back one bundle/version; a version bump reads cold", async () => {
    stubLocalStorage();
    const { isWasmDownloaded, markWasmDownloaded } = await loadModule({
      WASM_ROOT: "/wasm",
      WASM_MANIFEST_FILE: null,
    });
    expect(isWasmDownloaded("kicad_editor", "2.7.5")).toBe(false);
    markWasmDownloaded("kicad_editor", "2.7.5");
    expect(isWasmDownloaded("kicad_editor", "2.7.5")).toBe(true);
    // content-addressed: a new release is honestly "not downloaded yet"
    expect(isWasmDownloaded("kicad_editor", "2.8.0")).toBe(false);
    // flat/override layouts (ver null) never read warm and never write
    expect(isWasmDownloaded("kicad_editor", null)).toBe(false);
    markWasmDownloaded("gerbview", null);
    expect(isWasmDownloaded("gerbview", "any")).toBe(false);
  });

  it("keeps ONE marker per bundle and flags prior versions as an update", async () => {
    const map = stubLocalStorage();
    const { hasAnyWasmDownload, isWasmDownloaded, markWasmDownloaded } =
      await loadModule({ WASM_ROOT: "/wasm", WASM_MANIFEST_FILE: null });
    expect(hasAnyWasmDownload("kicad_editor")).toBe(false);
    markWasmDownloaded("kicad_editor", "2.7.5");
    markWasmDownloaded("gerbview", "2.7.5");
    // Before re-downloading, the OLD marker makes the consent an "update".
    expect(hasAnyWasmDownload("kicad_editor")).toBe(true);
    markWasmDownloaded("kicad_editor", "2.8.0");
    expect(isWasmDownloaded("kicad_editor", "2.8.0")).toBe(true);
    expect(isWasmDownloaded("kicad_editor", "2.7.5")).toBe(false); // superseded, dropped
    expect(isWasmDownloaded("gerbview", "2.7.5")).toBe(true); // other bundles untouched
    expect([...map.keys()].filter((k) => k.includes("kicad_editor"))).toHaveLength(1);
  });

  it("treats blocked/absent storage as cold and never throws", async () => {
    // node env: no localStorage global at all
    const { hasAnyWasmDownload, isWasmDownloaded, markWasmDownloaded } =
      await loadModule({ WASM_ROOT: "/wasm", WASM_MANIFEST_FILE: null });
    expect(isWasmDownloaded("kicad_editor", "2.7.5")).toBe(false);
    expect(hasAnyWasmDownload("kicad_editor")).toBe(false);
    expect(() => markWasmDownloaded("kicad_editor", "2.7.5")).not.toThrow();
  });

  it("auto-download preference round-trips and defaults off", async () => {
    stubLocalStorage();
    const { autoDownloadEnabled, setAutoDownloadEnabled } = await loadModule({
      WASM_ROOT: "/wasm",
      WASM_MANIFEST_FILE: null,
    });
    expect(autoDownloadEnabled()).toBe(false);
    setAutoDownloadEnabled(true);
    expect(autoDownloadEnabled()).toBe(true);
    setAutoDownloadEnabled(false);
    expect(autoDownloadEnabled()).toBe(false);
  });
});

describe("fetchWasmStoredSize", () => {
  it("HEADs the wasm and returns Content-Length; null on failure", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "12345678" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWasmStoredSize } = await loadModule({
      WASM_ROOT: "/wasm",
      WASM_MANIFEST_FILE: null,
    });
    expect(await fetchWasmStoredSize("https://cdn/x/1", "kicad_editor")).toBe(12345678);
    expect(fetchMock).toHaveBeenCalledWith("https://cdn/x/1/kicad_editor.wasm", {
      method: "HEAD",
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 405 })));
    expect(await fetchWasmStoredSize("https://cdn/x/1", "kicad_editor")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: { get: () => null } })));
    expect(await fetchWasmStoredSize("https://cdn/x/1", "kicad_editor")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("net"))));
    expect(await fetchWasmStoredSize("https://cdn/x/1", "kicad_editor")).toBeNull();
  });
});
