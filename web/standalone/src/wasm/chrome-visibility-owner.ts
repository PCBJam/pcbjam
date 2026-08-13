import { createLatestOwnerProjection } from "./latest-owner-projection";
import {
  runGuardedOwnerExport,
  type GuardedOwnerExport,
} from "./owner-job";

const DEFAULT_RETRY_MS = 300;
const DEFAULT_RETRY_FOR_MS = 30_000;

export type ChromeSetter = GuardedOwnerExport<
  readonly [show: boolean],
  boolean
>;

export interface ChromeVisibilityProjection {
  /** Replace the desired editor-chrome state. */
  setHidden(hidden: boolean): void;
  /** Invalidate queued work and cancel a pending frame-readiness retry. */
  stop(): void;
}

/**
 * Project the latest shell chrome intent into the serialized native owner.
 *
 * The native default is visible, so the first `false` intent needs no call.
 * After that, one owner ticket can run and one replaceable latest intent can
 * wait. If an old ticket already entered native code, its real side effect is
 * followed by a ticket for the current intent; a stale completion is never
 * mistaken for proof that the current intent was applied.
 */
export function createChromeVisibilityProjection(opts: {
  setChrome: ChromeSetter;
  report?: (message: string) => void;
  retryMs?: number;
  retryForMs?: number;
}): ChromeVisibilityProjection {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const retryForMs = opts.retryForMs ?? DEFAULT_RETRY_FOR_MS;
  let desiredHidden = false;
  let stopped = false;
  let cancelRetryWait: (() => void) | undefined;

  const interruptRetryWait = (): void => {
    const cancel = cancelRetryWait;
    cancelRetryWait = undefined;
    cancel?.();
  };

  const waitForRetry = (): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      let cancel!: () => void;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (cancelRetryWait === cancel) cancelRetryWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, retryMs);
      cancel = () => {
        clearTimeout(timer);
        finish();
      };
      cancelRetryWait = cancel;
    });

  const projection = createLatestOwnerProjection<boolean>({
    label: "set chrome visibility",
    snapshot: () => desiredHidden,
    submit: async (hidden, isCurrent) => {
      const deadline = Date.now() + retryForMs;
      let attempted = false;

      while (isCurrent()) {
        if (attempted && Date.now() >= deadline) return;
        attempted = true;
        const applied = await runGuardedOwnerExport(
          opts.setChrome,
          [!hidden] as const,
          isCurrent,
        );
        if (applied || !isCurrent()) return;
        await waitForRetry();
      }
    },
    retryMs,
    report: opts.report,
  });

  return {
    setHidden(hidden) {
      if (stopped || hidden === desiredHidden) return;
      desiredHidden = hidden;
      projection.request();
      // A changed intent need not wait for an obsolete frame-readiness delay.
      interruptRetryWait();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      projection.stop();
      interruptRetryWait();
    },
  };
}
