import { collabRoomId, docToFile, ydocHasState, yToDoc } from "@pcbjam/shared";
import type * as Y from "yjs";
import { restageTextFileAsOwner } from "../kicad-runner";
import {
  classifyOwnerJobFailure,
  isRetryableOwnerBackpressure,
} from "../owner-job";
import { connectKicadDoc, type KicadDocSession } from "./index";
import type { ProviderConfig } from "./provider";
import { destroyKicadDocSession } from "./doc-session-owner";

/**
 * Live sibling-document mirror for pcbnew sessions (project-sync 0001 bug 3).
 *
 * Boot stages every project file into MEMFS exactly once (kicad-runner
 * syncProjectToMemfs) — and since the files route materializes from the ydoc,
 * that snapshot is room-fresh at fetch time. A sheet can therefore only drift
 * from its MEMFS copy while SOMEONE IS EDITING IT — and whoever does sits in
 * the project presence room announcing which document their tab has open
 * (PresenceState.sheetPath). So instead of eagerly holding one board-room
 * WebSocket per sibling schematic for the whole session, this watches the
 * presence roster and connects a sheet's room only while a peer (including the
 * same user's other tab) actually has it open — a solo session holds ZERO
 * sibling sockets. On connect it restages once (the peer may have edited
 * between our boot fetch and now), then re-materializes into MEMFS on updates,
 * debounced like the lib refresh. When the peer leaves, the socket lingers
 * briefly (reload flaps), flushes a final restage, and closes.
 *
 * Without a presence room (provider "none", connect failure) it falls back to
 * the eager mode: every in-scope sheet is watched for the whole session.
 *
 * MEMFS-only: nothing is uploaded and no editor poke is needed — pcbnew reads
 * the schematic from MEMFS when the sync runs. Accepted v1 gaps: a sheet
 * created by a peer mid-session (path not in the boot file list), and a peer
 * whose edit lands between our boot fetch and their presence entry reaching us
 * (a seconds-wide window during boot; the next load heals it).
 */

const RESTAGE_DEBOUNCE_MS = 400;
/**
 * A full owner queue has no capacity-edge callback. Retry its retained latest
 * value at a fixed, bounded rate instead: one timer and at most one capacity
 * retry per path per second. A newer generation replaces the value and rearms
 * this same timer; it never creates another retry chain.
 */
const RESTAGE_BACKPRESSURE_RETRY_MS = 1_000;
/** How long a watch outlives its last announcing peer (reload/nav flaps). */
const CLOSE_LINGER_MS = 30_000;
/** First retry after an initial sibling-room provider/sync failure. */
const CONNECT_RETRY_BASE_MS = 1_000;
/** Upper bound keeps recovery live without turning an outage into a dial storm. */
const CONNECT_RETRY_MAX_MS = 30_000;

export interface SiblingRestageHandle {
  destroy(): void;
}

/**
 * The slice of `CrossAppHandle` this consumes (structural, so tests fake it):
 * the project-presence roster + its change feed.
 */
export interface SiblingPresence {
  peers(): Array<{ state: { sheetPath?: string } }>;
  subscribe(cb: () => void): () => void;
}

interface Watch {
  session?: KicadDocSession;
  connecting?: Promise<void>;
  connectAbort?: AbortController;
  detachConnectAbort?: () => void;
  linger?: ReturnType<typeof setTimeout>;
  /** The one delayed provider re-dial allowed for this sheet path. */
  reconnect?: ReturnType<typeof setTimeout>;
  /** Consecutive provider/sync failures; reset only by a published session. */
  connectFailures: number;
  /** Absolute lower bound retained even if roster churn cancels the timer. */
  retryNotBefore: number;
  /** Invalidates an aborted attempt and every late/reverse completion. */
  connectGeneration: number;
}

function newWatch(): Watch {
  return {
    connectFailures: 0,
    retryNotBefore: 0,
    connectGeneration: 0,
  };
}

