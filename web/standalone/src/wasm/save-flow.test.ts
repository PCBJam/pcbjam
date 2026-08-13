import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMFS_PROJECTS_DIR } from "./constants";
import {
  registerSaveHook,
  SAVE_COMMITTED,
  type SaveBlock,
  type SaveHookWindow,
  type SaveOutcome,
} from "./save-flow";

const SLUG = "myproj";
const HOME = MEMFS_PROJECTS_DIR; // …/projects  (editor's default "projects home")
const PROJ = `${HOME}/${SLUG}`; // …/projects/myproj  (this project's own folder)

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

function setup() {
  const saveBytes = vi.fn(async () => SAVE_COMMITTED);
  const onSaved = vi.fn();
  const win: SaveHookWindow = {
    FS: { readFile: () => new Uint8Array([1, 2, 3]) } as unknown as SaveHookWindow["FS"],
    kicadCollab: {},
  };
  registerSaveHook(win, { slug: SLUG, saveBytes, onSaved, log: () => {}, onStatus: () => {} });
  return { fire: (p: string) => win.kicadCollab!.onSave!(p), saveBytes, onSaved };
}

describe("registerSaveHook path routing", () => {
  it("routes a file in the project's own folder with its full relative path", () => {
    const { fire, saveBytes, onSaved } = setup();
    fire(`${PROJ}/sub/sheet.kicad_sch`);
    expect(onSaved).toHaveBeenCalledWith("sub/sheet.kicad_sch");
    expect(saveBytes).toHaveBeenCalledWith(
      "sub/sheet.kicad_sch",
      expect.any(Uint8Array),
      expect.any(AbortSignal),
    );
  });

  it("routes a bare file saved in the editor's default projects home to the project root", () => {
    const { fire, saveBytes, onSaved } = setup();
    fire(`${HOME}/main.kicad_sch`);
    expect(onSaved).toHaveBeenCalledWith("main.kicad_sch");
    expect(saveBytes).toHaveBeenCalledWith(
      "main.kicad_sch",
      expect.any(Uint8Array),
      expect.any(AbortSignal),
    );
  });

  it("ignores a save outside the projects tree", () => {
    const { fire, saveBytes, onSaved } = setup();
    fire(`/home/kicad/stray.kicad_sch`);
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
  });

  it("ignores a file under a DIFFERENT project's folder in the home dir", () => {
    const { fire, saveBytes, onSaved } = setup();
    fire(`${HOME}/other/board.kicad_pcb`);
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
  });

  it("onSavedText receives the decoded file text (layout save-sync, miss 08B)", () => {
    const onSavedText = vi.fn();
    const win: SaveHookWindow = {
      FS: {
        readFile: () => new TextEncoder().encode("(kicad_sch (version 1))"),
      } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      onSavedText,
      log: () => {},
      onStatus: () => {},
    });
    win.kicadCollab!.onSave!(`${PROJ}/sheet.kicad_sch`);
    expect(onSavedText).toHaveBeenCalledWith("sheet.kicad_sch", "(kicad_sch (version 1))");
  });

  it("an onSavedText read failure is logged, not thrown", () => {
    const onSavedText = vi.fn();
    const log = vi.fn();
    const win: SaveHookWindow = {
      FS: {
        readFile: () => {
          throw new Error("gone");
        },
      } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, { slug: SLUG, onSavedText, log, onStatus: () => {} });
    win.kicadCollab!.onSave!(`${PROJ}/sheet.kicad_sch`);
    expect(onSavedText).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("onSavedText read failed"));
  });
});

