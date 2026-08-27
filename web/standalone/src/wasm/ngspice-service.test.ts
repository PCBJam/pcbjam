import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ngspice-worker.js?raw", () => ({ default: "// fake ngspice worker" }));
vi.mock("./wasm-assets", () => ({
  resolveWasmBase: vi.fn(async () => "/wasm"),
}));

import {
  installNgspiceService,
  type NgspiceEvent,
  type NgspiceRequest,
  type NgspiceResponse,
} from "./ngspice-service";
import { resolveWasmBase } from "./wasm-assets";
import { FakeWorker, waitForWorker } from "./test-utils/fake-worker";

const mockedResolveWasmBase = vi.mocked(resolveWasmBase);

const TEST_BOOT_TIMEOUT_MS = 1_000;
const TEST_RESPONSE_TIMEOUT_MS = 5_000;

const commandRequest = (cmd = "run"): NgspiceRequest => ({ kind: "command", cmd });

const service = () => {
  const installed = globalThis.ngspiceService;
  if (!installed) throw new Error("ngspice service was not installed");
  return installed;
};

async function readyRequest(
  workerIndex: number,
  requestBody: NgspiceRequest = commandRequest(),
): Promise<{ worker: FakeWorker; request: Promise<NgspiceResponse>; id: number }> {
  const request = service().request(requestBody);
  const worker = await waitForWorker(workerIndex);
  worker.emitMessage({ ready: true });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
  const [{ id }] = worker.postMessage.mock.calls[0] as [{ id: number }];
  return { worker, request, id };
}

