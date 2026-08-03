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

**Layer 3, first attempt (wake-window deferral) — RETRACTED same day:**
deferring every root entry inside a sleep-wake window taxed EVERY parked
fiber completion with a macrotask hop; under CI load that stretched
three-client apply chains and flaked drift-trio S4 twice in a row (green
26/26 locally). It also modeled the wrong condition.

**Layer 3, final: consume-once root suspensions.** The actual fatal state is
a SECOND rewind of the same root suspension: root suspends once per
`fiber_swap` out of it, but two parked fibers completing against one root
suspension epoch (a tool fiber + a collab fiber both waking around
`open:settled`) each trigger `finishContextSwitch(root)` — the second rewinds
already-consumed data → "unreachable executed". The shim already records
every suspension (including root's); the fix is simply to stop exempting
root from the validity check: first consumption proceeds synchronously (zero
added latency anywhere), the second is refused
(`[wx-asyncify] fiber-resume-refused: root suspension already consumed`) —
the yielded fiber stays properly suspended and resumable, root continues via
its real pending resume, same contract as libcontext's ghost epochs enforced
one layer lower. Root stays exempt ONLY from the internally-parked
quarantine (its yield park is routine — the 19-red lesson).

## The white screen, round 3 (fixed at the DOM level)

v0.1.22's boundary was still not enough: a commit-phase throw in WasmTool's
OWN effects unmounts the root — no boundary below it can help.
`web/standalone/src/wasm/fatal-screen.ts` is the floor: a plain-DOM blue
screen with its own mirrored log ring (`recordFatalLog` from `append`),
installed at module import in main.tsx, cooperating with the React overlay
(stays hidden while `[data-testid="fatal-overlay"]` exists, takes over the
moment it disappears — 1 Hz ensure-loop). `fatal-overlay.spec.ts` now also
kills the React root after the fatal and asserts the DOM floor appears.

## Round 4 (2026-08-01 evening) — the recorder caught it: nested self-rewind of the root

v0.1.23 still trapped, but this time with the black box
(console-export-2026-8-1_19-16-8): dozens of benign fiber round-trips at
`w=0`, the yield cycling healthily — then `fcs old=root new=88145920 w=1` /
`fcs … ROOT w=1` and the trap, with the state dump frozen at
`state=2 currData=root+20`. The fatal condition, now OBSERVED rather than
inferred: a fiber round-trip executed inside the ROOT'S OWN sleep-wake
continuation re-suspends and re-rewinds the root nested inside its live wake
rewind — two rewind lifetimes on one context. Consume-once passed correctly
(the suspension was fresh); it guards a different corruption.

The retracted round-3 deferral was aimed right but unscoped: benign
parked-fiber completions run in FIBER-owned wake windows (or at w=0) and
must not pay the hop (that tax flaked S4). **Final form: ownership-scoped
deferral.** Every fresh sleep is tagged root- or fiber-owned (fiber ⇔
started inside a `finishContextSwitch` fiber slice or a fiber-owned wake);
`finishContextSwitch(root)` defers one macrotask ONLY while a ROOT-owned
wake is live (`Asyncify.__wakingRoot`), with the
`root-entry-deferred` beacon. Also fixed: the resume re-entry no longer
pushes sleep contexts (the v0.1.23 dump carried ~380 leaked zero-linked
entries).

## Round 5 (2026-08-02) — the scoped deferral hangs opens: RETIRED, road closed

v0.1.24 in prod: `open:settled result=failed` at the 60 s escape, heap never
past 256 MB, no traps, no beacons — the open crawled and (in a
timer-throttled background tab) effectively hung. Cause: the main loop's
every iteration runs INSIDE its yield-wake's synchronous extent (the v0.1.23
recording shows `sleep … w=1` on every tick), so "root re-entry during a
root-owned wake" matches every legitimate nested coroutine Call/return in a
board open — thousands per load, each paying a deferred macrotask.

**Verdict on the whole deferral family:** the fatal nested-rewind interleave
and the benign nested round-trips share the same observable signature at the
JS runtime layer. No discriminator exists here — this road is closed. What
remains shipped and sound: the consume-once validity + internally-parked
quarantine (never implicated in a regression), the flight recorder, the
beacons, and the WSOD floor. The rare nested-rewind crash is ACCEPTED, fully
observable, until the structural fix.