describe("registerSaveHook persistence ordering", () => {
  it("coalesces 1,000 same-path saves to one active and the immutable latest", async () => {
    const source = new Uint8Array([0, 0]);
    const writes: Array<{
      path: string;
      bytes: Uint8Array;
      completion: ReturnType<typeof deferred<SaveOutcome>>;
    }> = [];
    const saveBytes = vi.fn((path: string, bytes: Uint8Array) => {
      const completion = deferred<SaveOutcome>();
      writes.push({ path, bytes, completion });
      return completion.promise;
    });
    const win: SaveHookWindow = {
      FS: { readFile: () => source } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: () => {},
      onStatus: () => {},
    });

    for (let revision = 0; revision < 1_000; revision++) {
      source[0] = revision & 0xff;
      source[1] = revision >>> 8;
      win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    }

    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect([...writes[0]!.bytes]).toEqual([0, 0]);
    writes[0]!.completion.resolve(SAVE_COMMITTED);
    await flushMicrotasks();

    expect(saveBytes).toHaveBeenCalledTimes(2);
    expect(writes.map((write) => write.path)).toEqual([
      "board.kicad_pcb",
      "board.kicad_pcb",
    ]);
    expect([...writes[1]!.bytes]).toEqual([999 & 0xff, 999 >>> 8]);
    writes[1]!.completion.resolve(SAVE_COMMITTED);
    await flushMicrotasks();
    expect(saveBytes).toHaveBeenCalledTimes(2);
  });

  it("drops a not-committed latest, releases capacity, and permits an explicit retry", async () => {
    const source = new Uint8Array([1]);
    const writes: Array<{
      bytes: Uint8Array;
      completion: ReturnType<typeof deferred<SaveOutcome>>;
    }> = [];
    const saveBytes = vi.fn((_path: string, bytes: Uint8Array) => {
      const completion = deferred<SaveOutcome>();
      writes.push({ bytes, completion });
      return completion.promise;
    });
    const statuses: string[] = [];
    const win: SaveHookWindow = {
      FS: { readFile: () => source } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: () => {},
      onStatus: (status) => statuses.push(status),
      maxRetainedBytes: 2,
    });

    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    source[0] = 2;
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    writes[0]!.completion.resolve({
      kind: "not-committed",
      message: "Save rejected before publication",
    });
    await flushMicrotasks();

    // The newest status generation belongs to the pending snapshot, but it
    // cannot be promoted without proof that its predecessor committed.
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("Save rejected before publication");

    // A not-committed result is safe to retry explicitly, and both retained
    // bytes were released before this new snapshot is admitted.
    source[0] = 3;
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    expect(saveBytes).toHaveBeenCalledTimes(2);
    expect([...writes[1]!.bytes]).toEqual([3]);
    writes[1]!.completion.resolve(SAVE_COMMITTED);
    await flushMicrotasks();
    expect(statuses.at(-1)).toBe("Saved board.kicad_pcb ✓");
  });

  it("absorbs a conflict, keeps callbacks alive, and leaves other paths usable", async () => {
    const source = new Uint8Array([1]);
    const writes: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
    const saveBytes = vi.fn((_path: string, _bytes: Uint8Array) => {
      const completion = deferred<SaveOutcome>();
      writes.push(completion);
      return completion.promise;
    });
    const statuses: string[] = [];
    const blocks: SaveBlock[] = [];
    const onSaved = vi.fn();
    const onSavedText = vi.fn();
    const readFile = vi.fn(() => source);
    const win: SaveHookWindow = {
      FS: { readFile } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      onSaved,
      onSavedText,
      log: () => {},
      onStatus: (status) => statuses.push(status),
      onBlocked: (block) => blocks.push(block),
      // Active + pending fill the cap. Starting a later explicit save proves
      // conflict retirement released both snapshots exactly once.
      maxRetainedBytes: 2,
    });

    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`); // active A
    source[0] = 2;
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`); // captured B
    writes[0]!.resolve({
      kind: "conflict",
      message:
        "Save conflict: board.kicad_pcb (local base 4, server 5) — reload or merge, or save a copy",
    });
    await flushMicrotasks();

    // B was captured under revision 4. It must never be promoted or retried
    // against a merely observed remote revision.
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(blocks).toEqual([
      {
        relPath: "board.kicad_pcb",
        kind: "conflict",
        message:
          "Save conflict: board.kicad_pcb (local base 4, server 5) — reload or merge, or save a copy",
      },
    ]);
    expect(statuses.at(-1)).toContain("reload or merge");

    // A third native Save notification still feeds collaboration callbacks,
    // but the poisoned path does not read a persistence snapshot or call PUT.
    source[0] = 3;
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    expect(onSaved).toHaveBeenCalledTimes(3);
    expect(onSavedText).toHaveBeenCalledTimes(3);
    expect(saveBytes).toHaveBeenCalledTimes(1);
    // A and B each read once for text and once for persistence. C reads only
    // for the still-live text callback; it creates no byte snapshot.
    expect(readFile).toHaveBeenCalledTimes(5);

    // Conflict retirement released active + pending exactly once. Another
    // path can use the full one-byte capacity and remains independent.
    win.kicadCollab!.onSave!(`${PROJ}/other.kicad_sch`);
    expect(saveBytes).toHaveBeenCalledTimes(2);
    expect(saveBytes.mock.calls[1]![0]).toBe("other.kicad_sch");
    writes[1]!.resolve(SAVE_COMMITTED);
  });

  it("turns an unexpected throw into an absorbing unknown block", async () => {
    const completion = deferred<SaveOutcome>();
    const saveBytes = vi.fn(() => completion.promise);
    const onBlocked = vi.fn();
    const onSaved = vi.fn();
    const win: SaveHookWindow = {
      FS: { readFile: () => new Uint8Array([1]) } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      onSaved,
      onBlocked,
      log: () => {},
      onStatus: () => {},
    });

    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    completion.reject(new Error("connection disappeared"));
    await flushMicrotasks();

    expect(onBlocked).toHaveBeenCalledWith({
      relPath: "board.kicad_pcb",
      kind: "unknown",
      message: "Save state unknown: board.kicad_pcb — reload or save a copy",
    });
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(saveBytes).toHaveBeenCalledOnce();
  });

  it("keeps different paths concurrent", () => {
    const completions: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
    const saveBytes = vi.fn((_path: string, _bytes: Uint8Array) => {
      const completion = deferred<SaveOutcome>();
      completions.push(completion);
      return completion.promise;
    });
    const win: SaveHookWindow = {
      FS: { readFile: () => new Uint8Array([1]) } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: () => {},
      onStatus: () => {},
    });

    win.kicadCollab!.onSave!(`${PROJ}/a.kicad_sch`);
    win.kicadCollab!.onSave!(`${PROJ}/b.kicad_sch`);

    expect(saveBytes).toHaveBeenCalledTimes(2);
    expect(saveBytes.mock.calls.map(([path]) => path)).toEqual([
      "a.kicad_sch",
      "b.kicad_sch",
    ]);
    for (const completion of completions) completion.resolve(SAVE_COMMITTED);
  });

  it("does not let an older completion or clear timer overwrite newer status", async () => {
    vi.useFakeTimers();
    const completions = new Map<string, ReturnType<typeof deferred<SaveOutcome>>>();
    const saveBytes = vi.fn((path: string) => {
      const completion = deferred<SaveOutcome>();
      completions.set(path, completion);
      return completion.promise;
    });
    const statuses: string[] = [];
    const win: SaveHookWindow = {
      FS: { readFile: () => new Uint8Array([1]) } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: () => {},
      onStatus: (status) => statuses.push(status),
    });

    win.kicadCollab!.onSave!(`${PROJ}/old.kicad_sch`);
    win.kicadCollab!.onSave!(`${PROJ}/new.kicad_sch`);
    completions.get("new.kicad_sch")!.resolve(SAVE_COMMITTED);
    await flushMicrotasks();
    expect(statuses.at(-1)).toBe("Saved new.kicad_sch ✓");

    completions.get("old.kicad_sch")!.resolve(SAVE_COMMITTED);
    await flushMicrotasks();
    expect(statuses.at(-1)).toBe("Saved new.kicad_sch ✓");

    await vi.advanceTimersByTimeAsync(2500);
    expect(statuses.at(-1)).toBe("");
  });

  it("refuses excess retained bytes and excess distinct paths before copying", async () => {
    const source = new Uint8Array([1, 2]);
    const completions: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
    const saveBytes = vi.fn(() => {
      const completion = deferred<SaveOutcome>();
      completions.push(completion);
      return completion.promise;
    });
    const logs: string[] = [];
    const statuses: string[] = [];
    const win: SaveHookWindow = {
      FS: { readFile: () => source } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: (line) => logs.push(line),
      onStatus: (status) => statuses.push(status),
      maxRetainedBytes: 2,
      maxPaths: 1,
    });

    win.kicadCollab!.onSave!(`${PROJ}/a.kicad_sch`);
    win.kicadCollab!.onSave!(`${PROJ}/b.kicad_sch`);
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toContain("1 active paths");
    expect(statuses.at(-1)).toContain("queue is full");

    // A newer same-path revision replaces the pending slot, but the active
    // two-byte snapshot already owns the complete byte budget.
    source[0] = 3;
    win.kicadCollab!.onSave!(`${PROJ}/a.kicad_sch`);
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toContain("retained bytes");

    completions[0]!.resolve(SAVE_COMMITTED);
    await flushMicrotasks();
    win.kicadCollab!.onSave!(`${PROJ}/b.kicad_sch`);
    expect(saveBytes).toHaveBeenCalledTimes(2);
    completions[1]!.resolve(SAVE_COMMITTED);
  });
});

