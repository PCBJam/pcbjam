import { errorMessage, isTerminalError } from "./terminal-error";

/** Values accepted by the scheduler gateway's retained-payload accounting. */
export type OwnerJobArgument =
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint;

export type GuardedOwnerExport<
  Args extends readonly OwnerJobArgument[],
  Result,
> = ((...args: Args) => Result | Promise<Result>) & {
  __wxGuardedCall?: (
    args: OwnerJobArgument[],
    isCurrent: () => boolean,
  ) => Promise<Result>;
};

type OwnerJobScheduler = {
  canTouchNative?: () => boolean;
  _enqueueMutator?: (
    name: string,
    run: (...args: OwnerJobArgument[]) => unknown,
    args: OwnerJobArgument[],
    isCurrent: (() => boolean) | null,
  ) => Promise<unknown>;
};

type OwnerQueueError = {
  code?: unknown;
  reason?: unknown;
  estimatedBytes?: unknown;
  maxBytes?: unknown;
};

export type OwnerJobFailureKind =
  | "backpressure"
  | "stale"
  | "terminal"
  | "other";

function ownerErrorDetail(error: unknown): OwnerQueueError {
  return error !== null && typeof error === "object"
    ? (error as OwnerQueueError)
    : {};
}

/** Capacity can be retried only when this exact payload fits an empty queue. */
export function isRetryableOwnerBackpressure(error: unknown): boolean {
  const detail = ownerErrorDetail(error);
  if (detail.code !== "WX_MUTATOR_BACKPRESSURE") return false;
  if (detail.reason !== "jobs" && detail.reason !== "bytes") return false;
  return (
    typeof detail.estimatedBytes === "number" &&
    typeof detail.maxBytes === "number" &&
    Number.isSafeInteger(detail.estimatedBytes) &&
    Number.isSafeInteger(detail.maxBytes) &&
    detail.estimatedBytes >= 0 &&
    detail.estimatedBytes <= detail.maxBytes
  );
}

export function isStaleOwnerJobError(error: unknown): boolean {
  return ownerErrorDetail(error).code === "WX_MUTATOR_STALE";
}

/** Scheduler shutdown and a Wasm trap are terminal for this Module lifetime. */
export function isTerminalOwnerJobError(error: unknown): boolean {
  const detail = ownerErrorDetail(error);
  if (
    detail.code === "WX_NATIVE_ENTRY_ABANDONED" ||
    detail.code === "WX_OPEN_NATIVE_UNAVAILABLE" ||
    detail.code === "WX_OPEN_OWNER_FAILED"
  ) {
    return true;
  }
  const message = errorMessage(error);
  return (
    isTerminalError(error, message) ||
    /\[wx-scheduler\]\s+shutdown|rejected after native shutdown|owner gateway is unavailable|application is dead|native integrity (?:is )?(?:unknown|lost)|scheduler is dead/i.test(
      message,
    )
  );
}

export function classifyOwnerJobFailure(error: unknown): OwnerJobFailureKind {
  if (isRetryableOwnerBackpressure(error)) return "backpressure";
  if (isStaleOwnerJobError(error)) return "stale";
  if (isTerminalOwnerJobError(error)) return "terminal";
  return "other";
}

function schedulerFor(win: ToolWindow): OwnerJobScheduler | undefined {
  return (win as ToolWindow & { __wxScheduler?: OwnerJobScheduler })
    .__wxScheduler;
}

/**
 * Run a JavaScript closure as Ordinary execution-owner work.
 *
 * The scheduler's Promise gateway was built for wrapped Embind exports, but
 * its native ticket deliberately owns a JavaScript closure. This adapter uses
 * that same path for synchronous, stateful JS runtime operations such as a
 * MEMFS write. The closure therefore runs only after wx admits its Ordinary
 * owner, and the returned Promise settles only after that exact owner retires.
 * Do not return a Promise from the closure: a JavaScript continuation would
 * run after the native callback (and its owner) had returned.
 *
 * Keep retained input in `args`, not only in the closure. The gateway accounts
 * these primitive values against its payload bound. Reference-shaped payloads
 * are intentionally excluded; serialize or copy them to a string first.
 *
 * A non-scheduler bundle has no competing semantic owners, so it executes the
 * closure directly. A scheduler bundle with a missing gateway fails closed:
 * entering MEMFS or Wasm directly in that state would recreate the overlap
 * this boundary exists to prevent.
 */
