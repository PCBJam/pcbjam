import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/download", () => ({ downloadBytes: vi.fn() }));
vi.mock("./libs/models-bridge", () => ({
  collectBoardModelFiles: vi.fn(async () => []),
}));
vi.mock("./occ-worker.js?raw", () => ({ default: "// fake OCC worker" }));
vi.mock("./wasm-assets", () => ({
  resolveWasmBase: vi.fn(async () => "/wasm"),
}));

import { installOccService, type OccResponse } from "./occ-service";
import { collectBoardModelFiles } from "./libs/models-bridge";
import { resolveWasmBase } from "./wasm-assets";
import { FakeWorker, waitForWorker } from "./test-utils/fake-worker";

const mockedCollectBoardModelFiles = vi.mocked(collectBoardModelFiles);
const mockedResolveWasmBase = vi.mocked(resolveWasmBase);

const TEST_MODEL_PREFETCH_TIMEOUT_MS = 500;
const TEST_BOOT_TIMEOUT_MS = 1_000;
const TEST_RESPONSE_TIMEOUT_MS = 5_000;

const loadRequest = () => ({
  kind: "loadModel" as const,
  bytes: new Uint8Array([1, 2, 3]),
  ext: "step",
});

const exportRequest = () => ({
  kind: "export" as const,
  board: new TextEncoder().encode("(kicad_pcb)"),
  jobJson: '{"type":"step"}',
  fileName: "board.step",
});

const service = () => {
  const installed = globalThis.occService;
  if (!installed) throw new Error("OCC service was not installed");
  return installed;
};

async function readyRequest(workerIndex: number): Promise<{
  worker: FakeWorker;
  request: Promise<OccResponse>;
  id: number;
}> {
  const request = service().request(loadRequest());
  const worker = await waitForWorker(workerIndex);
  worker.emitMessage({ ready: true });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
  const [{ id }] = worker.postMessage.mock.calls[0] as [{ id: number }];
  return { worker, request, id };
}

