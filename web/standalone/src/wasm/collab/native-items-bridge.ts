/**
 * Owner-scoped acknowledgement adapter for the native items bridge.
 *
 * `kicadCollabApplyItems` only submits work to KiCad's CallAfter/coroutine
 * queue.  Its JavaScript return value is therefore never an acknowledgement.
 * The native tail emits `onItemsApplied` after the queued body has actually
 * completed; this adapter turns that completion into the Promise consumed by
 * the level-triggered projection pump.
 */

export const ITEMS_PROTOCOL_KEY = "_pcbjam";

export interface NativeItemsProtocolModule {
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabSetItemsOwner(ownerGeneration: string): boolean | void;
  kicadCollabReleaseItemsOwner(ownerGeneration: string): void;
}

export interface NativeItemsProtocolWindow {
  kicadCollab?: {
    onItems?: (json: string) => void;
    onItemsApplied?: (json: string) => void;
    [key: string]: unknown;
  };
}

export type NativeItemsApplyStatus =
  | "applied"
  | "busy"
  | "failed"
  | "invalid"
  | "partial"
  | "stale-owner"
  | "target-changed"
  | "unavailable";

export const DEFAULT_NATIVE_ITEMS_ACK_TIMEOUT_MS = 30_000;

export interface NativeItemsApplyAck {
  requestId: string;
  ownerGeneration: string;
  status: NativeItemsApplyStatus;
  retryable?: boolean;
  error?: string;
}

export class NativeItemsApplyError extends Error {
  constructor(
    readonly status:
      | NativeItemsApplyStatus
      | "ack-timeout"
      | "owner-released"
      | "owner-replaced"
      | "submission-failed"
      | "invalid-wire",
    readonly retryable: boolean,
    readonly ownerGeneration: string,
    readonly requestId?: string,
    message?: string,
  ) {
    super(message ?? `native items apply failed: ${status}`);
    this.name = "NativeItemsApplyError";
  }
}

export interface AcknowledgedItemsBridge {
  readonly ownerGeneration: string;
  snapshotItems(): string;
  applyItems(json: string): Promise<void>;
  onItems(cb: (json: string) => void): void;
  destroy(): void;
}

interface PendingRequest {
  readonly ownerGeneration: string;
  readonly resolve: () => void;
  readonly reject: (error: NativeItemsApplyError) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface WindowRuntime {
  readonly pending: Map<string, PendingRequest>;
  readonly previousAck?: (json: string) => void;
  activeOwner?: string;
  requestSequence: number;
}

const runtimes = new WeakMap<object, WindowRuntime>();
let ownerSequence = 0;

function ownerToken(): string {
  ownerSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `items-${ownerSequence}-${random}`;
}

function defaultRetryable(status: NativeItemsApplyAck["status"]): boolean {
  return status === "busy" || status === "unavailable";
}

const APPLY_STATUSES = new Set<NativeItemsApplyStatus>([
  "applied",
  "busy",
  "failed",
  "invalid",
  "partial",
  "stale-owner",
  "target-changed",
  "unavailable",
]);

function parseAck(json: string): NativeItemsApplyAck | null {
  try {
    const value = JSON.parse(json) as Partial<NativeItemsApplyAck>;
    if (
      typeof value.requestId !== "string" ||
      value.requestId.length === 0 ||
      typeof value.ownerGeneration !== "string" ||
      value.ownerGeneration.length === 0 ||
      typeof value.status !== "string"
    ) {
      return null;
    }
    const status = value.status as NativeItemsApplyStatus;
    if (!APPLY_STATUSES.has(status)) {
      return {
        requestId: value.requestId,
        ownerGeneration: value.ownerGeneration,
        status: "failed",
        retryable: false,
        error: `native items apply returned an unknown status: ${value.status}`,
      };
    }
    return {
      requestId: value.requestId,
      ownerGeneration: value.ownerGeneration,
      status,
      retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
    };
  } catch {
    return null;
  }
}

function runtimeFor(win: NativeItemsProtocolWindow): WindowRuntime {
  const key = win as object;
  const existing = runtimes.get(key);
  if (existing) return existing;

  const runtime: WindowRuntime = {
    pending: new Map(),
    previousAck: win.kicadCollab?.onItemsApplied,
    requestSequence: 0,
  };
  const dispatch = (json: string): void => {
    const ack = parseAck(json);
    if (ack) {
      const pending = runtime.pending.get(ack.requestId);
      if (pending?.ownerGeneration === ack.ownerGeneration) {
        runtime.pending.delete(ack.requestId);
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        if (ack.status === "applied") {
          pending.resolve();
        } else {
          pending.reject(
            new NativeItemsApplyError(
              ack.status,
              ack.retryable ?? defaultRetryable(ack.status),
              ack.ownerGeneration,
              ack.requestId,
              ack.error,
            ),
          );
        }
      }
    }
    // This dispatcher is called from EM_ASM at the native apply tail. A sibling
    // listener must not be able to throw back through Wasm after our ticket has
    // already settled (which can otherwise turn a successful apply into a trap).
    try {
      runtime.previousAck?.(json);
    } catch (error) {
      console.error("previous native items acknowledgement listener failed", error);
    }
  };
  win.kicadCollab = { ...win.kicadCollab, onItemsApplied: dispatch };
  runtimes.set(key, runtime);
  return runtime;
}

function rejectOwner(
  runtime: WindowRuntime,
  ownerGeneration: string,
  status: "owner-released" | "owner-replaced",
): void {
  for (const [requestId, pending] of runtime.pending) {
    if (pending.ownerGeneration !== ownerGeneration) continue;
    runtime.pending.delete(requestId);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.reject(
      new NativeItemsApplyError(
        status,
        false,
        ownerGeneration,
        requestId,
      ),
    );
  }
}

/** Build one active-owner bridge over the singleton native editor. */
export function createNativeItemsBridge(
  mod: NativeItemsProtocolModule,
  win: NativeItemsProtocolWindow,
  opts?: { ackTimeoutMs?: number },
): AcknowledgedItemsBridge {
  if (
    typeof mod.kicadCollabSetItemsOwner !== "function" ||
    typeof mod.kicadCollabReleaseItemsOwner !== "function"
  ) {
    throw new Error("native items acknowledgement protocol is unavailable; rebuild KiCad Wasm");
  }

  const ackTimeoutMs = opts?.ackTimeoutMs ?? DEFAULT_NATIVE_ITEMS_ACK_TIMEOUT_MS;
  if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0) {
    throw new RangeError("native items acknowledgement timeout must be positive");
  }
  const runtime = runtimeFor(win);
  const ownerGeneration = ownerToken();
  const acquired = mod.kicadCollabSetItemsOwner(ownerGeneration);
  if (acquired === false) {
    throw new NativeItemsApplyError(
      "busy",
      true,
      ownerGeneration,
      undefined,
      "native items owner is still draining its previous generation",
    );
  }
  if (runtime.activeOwner) rejectOwner(runtime, runtime.activeOwner, "owner-replaced");
  runtime.activeOwner = ownerGeneration;

