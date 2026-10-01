import { describe, expect, it } from "vitest";
import { fakeMemfs } from "./fake-memfs";
import { installLazyDirs, type LazyFs } from "./lazy-dirs";
import { placeholderDirs } from "./stage-plan";

const enc = new TextEncoder();
const ROOT = "/projects/p";
const TREE = ["hw/d/d.kicad_sch", "docs/a.png", "docs/b.pdf", "docs/img/c.png", "firmware/main.c"];

function setup(staged: string[] = ["hw/d/d.kicad_sch"], fail = 0) {
  const fs = fakeMemfs();
  const fetches: Array<{ dir: string; paths: string[] }> = [];
  const log: string[] = [];
  let failures = fail;
  for (const p of staged) {
    fs.mkdirTree(`${ROOT}/${p.slice(0, p.lastIndexOf("/"))}`);
    fs.writeFile(`${ROOT}/${p}`, "staged");
  }
  const { dirs, missing } = placeholderDirs(TREE, new Set(staged));
  const lazy = installLazyDirs({
    fs: fs as unknown as LazyFs,
    root: ROOT,
    dirs,
    missing,
    fetchFolder: (dir, paths) => {
      fetches.push({ dir, paths: [...paths].sort() });
      if (failures-- > 0) throw new Error("offline");
      return paths.map((p) => [p, enc.encode(`body of ${p}`)]);
    },
    stage: (path, bytes) => fs.writeFile(`${ROOT}/${path}`, bytes),
    log: (m) => log.push(m),
  });
  return { fs, lazy, fetches, log };
}

describe("placeholder folders", () => {
  it("every folder exists, empty, and nothing is fetched until looked into", () => {
    const { fs, lazy, fetches } = setup();
    expect(fs.analyzePath(`${ROOT}/docs/img`).exists).toBe(true);
    expect(fs.analyzePath(`${ROOT}/firmware`).exists).toBe(true);
    expect(fetches).toEqual([]);
    expect(lazy.pending().sort()).toEqual(["docs", "docs/img", "firmware"]);
  });

  it("listing a placeholder fills that one folder level with one fetch", () => {
    const { fs, lazy, fetches } = setup();
    expect(fs.readdir(`${ROOT}/docs`).sort()).toEqual(["a.png", "b.pdf", "img"]);
    expect(fetches).toEqual([{ dir: "docs", paths: ["docs/a.png", "docs/b.pdf"] }]);
    expect(new TextDecoder().decode(fs.readFile(`${ROOT}/docs/a.png`))).toBe("body of docs/a.png");
    // Its subfolder is still a placeholder; a second listing fetches nothing.
    fs.readdir(`${ROOT}/docs`);
    expect(fetches).toHaveLength(1);
    expect(lazy.pending().sort()).toEqual(["docs/img", "firmware"]);
  });

  it("opening a listed file by path fills its folder (a typed path, a reference nobody parsed)", () => {
    const { fs, fetches } = setup();
    expect(new TextDecoder().decode(fs.readFile(`${ROOT}/docs/img/c.png`))).toBe("body of docs/img/c.png");
    expect(fetches).toEqual([{ dir: "docs/img", paths: ["docs/img/c.png"] }]);
  });

  it("probing a placeholder for a name the listing does not have fetches nothing", () => {
    const { fs, fetches } = setup();
    expect(fs.analyzePath(`${ROOT}/docs/~a.png.lck`).exists).toBe(false);
    expect(fs.analyzePath(`${ROOT}/firmware/fp-info-cache`).exists).toBe(false);
    expect(fetches).toEqual([]);
  });

  it("a staged file in a folder that still owes others is not fetched again", () => {
    const { fs, fetches } = setup(["hw/d/d.kicad_sch", "docs/a.png"]);
    expect(new TextDecoder().decode(fs.readFile(`${ROOT}/docs/a.png`))).toBe("staged");
    expect(fetches).toEqual([]);
    fs.readdir(`${ROOT}/docs`);
    expect(fetches).toEqual([{ dir: "docs", paths: ["docs/b.pdf"] }]);
    expect(new TextDecoder().decode(fs.readFile(`${ROOT}/docs/a.png`))).toBe("staged");
  });

  it("a failed fill is retried on the next look, then given up", () => {
    const { fs, lazy, fetches, log } = setup(undefined, 5);
    expect(fs.readdir(`${ROOT}/firmware`)).toEqual([]);
    expect(fs.readdir(`${ROOT}/firmware`)).toEqual([]);
    expect(fs.readdir(`${ROOT}/firmware`)).toEqual([]);
    expect(fetches).toHaveLength(2);
    expect(lazy.pending()).not.toContain("firmware");
    expect(log.some((m) => m.includes("could not be loaded"))).toBe(true);
  });

  it("peer changes: loaded paths restage now, a placeholder's wait for the folder", () => {
    const { fs, lazy, fetches } = setup(["hw/d/d.kicad_sch", "docs/a.png"]);
    expect(lazy.noteChanged("hw/d/d.kicad_sch")).toBe(true); // fully loaded folder
    expect(lazy.noteChanged("docs/a.png")).toBe(true); // staged on its own
    expect(lazy.noteChanged("docs/b.pdf")).toBe(false); // owed
    expect(lazy.noteChanged("docs/new.png")).toBe(false); // new file in a placeholder
    expect(fetches).toEqual([]);
    fs.readdir(`${ROOT}/docs`);
    expect(fetches).toEqual([{ dir: "docs", paths: ["docs/b.pdf", "docs/new.png"] }]);
    expect(lazy.noteChanged("docs/new.png")).toBe(true);
  });

  it("a peer removing a placeholder's last file leaves a plain empty folder", () => {
    const { fs, lazy, fetches } = setup();
    lazy.noteRemoved("firmware/main.c");
    expect(lazy.pending()).not.toContain("firmware");
    expect(fs.readdir(`${ROOT}/firmware`)).toEqual([]);
    expect(fetches).toEqual([]);
  });
});
