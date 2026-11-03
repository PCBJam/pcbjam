/**
 * Team library fonts in the editors (fonts 0002 F2).
 *
 * The list of fonts comes from `GET …/projects/<project>/fonts` (family, style, file name
 * per face; no font bytes). It is not part of the boot answer: boot starts this request and
 * nothing waits for it, except an open whose document names one of these fonts. The answer
 * is kept in IndexedDB and revalidated with its ETag, so a warm start lists the fonts at
 * once and a project without library fonts pays one small request.
 *
 * A font's file is read through the library's sync stack the first time it is needed (the
 * stack fetches `font/` bodies on read and caches them, LayerDescriptor.lazy), then written
 * to MEMFS under {@link LIB_FONTS_DIR}. Its file name there is the uploaded one, which is
 * what "Embed fonts" stores. The faces join the installed fonts in the editor's one list
 * (local-fonts.ts editorFontList), so KiCad's font lookup, the Font list and the open-flow
 * prefetch treat both alike.
 */
import type { FontFace } from "@pcbjam/shared";
import { editorFontList, facesIn, LOCAL_FONTS_DIR, type LocalFontEntry } from "./local-fonts";

/** One font file of a team library, as the fonts route lists it. */
export interface LibFont {
  libId: string;
  libName: string;
  name: string;
  size: number;
  sha256: string;
  faces: FontFace[];
}

/** Where fetched library fonts live in MEMFS (a sub-folder of the installed fonts' folder). */
export const LIB_FONTS_DIR = `${LOCAL_FONTS_DIR}/lib`;

/** Cap on what one prefetch writes, as for installed fonts. */
const PREFETCH_BUDGET_BYTES = 64 * 1024 * 1024;

export function libFontPath(font: Pick<LibFont, "libId" | "name">): string {
  return `${LIB_FONTS_DIR}/${font.libId}/${font.name}`;
}

/**
 * A face's id in the editor's list: its PostScript name, which is how the font lookup
 * finds the face inside a collection (fontconfig_wasm.cpp localFaceIndex). Faces without
 * one get a synthetic id (index 0 then, right for single-face files).
 */
export function libFaceId(font: Pick<LibFont, "libId" | "name">, face: Pick<FontFace, "postscriptName" | "index">): string {
  return face.postscriptName || `lib:${font.libId}:${font.name}#${face.index}`;
}

/** The editor-list entries of a set of library fonts (every face of every file). */
export function libFontEntries(fonts: readonly LibFont[]): LocalFontEntry[] {
  return fonts.flatMap((f) => f.faces.map((face) => ({ id: libFaceId(f, face), family: face.family, style: face.style, path: libFontPath(f) })));
}

/** The list answer kept between sessions. */
interface CachedList {
  etag: string;
  fonts: LibFont[];
}

export interface LibFontsCache {
  get(key: string): Promise<CachedList | undefined>;
  set(key: string, value: CachedList): Promise<void>;
}

/** One IndexedDB store, one key per list URL; every failure reads as "not cached". */
export function idbLibFontsCache(): LibFontsCache {
  const DB = "pcbjam-lib-fonts";
  const STORE = "lists";
  let dbP: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> =>
    (dbP ??= new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    }));
  return {
    async get(key) {
      const db = await open();
      if (!db) return undefined;
      return new Promise((resolve) => {
        const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result as CachedList | undefined);
        r.onerror = () => resolve(undefined);
      });
    },
    async set(key, value) {
      const db = await open();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    },
  };
}

export interface LibFontsProvider {
  /** Settles once a list is in hand (cached or fetched), or the fetch failed. */
  ready(): Promise<void>;
  /** Font files listed. */
  count(): number;
  fonts(): readonly LibFont[];
  /** One face's font file, by its id in the editor's list. */
  load(id: string): Promise<Uint8Array | null>;
  /** The library fonts these KiCad files name. */
  named(texts: string[]): LibFont[];
  /** Write the library fonts these KiCad files name to MEMFS, before KiCad opens them. */
  prefetchFor(texts: string[]): Promise<number>;
  /** Re-read the list (a font was added or removed). */
  refresh(): Promise<void>;
  subscribe(fn: () => void): () => void;
}

