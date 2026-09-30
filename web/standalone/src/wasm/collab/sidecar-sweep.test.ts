import { describe, expect, it, vi } from "vitest";
import { memfsFilePath } from "../constants";
import { boardSidecarPaths, createSidecarSweep } from "./sidecar-sweep";

function memfs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  return {
    files,
    FS: {
      readFile(path: string): Uint8Array {
        const f = files.get(path);
        if (!f) throw new Error("ENOENT");
        return f;
      },
    },
  };
}

describe("sidecar sweep (proposal 21 S6: custom rules were never persisted)", () => {
  const dru = "b/board.kicad_dru";
  const abs = memfsFilePath("s", dru);

  it("derives the rules file from the board stem", () => {
    expect(boardSidecarPaths("b/board.kicad_pcb")).toEqual([dru]);
    expect(boardSidecarPaths("x.kicad_sch")).toEqual([]);
  });

  it("hands a rules file the Custom Rules panel rewrote to the save hook — once", () => {
    const fs = memfs({ [abs]: "(version 1)" });
    const onSave = vi.fn();
    const sweep = createSidecarSweep({ win: { FS: fs.FS, kicadCollab: { onSave } }, slug: "s", paths: [dru], log: () => {} });
    expect(sweep.sweep("board save")).toEqual([]); // untouched since staging
    fs.files.set(abs, new TextEncoder().encode("(version 1) (rule a)"));
    expect(sweep.sweep("board save")).toEqual([dru]);
    expect(onSave).toHaveBeenCalledWith(abs);
    expect(sweep.sweep("board save")).toEqual([]); // no double upload
  });

  it("uploads a rules file created after staging", () => {
    const fs = memfs({});
    const onSave = vi.fn();
    const sweep = createSidecarSweep({ win: { FS: fs.FS, kicadCollab: { onSave } }, slug: "s", paths: [dru], log: () => {} });
    fs.files.set(abs, new TextEncoder().encode("(version 1)"));
    expect(sweep.sweep("board save")).toEqual([dru]);
  });

  it("a peer's restaged version is not echoed back as an upload", () => {
    const fs = memfs({ [abs]: "(version 1)" });
    const onSave = vi.fn();
    const sweep = createSidecarSweep({ win: { FS: fs.FS, kicadCollab: { onSave } }, slug: "s", paths: [dru], log: () => {} });
    const peer = new TextEncoder().encode("(version 1) (rule peer)");
    fs.files.set(abs, peer);
    sweep.noteRestaged(dru, peer);
    expect(sweep.sweep("board save")).toEqual([]);
    expect(onSave).not.toHaveBeenCalled();
  });
});
