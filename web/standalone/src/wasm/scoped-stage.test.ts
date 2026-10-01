import { describe, expect, it } from "vitest";
import { manifestDigest, type SyncManifest } from "@pcbjam/shared";
import { memStore } from "@pcbjam/sync-client";
import { memfsProjectDir } from "./constants";
import { fakeMemfs } from "./fake-memfs";
import { stageScoped, type DriveOptions, type ProjectSyncConfig, type ToolFile } from "./kicad-runner";
import type { LazyDirs } from "./lazy-dirs";

/**
 * Project-sync 0003, end to end below the tool: a repository-shaped project
 * (the design in hw/d, sibling designs, shared libraries, firmware) opened on
 * hw/d downloads the project folder and what the design references — and
 * nothing else until KiCad looks into another folder.
 */

const enc = new TextEncoder();
const ROOT = memfsProjectDir("proj");

const BODIES: Record<string, string> = {
  "README.md": "readme",
  "firmware/main.c": "int main;",
  "firmware/main.h": "#pragma once",
  "hw/b/b.kicad_pro": "{}",
  "hw/b/b.kicad_sch": "(kicad_sch)",
  "hw/d/d.kicad_pro": '{"schematic": {"page_layout_descr_file": "${KIPRJMOD}/../common/frame.kicad_wks"}}',
  "hw/d/d.kicad_pcb": '(kicad_pcb (footprint "shared:R" (model "${KIPRJMOD}/../libs/3d/R.step")))',
  "hw/d/notes.txt": "notes",
  "hw/d/sym-lib-table": '(sym_lib_table (lib (name "shared")(type "KiCad")(uri "${KIPRJMOD}/../libs/shared.kicad_sym")))',
  "hw/d/sheets/power.kicad_sch": '(kicad_sch (property "Sheetfile" "deep/adc.kicad_sch"))',
  "hw/d/sheets/deep/adc.kicad_sch": "(kicad_sch)",
  "hw/d/scratch/old.kicad_sch": "(kicad_sch)",
  "hw/libs/shared.kicad_sym": "(kicad_symbol_lib)",
  "hw/libs/unused.kicad_sym": "(kicad_symbol_lib)",
  "hw/libs/3d/R.step": "STEP",
  "hw/libs/3d/R.wrl": "WRL",
  "hw/common/frame.kicad_wks": "(kicad_wks)",
};
const TARGET = "hw/d/d.kicad_sch";
const TARGET_TEXT = '(kicad_sch (sheet (property "Sheetfile" "sheets/power.kicad_sch")))';

function fakeServer() {
  const manifest: SyncManifest = { version: 1, entries: {} };
  for (const [path, text] of Object.entries(BODIES)) {
    manifest.entries[path] = { hash: `r1:u${path.length}`, size: enc.encode(text).length, mtime: 0 };
  }
  const bodyFetches: string[] = [];
  let manifestFetches = 0;
  let bundleFetches = 0;
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/sync/manifest")) {
      manifestFetches += 1;
      return Response.json(manifest);
    }
    if (url.endsWith("/sync/bundle")) {
      bundleFetches += 1;
      return new Response(null, { status: 500 });
    }
    const m = /\/sync\/body\/(.+)$/.exec(url);
    if (m) {
      const path = decodeURIComponent(m[1]!);
      bodyFetches.push(path);
      return new Response(enc.encode(BODIES[path]!) as BodyInit);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    manifest,
    bodyFetches,
    counters: {
      get manifestFetches() { return manifestFetches; },
      get bundleFetches() { return bundleFetches; },
    },
  };
}

function open(
  server: ReturnType<typeof fakeServer>,
  over: Partial<DriveOptions> = {},
  stores = new Map<string, ReturnType<typeof memStore>>(),
  sync: Partial<ProjectSyncConfig> = {},
) {
  const fs = fakeMemfs();
  fs.mkdirTree(ROOT);
  const files: ToolFile[] = [
    ...Object.keys(BODIES).map((path) => ({ path, revision: 1 })),
    // The target is room-backed: it comes through fetchBytes, never the namespace.
    { path: TARGET, revision: 2, hasYdoc: true },
  ];
  const perFile: string[] = [];
  const lazyFetches: Array<{ dir: string; paths: string[] }> = [];
  const progress: Array<[number, number]> = [];
  let lazy: LazyDirs | null = null;
  const projectSync: ProjectSyncConfig = {
    apiBase: "https://api.test",
    scope: "team",
    scopeId: "scope-1",
    projectId: "proj-1",
    fetchImpl: server.fetchImpl,
    storeFactory: (ns) => stores.get(ns) ?? stores.set(ns, memStore()).get(ns)!,
    ...sync,
  };
  const opts: DriveOptions = {
    tool: "eeschema",
    slug: "proj",
    files,
    targetPath: TARGET,
    fetchBytes: async (p) => {
      perFile.push(p);
      if (p === TARGET) return enc.encode(TARGET_TEXT);
      throw new Error(`unexpected per-file fetch: ${p}`);
    },
    projectSync,
    scoped: {
      fetchFolder: (dir, paths) => {
        lazyFetches.push({ dir, paths: [...paths].sort() });
        return paths.map((p) => [p, enc.encode(BODIES[p]!)]);
      },
      onLazyDirs: (l) => {
        lazy = l;
      },
    },
    log: () => {},
    onStatus: () => {},
    onFileProgress: (done, total) => progress.push([done, total]),
    ...over,
  };
  const win = { FS: fs } as unknown as ToolWindow;
  const stageOne = (path: string, bytes: Uint8Array) => {
    fs.mkdirTree(`${ROOT}/${path.slice(0, path.lastIndexOf("/"))}`);
    fs.writeFile(`${ROOT}/${path}`, bytes);
  };
  const run = stageScoped(win, opts, stageOne, () => {});
  return { fs, run, perFile, lazyFetches, lazy: () => lazy!, projectSync, stores };
}

