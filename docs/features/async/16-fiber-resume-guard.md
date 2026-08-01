# 16 — Fiber resume guard (the production board-load trap, fixed)

Status: 2026-07-31 · red/green e2e `tests/kicad/fiber-resume-park.spec.ts` ·
lineage: 14 (open-settle gate), 15 (timer-park lever + the v0.1.20 decode),
drift-trio #10b (fiber buffers, ghost beacons).

## The bug

`RuntimeError: index out of bounds` / `unreachable executed` on prod board
loads (editor.pcbjam.com, v0.1.12 → v0.1.20), runtime permanently poisoned
afterwards. Survived three shipped fixes aimed at other reentrancy holes
(open-settle gate, dispatch interlock, busy-guard-holds-interlock).

**Root cause — two suspension protocols share one context.** KiCad coroutines
(TOOL_MANAGER tool loops, collab fiber bodies) run on emscripten fibers via
the libcontext wasm port. A coroutine suspended by a real yield
(`jump_fcontext` → `emscripten_fiber_swap`) has valid rewind state in its
fiber struct. A coroutine whose body is asyncify-parked inside `handleSleep`
(lib-bridge wait, `emscripten_sleep`, any EM_ASYNC_JS below a tool handler)
is suspended in a way the fiber machinery — and TOOL_MANAGER — cannot see:
its live state sits in the sleep's buffer, and the fiber struct still holds
the stale data of its LAST real yield. Natively this state cannot exist (a
coroutine cannot be suspended without yielding), so no upstream code guards
it.

When the next event arrives during such a park, TOOL_MANAGER `Resume()`s the
"waiting" tool → `finishContextSwitch` rewinds the STALE fiber suspension →
binaryen's rewind-path mismatch `unreachable`, or replayed frames clobber the
parked body's stack; the sleep's wake then rewinds into wreckage. Every later
Asyncify entry (the GAL refresh timer's `emscripten_async_call` cascade was
the usual first victim, which is why the symbolization kept pointing at
timers) reads poisoned state → `index out of bounds`.

Trigger window in prod: right after `open:settled`, presync/realtime lib
churn + first-paint activity dispatch events while tool bodies still park in
lib waits. Fast loads crash too — the window needs only one event during one
park.

## The evidence chain

1. v0.1.20 shipped rate-limited `[wx-asyncify]` reporting in the handlesleep
   shim + the `[wx-timer]`/`[wx-dispatch]` channels. The crashing prod log
   (console-export-2026-7-31_22-33-27.log) showed NO concurrent-park, NO
   retry storms, NO depth erasure — every competing hypothesis ruled out on a
   live crash — and one `overlapped-wake … over null` 2 ms after settle: a
   fiber fingerprint (`finishContextSwitch`/`fiber_swap` are the only
   mid-flight sources of a null `currData`).
2. The trap-2 stack decoded mechanically against the shipped runtime:
   `maybeStopUnwind → Fibers.trampoline → finishContextSwitch → doRewind →
   unreachable` — a fiber swap-in rewinding stale data at the tail of an
   unwind.
3. The lever (`wasm/bindings/fiber_park.h`, `kicadTestFiberPark*`) stages the
   state machine deterministically: Call + yield (valid suspension) →
   legitimate resume → body parks in `emscripten_sleep` → **Resume during the
   park**. RED on the unguarded runtime: fiber-buffer/sleep-buffer
   cross-restores (`aliased-wake-live` 103710720 ⇄ 406683648), a
   `jump-ghost` beacon, and the parked body zombified (its wake lost — in
   prod, the next timer/tool entry turns this into the loud trap).

## The fix

`kicad/thirdparty/libcontext/libcontext.cpp` (wasm port only):
`wasm_fcontext::swap_suspended` — true only between a real `fiber_swap`
suspension and the next swap-in (set at both swap sites; fresh contexts start
true, the entry-point path needs no rewind). `jump_fcontext` REFUSES a target
whose flag is false — returns 0, the null-`INVOCATION_ARGS` contract the
jump-ghost path already established, with a rate-limited
`[collab-fcontext] jump-refused` beacon. The refused dispatch is dropped; the
parked body completes via its own wake, suspends properly, and the next
dispatch lands normally.

Why refuse rather than wait: a waiting guard (park the resumer until the
target suspends) deadlocks against the yield-back path — the target's yield
needs to swap into the very context that is busy waiting.

## Round 2 (2026-08-01) — v0.1.21 still trapped: the guard was laundered

The prod crash reproduced on v0.1.21 with ZERO `jump-refused` beacons: the
fatal swap passed the `swap_suspended` check. Mechanism: when a fresh JS
entry executes while `g_current_context` still points at a parked fiber (the
port has no way to know a new JS turn began), `jump_fcontext` attributes the
jump's old side to that parked fiber — `fiber_swap` then writes a fresh
(foreign but valid-looking) suspension INTO the parked fiber's struct and
re-marks it `swap_suspended`. The flag lies; the later Resume passes the C++
guard and rewinds garbage.

