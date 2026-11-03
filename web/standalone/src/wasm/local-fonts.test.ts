import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalFontsProvider,
  documentTexts,
  facesIn,
  installLocalFonts,
  localFontPath,
  type LocalFontData,
} from "./local-fonts";

const face = (family: string, style: string, postscriptName: string, bytes = [1, 2, 3]): LocalFontData => ({
  family,
  style,
  postscriptName,
  fullName: `${family} ${style}`,
  blob: async () => new Blob([new Uint8Array(bytes)]),
});

const INSTALLED = [
  face("Zapfino", "Regular", "Zapfino", [9, 9]),
  face("Times", "Roman", "Times-Roman"),
  face("Times", "Bold", "Times-Bold"),
  face("Verdana", "Regular", "Verdana"),
];

/** A MEMFS stand-in holding plain files by path. */
function memfs(files: Record<string, string> = {}) {
  const data = new Map<string, Uint8Array | string>(Object.entries(files));
  return {
    data,
    mkdirTree: vi.fn(),
    writeFile: vi.fn((p: string, d: Uint8Array | string) => void data.set(p, d)),
    readFile: (p: string) => {
      if (!data.has(p)) throw new Error("ENOENT");
      return data.get(p);
    },
    analyzePath: (p: string) => ({ exists: data.has(p) }),
    unlink: (p: string) => void data.delete(p),
    readdir: (dir: string) =>
      [...data.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
  };
}

function browser(opts: { permission?: PermissionState; query?: () => Promise<LocalFontData[]>; supported?: boolean } = {}) {
  const set = vi.fn();
  const FS = memfs();
  const win = {
    queryLocalFonts: opts.supported === false ? undefined : (opts.query ?? (async () => INSTALLED)),
    navigator: { permissions: { query: async () => ({ state: opts.permission ?? "prompt" }) } } as unknown as Navigator,
    Module: { kicadSetLocalFonts: set },
    FS,
  };
  return { win, set, FS };
}

afterEach(() => {
  globalThis.__pcbjamLocalFonts = undefined;
});

describe("facesIn", () => {
  it("lists each face a KiCad file names once, unescaped", () => {
    const sch = '(effects (font (face "Zapfino") (size 1.27 1.27)))\n(font (face "Zapfino"))\n(font (face "My \\"Quoted\\" Font"))';
    expect(facesIn([sch, '(face "Times")'])).toEqual(["Zapfino", 'My "Quoted" Font', "Times"]);
  });
});

describe("localFontPath", () => {
  it("keeps the postscript name readable, since Embed fonts stores the file name", () => {
    expect(localFontPath("Zapfino")).toBe("/home/kicad/.local/share/fonts/Zapfino.ttf");
    expect(localFontPath("Some Font/Bold")).toBe("/home/kicad/.local/share/fonts/Some_Font_Bold.ttf");
  });
});

describe("documentTexts", () => {
  it("reads a schematic with its sibling sheets, and a board alone", () => {
    const FS = memfs({
      "/p/main.kicad_sch": "main",
      "/p/sub.kicad_sch": "sub",
      "/p/board.kicad_pcb": "board",
    });
    expect(documentTexts(FS, "/p/main.kicad_sch").sort()).toEqual(["main", "sub"]);
    expect(documentTexts(FS, "/p/board.kicad_pcb")).toEqual(["board"]);
  });
});

describe("the installed-fonts provider", () => {
  it("is unsupported without the Local Font Access API", () => {
    const { win } = browser({ supported: false });
    expect(createLocalFontsProvider(win, () => {}).state()).toBe("unsupported");
  });

  it("request() reads the list and hands it to the editor as id, family, style and path", async () => {
    const { win, set } = browser();
    const provider = createLocalFontsProvider(win, () => {});
    expect(provider.state()).toBe("prompt");
    expect(await provider.request()).toBe("granted");
    expect(provider.count()).toBe(4);
    expect(JSON.parse(set.mock.calls[0]![0] as string)[0]).toEqual({
      id: "Zapfino",
      family: "Zapfino",
      style: "Regular",
      path: "/home/kicad/.local/share/fonts/Zapfino.ttf",
    });
  });

  it("a refused prompt reads as blocked only when the browser says so", async () => {
    const refused = async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    };
    const blocked = browser({ query: refused, permission: "denied" });
    expect(await createLocalFontsProvider(blocked.win, () => {}).request()).toBe("denied");
    const dismissed = browser({ query: refused, permission: "prompt" });
    expect(await createLocalFontsProvider(dismissed.win, () => {}).request()).toBe("prompt");
  });

  it("boot reads the list without a prompt once the permission is granted", async () => {
    const { win, set } = browser({ permission: "granted" });
    const provider = installLocalFonts(win, () => {});
    await provider.ready();
    expect(globalThis.__pcbjamLocalFonts).toBe(provider);
    expect(provider.state()).toBe("granted");
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("boot leaves a prompt state alone, and shows a block", async () => {
    const prompt = installLocalFonts(browser().win, () => {});
    await prompt.ready();
    expect(prompt.state()).toBe("prompt");
    const denied = installLocalFonts(browser({ permission: "denied" }).win, () => {});
    await denied.ready();
    expect(denied.state()).toBe("denied");
  });

  it("hands a list read before the editor was up to the editor once it is", async () => {
    vi.useFakeTimers();
    try {
      const { win } = browser();
      const set = vi.fn();
      win.Module = {} as typeof win.Module;
      const provider = createLocalFontsProvider(win, () => {});
      await provider.request();
      win.Module = { kicadSetLocalFonts: set };
      await vi.advanceTimersByTimeAsync(300);
      expect(set).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("load() returns a face's bytes by id", async () => {
    const { win } = browser();
    const provider = createLocalFontsProvider(win, () => {});
    await provider.request();
    expect([...(await provider.load("Zapfino"))!]).toEqual([9, 9]);
    expect(await provider.load("Missing")).toBeNull();
  });

  it("prefetchFor() writes every face of the families a document names, once", async () => {
    const { win, FS } = browser();
    const provider = createLocalFontsProvider(win, () => {});
    await provider.request();
    const doc = '(text "a" (effects (font (face "times") (size 1 1))))';
    expect(await provider.prefetchFor([doc])).toBe(2);
    expect([...FS.data.keys()].sort()).toEqual([
      "/home/kicad/.local/share/fonts/Times-Bold.ttf",
      "/home/kicad/.local/share/fonts/Times-Roman.ttf",
    ]);
    expect(await provider.prefetchFor([doc])).toBe(0);
  });

  it("prefetchFor() does nothing before a grant", async () => {
    const { win, FS } = browser();
    const provider = createLocalFontsProvider(win, () => {});
    expect(await provider.prefetchFor(['(face "Zapfino")'])).toBe(0);
    expect(FS.writeFile).not.toHaveBeenCalled();
  });

  it("notifies subscribers on every change", async () => {
    const { win } = browser();
    const provider = createLocalFontsProvider(win, () => {});
    const fn = vi.fn();
    const off = provider.subscribe(fn);
    await provider.request();
    off();
    await provider.request();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
