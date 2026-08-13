import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeImageBitmap = { close: ReturnType<typeof vi.fn> };
type FakeWxModule = {
  HEAPU8: Uint8Array;
  canvas: {
    addEventListener(name: string, fn: (event: unknown) => void): void;
    getBoundingClientRect(): { left: number; top: number };
  };
  _wx_file_drop_stage: () => number;
  wxDiscardFileDropBatches(): void;
  wxFileDropPendingBytes(): number;
};

function loadWxBridge() {
  const source = readFileSync(
    new URL("../../../../wxwidgets/build/wasm/wx.js", import.meta.url),
    "utf8",
  );
  const creations: Deferred<FakeImageBitmap>[] = [];
  const warnings: unknown[][] = [];

  class FakeImageData {
    data: Uint8ClampedArray;

    constructor(width: number, height: number) {
      this.data = new Uint8ClampedArray(4 * width * height);
    }
  }

  const sandbox = vm.createContext({
    Module: { HEAPU8: new Uint8Array(64) },
    ImageData: FakeImageData,
    createImageBitmap: () => {
      const next = deferred<FakeImageBitmap>();
      creations.push(next);
      return next.promise;
    },
    console: {
      log: () => undefined,
      error: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args),
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  vm.runInContext(source, sandbox, { filename: "wx.js" });

  return {
    creations,
    warnings,
    set(id: number, dataOffset: number) {
      vm.runInContext(`setBitmapData(${id}, 1, 1, ${dataOffset}, 1)`, sandbox);
    },
    destroy(id: number) {
      vm.runInContext(`destroyBitmap(${id})`, sandbox);
    },
    discardAll() {
      vm.runInContext(`Module.wxDiscardBitmapResources()`, sandbox);
    },
    current(id: number): FakeImageBitmap | null | undefined {
      return vm.runInContext(`bitmapMap.get(${id})?.imageBitmap`, sandbox) as
        | FakeImageBitmap
        | null
        | undefined;
    },
  };
}

function loadDropBridge() {
  const source = readFileSync(
    new URL("../../../../wxwidgets/build/wasm/wx.js", import.meta.url),
    "utf8",
  );
  const reads: Deferred<ArrayBuffer>[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const canvas = {
    addEventListener(name: string, fn: (event: unknown) => void) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const stageOld = vi.fn(() => 1);
  const stageNew = vi.fn(() => 1);
  const makeModule = (stage: () => number) => ({
    HEAPU8: new Uint8Array(64),
    canvas,
    _wx_file_drop_stage: stage,
  }) as FakeWxModule;
  const oldModule = makeModule(stageOld);
  const scheduler = {
    dead: false,
    canTouchNative: () => true,
    runNativeIngressReceipt: (_site: string, fn: (token: number) => number) => fn(51),
  };
  const sandbox = vm.createContext({
    Module: oldModule,
    __wxScheduler: scheduler,
    ImageData: class {
      data = new Uint8ClampedArray(4);
    },
    createImageBitmap: () => Promise.reject(new Error("unused")),
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  vm.runInContext(source, sandbox, { filename: "wx-old.js" });
  vm.runInContext("registerDragDropHandlers()", sandbox);

  return {
    oldModule,
    stageOld,
    stageNew,
    dispatchFiles(files: Array<{
      name: string;
      size: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }>) {
      const event = {
        dataTransfer: { files },
        clientX: 1,
        clientY: 2,
      };
      const dropHandlers = handlers.get("drop") ?? [];
      dropHandlers[dropHandlers.length - 1]!(event);
    },
    startOldRead() {
      const read = deferred<ArrayBuffer>();
      reads.push(read);
      const event = {
        dataTransfer: {
          files: [{ name: "old.bin", size: 4, arrayBuffer: () => read.promise }],
        },
        clientX: 1,
        clientY: 2,
      };
      const dropHandlers = handlers.get("drop") ?? [];
      dropHandlers[dropHandlers.length - 1]!(event);
      return read;
    },
    installReplacementAndReserve() {
      const newModule = makeModule(stageNew);
      (sandbox as Record<string, unknown>).Module = newModule;
      vm.runInContext(source, sandbox, { filename: "wx-new.js" });
      vm.runInContext("reserveDropBatch(dropLifetime, [{ size: 4 }])", sandbox);
      return newModule;
    },
  };
}

function loadGLTimerBridge() {
  const source = readFileSync(
    new URL("../../../../wxwidgets/build/wasm/wx.js", import.meta.url),
    "utf8",
  );
  type TimerRecord = { kind: "interval" | "timeout"; fn: () => void };
  const timers = new Map<number, TimerRecord>();
  let nextTimer = 1;
  const makeGL = () => ({
    currentContext: null,
    newRenderingFrameStarted: vi.fn(),
    _wxPatched: false,
  });
  const makeModule = () => ({ HEAPU8: new Uint8Array(64) }) as {
    HEAPU8: Uint8Array;
    wxDiscardGLPatchTimer(): void;
  };
  const oldModule = makeModule();
  const sandbox = vm.createContext({
    Module: oldModule,
    ImageData: class {
      data = new Uint8ClampedArray(4);
    },
    createImageBitmap: () => Promise.reject(new Error("unused")),
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
    setInterval: (fn: () => void) => {
      const id = nextTimer++;
      timers.set(id, { kind: "interval", fn });
      return id;
    },
    clearInterval: (id: number) => void timers.delete(id),
    setTimeout: (fn: () => void) => {
      const id = nextTimer++;
      timers.set(id, { kind: "timeout", fn });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
  });

  vm.runInContext(source, sandbox, { filename: "wx-gl-old.js" });
  const oldTimerIds = [...timers.keys()];
  const oldCallbacks = oldTimerIds.map((id) => timers.get(id)!.fn);

  const replacementModule = makeModule();
  (sandbox as Record<string, unknown>).Module = replacementModule;
  vm.runInContext(source, sandbox, { filename: "wx-gl-new.js" });

  return {
    oldModule,
    replacementModule,
    timers,
    oldTimerIds,
    oldCallbacks,
    setGL(gl: ReturnType<typeof makeGL>) {
      (sandbox as Record<string, unknown>).GL = gl;
    },
    makeGL,
  };
}

async function flushPromiseReactions(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("wx bitmap asynchronous generation", () => {
  it("keeps the newest pixels when createImageBitmap resolves out of order", async () => {
    const h = loadWxBridge();
    h.set(7, 0);
    h.set(7, 4);

    const oldImage: FakeImageBitmap = { close: vi.fn() };
    const newImage: FakeImageBitmap = { close: vi.fn() };
    h.creations[1]!.resolve(newImage);
    await flushPromiseReactions();
    expect(h.current(7)).toBe(newImage);

    h.creations[0]!.resolve(oldImage);
    await flushPromiseReactions();
    expect(h.current(7)).toBe(newImage);
    expect(oldImage.close).toHaveBeenCalledOnce();
    expect(newImage.close).not.toHaveBeenCalled();
  });

  it("closes replaced and destroyed browser resources and observes rejection", async () => {
    const h = loadWxBridge();
    h.set(9, 0);
    const firstImage: FakeImageBitmap = { close: vi.fn() };
    h.creations[0]!.resolve(firstImage);
    await flushPromiseReactions();

    h.set(9, 4);
    expect(firstImage.close).toHaveBeenCalledOnce();
    h.creations[1]!.reject(new Error("decode failed"));
    await flushPromiseReactions();
    expect(h.warnings).toHaveLength(1);
    expect(String(h.warnings[0]![0])).toContain("createImageBitmap failed");

    h.set(9, 8);
    const afterDestroy: FakeImageBitmap = { close: vi.fn() };
    h.destroy(9);
    h.creations[2]!.resolve(afterDestroy);
    await flushPromiseReactions();
    expect(h.current(9)).toBeUndefined();
    expect(afterDestroy.close).toHaveBeenCalledOnce();
  });

  it("makes published and pending conversions inert at terminal cleanup", async () => {
    const h = loadWxBridge();
    h.set(11, 0);
    const published: FakeImageBitmap = { close: vi.fn() };
    h.creations[0]!.resolve(published);
    await flushPromiseReactions();

    h.set(12, 4);
    h.discardAll();
    expect(published.close).toHaveBeenCalledOnce();

    const late: FakeImageBitmap = { close: vi.fn() };
    h.creations[1]!.resolve(late);
    await flushPromiseReactions();
    expect(h.current(11)).toBeUndefined();
    expect(h.current(12)).toBeUndefined();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it("keeps worker browser launches on the owner-aware pending-event path", () => {
    const source = readFileSync(
      new URL("../../../../wxwidgets/src/wasm/utils.cpp", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("emscripten_async_run_in_main_runtime_thread");
    expect(source.match(/wxTheApp->CallAfter/g)).toHaveLength(2);
  });
});

describe("wx file-drop module lifetime", () => {
  it("keeps a failed batch reserved until every non-cancellable read settles", async () => {
    const h = loadDropBridge();
    const slowRead = deferred<ArrayBuffer>();
    const bypassRead = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const mib = 1024 * 1024;

    h.dispatchFiles([
      { name: "slow.bin", size: 200 * mib, arrayBuffer: () => slowRead.promise },
      { name: "failed.bin", size: 1, arrayBuffer: () => Promise.reject(new Error("read failed")) },
    ]);
    await flushPromiseReactions();
    expect(h.oldModule.wxFileDropPendingBytes()).toBe(200 * mib + 1);

    // The failure is known, but the slow read is still live and cannot be
    // cancelled. Its reservation must prevent another 100 MiB read from
    // starting and exceeding the shared 256 MiB bound.
    h.dispatchFiles([
      { name: "bypass.bin", size: 100 * mib, arrayBuffer: bypassRead },
    ]);
    await flushPromiseReactions();
    expect(bypassRead).not.toHaveBeenCalled();
    expect(h.oldModule.wxFileDropPendingBytes()).toBe(200 * mib + 1);

    slowRead.resolve(new ArrayBuffer(0));
    await flushPromiseReactions();
    await flushPromiseReactions();
    expect(h.oldModule.wxFileDropPendingBytes()).toBe(0);
    expect(h.stageOld).not.toHaveBeenCalled();
  });

  it("cannot publish or release an old read into a replacement token generation", async () => {
    const h = loadDropBridge();
    const oldRead = h.startOldRead();
    expect(h.oldModule.wxFileDropPendingBytes()).toBe(4);

    const replacement = h.installReplacementAndReserve();
    expect(replacement.wxFileDropPendingBytes()).toBe(4);

    // The old cleanup closure must remain bound to the old map even though
    // wx.js has redefined its globals and restarted drop tokens at one.
    h.oldModule.wxDiscardFileDropBatches();
    expect(replacement.wxFileDropPendingBytes()).toBe(4);

    oldRead.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    await flushPromiseReactions();
    await flushPromiseReactions();
    expect(h.stageOld).not.toHaveBeenCalled();
    expect(h.stageNew).not.toHaveBeenCalled();
    expect(replacement.wxFileDropPendingBytes()).toBe(4);
  });
});

describe("wx GL patch timer lifetime", () => {
  it("cannot patch replacement GL or clear replacement timers", () => {
    const h = loadGLTimerBridge();
    const replacementTimerIds = [...h.timers.keys()].filter(
      (id) => !h.oldTimerIds.includes(id),
    );
    expect(h.oldTimerIds).toHaveLength(2);
    expect(replacementTimerIds).toHaveLength(2);

    const replacementGL = h.makeGL();
    h.setGL(replacementGL);
    h.oldCallbacks.forEach((fn) => fn());
    expect(replacementGL._wxPatched).toBe(false);
    expect(replacementTimerIds.every((id) => h.timers.has(id))).toBe(true);
    expect(h.oldTimerIds.every((id) => !h.timers.has(id))).toBe(true);

    h.replacementModule.wxDiscardGLPatchTimer();
    expect(h.timers.size).toBe(0);
    // Idempotent terminal cleanup must not affect later lifetimes.
    h.oldModule.wxDiscardGLPatchTimer();
    h.replacementModule.wxDiscardGLPatchTimer();
    expect(h.timers.size).toBe(0);
  });
});
