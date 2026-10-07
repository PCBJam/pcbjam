/**
 * OOM tab recovery — feature 0002.
 *
 * The KiCad WASM runtime is process-global and cannot be torn down (see boot.ts:
 * "Reload the page to open another tool"). After an out-of-memory the wasm heap
 * and `Module` are unrecoverable in-context, so the only clean reset is a fresh
 * page in a fresh content process. Recovery goes through the /recover airlock
 * (0009, airlock.ts): a plain reload stays in Firefox's shared cross-origin-
 * isolated process, which is exactly the one that ran out. Capped at
 * MAX_RETRIES so a genuinely too-small machine stops instead of looping forever.
 *
 * Two crash modes:
 *   - Mode A (soft abort): JS is still alive — emscripten `abort()` /
 *     `Module.onAbort`, or a `RangeError`/`RuntimeError`/"Aborted(" surfacing as
 *     a window error/unhandledrejection. The tab self-recovers.
 *   - Mode B (hard kill): the renderer is killed ("Aw, Snap"); no in-tab code
 *     runs. We detect it on the NEXT load via a stale `localStorage` heartbeat
 *     sentinel and continue the retry chain.
 *
 * The retry counter rides in the URL query (`?oomRetry=N`) so a fresh context
 * knows its place in the chain. A session that stays healthy for HEALTHY_RESET_MS
 * resets the chain.
 *
 * Pure-ish and unit-testable: all platform access goes through injectable
 * `win`/`storage` seams (default to the real `window`/`localStorage`).
 */

import { airlockUrl } from "./airlock";

export const MAX_RETRIES = 2;

const RETRY_PARAM = "oomRetry";
const SENTINEL_PREFIX = "oom:running:";

/** A session alive this long is "healthy" → clear the retry chain. */
export const HEALTHY_RESET_MS = 30_000;
/** How often a live tab refreshes its sentinel heartbeat. */
const HEARTBEAT_MS = 10_000;
/** A sentinel whose heartbeat is older than this means a hard-killed tab, not a
 *  live one (the false-positive guard for two tabs open on the same file). */
export const SENTINEL_STALE_MS = 60_000;