  let destroyed = false;
  let ownItemsCallback: ((json: string) => void) | undefined;

  return {
    ownerGeneration,
    snapshotItems: () => mod.kicadCollabSnapshotItems(),
    applyItems: (json: string): Promise<void> => {
      if (destroyed) {
        return Promise.reject(
          new NativeItemsApplyError("owner-released", false, ownerGeneration),
        );
      }

      let wire: Record<string, unknown>;
      try {
        const parsed = JSON.parse(json) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("items wire is not an object");
        }
        wire = parsed as Record<string, unknown>;
      } catch (error) {
        return Promise.reject(
          new NativeItemsApplyError(
            "invalid-wire",
            false,
            ownerGeneration,
            undefined,
            String(error),
          ),
        );
      }

      runtime.requestSequence += 1;
      const requestId = `${ownerGeneration}:${runtime.requestSequence}`;
      wire[ITEMS_PROTOCOL_KEY] = { requestId, ownerGeneration };

      return new Promise<void>((resolve, reject) => {
        runtime.pending.set(requestId, { ownerGeneration, resolve, reject });
        const armTimeout = (): void => {
          const pending = runtime.pending.get(requestId);
          if (!pending || pending.ownerGeneration !== ownerGeneration) return;
          if (pending.timeout !== undefined) return;
          pending.timeout = setTimeout(() => {
            const active = runtime.pending.get(requestId);
            if (!active || active.ownerGeneration !== ownerGeneration) return;
            runtime.pending.delete(requestId);
            active.reject(
              new NativeItemsApplyError(
                "ack-timeout",
                false,
                ownerGeneration,
                requestId,
                `native items apply did not acknowledge within ${ackTimeoutMs}ms; native state is unknown`,
              ),
            );
          }, ackTimeoutMs);
        };
        try {
          const submission = mod.kicadCollabApplyItems(JSON.stringify(wire));
          // The scheduler may return a Promise when it defers invocation behind
          // an open. Resolution still only means "submitted"; rejection means
          // native was never reached and can fail this ticket immediately.
          if (
            typeof submission === "object" &&
            submission !== null &&
            "then" in submission
          ) {
            Promise.resolve(submission).then(armTimeout).catch((error: unknown) => {
              const pending = runtime.pending.get(requestId);
              if (!pending || pending.ownerGeneration !== ownerGeneration) return;
              runtime.pending.delete(requestId);
              if (pending.timeout !== undefined) clearTimeout(pending.timeout);
              pending.reject(
                new NativeItemsApplyError(
                  "submission-failed",
                  true,
                  ownerGeneration,
                  requestId,
                  String(error),
                ),
              );
            });
          } else armTimeout();
        } catch (error) {
          const pending = runtime.pending.get(requestId);
          runtime.pending.delete(requestId);
          if (pending?.timeout !== undefined) clearTimeout(pending.timeout);
          reject(
            new NativeItemsApplyError(
              "submission-failed",
              false,
              ownerGeneration,
              requestId,
              String(error),
            ),
          );
        }
      });
    },
    onItems: (cb: (json: string) => void): void => {
      ownItemsCallback = cb;
      win.kicadCollab = { ...win.kicadCollab, onItems: cb };
    },
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      rejectOwner(runtime, ownerGeneration, "owner-released");
      if (runtime.activeOwner === ownerGeneration) runtime.activeOwner = undefined;
      try {
        mod.kicadCollabReleaseItemsOwner(ownerGeneration);
      } catch (error) {
        // The Wasm instance may already be gone during teardown. Local ticket
        // cancellation and callback detachment must still complete.
        console.error("native items owner release failed", error);
      }
      if (ownItemsCallback && win.kicadCollab?.onItems === ownItemsCallback) {
        win.kicadCollab = { ...win.kicadCollab, onItems: undefined };
      }
    },
  };
}
