import { describe, expect, it, vi } from "vitest";
import type { FontFace } from "@pcbjam/shared";
import { createLibFontsProvider, libFaceId, libFontEntries, libFontPath, type LibFont, type LibFontsCache } from "./lib-fonts";
import { createLocalFontsProvider, editorFontList, type LocalFontData } from "./local-fonts";

const face = (family: string, style: string, postscriptName: string | null, index = 0): FontFace => ({
  index,
  family,
  style,
  postscriptName,
  fullName: `${family} ${style}`,
  weight: /bold/i.test(style) ? 700 : 400,
  italic: /italic/i.test(style),
  embedding: "installable",
});

const font = (libId: string, name: string, faces: FontFace[], size = 100): LibFont => ({
  libId,
  libName: "Team",
  name,
  size,
  sha256: `${name}-sha`,
  faces,
});

const FIRA = font("lib-1", "FiraCode-Regular.ttf", [face("Fira Code", "Regular", "FiraCode-Regular")]);
const BAZ = font("lib-1", "sub/Baz.ttc", [face("Baz", "Regular", "Baz-Regular", 0), face("Baz", "Bold", "Baz-Bold", 1)]);
const NONAME = font("lib-2", "Old.ttf", [face("Old", "Regular", null)]);

/** A MEMFS stand-in holding plain files by path. */
function memfs() {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    mkdirTree: vi.fn(),
    writeFile: vi.fn((p: string, d: Uint8Array) => void data.set(p, d)),
    analyzePath: (p: string) => ({ exists: data.has(p) }),
  };
}

function setup(opts: { cached?: { etag: string; fonts: LibFont[] }; answers?: Array<{ status: number; fonts?: LibFont[]; etag?: string }> } = {}) {
  const set = vi.fn();
  const FS = memfs();
  const win = { Module: { kicadSetLocalFonts: set }, FS } as unknown as Parameters<typeof createLibFontsProvider>[0]["win"];
  const answers = [...(opts.answers ?? [{ status: 200, fonts: [FIRA, BAZ, NONAME], etag: '"v1"' }])];
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, ifNoneMatch: (init?.headers as Record<string, string>)?.["if-none-match"] ?? null });
    const a = answers.shift() ?? { status: 304 };
    return new Response(a.status === 304 ? null : JSON.stringify({ fonts: a.fonts ?? [] }), {
      status: a.status,
      headers: a.etag ? { etag: a.etag } : {},
    });
  }) as unknown as typeof fetch;
  const stored = new Map<string, { etag: string; fonts: LibFont[] }>(opts.cached ? [["/fonts", opts.cached]] : []);
  const cache: LibFontsCache = { get: async (k) => stored.get(k), set: async (k, v) => void stored.set(k, v) };
  const readFont = vi.fn(async (libId: string, name: string) => new TextEncoder().encode(`${libId}/${name}`));
  const provider = createLibFontsProvider({ win, listUrl: "/fonts", readFont, fetchImpl, cache, log: () => {} });
  const listed = () => JSON.parse(set.mock.calls.at(-1)?.[0] ?? "[]") as Array<{ id: string; family: string; path: string }>;
  return { provider, set, FS, win, requests, stored, readFont, listed };
}

describe("library font entries", () => {
  it("one entry per face, keyed by PostScript name, in the library font folder", () => {
    expect(libFontEntries([FIRA, BAZ, NONAME])).toEqual([
      { id: "FiraCode-Regular", family: "Fira Code", style: "Regular", path: "/home/kicad/.local/share/fonts/lib/lib-1/FiraCode-Regular.ttf" },
      { id: "Baz-Regular", family: "Baz", style: "Regular", path: "/home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc" },
      { id: "Baz-Bold", family: "Baz", style: "Bold", path: "/home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc" },
      { id: "lib:lib-2:Old.ttf#0", family: "Old", style: "Regular", path: "/home/kicad/.local/share/fonts/lib/lib-2/Old.ttf" },
    ]);
    expect(libFaceId(NONAME, NONAME.faces[0]!)).toBe("lib:lib-2:Old.ttf#0");
    expect(libFontPath(BAZ)).toBe("/home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc");
  });
});

