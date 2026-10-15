import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memfsFilePath } from "./constants";
import { capturePlotOutputs, isPlotOutput, PLOT_OUTPUT_SETTLE_MS } from "./plot-outputs";
import type { SaveOutcome } from "./save-flow";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const COMMITTED: SaveOutcome = { kind: "committed" };
const abs = (relPath: string) => memfsFilePath("s", relPath);

/** MEMFS stand-in: KiCad's fclose reaches `FS.close(stream)` with the stream's absolute path. */
function memfs() {
  const files = new Map<string, Uint8Array>();
  const FS = {
    readFile(path: string): Uint8Array {
      const f = files.get(path);
      if (!f) throw new Error("ENOENT");
      return f;
    },
    close(_stream: { path: string; isWrite: boolean }): void {},
    /** Like emscripten's: open, write, then `FS.close` through the global object. */
    writeFile(path: string, data: Uint8Array): void {
      files.set(path, data);
      FS.close({ path, isWrite: true });
    },
  };
  const original = FS.close;
  return {
    FS,
    original,
    /** KiCad writes `text` to `path` and closes the file. */
    write(path: string, text: string) {
      files.set(path, enc(text));
      FS.close({ path, isWrite: true });
    },
    /** KiCad opens `path` for reading and closes it. */
    read(path: string) {
      FS.close({ path, isWrite: false });
    },
  };
}