export function runOwnerJob<Args extends readonly OwnerJobArgument[], Result>(
  win: ToolWindow,
  label: string,
  args: Args,
  run: (...args: Args) => Result,
  isCurrent?: () => boolean,
): Promise<Result> {
  const invoke = (...rawArgs: OwnerJobArgument[]): Result => {
    const result = run(...(rawArgs as unknown as Args));
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new Error(
        `[wasm-owner] ${label} returned a Promise from a synchronous owner job`,
      );
    }
    return result;
  };

  const scheduler = schedulerFor(win);
  if (!scheduler) {
    try {
      if (isCurrent && !isCurrent()) {
        return Promise.reject(
          Object.assign(
            new Error(`[wasm-owner] ${label} rejected for a stale resource`),
            { code: "WX_MUTATOR_STALE" },
          ),
        );
      }
      return Promise.resolve(invoke(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  try {
    if (scheduler.canTouchNative && !scheduler.canTouchNative()) {
      return Promise.reject(
        new Error(`[wasm-owner] ${label} rejected after native shutdown`),
      );
    }
  } catch (error) {
    return Promise.reject(error);
  }

  const enqueue = scheduler._enqueueMutator;
  if (typeof enqueue !== "function") {
    return Promise.reject(
      new Error(`[wasm-owner] ${label} rejected: owner gateway is unavailable`),
    );
  }

  const retainedArgs = [...args];
  try {
    return Promise.resolve(
      enqueue.call(
        scheduler,
        label,
        invoke,
        retainedArgs,
        isCurrent ?? null,
      ) as Promise<Result>,
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Submit an already-wrapped Module export with a lifetime/version guard.
 *
 * Scheduler bundles evaluate the guard immediately before native admission,
 * not merely when JavaScript creates the ticket. A non-scheduler bundle has
 * no delayed ticket, so the same guard is checked immediately.
 */
export function runGuardedOwnerExport<
  Args extends readonly OwnerJobArgument[],
  Result,
>(
  fn: GuardedOwnerExport<Args, Result>,
  args: Args,
  isCurrent: () => boolean,
): Promise<Result> {
  if (typeof fn.__wxGuardedCall === "function") {
    return Promise.resolve(fn.__wxGuardedCall([...args], isCurrent));
  }

  if (!isCurrent()) {
    return Promise.reject(
      Object.assign(new Error("[wasm-owner] stale resource-affine mutator"), {
        code: "WX_MUTATOR_STALE",
      }),
    );
  }

  try {
    return Promise.resolve(fn(...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Observe a deliberately detached owner-gateway call.
 *
 * Scheduler builds make stateful Module exports promise-returning. UI sources
 * such as awareness and comment-pin updates do not wait for a visual refresh,
 * but they must still consume a rejected ticket: an unhandled rejection hides
 * the operation which failed and can be promoted to a fatal page error.
 * Promise.resolve also keeps this helper compatible with an older direct-call
 * bundle while a deployment rolls forward.
 */
export function observeOwnerJob<T>(
  label: string,
  run: () => T | Promise<T>,
  report: (message: string) => void = console.error,
): void {
  try {
    void Promise.resolve(run()).catch((error) => {
      // A controller generation ending after submission is expected lifecycle
      // cancellation, not a native failure worth surfacing to the user.
      if (isStaleOwnerJobError(error)) return;
      report(`[wasm-owner] ${label} failed: ${String(error)}`);
    });
  } catch (error) {
    if (isStaleOwnerJobError(error)) return;
    report(`[wasm-owner] ${label} failed: ${String(error)}`);
  }
}