const staged = (fs: ReturnType<typeof fakeMemfs>) =>
  Object.keys(BODIES).filter((p) => {
    // Peek without triggering a fill: a placeholder's files are not children yet.
    let node = fs.lookupPath(ROOT).node;
    for (const seg of p.split("/")) {
      const next = node.children?.get(seg);
      if (!next) return false;
      node = next;
    }
    return true;
  }).sort();

describe("scoped staging", () => {
  it("an editor downloads the project folder and what the design references — nothing else", async () => {
    const server = fakeServer();
    const s = open(server);
    await s.run;

    expect(s.perFile).toEqual([TARGET]);
    expect([...server.bodyFetches].sort()).toEqual([
      "hw/common/frame.kicad_wks", // the project file's drawing sheet
      "hw/d/d.kicad_pcb",
      "hw/d/d.kicad_pro",
      "hw/d/notes.txt", // any type: it sits in the project folder
      "hw/d/sheets/deep/adc.kicad_sch", // a sub-sheet of a sub-sheet
      "hw/d/sheets/power.kicad_sch",
      "hw/d/sym-lib-table",
      "hw/libs/3d/R.step", // the board's model, with its folder
      "hw/libs/3d/R.wrl",
      "hw/libs/shared.kicad_sym", // the lib table's library
    ]);
    expect(server.counters.bundleFetches).toBe(0);
    expect(staged(s.fs)).toEqual([...server.bodyFetches].sort());
    // Firmware, the sibling design, the unused library, the scratch sheet: placeholders.
    expect(s.lazy().pending().sort()).toEqual(["", "firmware", "hw/b", "hw/d/scratch", "hw/libs"]);
    expect(s.lazyFetches).toEqual([]);
  });

  it("looking into a placeholder loads that folder, once", async () => {
    const server = fakeServer();
    const s = open(server);
    await s.run;
    expect(s.fs.readdir(`${ROOT}/firmware`).sort()).toEqual(["main.c", "main.h"]);
    // A folder with one referenced file staged owes only the rest.
    expect(s.fs.readdir(`${ROOT}/hw/libs`).sort()).toEqual(["3d", "shared.kicad_sym", "unused.kicad_sym"]);
    s.fs.readdir(`${ROOT}/firmware`);
    expect(s.lazyFetches).toEqual([
      { dir: "firmware", paths: ["firmware/main.c", "firmware/main.h"] },
      { dir: "hw/libs", paths: ["hw/libs/unused.kicad_sym"] },
    ]);
  });

  it("a viewer downloads the project file and the design's sheets only", async () => {
    const server = fakeServer();
    const s = open(server, { viewerLocalSettings: true });
    await s.run;
    expect([...server.bodyFetches].sort()).toEqual([
      "hw/common/frame.kicad_wks",
      "hw/d/d.kicad_pcb", // the same-stem board: schematic ↔ board navigation
      "hw/d/d.kicad_pro",
      "hw/d/sheets/deep/adc.kicad_sch",
      "hw/d/sheets/power.kicad_sch",
    ]);
  });

  it("a warm reopen with the boot digest makes no request at all", async () => {
    const server = fakeServer();
    const stores = new Map<string, ReturnType<typeof memStore>>();
    await open(server, {}, stores).run;
    const bodies = server.bodyFetches.length;
    expect(server.counters.manifestFetches).toBe(1);

    const digest = await manifestDigest(server.manifest);
    const again = open(server, {}, stores, { digest });
    await again.run;
    expect(server.counters.manifestFetches).toBe(1);
    expect(server.bodyFetches.length).toBe(bodies);
    expect(staged(again.fs)).toHaveLength(bodies);
  });

  it("a sibling that cannot be read is skipped and stays owed to its folder; the target failing fails the open", async () => {
    const server = fakeServer();
    const broken = server.fetchImpl;
    const s = open(server, {}, undefined, {
      fetchImpl: (async (input: unknown, init?: RequestInit) =>
        String(input).includes("notes.txt") ? new Response(null, { status: 500 }) : broken(input as never, init)) as typeof fetch,
    });
    await s.run;
    expect(staged(s.fs)).not.toContain("hw/d/notes.txt");
    expect(s.lazy().pending()).toContain("hw/d");

    const failing = open(fakeServer(), {
      fetchBytes: async () => {
        throw new Error("room down");
      },
    });
    await expect(failing.run).rejects.toThrow(/room down/);
  });
});