describe("OCC service worker lifetime", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    mockedCollectBoardModelFiles.mockReset();
    mockedCollectBoardModelFiles.mockResolvedValue([]);
    mockedResolveWasmBase.mockReset();
    mockedResolveWasmBase.mockResolvedValue("/wasm");
    vi.stubGlobal("window", { location: { href: "https://pcbjam.test/editor" } });
    vi.stubGlobal("Worker", FakeWorker);
    let nextBlob = 1;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:occ-test-${nextBlob++}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    delete globalThis.occService;
    installOccService(vi.fn(), {
      modelPrefetchTimeoutMs: TEST_MODEL_PREFETCH_TIMEOUT_MS,
      bootTimeoutMs: TEST_BOOT_TIMEOUT_MS,
      responseTimeoutMs: TEST_RESPONSE_TIMEOUT_MS,
    });
  });

  afterEach(() => {
    delete globalThis.occService;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bounds a never-ready generation, retires it, and boots a fresh worker", async () => {
    vi.useFakeTimers();

    const timedOut = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    const deadWorker = FakeWorker.instances[0]!;
    expect(deadWorker).toBeDefined();

    await vi.advanceTimersByTimeAsync(TEST_BOOT_TIMEOUT_MS);
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      report: expect.stringContaining(
        `occ_service boot timed out after ${TEST_BOOT_TIMEOUT_MS} ms`,
      ),
    });
    expect(deadWorker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:occ-test-1");
    expect(vi.getTimerCount()).toBe(0);

    deadWorker.emitMessage({ ready: true });

    const recovered = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    const freshWorker = FakeWorker.instances[1]!;
    expect(freshWorker).toBeDefined();
    freshWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id }] = freshWorker.postMessage.mock.calls[0] as [{ id: number }];
    freshWorker.emitMessage({ id, res: { ok: true, report: "fresh" } });

    await expect(recovered).resolves.toEqual({ ok: true, report: "fresh" });
    expect(freshWorker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds delivery resolution and never creates a late retired worker", async () => {
    vi.useFakeTimers();
    let releaseBase!: (base: string) => void;
    mockedResolveWasmBase.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        releaseBase = resolve;
      }),
    );

    const timedOut = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TEST_BOOT_TIMEOUT_MS);
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      report: expect.stringContaining(
        `occ_service boot timed out after ${TEST_BOOT_TIMEOUT_MS} ms`,
      ),
    });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    // Delivery may still finish because the underlying fetch is not abortable
    // here. Its retired generation must not create a Worker or replace the
    // fresh slot which the next exact request owns.
    releaseBase("/stale-wasm");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(0);

    const recovered = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    const freshWorker = FakeWorker.instances[0]!;
    expect(freshWorker).toBeDefined();
    freshWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id }] = freshWorker.postMessage.mock.calls[0] as [{ id: number }];
    freshWorker.emitMessage({ id, res: { ok: true, report: "fresh" } });

    await expect(recovered).resolves.toEqual({ ok: true, report: "fresh" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exports without a hung model prefetch and ignores its late result", async () => {
    vi.useFakeTimers();
    let releaseModels!: (
      models: Array<{ path: string; bytes: Uint8Array }>,
    ) => void;
    let prefetchSignal: AbortSignal | undefined;
    mockedCollectBoardModelFiles.mockImplementationOnce(
      (_board, _concurrency, signal) => {
        prefetchSignal = signal;
        return new Promise((resolve) => {
          releaseModels = resolve;
        });
      },
    );
    const input = exportRequest();
    const request = service().request(input);

    // Request fields are captured before optional asynchronous preparation.
    input.fileName = "mutated-after-dispatch.step";
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TEST_MODEL_PREFETCH_TIMEOUT_MS);
    expect(prefetchSignal?.aborted).toBe(true);
    const worker = FakeWorker.instances[0]!;
    expect(worker).toBeDefined();
    worker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [{ id, req: dispatched }] = worker.postMessage.mock.calls[0] as [
      {
        id: number;
        req: {
          kind: "export";
          fileName: string;
          models: Array<{ path: string; bytes: Uint8Array }>;
        };
      },
    ];
    expect(dispatched).not.toBe(input);
    expect(dispatched.fileName).toBe("board.step");
    expect(dispatched.models).toEqual([]);
    expect(input).not.toHaveProperty("models");

    releaseModels([
      { path: "Late.3dshapes/model.step", bytes: new Uint8Array([9]) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched.models).toEqual([]);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    worker.emitMessage({ id, res: { ok: true, report: "exported" } });
    // The timeout is no longer silent at the headline level: the export
    // report carries the omission note. (The mock feeds no progress sink,
    // hence the 0-of-0 counts here.)
    await expect(request).resolves.toEqual({
      ok: true,
      report: "exported\nmodel prefetch timed out after "
        + `${TEST_MODEL_PREFETCH_TIMEOUT_MS} ms — 0 of 0 model(s) omitted`,
      fileName: undefined,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ships the partial prefetch on timeout and reports the omission", async () => {
    // E-21: a slow-but-alive prefetch used to be all-or-nothing — the 30s
    // deadline discarded every model already collected and the export
    // completed under a bare "Export complete." A timeout must ship the
    // accepted partials and surface the omission in the report.
    vi.useFakeTimers();
    mockedCollectBoardModelFiles.mockImplementationOnce(
      (_board, _concurrency, _signal, progress) => {
        if (progress) {
          progress.totalRefs = 3;
          progress.models.push(
            { path: "PartialA.3dshapes/a.step", bytes: new Uint8Array([1]) },
            { path: "PartialB.3dshapes/b.step", bytes: new Uint8Array([2]) },
          );
        }
        return new Promise(() => undefined); // hangs past the deadline
      },
    );

    const request = service().request(exportRequest());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TEST_MODEL_PREFETCH_TIMEOUT_MS);
    const worker = FakeWorker.instances[0]!;
    expect(worker).toBeDefined();
    worker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id, req: dispatched }] = worker.postMessage.mock.calls[0] as [
      { id: number; req: { models: Array<{ path: string }> } },
    ];
    expect(dispatched.models.map((m) => m.path), "the accepted partials ship")
      .toEqual(["PartialA.3dshapes/a.step", "PartialB.3dshapes/b.step"]);

    worker.emitMessage({ id, res: { ok: true, report: "Export complete." } });
    await expect(request).resolves.toEqual({
      ok: true,
      report: "Export complete.\nmodel prefetch timed out after "
        + `${TEST_MODEL_PREFETCH_TIMEOUT_MS} ms — 1 of 3 model(s) omitted`,
      fileName: undefined,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a ready-but-silent generation and settles all concurrent ids", async () => {
    vi.useFakeTimers();

    const first = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    const deadWorker = FakeWorker.instances[0]!;
    deadWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);

    const second = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    expect(deadWorker.postMessage).toHaveBeenCalledTimes(2);
    const [{ id: firstId }] = deadWorker.postMessage.mock.calls[0] as [
      { id: number },
    ];
    const [{ id: secondId }] = deadWorker.postMessage.mock.calls[1] as [
      { id: number },
    ];
    expect(firstId).not.toBe(secondId);

    await vi.advanceTimersByTimeAsync(TEST_RESPONSE_TIMEOUT_MS);
    const timeout =
      `occ_service response timed out after ${TEST_RESPONSE_TIMEOUT_MS} ms`;
    await expect(first).resolves.toEqual({ ok: false, report: timeout });
    await expect(second).resolves.toEqual({ ok: false, report: timeout });
    expect(deadWorker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:occ-test-1");
    expect(vi.getTimerCount()).toBe(0);

    const recovered = service().request(loadRequest());
    await vi.advanceTimersByTimeAsync(0);
    const freshWorker = FakeWorker.instances[1]!;
    freshWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id: freshId }] = freshWorker.postMessage.mock.calls[0] as [
      { id: number },
    ];
    let recoveredSettled = false;
    const observed = recovered.then((response) => {
      recoveredSettled = true;
      return response;
    });

    deadWorker.emitMessage({
      id: freshId,
      res: { ok: true, report: "stale" },
    });
    await Promise.resolve();
    expect(recoveredSettled).toBe(false);
    expect(freshWorker.terminate).not.toHaveBeenCalled();

    freshWorker.emitMessage({
      id: freshId,
      res: { ok: true, report: "fresh" },
    });
    await expect(observed).resolves.toEqual({ ok: true, report: "fresh" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles every pending request on a runtime crash and restarts", async () => {
    const first = await readyRequest(0);
    const alsoPending = service().request(loadRequest());
    await vi.waitFor(() => expect(first.worker.postMessage).toHaveBeenCalledTimes(2));

    first.worker.emitError("wasm trap");

    await expect(first.request).resolves.toEqual({
      ok: false,
      report: "occ_service crashed: wasm trap",
    });
    await expect(alsoPending).resolves.toEqual({
      ok: false,
      report: "occ_service crashed: wasm trap",
    });
    expect(first.worker.terminate).toHaveBeenCalledTimes(1);

    const second = await readyRequest(1);
    expect(second.worker).not.toBe(first.worker);

    let secondSettled = false;
    const observedSecond = second.request.then((response) => {
      secondSettled = true;
      return response;
    });

    // A callback retained by the retired generation cannot consume the current
    // generation's request, even if it carries that request's numeric id.
    first.worker.emitMessage({
      id: second.id,
      res: { ok: true, report: "stale result" },
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    second.worker.emitMessage({
      id: second.id,
      res: { ok: true, report: "fresh result" },
    });
    await expect(observedSecond).resolves.toEqual({
      ok: true,
      report: "fresh result",
    });
  });

  it("turns a boot error into a response and keeps the next boot retryable", async () => {
    const failedRequest = service().request(loadRequest());
    const failedWorker = await waitForWorker(0);

    failedWorker.emitMessage({ bootError: "initialization failed" });

    await expect(failedRequest).resolves.toMatchObject({
      ok: false,
      report: expect.stringContaining("occ_service boot failed: initialization failed"),
    });
    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);

    const retry = await readyRequest(1);
    retry.worker.emitMessage({
      id: retry.id,
      res: { ok: true, report: "recovered" },
    });
    await expect(retry.request).resolves.toEqual({ ok: true, report: "recovered" });
  });

  it("fails every request in a decode-faulted generation, then recovers", async () => {
    const failed = await readyRequest(0);
    const alsoPending = service().request(loadRequest());
    await vi.waitFor(() => expect(failed.worker.postMessage).toHaveBeenCalledTimes(2));
    failed.worker.emitMessageError();

    await expect(failed.request).resolves.toEqual({
      ok: false,
      report: "occ_service transport failed: message decode failed",
    });
    await expect(alsoPending).resolves.toEqual({
      ok: false,
      report: "occ_service transport failed: message decode failed",
    });
    expect(failed.worker.terminate).toHaveBeenCalledTimes(1);

    const retry = await readyRequest(1);
    retry.worker.emitMessage({
      id: retry.id,
      res: { ok: true, report: "decoded" },
    });
    await expect(retry.request).resolves.toEqual({ ok: true, report: "decoded" });
  });
});
