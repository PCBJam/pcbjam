import { describe, expect, it } from "vitest";
import { driveProjectIntoTool, type DriveOptions } from "./kicad-runner";
import { memfsFilePath } from "./constants";

/**
 * Findings Q-2 (docs/features/findings/groups/Q-…): a 404 on a NON-TARGET
 * sibling must degrade, not abort the open. Today `syncProjectToMemfs`
 * rethrows the first rejected fetch, so one missing `.kicad_sch` beside the
 * board (or a Q-1 phantom row the listing invented) takes the whole editor
 * boot down behind a "download failed (404)" that reads as corruption.
 * The TARGET file failing must still reject — there is nothing to open.
 */

interface FakeFS {
  files: Map<string, Uint8Array>;
}

function fakeWin(): { win: Parameters<typeof driveProjectIntoTool>[0]; fs: FakeFS } {
  const fs: FakeFS = { files: new Map() };
  const win = {
    FS: {
      writeFile: (path: string, data: Uint8Array) => {
        fs.files.set(path, data);
      },
      mkdirTree: () => {},
      readFile: () => new Uint8Array(),
      analyzePath: () => ({ exists: false }),
    },
  } as unknown as Parameters<typeof driveProjectIntoTool>[0];
  return { win, fs };
}

function opts(
  files: string[],
  fetchBytes: DriveOptions["fetchBytes"],
  extra: Partial<DriveOptions> = {},
): DriveOptions {
  return {
    tool: "pcbnew",
    slug: "proj",
    files: files.map((path) => ({ path })),
    fetchBytes,
    log: () => {},
    onStatus: () => {},
    ...extra,
  };
}

describe("Q-2 · sibling fetch failures during MEMFS staging", () => {
  it("a 404 on a non-target sibling is logged and skipped; every other file still stages", async () => {
    const { win, fs } = fakeWin();
    const files = ["board.kicad_pcb", "board.kicad_sch", "sub sheet.kicad_sch"];
    const logs: string[] = [];
    // No targetPath → the run stops after staging (no open flow), like the
    // sibling tests in kicad-runner.test.ts. The failing file is NOT the
    // target here either way.
    await driveProjectIntoTool(
      win,
      opts(
        files,
        async (p) => {
          if (p === "sub sheet.kicad_sch") {
            throw new Error(`download failed (404): ${p}`);
          }
          return new TextEncoder().encode(`body:${p}`);
        },
        { log: (m) => logs.push(m) },
      ),
    );

    expect(fs.files.has(memfsFilePath("proj", "board.kicad_pcb"))).toBe(true);
    expect(fs.files.has(memfsFilePath("proj", "board.kicad_sch"))).toBe(true);
    expect(fs.files.has(memfsFilePath("proj", "sub sheet.kicad_sch"))).toBe(false);
    expect(logs.some((l) => l.includes("sub sheet.kicad_sch") && l.includes("404"))).toBe(
      true,
    );
  });

  it("the target file failing still rejects (nothing to open)", async () => {
    const { win } = fakeWin();
    await expect(
      driveProjectIntoTool(
        win,
        opts(
          ["board.kicad_pcb", "board.kicad_sch"],
          async (p) => {
            if (p === "board.kicad_pcb") throw new Error(`download failed (404): ${p}`);
            return new TextEncoder().encode(`body:${p}`);
          },
          { targetPath: "board.kicad_pcb" },
        ),
      ),
    ).rejects.toThrow("board.kicad_pcb");
  });
});
