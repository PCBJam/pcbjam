import { expect, vi } from "vitest";

/**
 * Shared Worker test double for the service-lifetime suites (one copy —
 * previously duplicated verbatim in occ-service.test.ts and
 * ngspice-service.test.ts, where a fix to its event semantics applied to one
 * file left the other suite validating different fake-worker behavior).
 *
 * Honors J-4: no synthetic `dispatchEvent` — emit* invoke the exact functions
 * the service assigned to the handler attributes.
 *
 * (Not named *.test.ts: the vitest include glob must not collect it.)
 */
export type MessageListener = (event: MessageEvent) => void;

export class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: MessageListener | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private readonly messageListeners = new Set<MessageListener>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.messageListeners.add(listener as MessageListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.messageListeners.delete(listener as MessageListener);
  }

  emitMessage(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...this.messageListeners]) listener(event);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({} as MessageEvent);
  }
}

/** Await the service's Nth Worker construction. */
export async function waitForWorker(index: number): Promise<FakeWorker> {
  await vi.waitFor(() => expect(FakeWorker.instances.length).toBeGreaterThan(index));
  return FakeWorker.instances[index]!;
}
