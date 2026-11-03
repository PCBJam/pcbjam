/**
 * The browser's installed fonts in the editors (Local Font Access API, Chromium only).
 *
 * KiCad's font lookup in the wasm build (wasm/stubs/fontconfig_wasm.cpp) lists and matches
 * these alongside the document's embedded fonts:
 *  - the list goes in through `Module.kicadSetLocalFonts` as `{ id, family, style, path }`;
 *  - a face's bytes are fetched on first use: the lookup calls `load(id)` through
 *    `globalThis.__pcbjamLocalFonts` and writes them to `path` in MEMFS;
 *  - a file load cannot wait for that, so the open flow calls `prefetchFor()` first, which
 *    writes the faces the document names.
 *
 * Reading the list needs the "local-fonts" permission. The first request must come from a
 * user gesture (`request()`, the session menu's "Use installed fonts"); once granted, Chrome
 * remembers it and boot reads the list on its own.
 *
 * The editor has one font list. Team library fonts (lib-fonts.ts) go into it too, through
 * {@link editorFontList}: installed faces first, so an installed font wins over the same
 * library font (no download), and `load(id)` hands library ids to their source.
 */

/** Permission and support, as the session menu shows it. */
export type LocalFontsState = "unsupported" | "prompt" | "granted" | "denied";

/** The parts of the browser's FontData the editor uses. */
export interface LocalFontData {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}

/** One installed face as the font lookup sees it. */
export interface LocalFontEntry {
  id: string;
  family: string;
  style: string;
  path: string;
}

export interface LocalFontsProvider {
  state(): LocalFontsState;
  /** Settles once boot's permission check (and, when granted, the list read) is done. */
  ready(): Promise<void>;
  /** Installed faces, after a grant. */
  count(): number;
  /** Ask for the permission and read the list. Call from a user gesture. */
  request(): Promise<LocalFontsState>;
  /** The font file of one face, by id (its postscript name). */
  load(id: string): Promise<Uint8Array | null>;
  /** Fetch the faces of the families these KiCad files name, before KiCad opens them. */
  prefetchFor(texts: string[]): Promise<number>;
  /** Called on every state or list change; returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** Where fetched faces live in MEMFS. Their file names are what "Embed fonts" stores. */
export const LOCAL_FONTS_DIR = "/home/kicad/.local/share/fonts";

/** Cap on what one prefetch writes, so a document naming a huge family stays cheap. */
const PREFETCH_BUDGET_BYTES = 64 * 1024 * 1024;

export function localFontPath(id: string): string {
  return `${LOCAL_FONTS_DIR}/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.ttf`;
}

/** The distinct font names KiCad files use: `(face "Name")`. */
export function facesIn(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\(face "((?:[^"\\]|\\.)*)"\)/g)) names.add(m[1]!.replace(/\\(.)/g, "$1"));
  }
  return [...names];
}

/**
 * The KiCad files an open of `absPath` reads: the file, plus for a schematic its sibling
 * sheets (a hierarchy loads them in the same open).
 */
export function documentTexts(FS: EmscriptenFS, absPath: string): string[] {
  const read = (p: string): string | null => {
    try {
      return FS.readFile(p, { encoding: "utf8" }) as string;
    } catch {
      return null;
    }
  };
  const paths = [absPath];
  const dir = absPath.slice(0, absPath.lastIndexOf("/"));
  if (absPath.endsWith(".kicad_sch") && typeof FS.readdir === "function") {
    for (const name of FS.readdir(dir)) {
      if (name.endsWith(".kicad_sch") && `${dir}/${name}` !== absPath) paths.push(`${dir}/${name}`);
    }
  }
  return paths.map(read).filter((t): t is string => t !== null);
}

type LocalFontsWindow = {
  queryLocalFonts?: () => Promise<LocalFontData[]>;
  navigator: Navigator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Module?: any;
  FS?: EmscriptenFS;
};

/** Where the editor's font list comes from, in list order. */
export type FontListSource = "installed" | "library";

export interface EditorFontList {
  /** Replace one source's faces; the merged list goes to the editor. */
  set(source: FontListSource, entries: LocalFontEntry[], load?: (id: string) => Promise<Uint8Array | null>): void;
  /** A face's bytes from the source that listed it (null when none did). */
  load(id: string): Promise<Uint8Array | null>;
  entries(): LocalFontEntry[];
}

const fontLists = new WeakMap<object, EditorFontList>();