const OOM_SIGNATURE =
  /out of memory|RangeError|Aborted\(|Cannot enlarge memory|memory access out of bounds/i;

/** Whether a console/error string looks like an OOM. Exported for tests. */
export function looksLikeOom(text: string | null | undefined): boolean {
  return typeof text === "string" && OOM_SIGNATURE.test(text);
}

interface SentinelValue {
  startedAt: number;
  /** Last heartbeat — staleness is measured from this. */
  beat: number;
  /** Retry-chain position this instance was running at. */
  retry: number;
}

export interface OomWatchOptions {
  /** Project slug + target file — same keying as the collab channel. */
  channelKey: string;
  /** Show the terminal "not enough memory" UI when the cap is reached. */
  showExhaustedDialog: () => void;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to the real globals. */
  win?: Window;
  storage?: Storage;
}

export interface OomWatch {
  /**
   * Install listeners + the sentinel, and reconcile any stale hard-kill sentinel.
   * Returns `proceed: false` when the chain is already exhausted (boot should be
   * skipped — the terminal dialog is shown instead).
   */
  start: () => { proceed: boolean };
  /** Remove listeners + timers and clear our own sentinel (clean unload). */
  stop: () => void;
  /** Soft-abort entry point — wired to `Module.onAbort` in boot.ts. */
  onAbort: (what?: unknown) => void;
}

function now(): number {
  // App code (not a workflow script): Date.now is available.
  return Date.now();
}

function newTabId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createOomWatch(opts: OomWatchOptions): OomWatch {
  const win = opts.win ?? window;
  const storage: Storage | null = opts.storage ?? safeLocalStorage(win);
  const log = opts.log ?? (() => {});
  const tabId = newTabId();
  const sentinelKey = `${SENTINEL_PREFIX}${opts.channelKey}:${tabId}`;

  let recovering = false; // idempotent latch — one OOM fires recovery once
  let started = false;
  let healthyTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const currentRetry = (): number => {
    const raw = new URLSearchParams(win.location.search).get(RETRY_PARAM);
    const n = Number(raw ?? "0");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  // --- sentinel helpers ------------------------------------------------------

  const writeSentinel = (retry: number): void => {
    if (!storage) return;
    const t = now();
    const value: SentinelValue = { startedAt: t, beat: t, retry };
    try {
      storage.setItem(sentinelKey, JSON.stringify(value));
    } catch {
      /* storage disabled — Mode B simply won't be available */
    }
  };

  const beat = (): void => {
    if (!storage) return;
    try {
      const raw = storage.getItem(sentinelKey);
      if (!raw) return;
      const value = JSON.parse(raw) as SentinelValue;
      value.beat = now();
      storage.setItem(sentinelKey, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  };

  const clearOwnSentinel = (): void => {
    if (!storage) return;
    try {
      storage.removeItem(sentinelKey);
    } catch {
      /* ignore */
    }
  };

  /** Scan for stale sentinels of THIS channel from other (crashed) tabs; remove
   *  them and return the highest retry seen, or null if none. */
  const reapStaleSentinels = (): number | null => {
    if (!storage) return null;
    const prefix = `${SENTINEL_PREFIX}${opts.channelKey}:`;
    const stale: string[] = [];
    let maxRetry: number | null = null;
    const t = now();
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || k === sentinelKey || !k.startsWith(prefix)) continue;
        let value: SentinelValue | null = null;
        try {
          value = JSON.parse(storage.getItem(k) ?? "") as SentinelValue;
        } catch {
          value = null;
        }
        // Malformed or heartbeat older than the staleness window ⇒ dead tab.
        if (!value || typeof value.beat !== "number" || t - value.beat > SENTINEL_STALE_MS) {
          stale.push(k);
          const r = value && typeof value.retry === "number" ? value.retry : 0;
          maxRetry = Math.max(maxRetry ?? 0, r);
        }
      }
      for (const k of stale) storage.removeItem(k);
    } catch {
      return maxRetry;
    }
    return maxRetry;
  };

  // --- recovery state machine ------------------------------------------------

  const recover = (reason: string, what?: string): void => {
    if (recovering) return;
    recovering = true;
    const n = currentRetry();
    log(`[oom] recover (${reason}${what ? `: ${what}` : ""}) at retry ${n}`);

    if (n >= MAX_RETRIES) {
      log(`[oom] retry cap (${MAX_RETRIES}) reached — giving up`);
      clearOwnSentinel();
      opts.showExhaustedDialog();
      return;
    }

    const url = new URL(win.location.href);
    url.searchParams.set(RETRY_PARAM, String(n + 1));
    clearOwnSentinel(); // the new context writes its own sentinel

    // Through the airlock (0009), never an in-place reload: leaving for a
    // non-isolated page is what lets Firefox drop the exhausted process.
    win.location.replace(airlockUrl(url.toString()));
  };

  // --- Mode A listeners ------------------------------------------------------

  const onError = (e: ErrorEvent): void => {
    const msg = e?.message || (e?.error ? String(e.error) : "");
    if (looksLikeOom(msg)) recover("error", msg);
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    const reason = e?.reason;
    const msg = typeof reason === "string" ? reason : reason ? String(reason) : "";
    if (looksLikeOom(msg)) recover("unhandledrejection", msg);
  };
  const onBeforeUnload = (): void => {
    // Clean unload → drop our sentinel so it isn't mistaken for a hard kill.
    clearOwnSentinel();
  };

  // --- public API ------------------------------------------------------------

  const onAbort = (what?: unknown): void => {
    recover("onabort", what === undefined ? undefined : String(what));
  };

  const start = (): { proceed: boolean } => {
    if (started) return { proceed: true };
    started = true;

    // Mode B: a stale sentinel from a prior hard-killed instance ⇒ continue its
    // retry chain rather than resetting (so the cap still applies).
    const staleRetry = reapStaleSentinels();
    if (staleRetry !== null) {
      const n = Math.max(currentRetry(), staleRetry);
      if (n >= MAX_RETRIES) {
        log(`[oom] hard-kill chain already exhausted at retry ${n}`);
        opts.showExhaustedDialog();
        return { proceed: false };
      }
      // Adopt the chain position so a further OOM in THIS instance caps correctly.
      const url = new URL(win.location.href);
      url.searchParams.set(RETRY_PARAM, String(n));
      try {
        win.history.replaceState(null, "", url.toString());
      } catch {
        /* ignore — currentRetry will still read the original */
      }
      log(`[oom] continuing hard-kill chain at retry ${n}`);
    }

    writeSentinel(currentRetry());
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);

    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    win.addEventListener("beforeunload", onBeforeUnload);

    // Healthy-session reset: after surviving HEALTHY_RESET_MS, clear the chain so
    // a later, unrelated OOM starts counting fresh.
    if (currentRetry() > 0) {
      healthyTimer = setTimeout(() => {
        const url = new URL(win.location.href);
        if (url.searchParams.has(RETRY_PARAM)) {
          url.searchParams.delete(RETRY_PARAM);
          try {
            win.history.replaceState(null, "", url.toString());
          } catch {
            /* ignore */
          }
          log("[oom] healthy session — retry chain reset");
        }
        writeSentinel(0);
      }, HEALTHY_RESET_MS);
    }

    return { proceed: true };
  };

  const stop = (): void => {
    if (healthyTimer) clearTimeout(healthyTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
    win.removeEventListener("beforeunload", onBeforeUnload);
    clearOwnSentinel();
  };

  return { start, stop, onAbort };
}

/**
 * The terminal dialog's "Restart the editor": the same airlock trip as the
 * automatic recovery, with a fresh retry chain (this is a manual retry).
 */
export function restartViaAirlock(win: Window = window): void {
  const url = new URL(win.location.href);
  url.searchParams.delete(RETRY_PARAM);
  win.location.replace(airlockUrl(url.toString()));
}

function safeLocalStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}