function connectRetryDelay(failures: number): number {
  // Clamp the exponent before exponentiation too: this remains finite even
  // across a multi-day outage with an unbounded number of failed attempts.
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(CONNECT_RETRY_BASE_MS * 2 ** exponent, CONNECT_RETRY_MAX_MS);
}

function linkedAbortController(parent?: AbortSignal): {
  controller: AbortController;
  detach(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    detach: () => parent?.removeEventListener("abort", onAbort),
  };
}

interface RestageLane {
  /** Changes for every accepted body; an older owner ticket checks this. */
  version: number;
  /** One retained latest value while the submitted ticket is still pending. */
  pending?: string;
  /** True from gateway submission through exact native-owner retirement. */
  ticketPending: boolean;
  /** The sole level-triggered retry for a temporarily full owner queue. */
  retry?: ReturnType<typeof setTimeout>;
  /** Avoid one warning per bounded retry while the same lane is blocked. */
  backpressureReported: boolean;
}

type OwnerBackpressure = {
  code?: unknown;
  reason?: unknown;
  estimatedBytes?: unknown;
  maxBytes?: unknown;
};

function ownerError(error: unknown): OwnerBackpressure {
  return error !== null && typeof error === "object"
    ? (error as OwnerBackpressure)
    : {};
}

function measuredPayload(detail: OwnerBackpressure):
  | { estimatedBytes: number; maxBytes: number }
  | undefined {
  const { estimatedBytes, maxBytes } = detail;
  if (
    typeof estimatedBytes !== "number" ||
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(estimatedBytes) ||
    !Number.isSafeInteger(maxBytes) ||
    estimatedBytes < 0 ||
    maxBytes < 0
  ) {
    return undefined;
  }
  return { estimatedBytes, maxBytes };
}

function isIntrinsicOwnerOversize(error: unknown): boolean {
  const detail = ownerError(error);
  const payload = measuredPayload(detail);
  return (
    detail.code === "WX_MUTATOR_BACKPRESSURE" &&
    payload !== undefined &&
    payload.estimatedBytes > payload.maxBytes
  );
}