describe("createLibFontsProvider", () => {
  it("lists the fetched fonts in the editor and caches the answer with its ETag", async () => {
    const { provider, listed, stored, requests } = setup();
    await provider.ready();
    expect(requests).toEqual([{ url: "/fonts", ifNoneMatch: null }]);
    expect(provider.count()).toBe(3);
    expect(listed().map((e) => e.family)).toEqual(["Fira Code", "Baz", "Baz", "Old"]);
    expect(stored.get("/fonts")).toEqual({ etag: '"v1"', fonts: [FIRA, BAZ, NONAME] });
  });

  it("a warm start lists the cached fonts at once and revalidates (304 keeps them)", async () => {
    const { provider, listed, requests } = setup({ cached: { etag: '"v1"', fonts: [FIRA] }, answers: [{ status: 304 }] });
    await provider.ready();
    expect(requests).toEqual([{ url: "/fonts", ifNoneMatch: '"v1"' }]);
    expect(listed().map((e) => e.id)).toEqual(["FiraCode-Regular"]);
  });

  it("a refresh after a font was added replaces the list", async () => {
    const { provider, listed } = setup({ answers: [{ status: 200, fonts: [FIRA], etag: '"v1"' }, { status: 200, fonts: [FIRA, BAZ], etag: '"v2"' }] });
    await provider.ready();
    const seen = vi.fn();
    provider.subscribe(seen);
    await provider.refresh();
    expect(listed().map((e) => e.id)).toEqual(["FiraCode-Regular", "Baz-Regular", "Baz-Bold"]);
    expect(seen).toHaveBeenCalled();
  });

  it("a failed list request leaves the editor without library fonts, and is not fatal", async () => {
    const { provider } = setup({ answers: [{ status: 500 }] });
    await provider.ready();
    expect(provider.count()).toBe(0);
  });

  it("loads a face's file through its library, by the face's id", async () => {
    const { provider, readFont } = setup();
    await provider.ready();
    expect(new TextDecoder().decode((await provider.load("Baz-Bold"))!)).toBe("lib-1/sub/Baz.ttc");
    expect(readFont).toHaveBeenCalledWith("lib-1", "sub/Baz.ttc");
    expect(await provider.load("Nope")).toBeNull();
  });

  it("prefetches only the fonts a document names, once", async () => {
    const { provider, FS, readFont } = setup();
    await provider.ready();
    const sch = '(text "a" (effects (font (face "baz") (size 1 1))))';
    expect(provider.named([sch]).map((f) => f.name)).toEqual(["sub/Baz.ttc"]);
    expect(await provider.prefetchFor([sch])).toBe(1);
    expect([...FS.data.keys()]).toEqual(["/home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc"]);
    expect(await provider.prefetchFor([sch])).toBe(0); // already in MEMFS
    expect(readFont).toHaveBeenCalledTimes(1);
    expect(await provider.prefetchFor(['(font (face "KiCad Font"))'])).toBe(0);
  });
});

describe("the editor's one font list", () => {
  it("installed faces come first, a library face with the same id is left out, and each face loads from its source", async () => {
    const { provider, win, listed, readFont } = setup({ answers: [{ status: 200, fonts: [FIRA, BAZ], etag: '"v1"' }] });
    await provider.ready();
    const installed: LocalFontData[] = [
      { family: "Fira Code", style: "Regular", postscriptName: "FiraCode-Regular", fullName: "Fira Code", blob: async () => new Blob([new Uint8Array([7])]) },
    ];
    Object.assign(win, {
      queryLocalFonts: async () => installed,
      navigator: { permissions: { query: async () => ({ state: "granted" }) } },
    });
    const local = createLocalFontsProvider(win as never, () => {});
    await local.request();

    expect(listed().map((e) => `${e.id} ${e.path}`)).toEqual([
      "FiraCode-Regular /home/kicad/.local/share/fonts/FiraCode-Regular.ttf",
      "Baz-Regular /home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc",
      "Baz-Bold /home/kicad/.local/share/fonts/lib/lib-1/sub/Baz.ttc",
    ]);
    // The font lookup asks the installed provider for every face in the list.
    expect([...(await local.load("FiraCode-Regular"))!]).toEqual([7]);
    expect(new TextDecoder().decode((await local.load("Baz-Bold"))!)).toBe("lib-1/sub/Baz.ttc");
    expect(readFont).toHaveBeenCalledWith("lib-1", "sub/Baz.ttc");
    expect(editorFontList(win).entries()).toHaveLength(3);
  });
});