**The structural fix is design B** (06/12/13-design-b-*): one fiber-first
scheduler owning every suspension, so dual-protocol nesting cannot exist.
That is the next real investment; guard-layer iteration has hit its ceiling
— five variants, each defeated by a neighboring interleave or by taxing the
benign bulk.

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

## Round 6 (2026-08-03): local repro at last, and the microtask deferral

**The trigger was never a feature.** The prod differential ladder (V0–V4,
then V1a–V1d) exonerated every content theory one release at a time — 3D
models, sibling restage timing, collab/ydoc/presence (valid `?collab=0`
crashes), sibling lib-table/.kicad_pro surface (V1a: tables disabled, still
died), sibling KiCad-extension handling (V1c: extensions neutralized byte-
for-byte, still died), file count (V1b: +120 files, clean). What remained:
**staged byte volume × a warm load**, with dose-response — 140MB dies on
warm load 2, 123MB of *pure inert ballast* (V1d) dies on load 3–4, 14MB
never dies. Volume loads the dice; the defect was always the dual-protocol
race.

**Local repro (first after 5+ failed campaigns):** seed the V1d ballast tree
into the local stack (`seed-from-dir.ts`, 110MB), then
`REPRO_PROFILE=<dir> repro-board-load.ts` — run 1 cold is clean, warm runs
2/3/4 crash with the exact prod signature (`fcsTotal=68 rootHotTotal=1`,
`currData=root+20`, state stuck Rewinding). 100% warm reproduction.

**The frozen ring names the interleave.** On a crashed run the recorder
stops at the trap and retains the whole run. Healthy iterations: root parks
(`sleep s=0`), wakes ~8ms later, re-parks within ~3ms; ALL coroutine
round-trips run at `w=0` — fresh JS entries while root is parked. The kill:
one wake's forward slice runs 670ms (the volume-stretched settle work), and
*inside that live slice* a pending event dispatches a coroutine —
`fcs old=ROOT new=F w=1`, `fcs old=F new=ROOT w=1` — the only `w=1` pair in
the entire run. The return rewinds root+20 nested inside the wake's own
doRewind frame. rootHotTotal across many runs: 1 in crashed runs (the kill),
1–3 in green runs. **The "matches thousands per open" fear that retired the
deferral family was wrong on current code — the predicate is 1-per-crash
rare.**