describe("registerSaveHook lifetime", () => {
  it("aborts the active transport, drops pending and makes completion inert", async () => {
    const source = new Uint8Array([1]);
    const active = deferred<SaveOutcome>();
    let activeSignal: AbortSignal | undefined;
    const saveBytes = vi.fn(
      (_path: string, _bytes: Uint8Array, signal?: AbortSignal) => {
        activeSignal = signal;
        return active.promise;
      },
    );
    const statuses: string[] = [];
    const logs: string[] = [];
    const win: SaveHookWindow = {
      FS: { readFile: () => source } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    const handle = registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: (line) => logs.push(line),
      onStatus: (status) => statuses.push(status),
    });

    const installed = win.kicadCollab!.onSave!;
    installed(`${PROJ}/board.kicad_pcb`);
    source[0] = 2;
    installed(`${PROJ}/board.kicad_pcb`);
    expect(saveBytes).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(activeSignal?.aborted).toBe(true);
    expect(win.kicadCollab!.onSave).toBeUndefined();
    installed(`${PROJ}/ignored.kicad_pcb`);
    active.resolve(SAVE_COMMITTED);
    await flushMicrotasks();

    // The pending revision never starts, and the already-running revision does
    // not report through the retired component lifetime when it settles.
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      "Saving board.kicad_pcb…",
      "Saving board.kicad_pcb…",
    ]);
    expect(logs).toEqual([]);
  });

  it("does not start a queued latest write when stop aborts the active one", async () => {
    const source = new Uint8Array([1]);
    const active = deferred<SaveOutcome>();
    const saveBytes = vi.fn(() => active.promise);
    const win: SaveHookWindow = {
      FS: { readFile: () => source } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    const handle = registerSaveHook(win, {
      slug: SLUG,
      saveBytes,
      log: () => {},
      onStatus: () => {},
    });

    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    source[0] = 2;
    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    handle.stop();
    active.reject(new DOMException("Aborted", "AbortError"));
    await flushMicrotasks();

    expect(saveBytes).toHaveBeenCalledOnce();
  });

  it("does not detach a replacement hook and gives the remount a fresh cap", () => {
    const oldWrite = deferred<SaveOutcome>();
    const oldSave = vi.fn(() => oldWrite.promise);
    const newSave = vi.fn(async () => SAVE_COMMITTED);
    const win: SaveHookWindow = {
      FS: { readFile: () => new Uint8Array([1, 2]) } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    const oldHandle = registerSaveHook(win, {
      slug: SLUG,
      saveBytes: oldSave,
      log: () => {},
      onStatus: () => {},
      maxRetainedBytes: 2,
      maxPaths: 1,
    });
    win.kicadCollab!.onSave!(`${PROJ}/old.kicad_sch`);

    const newHandle = registerSaveHook(win, {
      slug: SLUG,
      saveBytes: newSave,
      log: () => {},
      onStatus: () => {},
      maxRetainedBytes: 2,
      maxPaths: 1,
    });
    const replacement = win.kicadCollab!.onSave;
    oldHandle.stop();

    expect(win.kicadCollab!.onSave).toBe(replacement);
    win.kicadCollab!.onSave!(`${PROJ}/new.kicad_sch`);
    expect(newSave).toHaveBeenCalledOnce();
    newHandle.stop();
    expect(win.kicadCollab!.onSave).toBeUndefined();
    oldWrite.resolve(SAVE_COMMITTED);
  });

  it("cancels a pending success-clear timer on stop", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const win: SaveHookWindow = {
      FS: { readFile: () => new Uint8Array([1]) } as unknown as SaveHookWindow["FS"],
      kicadCollab: {},
    };
    const handle = registerSaveHook(win, {
      slug: SLUG,
      saveBytes: async () => SAVE_COMMITTED,
      log: () => {},
      onStatus: (status) => statuses.push(status),
    });

    win.kicadCollab!.onSave!(`${PROJ}/board.kicad_pcb`);
    await flushMicrotasks();
    expect(statuses.at(-1)).toBe("Saved board.kicad_pcb ✓");
    expect(vi.getTimerCount()).toBe(1);

    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(statuses.at(-1)).toBe("Saved board.kicad_pcb ✓");
  });
});
