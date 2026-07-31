/**
 * Load timeline for diagnosing the production board-load crash
 * (`RuntimeError: table index is out of bounds` / `indirect call signature
 * mismatch`), which we have never reproduced locally across many attempts.
 *
 * The symbolized stack puts the fault in the GAL refresh timer re-arming itself
 * (`onRefreshTimer` -> `ForceRefresh` -> `wxTimer::Start` -> `emscripten_async_call`),
 * a loop that only runs while the canvas has not yet initialized — i.e. inside
 * `OpenProjectFiles`, during the `PreloadLibraries` pass that runs INLINE on the
 * main thread in the WASM build. Every prod report so far has been a console
 * dump with no timing and no state, which is why five theories died slowly.
 *
 * So this records the few facts that would actually discriminate between the
 * surviving hypotheses, and nothing else:
 *
 *  - WHEN each phase happened, on one monotonic clock, so a crash can be placed
 *    inside or outside the open window rather than guessed at from log order;
 *  - HEAP SIZE at every mark, and every growth event. Growing wasm memory
 *    detaches JS-side views, and a stale view writing into a detached buffer is
 *    one of the few mechanisms that produces exactly a bad function-table index
 *    much later. Locally the heap barely moves; in production it should not be
 *    guessed at;
 *  - whether the wx UI ever reached first paint, which is the precondition that
 *    closes the vulnerable window.
 *
 * Cheap enough to leave on in production: a bounded array, a handful of marks
 * per load, and one `console.info` line each. `dump()` is what a fatal handler
 * prints — the whole timeline at once, so a user pasting one block gives us
 * everything instead of a screenshot of the last line.
 */

export interface TraceEntry {
  /** ms since the trace started (monotonic; `performance.now`-based). */
  t: number;
  phase: string;
  detail?: string;
  /** wasm linear-memory size at this mark, in bytes (0 when not yet up). */
  heap: number;
}

const MAX_ENTRIES = 200;
const entries: TraceEntry[] = [];
const t0 = typeof performance !== "undefined" ? performance.now() : 0;
let lastHeap = 0;

function now(): number {
  return (typeof performance !== "undefined" ? performance.now() : 0) - t0;
}

/**
 * Current wasm linear-memory size. Emscripten replaces the HEAP* views on
 * growth, so reading `byteLength` off the live view each time reports the
 * CURRENT size rather than a cached one.
 */
export function heapBytes(win: unknown = globalThis): number {
  const w = win as {
    wasmMemory?: { buffer?: ArrayBuffer };
    Module?: { HEAPU8?: { byteLength?: number }; wasmMemory?: { buffer?: ArrayBuffer } };
  };
  return (
    w.wasmMemory?.buffer?.byteLength ??
    w.Module?.wasmMemory?.buffer?.byteLength ??
    w.Module?.HEAPU8?.byteLength ??
    0
  );
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)}MB`;

/**
 * Record one phase transition. Returns the formatted line so a caller can also
 * put it in the in-app log panel (which the fatal overlay now shows) without
 * formatting it twice.
 */
export function mark(phase: string, detail?: string): string {
  const heap = heapBytes();
  const t = now();
  if (entries.length >= MAX_ENTRIES) entries.shift();
  entries.push(detail ? { t, phase, detail, heap } : { t, phase, heap });

  // Growth is called out explicitly: it's the event most likely to matter and
  // the one hardest to spot in a wall of absolute numbers.
  let grew = "";
  if (lastHeap && heap > lastHeap) grew = ` GREW +${mb(heap - lastHeap)}`;
  lastHeap = heap;

  const line =
    `[trace] +${(t / 1000).toFixed(1)}s ${phase}` +
    (detail ? ` ${detail}` : "") +
    (heap ? ` heap=${mb(heap)}${grew}` : "");
  try {
    console.info(line);
  } catch {
    /* console unavailable — the entry is still recorded for dump() */
  }
  return line;
}

/**
 * The whole timeline as one block, for a fatal handler to print. One paste from
 * a user then carries the full load shape instead of a single error line.
 */
export function dump(): string {
  if (entries.length === 0) return "[trace] (no entries)";
  const rows = entries.map(
    (e) =>
      `  +${(e.t / 1000).toFixed(1)}s  ${e.phase}${e.detail ? ` ${e.detail}` : ""}` +
      (e.heap ? `  heap=${mb(e.heap)}` : ""),
  );
  const peak = entries.reduce((m, e) => Math.max(m, e.heap), 0);
  return [
    `[trace] load timeline (${entries.length} marks, peak heap ${mb(peak)}):`,
    ...rows,
  ].join("\n");
}

/** Test seam / re-mount reset. */
export function resetTrace(): void {
  entries.length = 0;
  lastHeap = 0;
}
