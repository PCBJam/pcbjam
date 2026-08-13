/**
 * Behavioral unit test for the injected ngspice harness.
 *
 * It runs the init-script closure in Node with a deterministic Worker.  No
 * browser, KiCad build, or ngspice binary is involved.
 *
 * Run: cd tests && npm run ngspice:harness-unit
 */
import { strict as assert } from "node:assert";
import type { Page } from "@playwright/test";
import { installNgspiceServiceStub } from "../kicad/utils/ngspice-service";

type MessageListener = (event: { data: any }) => void;

class FakeWorker {
  static autoReady = false;
  static instances: FakeWorker[] = [];
  static silentKinds = new Set<string>();

  onmessage: MessageListener | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  private readonly listeners = new Set<MessageListener>();

  constructor(public readonly url: string) {
    FakeWorker.instances.push(this);
    if (FakeWorker.autoReady) queueMicrotask(() => this.emit({ ready: true }));
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: MessageListener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: { id: number; req: { kind: string } }): void {
    if (FakeWorker.silentKinds.has(message.req.kind)) return;
    queueMicrotask(() => {
      const res = message.req.kind.startsWith("unknown")
        ? { error: `unknown request kind ${message.req.kind}` }
        : { ret: 0, length: 128 };
      this.emit({ id: message.id, res });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(data: any): void {
    if (this.terminated) return;
    const event = { data };
    this.onmessage?.(event);
    for (const listener of [...this.listeners]) listener(event);
  }
}

const runtime = globalThis as any;
const originalWindow = runtime.window;
const originalWorker = runtime.Worker;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

const activeTimers = new Set<ReturnType<typeof setTimeout>>();
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
  let timer!: ReturnType<typeof setTimeout>;
  timer = originalSetTimeout(() => {
    activeTimers.delete(timer);
    if (typeof handler === "function") handler(...args);
  }, timeout);
  activeTimers.add(timer);
  return timer;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
  activeTimers.delete(timer);
  originalClearTimeout(timer);
}) as typeof clearTimeout;

const pagehideListeners: Array<() => void> = [];
runtime.window = {
  location: { href: "https://pcbjam.test/kicad/eeschema.html" },
  addEventListener(type: string, listener: () => void): void {
    if (type === "pagehide") pagehideListeners.push(listener);
  },
};
runtime.Worker = FakeWorker;

let nextUrl = 1;
const revoked: string[] = [];
URL.createObjectURL = (() => `blob:ngspice-harness-${nextUrl++}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;

const page = {
  async addInitScript(callback: (arg: any) => void, arg: any): Promise<void> {
    callback(arg);
  },
} as unknown as Page;

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return String((error as Error).message);
  }
}

async function main(): Promise<void> {
  try {
    await installNgspiceServiceStub(page, {
      bootTimeoutMs: 10,
      responseTimeoutMs: 15,
    });

    const hooks = runtime.__ngspiceServiceTestHooks;
    const service = runtime.ngspiceService;

    const bootFailure = await service.request({ kind: "init" });
    assert.match(bootFailure.error, /boot timed out after 10 ms/);
    assert.deepEqual(hooks.snapshot().retiredGenerations, [1]);
    assert.equal(FakeWorker.instances[0]!.terminated, true);
    assert.deepEqual(revoked, ["blob:ngspice-harness-1"]);
    console.log("ok   boot deadline retires and revokes the exact generation");

    FakeWorker.autoReady = true;
    FakeWorker.silentKinds.add("silent");
    const responseFailure = await service.request({ kind: "silent" });
    assert.match(responseFailure.error, /response timed out after 15 ms/);
    assert.deepEqual(hooks.snapshot().retiredGenerations, [1, 2]);
    assert.equal(FakeWorker.instances[1]!.terminated, true);
    assert.deepEqual(revoked, ["blob:ngspice-harness-1", "blob:ngspice-harness-2"]);
    console.log("ok   response deadline settles and retires every exact request generation");

    const checkpoint = hooks.requestCheckpoint();
    const subscribed = hooks.waitForRequestAfter(checkpoint, { kind: "ok" }, 100);
    const success = service.request({ kind: "ok" });
    const [summary, response] = await Promise.all([subscribed, success]);
    assert.equal(summary.sequence > checkpoint, true);
    assert.equal(summary.error, undefined);
    assert.equal(response.ret, 0);

    const scanCheckpoint = hooks.requestCheckpoint();
    await service.request({ kind: "scan-ok" });
    const scanned = await hooks.waitForRequestAfter(scanCheckpoint, { kind: "scan-ok" });
    assert.equal(scanned.sequence > scanCheckpoint, true);
    console.log("ok   request receipt covers subscribe and scan paths");

    const errorCheckpoint = hooks.requestCheckpoint();
    const successOnly = hooks.waitForRequestAfter(
      errorCheckpoint,
      { kind: "unknown-unit" },
      5,
    );
    const errorResponse = await service.request({ kind: "unknown-unit" });
    assert.match(errorResponse.error, /unknown request kind/);
    assert.match(await rejectedMessage(successOnly), /timed out/);
    assert.equal(hooks.snapshot().requestReceiptWaiters, 0);
    console.log("ok   error summaries cannot satisfy success receipts");

    const canceled = hooks.waitForRequestAfter(
      hooks.requestCheckpoint(),
      { kind: "never-issued" },
      100,
    );
    const canceledMessage = rejectedMessage(canceled);
    canceled.cancel("canceled by unit test");
    assert.match(await canceledMessage, /canceled by unit test/);

    const bounded = hooks.waitForRequestAfter(
      hooks.requestCheckpoint(),
      { kind: "also-never-issued" },
      5,
    );
    assert.match(await rejectedMessage(bounded), /timed out/);
    assert.equal(hooks.snapshot().requestReceiptWaiters, 0);
    console.log("ok   request receipt timeout and cancellation remove their timers");

    const appliedHook = runtime.__pcbjamNgspiceFinalRefreshApplied;
    const appliedCheckpoint = hooks.appliedGenerationCheckpoint();
    appliedHook(appliedCheckpoint + 1);
    const scannedApplied = await hooks.waitForAppliedGenerationAfter(appliedCheckpoint);
    const subscribedApplied = hooks.waitForAppliedGenerationAfter(scannedApplied.generation);
    appliedHook(scannedApplied.generation + 1);
    assert.equal(
      (await subscribedApplied).generation,
      scannedApplied.generation + 1,
    );
    assert.equal(hooks.snapshot().appliedGenerationWaiters, 0);
    console.log("ok   applied-generation receipt covers scan and subscribe paths");

    const teardownRequest = hooks.waitForRequestAfter(
      hooks.requestCheckpoint(),
      { kind: "teardown-request" },
    );
    const teardownRequestMessage = rejectedMessage(teardownRequest);
    const teardownApplied = hooks.waitForAppliedGenerationAfter(
      hooks.appliedGenerationCheckpoint(),
    );
    const teardownAppliedMessage = rejectedMessage(teardownApplied);
    hooks.dispose();
    assert.match(await teardownRequestMessage, /teardown/);
    assert.match(await teardownAppliedMessage, /teardown/);
    assert.deepEqual(hooks.snapshot(), {
      ...hooks.snapshot(),
      requestReceiptWaiters: 0,
      appliedGenerationWaiters: 0,
      disposed: true,
    });
    assert.equal(activeTimers.size, 0);
    assert.equal(FakeWorker.instances[2]!.terminated, true);
    assert.deepEqual(revoked, [
      "blob:ngspice-harness-1",
      "blob:ngspice-harness-2",
      "blob:ngspice-harness-3",
    ]);
    console.log("ok   teardown rejects waiters and clears worker and receipt timers");

    assert.equal(pagehideListeners.length, 1);
    pagehideListeners[0]!();
    assert.equal(activeTimers.size, 0);
    console.log("ngspice-harness-unit: all green");
  } finally {
    for (const timer of [...activeTimers]) originalClearTimeout(timer);
    activeTimers.clear();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    runtime.window = originalWindow;
    runtime.Worker = originalWorker;
    delete runtime.ngspiceService;
    delete runtime.__ngspiceServiceTestHooks;
    delete runtime.__pcbjamNgspiceFinalRefreshApplied;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