**Fix (third deferral variant — microtask, entry-side primary):** both
retired variants failed for macrotask reasons, not deferral reasons.
`setTimeout(0)` retries are background-tab throttled (the v0.1.24 hung
opens), and the macrotask gap lets a fresh timer entry launder root's
suspension slot before the retry (the Nano crash 22ms after `deferrals=1`).
A microtask retry runs after the current stack unwinds — past the hazardous
live doRewind frame — but before ANY timer/event can enter wasm: no
throttling, no laundering window, thousands would cost nothing. Predicate is
root-owned-wake-scoped (`__wakingRoot > 0`) on both sides: entry-side
(`old == root, new != root`) stops the fatal round-trip before the fiber
ever runs nested; return-side (`new == root`, v0.1.24's predicate) remains
as backup for laundered attributions. Chain cap (1000 microtask hops →
setTimeout) converts any pathological livelock into a macrotask hop instead
of starving the event loop.

**Verification gate:** warm repro ×3 must survive with `deferrals≥1` and a
settled board; cold run clean; kicad e2e (collab + drift + park suites) and
web e2e green.

### Round 6 corrections (same day, local iteration loop)

**The microtask deferral trapped identically** — retried on a clean empty
stack at `w=0` and died in the same doRewind. The suspension is broken AT
WRITE TIME, not by nesting. Instrumentation (`rem=`/`rf=` on every fcs event)
then showed why: healthy fresh-entry root captures record their rewind entry
as the `dynCall_*` export they were taken under (~10KB of frames); the fatal
in-slice capture records **`rf=__main_argc_argv`** — `emscripten_fiber_swap`
stamps `Asyncify.exportCallStack[0]` (the re-invoked main export of the wake)
onto a 1.3KB capture of swap-site frames. Rewinding that pairing can never
work. Deferral family closed for good; prevention must run BEFORE
`_asyncify_start_unwind`.

**Guard v1 (refuse `old==main && hot` in jump_fcontext) was aimed wrong**: the
only refusal it ever fired was a jump INTO main (`ctx=1`) — a fiber yield-back
flavor — and stranding that mid-yield cascaded into a genuine top-window
close (app quit, page reload; the "crash" became
`~wxTopLevelWindowWasm → wxAppTopWindowClosed → quit hook → teardown trap`).
fcsTotal read 66 = baseline 68 minus the never-completed fatal pair, so the
refused jump was part of the fatal chain itself.

**Guard v2**: refuse only `old==main && new!=main && hot` (the doomed MAIN
suspension write); always allow jumps into main (they consume main's existing
suspension — fiber yield-backs, laundered-null attribution included); beacon
`jump-hot-into-main` observes the remaining hot flavors without refusing.

### Round 6 verdict: refusal retracted, mechanism nailed

Guard v2 (refuse `old==main && new!=main && hot`) fired exactly once per load,
on the right event, and the `unreachable executed` cascade vanished — the
doomed suspension was genuinely never written. The load still died: the
dropped dispatch strands the tool coroutine, the frame tears down,
`~wxTopLevelWindowWasm` fires the host quit notification (which the shell
reads as "user quit" and navigates away), and the teardown itself traps
`index out of bounds`. With the quit hook suppressed and navigation blocked,
the open reported `settled=true` but the page was the blue screen. Same dead
board, different obituary — so the refusal is retracted (kept as the
`hot-main-swap-out` beacon, which names the fatal interleave in any field log,
plus `jump-hot-into-main` for correlation).

**Where this leaves the fix.** Vetoing the swap after the fact cannot work:
by then the only choices are "write an unrewindable suspension" or "drop a
dispatch the tool framework needs". The cure must stop main from swapping out
inside its own wake continuation at all — either by delivering wx events from
a fresh JS entry rather than inline in that continuation (a targeted requeue
at the dispatch site, unexplored), or by removing the dual-protocol nesting
entirely (design B, the fiber-first runtime). Everything needed to evaluate
either is now in place: a 100%-reproducible local warm-load repro and beacons
that name the exact event.

## THE FIX (2026-08-03): deliver the tick's events from a fresh JS task

`wxGUIEventLoop::DoRun`'s top-level loop was

    while (!m_shouldExit) { ProcessEvents(); wxWasmYieldToBrowser(); }

and *everything after `wxWasmYieldToBrowser()` returns runs inside that park's
synchronous wake continuation*. So the loop's own `ProcessEvents()` — the one
call site that dispatches from main's C stack rather than from a fresh JS
entry — was the one that could resume a tool coroutine inside main's live
wake and trigger the unrewindable suspension write. Every OTHER dispatch in
the system (DOM handlers, timer callbacks, the modal pump's ccall) already
runs as a fresh entry while main is parked; the flight recorder shows all of
them at wake-depth 0, and none of them has ever produced the trap.

The loop now schedules instead of dispatching:

    while (!m_shouldExit) { wxWasmScheduleProcessEvents(); wxWasmYieldToBrowser(); }

where `wxWasmScheduleProcessEvents` is an `EM_JS` that does
`setTimeout(() => Module["_ProcessEvents"](), 0)` with the same
abandon-on-trap guard the DOM handlers use. The scheduled task runs while main
is parked in the rAF yield — wake-depth 0, a proper export as the rewind entry
— which is exactly the healthy pattern. `ProcessEvents` was already
re-entrancy-safe (it no-ops into a repaint whenever a chain is parked), so
overlapping schedules cost nothing.

**Result on the local warm repro** (the case that failed 100% of warm loads on
every previous build): 3/3 loads settle with a fully rendered board,
`rootHotTotal=0` (it was exactly 1 at every death), `fcsTotal=72` — the
healthy cold-load number — and zero wasm traps. The fatal interleave no longer
occurs, rather than being caught after the fact.

**Also fixed** (`toplevel.cpp`): `~wxTopLevelWindowWasm` notified the host of
an "app quit" whenever `wxTheApp->GetTopWindow() == this`, but wx re-points the
top window at whatever TLW remains — so a transient frame dying mid-session
ejected the user out of the editor. Now gated on `IsMainFrame()`
(`wxTopLevelWindows[0]`, the real application frame).
