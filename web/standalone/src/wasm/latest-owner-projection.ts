/** One active native ticket plus one replaceable authoritative latest value. */

import {
  isRetryableOwnerBackpressure,
  isStaleOwnerJobError,
  isTerminalOwnerJobError,
} from "./owner-job";

const DEFAULT_RETRY_MS = 1_000;

export interface LatestOwnerProjection {
  /** Mark authoritative state dirty. Repeated calls replace one pending level. */
  request(): void;
  /** Invalidate queued tickets and cancel the sole retry timer. */
  stop(): void;
}

/**
 * Project authoritative JavaScript state into a serialized native owner.
 *
 * `snapshot` runs only when a ticket can be submitted. While that ticket is
 * parked, any number of request() calls occupy one pending bit. The next
 * ticket recomputes current state instead of replaying obsolete snapshots.
 * A queue-capacity rejection retains that level behind one fixed-rate timer;
 * no Promise or timer chain can grow with the input rate.
 */
export function createLatestOwnerProjection<T>(opts: {
  label: string;
  snapshot: () => T;
  submit: (value: T, isCurrent: () => boolean) => Promise<unknown>;
  retryMs?: number;
  report?: (message: string) => void;
}): LatestOwnerProjection {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const report = opts.report ?? console.error;
  let version = 0;
  let pending = false;
  let running = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const stopAfterTerminalFailure = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    version++;
    pending = false;
    if (retry) clearTimeout(retry);
    retry = undefined;
    report(
      `[wasm-owner] ${opts.label} stopped after terminal native failure: ${String(error)}`,
    );
  };

  const armRetry = (): void => {
    if (stopped || retry || !pending || running) return;
    retry = setTimeout(() => {
      retry = undefined;
      drain();
    }, retryMs);
  };

  const drain = (): void => {
    if (stopped || running || retry || !pending) return;

    pending = false;
    running = true;
    const submittedVersion = version;
    let value: T;

    try {
      value = opts.snapshot();
    } catch (error) {
      running = false;
      report(`[wasm-owner] ${opts.label} snapshot failed: ${String(error)}`);
      return;
    }

    let retryAfter = false;
    let submission: Promise<unknown>;
    try {
      submission = Promise.resolve(
        opts.submit(
          value,
          () => !stopped && submittedVersion === version,
        ),
      );
    } catch (error) {
      running = false;
      if (isTerminalOwnerJobError(error)) {
        stopAfterTerminalFailure(error);
        return;
      }
      report(`[wasm-owner] ${opts.label} failed: ${String(error)}`);
      if (pending) drain();
      return;
    }

    submission
      .catch((error: unknown) => {
        if (isRetryableOwnerBackpressure(error)) {
          // Preserve the rejected value only if no newer request already owns
          // the pending slot. Either way, the capacity retry stays rate-bound.
          if (submittedVersion === version) pending = true;
          retryAfter = true;
          return;
        }
        if (isTerminalOwnerJobError(error)) {
          stopAfterTerminalFailure(error);
          return;
        }
        if (!isStaleOwnerJobError(error) && !stopped) {
          report(`[wasm-owner] ${opts.label} failed: ${String(error)}`);
        }
      })
      .finally(() => {
        running = false;
        if (stopped || !pending) return;
        if (retryAfter) armRetry();
        else drain();
      });
  };

  return {
    request() {
      if (stopped) return;
      version++;
      pending = true;
      // New state replaces the value but does not bypass an already-armed
      // capacity delay; that would turn a hot source into a retry storm.
      drain();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      version++;
      pending = false;
      if (retry) clearTimeout(retry);
      retry = undefined;
    },
  };
}