export async function startSiblingRestage(opts: {
  win: ToolWindow;
  slug: string;
  scopeId: string;
  projectId: string;
  files: { path: string }[];
  /** The opened `.kicad_pcb` — scopes the watch to ITS KiCad project. */
  targetPath?: string;
  /** Project presence roster; omitted ⇒ eager mode (watch every sheet). */
  presence?: SiblingPresence;
  provider: ProviderConfig;
  /** Owning editor lifetime; aborts every unfinished room handshake. */
  signal?: AbortSignal;
  /** Test/diagnostic override for the initial provider sync deadline. */
  syncTimeoutMs?: number;
  log: (m: string) => void;
}): Promise<SiblingRestageHandle> {
  const { win, slug, log } = opts;
  // Only the opened board's own KiCad project can be synced from: pcbnew's
  // "update from schematic" reads the sheets next to the .kicad_pcb (same
  // directory tree). A backend project holding SEVERAL KiCad projects (a
  // repo of boards) must not fan out repo-wide — that held ~27 idle
  // board-room sockets for an 8-board repo. Sheets a project references
  // OUTSIDE its directory (rare ../ sheet paths) fall back to the boot
  // snapshot — same gap v1 already accepts for new sheets.
  const dir = opts.targetPath
    ? opts.targetPath.slice(0, opts.targetPath.lastIndexOf("/") + 1)
    : "";
  const sheetPaths = opts.files
    .map((f) => f.path)
    .filter((p) => p.endsWith(".kicad_sch") && p.startsWith(dir));
  const sheetSet = new Set(sheetPaths);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const restages = new Map<string, RestageLane>();
  let destroyed = false;
  // This handle belongs to one editor Module lifetime. A terminal scheduler or
  // Wasm failure stops only native MEMFS projection; the Yjs/WebSocket rooms
  // remain useful and continue receiving authoritative data until destroy().
  let nativeRestageStopped = false;
  const lifetime = linkedAbortController(opts.signal);
  if (lifetime.controller.signal.aborted) destroyed = true;
  else {
    lifetime.controller.signal.addEventListener("abort", () => {
      destroyed = true;
    }, { once: true });
  }

  const retireSession = (
    sheetPath: string,
    session: KicadDocSession,
  ): void => {
    try {
      // The provider owns the socket and the Y.Doc owns its observers. The
      // shared helper uses finally so a throwing provider destructor cannot
      // strand the document; this boundary keeps teardown terminal.
      destroyKicadDocSession(session);
    } catch (err) {
      log(`[sibling] session cleanup failed for ${sheetPath}: ${String(err)}`);
    }
  };

  const cancelRetry = (lane: RestageLane): void => {
    if (lane.retry !== undefined) {
      clearTimeout(lane.retry);
      lane.retry = undefined;
    }
  };

  const cancelRestages = (): void => {
    for (const lane of restages.values()) {
      cancelRetry(lane);
      lane.pending = undefined;
    }
    restages.clear();
  };

  const stopNativeRestages = (): void => {
    if (nativeRestageStopped) return;
    nativeRestageStopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    cancelRestages();
  };

  const scheduleRetry = (sheetPath: string, lane: RestageLane): void => {
    if (
      destroyed ||
      nativeRestageStopped ||
      restages.get(sheetPath) !== lane ||
      lane.pending === undefined ||
      lane.ticketPending ||
      lane.retry !== undefined
    ) {
      return;
    }

    const version = lane.version;
    lane.retry = setTimeout(() => {
      lane.retry = undefined;
      if (
        destroyed ||
        restages.get(sheetPath) !== lane ||
        lane.version !== version
      ) {
        return;
      }
      drainRestage(sheetPath, lane);
    }, RESTAGE_BACKPRESSURE_RETRY_MS);
  };

  const drainRestage = (sheetPath: string, lane: RestageLane): void => {
    if (destroyed || nativeRestageStopped || restages.get(sheetPath) !== lane) {
      lane.pending = undefined;
      return;
    }
    const text = lane.pending;
    if (text === undefined || lane.ticketPending) return;

    lane.pending = undefined;
    lane.ticketPending = true;
    const version = lane.version;
    let completion:
      | "success"
      | "retry"
      | "stale"
      | "terminal"
      | "oversized"
      | "failed" = "success";
    void restageTextFileAsOwner(
      win,
      slug,
      sheetPath,
      text,
      log,
      () =>
        !destroyed &&
        !nativeRestageStopped &&
        restages.get(sheetPath) === lane &&
        lane.version === version,
    )
      .catch((error: unknown) => {
        // A newer body intentionally invalidates the queued owner ticket.
        // The latest value below gets the next (and only next) ticket.
        const failureKind = classifyOwnerJobFailure(error);
        if (failureKind === "backpressure") {
          completion = "retry";
          // Do not overwrite a newer generation which arrived while this
          // ticket was pending. Otherwise restore the rejected body as the
          // authoritative level value for the bounded retry.
          if (lane.version === version && lane.pending === undefined) {
            lane.pending = text;
          }
          if (!lane.backpressureReported && !destroyed) {
            lane.backpressureReported = true;
            log(
              `[sibling] owner queue full; delaying restage for ${sheetPath}`,
            );
          }
        } else if (failureKind === "stale") {
          completion = "stale";
        } else if (failureKind === "terminal") {
          completion = "terminal";
          const reportTerminal = !nativeRestageStopped && !destroyed;
          // Latch before calling the host logger. A diagnostic callback must
          // not be able to resurrect native work if it throws.
          stopNativeRestages();
          if (reportTerminal) {
            log(
              `[sibling] native restaging stopped after terminal owner failure: ${String(error)}`,
            );
          }
        } else if (isIntrinsicOwnerOversize(error)) {
          completion = "oversized";
        } else {
          completion = "failed";
        }
        if (
          (completion === "failed" || completion === "oversized") &&
          !destroyed
        ) {
          log(`[sibling] restage failed for ${sheetPath}: ${String(error)}`);
        }
      })
      .finally(() => {
        lane.ticketPending = false;
        if (destroyed || restages.get(sheetPath) !== lane) {
          lane.pending = undefined;
          return;
        }
        if (completion === "success") lane.backpressureReported = false;

        // An unknown failure is not a capacity signal. Stop this lane instead
        // of retrying the same value. Stale and intrinsically oversized bodies
        // are not retried either, but a newer generation which arrived in this
        // live resource can still be independent. Terminal failure has already
        // retired every native-restage lane for this handle above.
        if (completion === "failed") {
          lane.pending = undefined;
          restages.delete(sheetPath);
        } else if (lane.pending !== undefined) {
          if (completion === "retry") scheduleRetry(sheetPath, lane);
          else drainRestage(sheetPath, lane);
        } else {
          restages.delete(sheetPath);
        }
      });
  };

  const queueRestage = (sheetPath: string, text: string): void => {
    if (destroyed || nativeRestageStopped) return;
    let lane = restages.get(sheetPath);
    if (!lane) {
      lane = {
        version: 0,
        ticketPending: false,
        backpressureReported: false,
      };
      restages.set(sheetPath, lane);
    }
    const wasWaitingToRetry = lane.retry !== undefined;
    cancelRetry(lane);
    lane.version++;
    lane.pending = text;
    // A generation change cancels the old timer and rearms one timer for the
    // new latest value. It must not bypass the retry rate limit merely because
    // WebSocket updates keep arriving.
    if (wasWaitingToRetry) scheduleRetry(sheetPath, lane);
    else drainRestage(sheetPath, lane);
  };

  const restageFromDoc = (sheetPath: string, doc: Y.Doc) => {
    if (destroyed || nativeRestageStopped) return;
    try {
      // An empty room means no one ever seeded this sheet — the boot-staged
      // API snapshot is the freshest copy there is; leave it alone.
      if (!ydocHasState(doc)) return;
      const text = docToFile(yToDoc(doc));
      queueRestage(sheetPath, text);
    } catch (err) {
      log(`[sibling] restage failed for ${sheetPath}: ${String(err)}`);
    }
  };

  const schedule = (sheetPath: string, doc: Y.Doc) => {
    if (destroyed || nativeRestageStopped) return;
    const prev = timers.get(sheetPath);
    if (prev) clearTimeout(prev);
    timers.set(
      sheetPath,
      setTimeout(() => {
        timers.delete(sheetPath);
        if (!destroyed) restageFromDoc(sheetPath, doc);
      }, RESTAGE_DEBOUNCE_MS),
    );
  };

  const openSession = async (
    sheetPath: string,
    isCurrent: () => boolean = () => !destroyed,
    signal: AbortSignal = lifetime.controller.signal,
  ): Promise<KicadDocSession | null> => {
    const session = await connectKicadDoc({
      provider: opts.provider,
      room: collabRoomId(opts.scopeId, opts.projectId, sheetPath),
      signal,
      syncTimeoutMs: opts.syncTimeoutMs,
    });
    // A peer can leave, the linger can expire, and a new watch can start while
    // the old WebSocket handshake is still in flight. Only the exact Watch
    // that issued this connect may install observers or restage MEMFS.
    if (!isCurrent()) {
      retireSession(sheetPath, session);
      return null;
    }
    try {
      // Data-only observer: never appear in the sheet's presence roster
      // (mirrors the sheet-manager's read-only invisible-observer handling).
      session.provider.awareness?.setLocalState(null);
      session.doc.on("update", () => {
        if (isCurrent()) schedule(sheetPath, session.doc);
      });
      log(`[sibling] watching ${sheetPath}`);
      restageFromDoc(sheetPath, session.doc);
      return session;
    } catch (err) {
      // A connected session is already owned even if observer setup fails.
      retireSession(sheetPath, session);
      throw err;
    }
  };

  /* -------------------- bounded room-connection watches ------------------- */

  const watches = new Map<string, Watch>();
  let announced = new Set<string>();

  const cancelReconnect = (w: Watch) => {
    if (w.reconnect !== undefined) {
      clearTimeout(w.reconnect);
      w.reconnect = undefined;
    }
  };

  const abortConnect = (
    sheetPath: string,
    w: Watch,
    retainRateLimit: boolean,
  ) => {
    if (!w.connecting) return;
    // Invalidate before aborting. Some provider constructors cannot be
    // force-cancelled and can still resolve after their signal is aborted.
    w.connectGeneration++;
    if (retainRateLimit) {
      w.retryNotBefore = Math.max(
        w.retryNotBefore,
        Date.now() + connectRetryDelay(Math.max(w.connectFailures, 1)),
      );
    }
    w.detachConnectAbort?.();
    w.detachConnectAbort = undefined;
    w.connectAbort?.abort(
      new DOMException(
        `The sibling connect for ${sheetPath} was retired`,
        "AbortError",
      ),
    );
    w.connectAbort = undefined;
    // Do not let an abort-insensitive old constructor block a future exact
    // attempt. Its generation guard will destroy any late provider/doc pair.
    w.connecting = undefined;
  };

  const isCurrentWatch = (sheetPath: string, w: Watch) =>
    !destroyed && watches.get(sheetPath) === w;

  const shouldConnect = (sheetPath: string, w: Watch) =>
    isCurrentWatch(sheetPath, w) && announced.has(sheetPath) && !w.session;

  const scheduleReconnect = (sheetPath: string, w: Watch): void => {
    if (
      !shouldConnect(sheetPath, w) ||
      w.connecting ||
      w.reconnect !== undefined
    ) {
      return;
    }
    const delay = Math.max(0, w.retryNotBefore - Date.now());
    if (delay === 0) {
      beginConnect(sheetPath, w);
      return;
    }
    w.reconnect = setTimeout(() => {
      w.reconnect = undefined;
      if (shouldConnect(sheetPath, w)) beginConnect(sheetPath, w);
    }, delay);
  };

  const beginConnect = (sheetPath: string, w: Watch): Promise<void> => {
    if (!shouldConnect(sheetPath, w) || w.connecting) {
      return w.connecting ?? Promise.resolve();
    }
    cancelReconnect(w);
    const generation = ++w.connectGeneration;
    const attemptLifetime = linkedAbortController(lifetime.controller.signal);
    w.connectAbort = attemptLifetime.controller;
    w.detachConnectAbort = attemptLifetime.detach;
    let retry = false;

    const attempt = (async () => {
      try {
        const session = await openSession(
          sheetPath,
          () =>
            isCurrentWatch(sheetPath, w) &&
            w.connectGeneration === generation,
          attemptLifetime.controller.signal,
        );
        if (!session) return;
        // Publication is the exact reset edge. A later failure starts again
        // at the base delay instead of inheriting an old outage's backoff.
        w.session = session;
        w.connectFailures = 0;
        w.retryNotBefore = 0;
      } catch (err) {
        if (
          attemptLifetime.controller.signal.aborted ||
          !isCurrentWatch(sheetPath, w) ||
          w.connectGeneration !== generation
        ) {
          return;
        }
        // Once the maximum delay is reached, a larger counter has no meaning.
        w.connectFailures = Math.min(w.connectFailures + 1, 31);
        w.retryNotBefore =
          Date.now() + connectRetryDelay(w.connectFailures);
        retry = true;
        log(`[sibling] room connect failed for ${sheetPath}: ${String(err)}`);
      } finally {
        attemptLifetime.detach();
        if (
          isCurrentWatch(sheetPath, w) &&
          w.connectGeneration === generation
        ) {
          w.connectAbort = undefined;
          w.detachConnectAbort = undefined;
          w.connecting = undefined;
          if (retry) scheduleReconnect(sheetPath, w);
        }
      }
    })();
    w.connecting = attempt;
    return attempt;
  };

  const closeNow = (sheetPath: string, w: Watch, flushPending: boolean) => {
    const t = timers.get(sheetPath);
    if (t) {
      clearTimeout(t);
      timers.delete(sheetPath);
      // A debounced restage was pending — run it before dropping the doc, or
      // the peer's last burst of edits never reaches MEMFS.
      if (flushPending && w.session) restageFromDoc(sheetPath, w.session.doc);
    }
    if (w.linger) clearTimeout(w.linger);
    cancelReconnect(w);
    abortConnect(sheetPath, w, false);
    // Invalidate the Watch before calling third-party destructors. A late
    // callback then sees no current owner even if cleanup itself faults.
    watches.delete(sheetPath);
    const session = w.session;
    w.session = undefined;
    if (session) retireSession(sheetPath, session);
  };

  /* ------------------------- eager fallback (no presence room) ------------ */

  if (!opts.presence) {
    announced = new Set(sheetPaths);
    await Promise.all(
      sheetPaths.map((sheetPath) => {
        const w = newWatch();
        watches.set(sheetPath, w);
        return beginConnect(sheetPath, w);
      }),
    );
    return {
      destroy() {
        destroyed = true;
        lifetime.detach();
        lifetime.controller.abort(
          new DOMException("The sibling restage handle was destroyed", "AbortError"),
        );
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        cancelRestages();
        for (const [sheetPath, w] of [...watches]) {
          closeNow(sheetPath, w, false);
        }
      },
    };
  }

  /* ------------------------- presence-driven mode ------------------------- */

  const presence = opts.presence;

  const reconcile = () => {
    if (destroyed) return;
    const open = new Set<string>();
    for (const p of presence.peers()) {
      const sp = p.state.sheetPath;
      if (sp && sheetSet.has(sp)) open.add(sp);
    }
    announced = open;
    for (const sheetPath of open) {
      let w = watches.get(sheetPath);
      if (w?.linger) {
        clearTimeout(w.linger);
        w.linger = undefined;
      }
      if (!w) {
        w = newWatch();
        watches.set(sheetPath, w);
      }
      scheduleReconnect(sheetPath, w);
    }
    for (const [sheetPath, w] of watches) {
      if (open.has(sheetPath) || w.linger) continue;
      // Leaving the live roster removes the reason to dial immediately. Keep
      // the absolute not-before edge so leave/rejoin churn cannot bypass the
      // per-path rate reducer, but cancel the timer itself while out of scope.
      cancelReconnect(w);
      abortConnect(sheetPath, w, true);
      w.linger = setTimeout(() => {
        if (destroyed) return;
        log(`[sibling] releasing ${sheetPath} (no peer has it open)`);
        closeNow(sheetPath, w, true);
      }, CLOSE_LINGER_MS);
    }
  };

  const unsubscribe = presence.subscribe(reconcile);
  reconcile();
  log(
    `[sibling] presence-scoped watch over ${sheetPaths.length} sheet(s) — ` +
      `connecting only while a peer has one open`,
  );

  return {
    destroy() {
      destroyed = true;
      lifetime.detach();
      lifetime.controller.abort(
        new DOMException("The sibling restage handle was destroyed", "AbortError"),
      );
      try {
        unsubscribe();
      } catch (err) {
        log(`[sibling] presence unsubscribe failed: ${String(err)}`);
      }
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      cancelRestages();
      for (const [sheetPath, w] of [...watches]) closeNow(sheetPath, w, false);
    },
  };
}