describe("ngspice service worker lifetime", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    mockedResolveWasmBase.mockReset();
    mockedResolveWasmBase.mockResolvedValue("/wasm");
    vi.stubGlobal("window", { location: { href: "https://pcbjam.test/editor" } });
    vi.stubGlobal("Worker", FakeWorker);
    let nextBlob = 1;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:ngspice-test-${nextBlob++}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    delete globalThis.ngspiceService;
    delete globalThis.__ngspiceOnEvent;
    installNgspiceService(vi.fn(), {
      bootTimeoutMs: TEST_BOOT_TIMEOUT_MS,
      responseTimeoutMs: TEST_RESPONSE_TIMEOUT_MS,
    });
  });

  afterEach(() => {
    delete globalThis.ngspiceService;
    delete globalThis.__ngspiceOnEvent;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bounds a never-ready generation, retires it, and boots a fresh worker", async () => {
    vi.useFakeTimers();

    const timedOut = service().request(commandRequest("never ready"));
    await vi.advanceTimersByTimeAsync(0);
    const deadWorker = FakeWorker.instances[0]!;
    expect(deadWorker).toBeDefined();

    await vi.advanceTimersByTimeAsync(TEST_BOOT_TIMEOUT_MS);
    await expect(timedOut).resolves.toEqual({
      error: expect.stringContaining(
        `ngspice_service boot timed out after ${TEST_BOOT_TIMEOUT_MS} ms`,
      ),
    });
    expect(deadWorker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:ngspice-test-1");
    expect(vi.getTimerCount()).toBe(0);

    // The old listener was removed and the slot is retired. A late ready frame
    // cannot resurrect this generation.
    deadWorker.emitMessage({ ready: true });

    const recovered = service().request(commandRequest("fresh"));
    await vi.advanceTimersByTimeAsync(0);
    const freshWorker = FakeWorker.instances[1]!;
    expect(freshWorker).toBeDefined();
    freshWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id }] = freshWorker.postMessage.mock.calls[0] as [{ id: number }];
    freshWorker.emitMessage({ id, res: { ret: 0 } });

    await expect(recovered).resolves.toEqual({ ret: 0 });
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

    const timedOut = service().request(commandRequest("resolve forever"));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TEST_BOOT_TIMEOUT_MS);
    await expect(timedOut).resolves.toEqual({
      error: expect.stringContaining(
        `ngspice_service boot timed out after ${TEST_BOOT_TIMEOUT_MS} ms`,
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

    const recovered = service().request(commandRequest("fresh"));
    await vi.advanceTimersByTimeAsync(0);
    const freshWorker = FakeWorker.instances[0]!;
    expect(freshWorker).toBeDefined();
    freshWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);
    const [{ id }] = freshWorker.postMessage.mock.calls[0] as [{ id: number }];
    freshWorker.emitMessage({ id, res: { ret: 0 } });

    await expect(recovered).resolves.toEqual({ ret: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a ready-but-silent generation and settles all concurrent ids", async () => {
    vi.useFakeTimers();

    const first = service().request(commandRequest("silent one"));
    await vi.advanceTimersByTimeAsync(0);
    const deadWorker = FakeWorker.instances[0]!;
    deadWorker.emitMessage({ ready: true });
    await vi.advanceTimersByTimeAsync(0);

    const second = service().request(commandRequest("silent two"));
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
      `ngspice_service response timed out after ${TEST_RESPONSE_TIMEOUT_MS} ms`;
    await expect(first).resolves.toEqual({ error: timeout });
    await expect(second).resolves.toEqual({ error: timeout });
    expect(deadWorker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:ngspice-test-1");
    expect(vi.getTimerCount()).toBe(0);

    const recovered = service().request(commandRequest("recovered"));
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

    // Even a late old-generation callback carrying the current numeric id is
    // ignored. The replacement remains live until its own Worker answers.
    deadWorker.emitMessage({ id: freshId, res: { ret: 99 } });
    await Promise.resolve();
    expect(recoveredSettled).toBe(false);
    expect(freshWorker.terminate).not.toHaveBeenCalled();

    freshWorker.emitMessage({ id: freshId, res: { ret: 0 } });
    await expect(observed).resolves.toEqual({ ret: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a first request when the worker crashes before ready and retries", async () => {
    const firstRequest = service().request(commandRequest("first"));
    const firstWorker = await waitForWorker(0);

    firstWorker.emitError("boot trap");

    await expect(firstRequest).resolves.toEqual({
      error: expect.stringContaining("ngspice_service crashed: boot trap"),
    });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    const retry = await readyRequest(1, commandRequest("retry"));
    retry.worker.emitMessage({ id: retry.id, res: { ret: 0 } });
    await expect(retry.request).resolves.toEqual({ ret: 0 });
  });

  it("fails every exact pending request on a runtime crash and ignores stale callbacks", async () => {
    const first = await readyRequest(0, commandRequest("one"));
    const alsoPending = service().request(commandRequest("two"));
    await vi.waitFor(() => expect(first.worker.postMessage).toHaveBeenCalledTimes(2));

    first.worker.emitError("wasm trap");

    await expect(first.request).resolves.toEqual({
      error: "ngspice_service crashed: wasm trap",
    });
    await expect(alsoPending).resolves.toEqual({
      error: "ngspice_service crashed: wasm trap",
    });
    expect(first.worker.terminate).toHaveBeenCalledTimes(1);

    const second = await readyRequest(1, commandRequest("recovered"));
    let secondSettled = false;
    const observedSecond = second.request.then((response) => {
      secondSettled = true;
      return response;
    });

    first.worker.emitMessage({ id: second.id, res: { ret: 99 } });
    first.worker.emitError("late old error");
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(second.worker.terminate).not.toHaveBeenCalled();

    second.worker.emitMessage({ id: second.id, res: { ret: 0 } });
    await expect(observedSecond).resolves.toEqual({ ret: 0 });
  });

  it("keeps requests concurrent and correlates out-of-order responses by id", async () => {
    const first = await readyRequest(0, commandRequest("slow"));
    const secondRequest = service().request(commandRequest("fast"));
    await vi.waitFor(() => expect(first.worker.postMessage).toHaveBeenCalledTimes(2));
    const [{ id: secondId }] = first.worker.postMessage.mock.calls[1] as [
      { id: number },
    ];

    first.worker.emitMessage({ id: secondId, res: { ret: 2 } });
    await expect(secondRequest).resolves.toEqual({ ret: 2 });

    let firstSettled = false;
    const observedFirst = first.request.then((response) => {
      firstSettled = true;
      return response;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    first.worker.emitMessage({ id: first.id, res: { ret: 1 } });
    await expect(observedFirst).resolves.toEqual({ ret: 1 });
  });

  it("turns bootError into a response and keeps the next generation retryable", async () => {
    const failedRequest = service().request(commandRequest());
    const failedWorker = await waitForWorker(0);

    failedWorker.emitMessage({ bootError: "initialization failed" });

    await expect(failedRequest).resolves.toEqual({
      error: expect.stringContaining(
        "ngspice_service boot failed: initialization failed",
      ),
    });
    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);

    const retry = await readyRequest(1);
    retry.worker.emitMessage({ id: retry.id, res: { ret: 0 } });
    await expect(retry.request).resolves.toEqual({ ret: 0 });
  });

  it("fails all boot and runtime waiters on decode errors, then recovers", async () => {
    const bootRequest = service().request(commandRequest("boot-one"));
    const alsoBooting = service().request(commandRequest("boot-two"));
    const bootWorker = await waitForWorker(0);
    bootWorker.emitMessageError();
    await expect(bootRequest).resolves.toEqual({
      error: expect.stringContaining("ngspice_service crashed: message decode failed"),
    });
    await expect(alsoBooting).resolves.toEqual({
      error: expect.stringContaining("ngspice_service crashed: message decode failed"),
    });

    const runtime = await readyRequest(1, commandRequest("runtime"));
    const alsoPending = service().request(commandRequest("also-runtime"));
    await vi.waitFor(() => expect(runtime.worker.postMessage).toHaveBeenCalledTimes(2));
    runtime.worker.emitMessageError();
    await expect(runtime.request).resolves.toEqual({
      error: "ngspice_service crashed: message decode failed",
    });
    await expect(alsoPending).resolves.toEqual({
      error: "ngspice_service crashed: message decode failed",
    });

    const recovered = await readyRequest(2, commandRequest("recovered"));
    recovered.worker.emitMessage({ id: recovered.id, res: { ret: 0 } });
    await expect(recovered.request).resolves.toEqual({ ret: 0 });
  });

  it("settles a synchronous postMessage failure without leaking its pending id", async () => {
    const failedRequest = service().request(commandRequest("bad post"));
    const worker = await waitForWorker(0);
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException("cannot clone", "DataCloneError");
    });
    worker.emitMessage({ ready: true });

    await expect(failedRequest).resolves.toEqual({
      error: expect.stringContaining("ngspice_service request failed: DataCloneError"),
    });

    const retry = service().request(commandRequest("good post"));
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    const [{ id }] = worker.postMessage.mock.calls[1] as [{ id: number }];
    worker.emitMessage({ id, res: { ret: 0 } });
    await expect(retry).resolves.toEqual({ ret: 0 });

    // A late reply for the failed request cannot consume the recovered request.
    const [{ id: failedId }] = worker.postMessage.mock.calls[0] as [{ id: number }];
    expect(id).not.toBe(failedId);
  });

  it("drops queued events and late event callbacks from a retired generation", async () => {
    const first = await readyRequest(0);
    first.worker.emitMessage({
      evt: { kind: "char", lines: ["old"] },
      eventSequence: 1,
      eventBytes: 31,
    });
    first.worker.emitError("worker died");
    await expect(first.request).resolves.toEqual({
      error: "ngspice_service crashed: worker died",
    });

    const events: string[] = [];
    globalThis.__ngspiceOnEvent = (event) => events.push(event.lines?.[0] ?? event.kind);

    const second = await readyRequest(1);
    first.worker.emitMessage({
      evt: { kind: "char", lines: ["late old"] },
      eventSequence: 2,
      eventBytes: 36,
    });
    second.worker.emitMessage({
      evt: { kind: "char", lines: ["new"] },
      eventSequence: 1,
      eventBytes: 31,
    });
    second.worker.emitMessage({ id: second.id, res: { ret: 0 } });

    await expect(second.request).resolves.toEqual({ ret: 0 });
    expect(events).toEqual(["new"]);
  });

  it("acks a pre-handler queued frame at enqueue so the transport window never starves", async () => {
    // Pin for the E-6 refinement: placing a frame in the bounded mirror queue
    // IS taking ownership — without the enqueue-time ack, a stream that starts
    // before the C++ handler installs pins the worker's 64-frame credit
    // window open forever (observed as the ngspice-probe bg_halt starvation).
    const first = await readyRequest(0);
    expect(globalThis.__ngspiceOnEvent).toBeUndefined();

    first.worker.emitMessage({
      evt: { kind: "char", lines: ["early"] },
      eventSequence: 1,
      eventBytes: 33,
    });
    await vi.waitFor(() =>
      expect(first.worker.postMessage).toHaveBeenCalledWith({
        eventAck: { sequence: 1, bytes: 33 },
      }));

    // Once the handler installs, the queued frame is dispatched WITHOUT a
    // second ack; only the new frame earns one.
    const events: string[] = [];
    globalThis.__ngspiceOnEvent = (event) => events.push(event.lines?.[0] ?? event.kind);
    first.worker.emitMessage({
      evt: { kind: "char", lines: ["late"] },
      eventSequence: 2,
      eventBytes: 32,
    });
    await vi.waitFor(() => expect(events).toEqual(["early", "late"]));
    const acks = first.worker.postMessage.mock.calls
      .map((call) => (call[0] as { eventAck?: { sequence: number; bytes: number } }).eventAck)
      .filter(Boolean);
    expect(acks, "exactly one ack per frame, none repeated on drain").toEqual([
      { sequence: 1, bytes: 33 },
      { sequence: 2, bytes: 32 },
    ]);

    first.worker.emitMessage({ id: first.id, res: { ret: 0 } });
    await expect(first.request).resolves.toEqual({ ret: 0 });
  });

  it("acks a frame whose handler throws — one throw must not leak credit", async () => {
    // E-19: the host takes transport ownership at onmessage; the sharedspice
    // client deliberately rethrows non-trap errors, and each throw that
    // escaped before the ack leaked one unit of the worker's 64-frame credit
    // window until the stream died with a misattributed overload.
    const first = await readyRequest(0);
    globalThis.__ngspiceOnEvent = () => {
      throw new Error("plot apply bug");
    };

    expect(() => first.worker.emitMessage({
      evt: { kind: "char", lines: ["boom"] },
      eventSequence: 1,
      eventBytes: 32,
    }), "the handler throw keeps propagating (trap machinery must see it)")
      .toThrow("plot apply bug");

    const acks = () => first.worker.postMessage.mock.calls
      .map((call) => (call[0] as { eventAck?: { sequence: number; bytes: number } }).eventAck)
      .filter(Boolean);
    expect(acks(), "the frame is acked despite the throwing handler")
      .toEqual([{ sequence: 1, bytes: 32 }]);

    // The stream stays live: a later frame delivers and acks normally.
    const events: string[] = [];
    globalThis.__ngspiceOnEvent = (event) => events.push(event.lines?.[0] ?? event.kind);
    first.worker.emitMessage({
      evt: { kind: "char", lines: ["after"] },
      eventSequence: 2,
      eventBytes: 33,
    });
    expect(events).toEqual(["after"]);
    expect(acks()).toEqual([
      { sequence: 1, bytes: 32 },
      { sequence: 2, bytes: 33 },
    ]);

    first.worker.emitMessage({ id: first.id, res: { ret: 0 } });
    await expect(first.request).resolves.toEqual({ ret: 0 });
  });

  it("acks the live frame exactly once when the queued-frame drain throws", async () => {
    // E-19, drain path: a throw while draining the pre-handler queue aborts
    // delivery, but the live frame's credit was owned at onmessage — its ack
    // must still go out, and the queued frame (acked at enqueue) not twice.
    const first = await readyRequest(0);
    first.worker.emitMessage({
      evt: { kind: "char", lines: ["early"] },
      eventSequence: 1,
      eventBytes: 33,
    });
    globalThis.__ngspiceOnEvent = (event) => {
      if (event.lines?.[0] === "early") throw new Error("drain bug");
    };

    expect(() => first.worker.emitMessage({
      evt: { kind: "char", lines: ["live"] },
      eventSequence: 2,
      eventBytes: 32,
    })).toThrow("drain bug");

    const acks = first.worker.postMessage.mock.calls
      .map((call) => (call[0] as { eventAck?: { sequence: number; bytes: number } }).eventAck)
      .filter(Boolean);
    expect(acks, "exactly one ack per owned frame, none doubled").toEqual([
      { sequence: 1, bytes: 33 },
      { sequence: 2, bytes: 32 },
    ]);

    first.worker.emitMessage({ id: first.id, res: { ret: 0 } });
    await expect(first.request).resolves.toEqual({ ret: 0 });
  });

  it("delivers the terminal notice's pending events, then retires, then exits", async () => {
    // E-20: the worker's fatal frame carries the deferred batches it had
    // already accepted (typically the diagnostics explaining the failure) —
    // they must reach the handler, in order, without acks; the retirement's
    // synthetic controlled-exit (E-10) follows them.
    const first = await readyRequest(0);
    const events: string[] = [];
    globalThis.__ngspiceOnEvent = (event) => events.push(event.lines?.[0] ?? event.kind);

    first.worker.emitMessage({
      fatal: "ngspice event line exceeds 1048576 UTF-8 bytes",
      pendingEvents: [
        { evt: { kind: "char", lines: ["tail diagnostics"] }, eventBytes: 42 },
        { evt: { kind: "bg", finished: true }, eventBytes: 30 },
      ],
    });

    await expect(first.request).resolves.toEqual({
      error: "ngspice_service crashed: event stream failure: "
        + "ngspice event line exceeds 1048576 UTF-8 bytes",
    });
    expect(events, "accepted frames first, synthetic exit last").toEqual([
      "tail diagnostics",
      "bg",
      "exit",
    ]);
    const acks = first.worker.postMessage.mock.calls
      .map((call) => (call[0] as { eventAck?: unknown }).eventAck)
      .filter(Boolean);
    expect(acks, "terminal delivery is outside the credit protocol").toEqual([]);
  });

  it("synthesizes one controlled exit per retirement so the run mirror unlatches", async () => {
    // E-10: a retired worker emits no bg/exit frame of its own; without the
    // synthetic exit the sharedspice s_bgRunning mirror stays latched true
    // and the simulator's Run action is disabled for the session.
    const first = await readyRequest(0);
    const events: NgspiceEvent[] = [];
    globalThis.__ngspiceOnEvent = (event) => events.push(event);

    first.worker.emitError("wasm trap");
    await expect(first.request).resolves.toEqual({
      error: "ngspice_service crashed: wasm trap",
    });
    expect(events).toEqual([
      { kind: "exit", status: 1, immediate: true, quit: false },
    ]);

    // Retirement is idempotent — a late second fault emits nothing more.
    first.worker.emitError("late echo");
    expect(events).toHaveLength(1);

    // And a throwing handler must not break the retirement itself.
    const second = await readyRequest(1);
    globalThis.__ngspiceOnEvent = () => {
      throw new Error("exit handler bug");
    };
    second.worker.emitError("second trap");
    await expect(second.request).resolves.toEqual({
      error: "ngspice_service crashed: second trap",
    });
  });

  it("retires a worker whose bounded event stream reports a fatal line", async () => {
    const first = await readyRequest(0, commandRequest("oversize output"));
    first.worker.emitMessage({
      fatal: "ngspice event line exceeds 1048576 UTF-8 bytes",
    });

    await expect(first.request).resolves.toEqual({
      error: "ngspice_service crashed: event stream failure: "
        + "ngspice event line exceeds 1048576 UTF-8 bytes",
    });
    expect(first.worker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:ngspice-test-1");

    const recovered = await readyRequest(1, commandRequest("fresh generation"));
    recovered.worker.emitMessage({ id: recovered.id, res: { ret: 0 } });
    await expect(recovered.request).resolves.toEqual({ ret: 0 });
  });
});