**Layer 2 (attribution-proof, JS runtime):** `handlesleep.js` wraps
`Fibers.finishContextSwitch` and tracks truth at the emscripten-fiber layer:

- a fiber is *validly suspended* only when a real swap-out wrote its
  suspension (observable: `fiber_swap` leaves `currData = oldFiber+20` when
  the trampoline runs);
- a fiber whose entered slice ends in a `handleSleep` park (currData holds a
  sleep buffer, no `nextFiber`) is *internally parked* — quarantined until a
  GENUINE swap-out, where genuine means its pending sleep has resolved
  (checked against the shim's `__pendingSleepContexts`); a laundering write
  while the sleep is still pending does not lift the quarantine;
- entering a quarantined or suspension-less fiber is REFUSED
  (`[wx-asyncify] fiber-resume-refused` beacon, currData cleared, ghost
  contract as usual).

Lever for the laundered scenario: `kicadTestFiberParkStartSecond/PokeSecond`
(a second coroutine started while the first is parked = the misattributed
jump), spec scenario 2 asserts the refusal beacon fires AND everything
completes cleanly.

## The white screen itself (fixed this round)

The prod logs also revealed why every fatal-overlay attempt failed: the last
trap of each cascade lands inside a React EFFECT (an embind call via a
react-query subscription), React unmounts the entire root, and the overlay +
console die with the tree. Fix: `WasmErrorBoundary` inside `WasmTool` — all
crash-capable children live inside it; the fatal screen (now an actual blue
screen) and the console panel live OUTSIDE it and survive. All fatal
promotions auto-open the console. Pinned by `tests/web/fatal-overlay.spec.ts`.

## Round 3 (2026-08-01 afternoon) — v0.1.22 still trapped: the target is the ROOT

The v0.1.22 prod log (console-export-2026-8-1_13-39-41) showed both guards
silent — because the fatal rewind's target is the ROOT context, which layer 2
exempted outright. Reading all four identical prod stacks precisely:
`maybeStopUnwind → Fibers.trampoline → finishContextSwitch → doRewind(root) →
unreachable`, fired from INSIDE a sleep-wake's own rewind. A fiber completes
its yield-back to main while main's yield wake is mid-rewind: two different
"resume main" paths interleaved in one tick — the wake's `doRewind(Y)` and
the fiber's `finishContextSwitch` rewind of `main+20` — replaying frames
over live state. The 8 ms-earlier "index out of bounds" is the wake side of
the same collision.

Root entry is legal and constant in healthy flow; ONLY the wake-window
overlap is fatal. **Layer 3: serialize, don't refuse.** The shim marks the
synchronous wake window (`Asyncify.__inSleepWake` around `wakeUp()`);
`finishContextSwitch(root)` inside that window is DEFERRED one macrotask
(`[wx-asyncify] root-entry-deferred` beacon) and re-fired via the trampoline
once the wake has settled. Ordering change only — nothing is dropped.

## The white screen, round 3 (fixed at the DOM level)

v0.1.22's boundary was still not enough: a commit-phase throw in WasmTool's
OWN effects unmounts the root — no boundary below it can help.
`web/standalone/src/wasm/fatal-screen.ts` is the floor: a plain-DOM blue
screen with its own mirrored log ring (`recordFatalLog` from `append`),
installed at module import in main.tsx, cooperating with the React overlay
(stays hidden while `[data-testid="fatal-overlay"]` exists, takes over the
moment it disappears — 1 Hz ensure-loop). `fatal-overlay.spec.ts` now also
kills the React root after the fatal and asserts the DOM floor appears.

## Flight recorder (round 3, targeting instrument)

The shim keeps a 96-entry ring of asyncify/fiber events (sleep entries with
state/currData/wake-depth, wakes with buffer + clobber info, every
finishContextSwitch with old→new/ROOT/wake-depth, refusals, deferrals) —
never printed in normal operation. On the FIRST trap signature it dumps the
ring plus full machine state (`Asyncify.state/currData/__inSleepWake`,
pending sleep buffers, `Fibers.nextFiber/trampolineRunning/root/valid/
parked/deferrals`) to the console (`[wx-asyncify] STATE` + `RECORDER`), and
`window.__wxAsyncifyDump()` returns it on demand. The WasmTool fatal
promotion appends the same dump into the in-page log, so the blue screen —
React or DOM-floor — carries it. The next prod export reads like a black-box
recording instead of a stack-shape puzzle.

## Verification

- `fiber-resume-park.spec.ts` red on unguarded build (phase-3 poll dies),
  green with the guard: mid-park poke refused + logged, body completes its
  park, second yield reached, post-yield resume works, no trap signatures,
  model walk functional afterwards.
- `timer-park-repro.spec.ts`, `collab-load-fuzz.spec.ts`, `load-pcb.spec.ts`
  stay green (guard must not refuse valid suspensions).
- Prod validation: watch for `jump-refused` beacons in the next crash-free
  Leonardo load — each one is a would-have-been crash.
