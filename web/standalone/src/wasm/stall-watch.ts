/**
 * KiCad stall watch. A person saw the editor stop taking input for a while (no cursor, no
 * zoom) while the page's own controls kept working: KiCad's event loop dispatches nothing
 * while one of its handlers is parked on a wait (`ProcessEvents` no-ops into a repaint,
 * wxwidgets/src/wasm/evtloop.cpp). This logs every such park over STALL_MS once, with what
 * the scheduler says it waits on and the last operation the editor ran for a plugin or an
 * agent: the line to send when it happens.
 */

/** A park this long is a stall a person notices. */
const STALL_MS = 2000;

interface SchedulerDump {
  suspendedActivations?: Array<{ id: number; kind: string; waitKind: string | null; token: number; suspendedMs: number }>;
  pendingWaits?: number;
}

/** The last editor operation run for a plugin or an agent, set by whoever runs it. */
export const lastHostOp: { op: string | null; startedAt: number; endedAt: number | null } = { op: null, startedAt: 0, endedAt: null };

/** Start watching; returns the stop. */
export function startStallWatch(): () => void {
  const reported = new Set<number>();
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return; // a hidden tab gets no frames: not a stall
    const dump = (globalThis as { __wxScheduler?: { dump(): SchedulerDump } }).__wxScheduler?.dump();
    // The library context's coroutine lives parked by design, and the main loop parks on every frame.
    const parked = (dump?.suspendedActivations ?? []).filter((a) => a.kind !== 'libctx' && a.waitKind !== 'frame' && a.suspendedMs >= STALL_MS);
    for (const id of reported) if (!parked.some((a) => a.id === id)) reported.delete(id);
    const fresh = parked.filter((a) => !reported.has(a.id));
    if (!fresh.length) return;
    for (const a of fresh) reported.add(a.id);
    const now = Date.now();
    const op = lastHostOp.op
      ? `last host op: ${lastHostOp.op} ${Math.round((now - lastHostOp.startedAt) / 1000)}s ago, ${lastHostOp.endedAt === null ? 'still running' : `took ${lastHostOp.endedAt - lastHostOp.startedAt}ms`}`
      : 'no host op yet';
    console.warn(`[stall] KiCad has a handler parked ${(Math.max(...fresh.map((a) => a.suspendedMs)) / 1000).toFixed(1)}s (no input until it resumes); ${op}`, JSON.stringify(dump));
  }, 1000);
  return () => clearInterval(timer);
}