/** The one font list of this window's editor (`Module.kicadSetLocalFonts`). */
export function editorFontList(win: Pick<LocalFontsWindow, "Module">): EditorFontList {
  let list = fontLists.get(win);
  if (list) return list;
  const sources = new Map<FontListSource, { entries: LocalFontEntry[]; load?: (id: string) => Promise<Uint8Array | null> }>();
  const order: FontListSource[] = ["installed", "library"];
  const merged = (): Array<LocalFontEntry & { source: FontListSource }> => {
    const seen = new Set<string>();
    const out: Array<LocalFontEntry & { source: FontListSource }> = [];
    for (const source of order) {
      for (const e of sources.get(source)?.entries ?? []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ ...e, source });
      }
    }
    return out;
  };

  // The binding exists once the runtime is up; a list set before that is handed over
  // when it appears.
  let pushTimer: ReturnType<typeof setInterval> | null = null;
  const push = () => {
    const tryPush = (): boolean => {
      const set = win.Module?.kicadSetLocalFonts;
      if (typeof set !== "function") return false;
      set.call(win.Module, JSON.stringify(merged().map(({ id, family, style, path }) => ({ id, family, style, path }))));
      return true;
    };
    if (tryPush()) return;
    if (pushTimer) return;
    pushTimer = setInterval(() => {
      if (tryPush() && pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
      }
    }, 250);
  };

  list = {
    set(source, entries, load) {
      sources.set(source, { entries, load });
      push();
    },
    async load(id) {
      const hit = merged().find((e) => e.id === id);
      const load = hit ? sources.get(hit.source)?.load : undefined;
      return load ? load(id) : null;
    },
    entries: () => merged().map(({ id, family, style, path }) => ({ id, family, style, path })),
  };
  fontLists.set(win, list);
  return list;
}

declare global {
  // eslint-disable-next-line no-var
  var __pcbjamLocalFonts: LocalFontsProvider | undefined;
}

export function createLocalFontsProvider(win: LocalFontsWindow, log: (m: string) => void): LocalFontsProvider {
  let state: LocalFontsState = typeof win.queryLocalFonts === "function" ? "prompt" : "unsupported";
  let fonts: LocalFontData[] = [];
  const byId = new Map<string, LocalFontData>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  let settled: Promise<void> = Promise.resolve();

  const entries = (): LocalFontEntry[] =>
    fonts.map((f) => ({ id: f.postscriptName, family: f.family, style: f.style, path: localFontPath(f.postscriptName) }));

  const fontList = editorFontList(win);
  const pushToEditor = () => fontList.set("installed", entries(), loadInstalled);

  const permission = async (): Promise<PermissionState | null> => {
    try {
      return (await win.navigator.permissions.query({ name: "local-fonts" as PermissionName })).state;
    } catch {
      return null; // the browser does not know the permission name
    }
  };

  const read = async (): Promise<LocalFontsState> => {
    if (state === "unsupported") return state;
    try {
      const list = await win.queryLocalFonts!();
      fonts = list.filter((f) => f.postscriptName && f.family);
      byId.clear();
      for (const f of fonts) byId.set(f.postscriptName, f);
      state = "granted";
      log(`[fonts] ${fonts.length} installed font face(s) available`);
      pushToEditor();
    } catch (e) {
      const name = (e as { name?: string }).name;
      state = (await permission()) === "denied" ? "denied" : "prompt";
      log(`[fonts] installed fonts not readable: ${name ?? e}`);
    }
    notify();
    return state;
  };

  const loadInstalled = async (id: string): Promise<Uint8Array | null> => {
    const f = byId.get(id);
    if (!f) return null;
    return new Uint8Array(await (await f.blob()).arrayBuffer());
  };
  // The editor's font lookup calls this for every face in its list, library ones too.
  const load = async (id: string): Promise<Uint8Array | null> =>
    byId.has(id) ? loadInstalled(id) : fontList.load(id);

  const provider: LocalFontsProvider & { init(): void } = {
    state: () => state,
    ready: () => settled,
    count: () => fonts.length,
    request: read,
    load,
    async prefetchFor(texts) {
      if (state !== "granted" || fonts.length === 0) return 0;
      const FS = win.FS;
      if (!FS) return 0;
      const wanted = new Set(facesIn(texts).map((n) => n.toLowerCase()));
      let written = 0;
      let bytes = 0;
      for (const f of fonts) {
        if (!wanted.has(f.family.toLowerCase())) continue;
        const path = localFontPath(f.postscriptName);
        if (FS.analyzePath(path).exists) continue;
        const data = await load(f.postscriptName).catch(() => null);
        if (!data || bytes + data.length > PREFETCH_BUDGET_BYTES) continue;
        FS.mkdirTree(LOCAL_FONTS_DIR);
        FS.writeFile(path, data);
        bytes += data.length;
        written++;
      }
      if (written) log(`[fonts] prefetched ${written} installed face(s) the document uses`);
      return written;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Boot: a remembered grant reads the list without a prompt; a block shows as such.
    init() {
      if (state === "unsupported") return;
      settled = (async () => {
        const p = await permission();
        if (p === "granted") await read();
        else if (p === "denied") {
          state = "denied";
          notify();
        }
      })();
    },
  };
  return provider;
}

/** Install the provider for the editor bundle (boot.ts). */
export function installLocalFonts(win: LocalFontsWindow, log: (m: string) => void): LocalFontsProvider {
  const provider = createLocalFontsProvider(win, log) as LocalFontsProvider & { init(): void };
  globalThis.__pcbjamLocalFonts = provider;
  provider.init();
  return provider;
}
