import { describe, expect, it } from "vitest";
import { driveProjectIntoTool, type DriveOptions } from "./kicad-runner";
import { memfsFilePath } from "./constants";

/**
 * MEMFS project staging (driveProjectIntoTool → syncProjectToMemfs).
 *
 * The staging fetch used to be serial — one full request round-trip per file,
 * which dominated the open of a many-file project (an uploaded repo). These
 * cover the concurrency contract: every file still lands, fetches overlap, the
 * overlap stays bounded, and a failed fetch still rejects.
 */

interface FakeFS {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

function fakeWin(): { win: Parameters<typeof driveProjectIntoTool>[0]; fs: FakeFS } {
  const fs: FakeFS = { files: new Map(), dirs: new Set() };
  const win = {
    FS: {
      writeFile: (path: string, data: Uint8Array) => {
        fs.files.set(path, data);
      },
      mkdirTree: (path: string) => {
        fs.dirs.add(path);
      },
      readFile: () => new Uint8Array(),
      analyzePath: () => ({ exists: false }),
    },
  } as unknown as Parameters<typeof driveProjectIntoTool>[0];
  return { win, fs };
}

/** Options with no targetPath, so the run stops after staging (no open flow). */
function opts(
  files: string[],
  fetchBytes: DriveOptions["fetchBytes"],
): DriveOptions {
  return {
    tool: "pcbnew",
    slug: "proj",
    files: files.map((path) => ({ path })),
    fetchBytes,
    log: () => {},
    onStatus: () => {},
  };
}

describe("MEMFS project staging", () => {
  it("stages every file, whatever order the fetches settle in", async () => {
    const { win, fs } = fakeWin();
    const files = Array.from({ length: 25 }, (_, i) => `dir${i % 4}/file${i}.kicad_sym`);
    // Reverse-staggered delays: later files resolve FIRST, so a serial
    // implementation and a parallel one produce different completion orders
    // and any order-dependent bug shows up here.
    await driveProjectIntoTool(
      win,
      opts(files, async (p) => {
        const idx = files.indexOf(p);
        await new Promise((r) => setTimeout(r, (files.length - idx) % 7));
        return new TextEncoder().encode(`body:${p}`);
      }),
    );

    expect(fs.files.size).toBe(files.length);
    for (const p of files) {
      const written = fs.files.get(memfsFilePath("proj", p));
      expect(new TextDecoder().decode(written!)).toBe(`body:${p}`);
    }
  });

  it("overlaps fetches without exceeding the concurrency cap", async () => {
    const { win } = fakeWin();
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.kicad_mod`);
    let inFlight = 0;
    let peak = 0;

    await driveProjectIntoTool(
      win,
      opts(files, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return new Uint8Array([1]);
      }),
    );

    // Parallel (the point of the change) but bounded — a serial staging peaks
    // at 1, an unbounded one at files.length.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("rejects when a fetch fails", async () => {
    const { win } = fakeWin();
    const files = ["ok1.kicad_sym", "bad.kicad_sym", "ok2.kicad_sym"];

    await expect(
      driveProjectIntoTool(
        win,
        opts(files, async (p) => {
          if (p === "bad.kicad_sym") throw new Error("fetch exploded");
          return new Uint8Array([1]);
        }),
      ),
    ).rejects.toThrow("fetch exploded");
  });
});