function setup(save = vi.fn(async (_relPath: string, _bytes: Uint8Array) => COMMITTED)) {
  const fs = memfs();
  const onStatus = vi.fn();
  const capture = capturePlotOutputs({ win: { FS: fs.FS }, slug: "s", save, log: () => {}, onStatus });
  if (!capture) throw new Error("no capture");
  const saved = () => save.mock.calls.map(([p, b]) => [p, dec(b)]);
  return { fs, save, saved, onStatus, capture };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("plot outputs reach the project (0007 P1: a plot said Done. and left nothing)", () => {
  it("knows Gerber, Gerber job and Excellon drill files", () => {
    for (const p of ["demo-F_Cu.gbr", "demo-job.gbrjob", "demo-PTH.drl", "fab/demo-NPTH.drl", "demo-drl_map.gbr", "DEMO-F_CU.GBR"]) {
      expect(isPlotOutput(p), p).toBe(true);
    }
    for (const p of ["demo.kicad_pcb", "demo-drl.rpt", "demo-F_Cu.pdf", "demo-F_Cu.gbr.tmp", "gbr"]) {
      expect(isPlotOutput(p), p).toBe(false);
    }
  });

  it("hands every Gerber, job and drill file KiCad writes in the project to save, once the plot settles", async () => {
    const { fs, save, saved } = setup();
    fs.write(abs("demo-F_Cu.gbr"), "G04 F_Cu*");
    fs.write(abs("demo-job.gbrjob"), "{}");
    fs.write(abs("fab/demo-PTH.drl"), "M48");
    expect(save).not.toHaveBeenCalled(); // KiCad is still plotting
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(saved()).toEqual([
      ["demo-F_Cu.gbr", "G04 F_Cu*"],
      ["demo-job.gbrjob", "{}"],
      ["fab/demo-PTH.drl", "M48"],
    ]);
  });

  it("ignores files KiCad only read, other file types and files outside the project", async () => {
    const { fs, save } = setup();
    fs.write(abs("demo-F_Cu.gbr"), "G04*");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    save.mockClear();
    fs.read(abs("demo-F_Cu.gbr"));
    fs.write(abs("demo.kicad_pcb"), "(kicad_pcb)");
    fs.write(abs("demo-drl.rpt"), "report");
    fs.write("/tmp/demo-F_Cu.gbr", "G04*");
    fs.write(memfsFilePath("other", "demo-F_Cu.gbr"), "G04*");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(save).not.toHaveBeenCalled();
  });

  it("a file written twice in one plot is saved once, with its last bytes", async () => {
    const { fs, saved } = setup();
    fs.write(abs("demo-F_Cu.gbr"), "first");
    fs.write(abs("demo-F_Cu.gbr"), "second");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(saved()).toEqual([["demo-F_Cu.gbr", "second"]]);
  });

  it("a re-plot saves again; bytes the project already has are not sent twice", async () => {
    const { fs, saved } = setup();
    fs.write(abs("demo-F_Cu.gbr"), "v1");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    fs.write(abs("demo-F_Cu.gbr"), "v1");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    fs.write(abs("demo-F_Cu.gbr"), "v2");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(saved()).toEqual([
      ["demo-F_Cu.gbr", "v1"],
      ["demo-F_Cu.gbr", "v2"],
    ]);
  });

  it("files the page stages itself (a lazy folder, a peer's plot restaged) are not echoed back", async () => {
    const { fs, save } = setup();
    fs.FS.writeFile(abs("gerbers/demo-F_Cu.gbr"), enc("from the project"));
    fs.FS.writeFile(abs("demo-PTH.drl"), enc("a peer's plot"));
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(save).not.toHaveBeenCalled();
  });

  it("reports the result on the status line", async () => {
    const { fs, onStatus } = setup();
    fs.write(abs("demo-F_Cu.gbr"), "a");
    fs.write(abs("demo-PTH.drl"), "b");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(onStatus).toHaveBeenLastCalledWith("Saved 2 fabrication files to the project ✓");
    fs.write(abs("demo-F_Cu.gbr"), "c");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(onStatus).toHaveBeenLastCalledWith("Saved demo-F_Cu.gbr to the project ✓");
  });

  it("a failed save is reported and the file is sent again by the next plot", async () => {
    const save = vi.fn(async (_relPath: string, _bytes: Uint8Array): Promise<SaveOutcome> => ({
      kind: "not-committed",
      message: "Save failed (415): demo-F_Cu.gbr",
    }));
    const { fs, onStatus } = setup(save);
    fs.write(abs("demo-F_Cu.gbr"), "v1");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(onStatus).toHaveBeenLastCalledWith("Save failed (415): demo-F_Cu.gbr");
    save.mockResolvedValue(COMMITTED);
    fs.write(abs("demo-F_Cu.gbr"), "v1");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("one plot uploads at a time: a re-plot during an upload goes out after it", async () => {
    let release!: () => void;
    const order: string[] = [];
    const save = vi.fn(async (_relPath: string, bytes: Uint8Array) => {
      order.push(`start ${dec(bytes)}`);
      if (dec(bytes) === "v1") await new Promise<void>((r) => (release = r));
      order.push(`end ${dec(bytes)}`);
      return COMMITTED;
    });
    const { fs } = setup(save);
    fs.write(abs("demo-F_Cu.gbr"), "v1");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    fs.write(abs("demo-F_Cu.gbr"), "v2");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(order).toEqual(["start v1"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start v1", "end v1", "start v2", "end v2"]);
  });

  it("stop() puts FS back and drops what is pending", async () => {
    const fs0 = memfs();
    const originalWriteFile = fs0.FS.writeFile;
    const save = vi.fn(async () => COMMITTED);
    const capture = capturePlotOutputs({ win: { FS: fs0.FS }, slug: "s", save, log: () => {} })!;
    expect(fs0.FS.close).not.toBe(fs0.original);
    fs0.write(abs("demo-F_Cu.gbr"), "v1");
    capture.stop();
    expect(fs0.FS.close).toBe(fs0.original);
    expect(fs0.FS.writeFile).toBe(originalWriteFile);
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(save).not.toHaveBeenCalled();
  });

  it("a close that fails is not recorded", async () => {
    const fs = memfs();
    fs.FS.close = () => {
      throw new Error("EBADF");
    };
    const save = vi.fn(async () => COMMITTED);
    capturePlotOutputs({ win: { FS: fs.FS }, slug: "s", save, log: () => {} });
    expect(() => fs.write(abs("demo-F_Cu.gbr"), "v1")).toThrow("EBADF");
    await vi.advanceTimersByTimeAsync(PLOT_OUTPUT_SETTLE_MS);
    expect(save).not.toHaveBeenCalled();
  });

  it("without a filesystem there is nothing to watch", () => {
    expect(capturePlotOutputs({ win: {}, slug: "s", save: vi.fn(), log: () => {} })).toBeNull();
  });
});