type LibFontsWindow = Parameters<typeof editorFontList>[0] & { FS?: EmscriptenFS };

export function createLibFontsProvider(deps: {
  win: LibFontsWindow;
  /** The fonts route of this project. */
  listUrl: string;
  /** A font file through its library's sync stack (lazy, IDB-cached). */
  readFont: (libId: string, name: string) => Promise<Uint8Array | null>;
  fetchImpl?: typeof fetch;
  cache?: LibFontsCache;
  log: (m: string) => void;
}): LibFontsProvider {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const fontList = editorFontList(deps.win);
  let fonts: LibFont[] = [];
  let etag: string | null = null;
  const listeners = new Set<() => void>();

  const byFaceId = (): Map<string, LibFont> => {
    const out = new Map<string, LibFont>();
    for (const f of fonts) for (const face of f.faces) if (!out.has(libFaceId(f, face))) out.set(libFaceId(f, face), f);
    return out;
  };
  const load = async (id: string): Promise<Uint8Array | null> => {
    const font = byFaceId().get(id);
    return font ? deps.readFont(font.libId, font.name) : null;
  };
  const apply = (next: LibFont[], from: string) => {
    fonts = next;
    fontList.set("library", libFontEntries(fonts), load);
    if (fonts.length) deps.log(`[fonts] ${fonts.length} team library font file(s) (${from})`);
    listeners.forEach((fn) => fn());
  };

  // A refresh while one runs runs once more after it, so the last change is never missed.
  let inflight: Promise<void> | null = null;
  let again = false;
  const fetchList = async (): Promise<void> => {
    const res = await fetchImpl(deps.listUrl, {
      credentials: "include",
      headers: etag ? { "if-none-match": etag } : {},
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`fonts list ${res.status}`);
    const body = (await res.json()) as { fonts?: LibFont[] };
    etag = res.headers.get("etag");
    apply(Array.isArray(body.fonts) ? body.fonts : [], "fetched");
    if (etag && deps.cache) await deps.cache.set(deps.listUrl, { etag, fonts });
  };
  const refresh = (): Promise<void> => {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        try {
          await fetchList();
        } catch (e) {
          deps.log(`[fonts] team library font list not read: ${e}`);
        }
      } while (again);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const settled = (async () => {
    const cached = await deps.cache?.get(deps.listUrl).catch(() => undefined);
    if (cached) {
      etag = cached.etag;
      apply(cached.fonts, "cached");
    }
    await refresh();
  })();

  const named = (texts: string[]): LibFont[] => {
    const wanted = new Set(facesIn(texts).map((n) => n.toLowerCase()));
    if (wanted.size === 0) return [];
    return fonts.filter((f) => f.faces.some((face) => wanted.has(face.family.toLowerCase())));
  };

  return {
    ready: () => settled,
    count: () => fonts.length,
    fonts: () => fonts,
    load,
    named,
    async prefetchFor(texts) {
      const FS = deps.win.FS;
      if (!FS) return 0;
      let written = 0;
      let bytes = 0;
      for (const font of named(texts)) {
        const path = libFontPath(font);
        if (FS.analyzePath(path).exists) continue;
        if (bytes + font.size > PREFETCH_BUDGET_BYTES) continue;
        const data = await deps.readFont(font.libId, font.name).catch(() => null);
        if (!data) continue;
        FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        FS.writeFile(path, data);
        bytes += data.length;
        written++;
      }
      if (written) deps.log(`[fonts] prefetched ${written} team library font file(s) the document uses`);
      return written;
    },
    refresh,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __pcbjamLibFonts: LibFontsProvider | undefined;
}
