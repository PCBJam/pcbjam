# 15 — Timer-park repro lever (concurrent-Asyncify collision)

Status: lever built 2026-07-31 · spec `tests/kicad/timer-park-repro.spec.ts` ·
investigation: the v0.1.17–19 prod board-load trap (gal-refresh-timer).

## Why this exists

The prod trap ("index out of bounds" + "unreachable executed" in
`doRewind`/`finishContextSwitch`) has survived three shipped fixes and 10+
local repro attempts. The 2026-07-31 v0.1.19 crash log re-ranked the
hypotheses decisively:

- The wx diagnostics shipped in v0.1.19 (`[wx-dispatch]` depth-erasure,
  `[wx-timer]` retry storms) were **live and silent** on a real crashing run —
  the modal depth-zeroing and long-parked-dispatch theories are disfavored.
- The load was **fast** (0.5 s open, warm caches) and still trapped, 214 ms
  after `open:settled`, before any collab embind entry — inside the GAL
  pre-first-paint 100 ms rearm cascade.

What remains is the **concurrent-park family** (emscripten #9153): the main
loop spends most wall-clock time Asyncify-parked in `wxWasmYieldToBrowser`; a
wx timer callback is a fresh JS→wasm entry; if the timer handler itself parks,
two live Asyncify contexts share the single-slot `Asyncify.currData`. The
`handlesleep.js` shim silently repairs the pointer aliasing (as of this change
it REPORTS each repair as `[wx-asyncify] …`), but fiber swaps
(`emscripten_fiber_swap`, used by every collab entry via TOOL_MANAGER
coroutines) bypass its accounting entirely — and `finishContextSwitch` is
exactly where the prod trap's second stack dies.

## The lever

`wasm/bindings/timer_park.h` + exports in `pcbnew_embind.cpp` and
`kicad_editor_embind.cpp` (mirrors the `kicadTestSetOpenPark` conventions):

- `kicadTestArmTimerPark(delayMs, parkMs) → bool` — one-shot `wxTimer` whose
  `Notify()` runs `emscripten_sleep(parkMs)`. The entry path is byte-for-byte
  the GAL refresh timer's: `emscripten_async_call → TimerCallbackFunc::Run →
  wxWasmDispatchGuard → Notify()` — then it parks, which is what the GAL
  handler is suspected of doing (paint → GAL init / lib bridge) on crashing
  loads.
- `kicadTestTimerParkState() → {"fired","done","parked","parkMs"}` — JS-pollable
  progress. `fired` without `done` = the park is in flight.

Production is inert: nothing fires unless armed.

Side effect worth knowing: while the parked `Notify()` holds its dispatch
guard, every other due timer spins the 17 ms retry loop — a park ≥ ~1 s also
exercises the `[wx-timer] retry storm` diagnostic.

## The spec

`tests/kicad/timer-park-repro.spec.ts` (pcbnew-collab harness, merged
`kicad_editor.js`): open a 2k-item board, settle, then three cycles —
park-only, park + fiber hammering (`kicadCollabSnapshotItems` /
`kicadCollabGetPos` every 10 ms through the window), and a second hammered
draw. Asserts:

- each cycle's `Notify()` fires, is observed parked, and **survives its rewind**;
- no embind entry traps; no trap signature anywhere in the console;
- the runtime stays functional afterwards (snapshot walks the board, a real
  apply lands);
- the `[wx-asyncify]` shim diagnostics observed the concurrent-park window —
  silence there means the lever never created the overlap (vacuous run), not
  a pass.

**Interpretation:** RED with the prod signature ⇒ hypothesis confirmed, and
the failing interleaving is named by the shim lines. GREEN ⇒ plain
double-park + fiber-during-park is handled; the prod mechanism needs another
ingredient (ranked next: fiber swap racing a park's WAKE, GAL-init-specific
state, memory growth mid-park — see the trace `GREW +187MB` at `stage:done`).

## Round 1 result (2026-07-31, first run of the lever)

**GREEN — and the window demonstrably engaged.** Three cycles (park-only,
2× park + fiber hammer) on the fresh build:

- `[wx-asyncify] aliased-wake-live` fired **6×**: two different chains'
  asyncify buffers restored over each other (`83722240 ⇄ 104366080`) — the
  literal #9153 cross-chain aliasing, live and deterministic. The shim's
  repair held every time; the runtime stayed fully functional.
- `[wx-timer] retry storm: 60 retries (~1s parked, depth=1)` + storm-end —
  the v0.1.19 C++ diagnostic channel validated end-to-end. (Prod's crash log
  had NO storm line ⇒ prod's fatal window is < ~1 s.)
- Shim-check calibration learned the hard way: `handleSleep` re-entry with
  `state=2` (Rewinding) + currData set is NORMAL resume mechanics (~100/s
  during the cycles) — the `concurrent-park`/`reentrant-state` checks were
  narrowed to `state===0` / `state===1` accordingly.

**Implication:** plain concurrent park + fiber swaps + live pointer aliasing
is INSUFFICIENT to trap on this build. Round 2 adds the next prod ingredient:
heap growth mid-park (`___libc_malloc(256MB)` through the window — the prod
trace grew +187 MB during the load), cycle 4 of the spec.

## Round 2 result (2026-07-31, refined shim + growth cycle)

**Still GREEN — four cycles, growth included.** With the calibrated checks the
picture is precise: 4× genuine `concurrent-park` (state 0 — the timer's
`_emscripten_sleep` starting while the yield park's currData was live, wasm
frames in the report stack), 8× `aliased-wake-live` (the two chains'
buffers cross-restored, both directions), 5× `overlapped-wake`, **0×
`reentrant-state`** (mid-unwind entry does not occur), 256 MB heap growth
mid-park absorbed cleanly.

So on Firefox/local, the full stack of suspected ingredients — fresh
double-park, fiber swaps through the window, live currData aliasing, heap
growth across parked buffers — is handled by the shim + runtime. The prod
trap requires something this harness still lacks. Ranked next:

1. **A second parking timer staggered into the FIRST one's wake tick** — the
   prod first-trap stack is 3-deep in the async_call rearm cascade; a park
   colliding with a *rewind in progress* (not a parked-idle chain) is the one
   interleaving the lever does not yet force.
2. GAL pre-first-paint state (prod trapped before first paint; this harness
   is long-painted by cycle time).
3. Prod-only environment: real lib realtime resolves + presence WSS fibers +
   the user's machine timing.

The lever + spec stay as the regression gate for the fix regardless: they
deterministically create and verify the concurrent-park window that all three
shipped fixes were blind to.

## Candidate real fix (only after a red)

Deliver timer notifies from the main-loop chain: the JS timer callback only
marks the timer due and wakes the yield; the loop dispatches due timers after
its rewind, when it is the sole live context. Structurally removes
fresh-entry parks from timers. Keep the 17 ms retry interlock for the
dispatch-chain case.
