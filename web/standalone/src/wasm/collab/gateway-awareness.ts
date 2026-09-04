import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import type * as Y from "yjs";

/**
 * Awareness for the gateway transport, WITHOUT the y-protocols liveness
 * clock (do-observability 0001 §A).
 *
 * Stock `Awareness` re-publishes the local state every ~15 s (and emits
 * `update` for it) so peers can expire a silent client after 30 s. On the
 * gateway that clock is redundant — the ProjectRoom synthesizes an awareness
 * tombstone + `gone` control for every departing (connection, channel) pair
 * (load-path-rework 0003 §4) — and it is the entire idle cost of an open
 * tab: every renewal is a frame, every frame wakes a hibernated Durable
 * Object, and N parked sheets run N clocks.
 *
 * This variant keeps `setLocalState` semantics (a real change still emits
 * exactly one update) but:
 *  - never renews the local state on a timer, so an idle tab is silent;
 *  - expires REMOTE states only after a long safety window, for the rare
 *    peer whose tombstone was lost (gateway restart mid-departure).
 *
 * The BroadcastChannel transport keeps the stock clock: it has no tombstones
 * and costs no DO.
 */

/** Remote state older than this is dropped (tombstones are the fast path). */
export const GATEWAY_AWARENESS_EXPIRY_MS = 10 * 60_000;
/** How often the safety sweep runs. */
export const GATEWAY_AWARENESS_SWEEP_MS = 30_000;

interface AwarenessInternals {
  _checkInterval: ReturnType<typeof setInterval>;
}

export function createGatewayAwareness(
  doc: Y.Doc,
  opts: { expiryMs?: number; sweepMs?: number; now?: () => number } = {},
): Awareness {
  const awareness = new Awareness(doc);
  const expiryMs = opts.expiryMs ?? GATEWAY_AWARENESS_EXPIRY_MS;
  const sweepMs = opts.sweepMs ?? GATEWAY_AWARENESS_SWEEP_MS;
  const now = opts.now ?? (() => Date.now());
  // Replace the stock renew/expire tick. `destroy()` clears `_checkInterval`,
  // so installing ours under the same field keeps teardown intact.
  const internals = awareness as unknown as AwarenessInternals;
  clearInterval(internals._checkInterval);
  internals._checkInterval = setInterval(() => {
    const t = now();
    const stale: number[] = [];
    for (const [clientId, meta] of awareness.meta) {
      if (clientId === awareness.clientID) continue;
      if (t - meta.lastUpdated >= expiryMs && awareness.states.has(clientId)) {
        stale.push(clientId);
      }
    }
    if (stale.length > 0) removeAwarenessStates(awareness, stale, "timeout");
  }, sweepMs);
  return awareness;
}
