import { describe, expect, it, vi } from "vitest";
import {
  driveProjectIntoTool,
  restageBytesFileAsOwner,
  restageTextFileAsOwner,
  type DriveOptions,
} from "./kicad-runner";
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

type PendingOwnerJob = {
  label: string;
  run: (...args: unknown[]) => unknown;
  args: unknown[];
  isCurrent: (() => boolean) | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  result?: unknown;
};

/** Scheduler double with separate enqueue, admission, and retirement edges. */
function controlledOwnerWin(nativeRuntimeReady = true) {
  const { win, fs } = fakeWin();
  if (nativeRuntimeReady) win.__pcbjamNativeRuntimeReady = true;
  const pending: PendingOwnerJob[] = [];
  let active: PendingOwnerJob | null = null;

  (
    win as unknown as {
      __wxScheduler: {
        canTouchNative: () => boolean;
        _enqueueMutator: (
          label: string,
          run: (...args: unknown[]) => unknown,
          args: unknown[],
          isCurrent: (() => boolean) | null,
        ) => Promise<unknown>;
      };
    }
  ).__wxScheduler = {
    canTouchNative: () => true,
    _enqueueMutator(label, run, args, isCurrent) {
      return new Promise((resolve, reject) => {
        pending.push({ label, run, args, isCurrent, resolve, reject });
      });
    },
  };

  const admitNext = (): PendingOwnerJob => {
    if (active) throw new Error("an owner job is already active");
    const job = pending.shift();
    if (!job) throw new Error("no owner job is pending");
    if (job.isCurrent && !job.isCurrent()) {
      job.reject(
        Object.assign(new Error("stale resource-affine mutator"), {
          code: "WX_MUTATOR_STALE",
        }),
      );
      return job;
    }
    active = job;
    try {
      job.result = job.run(...job.args);
    } catch (error) {
      active = null;
      job.reject(error);
    }
    return job;
  };

  const retire = (): void => {
    if (!active) throw new Error("no owner job is active");
    const job = active;
    active = null;
    job.resolve(job.result);
  };

  return { win, fs, pending, admitNext, retire };
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
  it("uses the explicit runtime edge across concurrent out-of-order completions", async () => {
    const h = controlledOwnerWin(false);
    const files = ["a.kicad_sym", "b.kicad_sym", "c.kicad_sym"];
    const started: string[] = [];
    const complete = new Map<string, (bytes: Uint8Array) => void>();

    const drive = driveProjectIntoTool(
      h.win,
      opts(files, (path) => {
        started.push(path);
        return new Promise<Uint8Array>((resolve) => complete.set(path, resolve));
      }),
    );

    await vi.waitFor(() => expect(started).toEqual(files));
    complete.get("b.kicad_sym")!(new Uint8Array([2]));
    await vi.waitFor(() => expect(h.fs.files.size).toBe(1));
    // FS and a scheduler object already exist, but absent explicit readiness
    // means pre-native. The early write finishes directly and queues nothing.
    expect(h.pending).toHaveLength(0);
    expect(h.fs.files.get(memfsFilePath("proj", "b.kicad_sym"))).toEqual(
      new Uint8Array([2]),
    );

    h.win.__pcbjamNativeRuntimeReady = true;
    complete.get("c.kicad_sym")!(new Uint8Array([3]));
    complete.get("a.kicad_sym")!(new Uint8Array([1]));
    await vi.waitFor(() =>
      expect(h.pending.map((job) => job.label)).toEqual([
        "project MEMFS restage: c.kicad_sym",
      ]),
    );
    // A post-edge enqueue is not native admission. The late files have not
    // touched MEMFS, and the one early file remains the only publication.
    expect(h.fs.files.size).toBe(1);

    h.admitNext();
    expect(h.fs.files.size).toBe(2);
    h.retire();
    await vi.waitFor(() =>
      expect(h.pending.map((job) => job.label)).toEqual([
        "project MEMFS restage: a.kicad_sym",
      ]),
    );
    h.admitNext();
    expect(h.fs.files.size).toBe(3);
    h.retire();
    await drive;

    expect(h.fs.files.get(memfsFilePath("proj", "a.kicad_sym"))).toEqual(
      new Uint8Array([1]),
    );
    expect(h.fs.files.get(memfsFilePath("proj", "b.kicad_sym"))).toEqual(
      new Uint8Array([2]),
    );
    expect(h.fs.files.get(memfsFilePath("proj", "c.kicad_sym"))).toEqual(
      new Uint8Array([3]),
    );
  });

  it("does not infer owner readiness from FS or the scheduler object", async () => {
    const h = controlledOwnerWin(false);
    await restageBytesFileAsOwner(
      h.win,
      "proj",
      "early.kicad_sch",
      new Uint8Array([4, 5, 6]),
      () => {},
    );

    expect(h.pending).toHaveLength(0);
    expect(h.fs.files.get(memfsFilePath("proj", "early.kicad_sch"))).toEqual(
      new Uint8Array([4, 5, 6]),
    );
  });

  it("checks the exact project lifetime at owner admission and drops a stale fetch", async () => {
    const h = controlledOwnerWin();
    let current = true;
    let finishFetch!: (bytes: Uint8Array) => void;
    const drive = driveProjectIntoTool(h.win, {
      ...opts(
        ["old.kicad_pcb"],
        () => new Promise<Uint8Array>((resolve) => (finishFetch = resolve)),
      ),
      isCurrent: () => current,
    });
    const rejected = expect(drive).rejects.toMatchObject({
      code: "WX_MUTATOR_STALE",
    });

    await vi.waitFor(() => expect(finishFetch).toBeTypeOf("function"));
    finishFetch(new Uint8Array([9, 8, 7]));
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    current = false;
    h.admitNext();

    await rejected;
    expect(h.fs.files.size).toBe(0);
    expect(h.fs.dirs.size).toBe(0);
  });

  it("checks the project lifetime before a pre-native direct write", async () => {
    const h = controlledOwnerWin(false);
    await expect(
      restageBytesFileAsOwner(
        h.win,
        "proj",
        "stale-early.kicad_sch",
        new Uint8Array([1]),
        () => {},
        () => false,
      ),
    ).rejects.toMatchObject({ code: "WX_MUTATOR_STALE" });

    expect(h.pending).toHaveLength(0);
    expect(h.fs.files.size).toBe(0);
    expect(h.fs.dirs.size).toBe(0);
  });

  it("copies mutable fetch bytes before they wait for owner admission", async () => {
    const h = controlledOwnerWin();
    const fetched = new Uint8Array([0, 127, 128, 255, 17]);
    const restage = restageBytesFileAsOwner(
      h.win,
      "proj",
      "binary.kicad_pcb",
      fetched,
      () => {},
    );

    fetched.fill(42);
    expect(h.fs.files.size).toBe(0);
    h.admitNext();
    expect(h.fs.files.get(memfsFilePath("proj", "binary.kicad_pcb"))).toEqual(
      new Uint8Array([0, 127, 128, 255, 17]),
    );
    h.retire();
    await restage;
  });

  it("performs a live text write inside the owner ticket", async () => {
    const { win, fs } = fakeWin();
    let admit!: () => void;
    let retire!: () => void;
    let settled = false;
    let result: unknown;
    let resolveTicket!: (value: unknown) => void;
    let rejectTicket!: (error: unknown) => void;

    (
      win as unknown as {
        __wxScheduler: {
          canTouchNative: () => boolean;
          _enqueueMutator: (
            label: string,
            run: (...args: unknown[]) => unknown,
            args: unknown[],
            isCurrent: (() => boolean) | null,
          ) => Promise<unknown>;
        };
      }
    ).__wxScheduler = {
      canTouchNative: () => true,
      _enqueueMutator(label, run, args, isCurrent) {
        expect(label).toBe("sibling MEMFS restage: main.kicad_sch");
        expect(args).toEqual(["latest body"]); // retained-payload accounting
        const ticket = new Promise((resolve, reject) => {
          resolveTicket = resolve;
          rejectTicket = reject;
        });
        admit = () => {
          if (isCurrent && !isCurrent()) {
            rejectTicket(new Error("stale"));
            return;
          }
          try {
            result = run(...args);
          } catch (error) {
            rejectTicket(error);
          }
        };
        // The real gateway resolves only after this ticket's native owner
        // retires, not merely when the JavaScript closure returns.
        retire = () => resolveTicket(result);
        return ticket;
      },
    };

    const restage = restageTextFileAsOwner(
      win,
      "proj",
      "main.kicad_sch",
      "latest body",
      () => {},
      () => true,
    ).then(() => {
      settled = true;
    });

    expect(fs.files.size).toBe(0);
    admit();
    expect(
      new TextDecoder().decode(
        fs.files.get(memfsFilePath("proj", "main.kicad_sch"))!,
      ),
    ).toBe("latest body");
    expect(settled).toBe(false);
    retire();
    await restage;
    expect(settled).toBe(true);
  });

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

  it("reports per-file progress from 0 up to the total", async () => {
    const { win } = fakeWin();
    const files = ["a.kicad_sym", "b.kicad_sym", "c.kicad_sym"];
    const seen: Array<[number, number]> = [];

    await driveProjectIntoTool(win, {
      ...opts(files, async () => new Uint8Array([1])),
      onFileProgress: (done, total) => seen.push([done, total]),
    });

    // One up-front (0, total) so the line shows immediately, then one tick per
    // staged file, ending exactly at the total.
    expect(seen[0]).toEqual([0, files.length]);
    expect(seen).toHaveLength(files.length + 1);
    expect(seen.map(([done]) => done).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(seen.at(-1)?.[1]).toBe(files.length);
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
