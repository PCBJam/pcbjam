# 19 — Symbol Properties dialog hangs: a stranded tool fiber (live investigation)

> **Status: DIAGNOSED + PINNED RED, NOT FIXED (2026-08-05).** Reproduced end-to-end in a
> real browser against the dev platform on the scheduler build, and since D0 also
> **deterministically in e2e**: `tests/kicad/quasimodal-strand.spec.ts` (6/6 identical —
> `closed=false dialogs=1 refused-resumes=1`). The fix lands at doc 20 **D3**, where that
> spec's `test.fail()` marker comes off. Regression-vs-pre-existing is **not yet
> determined** — see §5. Related: [`17`](17-mailbox-scheduler-plan.md) S4 (waits),
> [`16`](16-fiber-resume-guard.md) (the quarantine guard), the 8/4 three-UI-bugs triage
> (which blamed the interlock drain — that is the *symptom layer*, not the proximate cause).

## 1. Repro

**Automated (D0, ~30 s, deterministic):**
`npx playwright test --project=kicad-firefox kicad/quasimodal-strand.spec.ts`. The
"staging" test proves the window is real (dialog open + timer fired + concurrent-park
beacons); the "doc-19 red" test clicks OK and records the hang. The overlap is
structural, not a race: the parking timer (`wasm/bindings/timer_park.h`) is armed
*after* the dialog is confirmed open, so it necessarily parks on top of the opener's
open-ended fiber park. Note the strand reproduces on a **2-object fixture schematic** —
Leonardo's byte volume is not an ingredient, only concurrent parks are.

**Manual (100%, ~40 s):** dev platform (`npm run dev`), editor at `:3048`, Arduino
Leonardo schematic:

1. Open the project URL, wait for load (~30 s).
2. Double-click the USB receptacle (J1) → **Symbol Properties** opens.
3. Click OK / Cancel / any control → **nothing happens**. Only the titlebar × closes it.

## 2. Frozen state (captured live)

```
Fibers.__internallyParked      = [607191040]          // tool fiber, quarantined
Fibers.__parkSleepBuf          = {607191040 → 607977472}
Asyncify.__pendingSleepContexts= [{buf 607977472, rootOwned:false, cleaned:false},
                                  {buf 205586432, rootOwned:true,  cleaned:false}]
Asyncify.currData              = 205586432, state = 0
Fibers.__validSuspensions      ∌ 607191040           // no resumable suspension
scheduler: mailbox=3 enqueued=655 delivered=652      // FROZEN (0 progress in 4 s)
           waits=1 waitsBegun=1 waitsResolved=0      // the quasi-modal wait, unresolved
```

Console beacons, in order:

```
[wx-asyncify] overlapped-wake × 10            (benign: restore over null)
[wx-asyncify] aliased-wake-live: restoring currData=205586432 over 607977472
[wx-asyncify] fiber-resume-refused: fiber=607191040 is asyncify-parked mid-body (sleep in flight)
```

## 3. What is NOT the cause

- **Not clicks failing to reach wx.** The OK click produced exactly one
  `wx_dom_event(domId 81, kind 1)` ccall; the button is enabled and hit-testable.
  (Rules out the `WINDOW_DISABLER`/`IsEnabled()` hypothesis.)
- **Not slow I/O.** The last library network resource completed at t=5 s; the hang was
  inspected at t=277 s with nothing in flight. The fiber's park is waiting on a promise
  that will never settle — a **lost wake**, not pending work.
- **Not the mailbox/embind/wait bookkeeping.** `strayWrites=0`, `mutQ=0`, no deferred
  wakes, no stranded messages beyond the 3 blocked by the interlock.

## 4. Mechanism

The tool fiber running the dialog parks mid-body (the quasi-modal wait). The stale-fiber
guard correctly marks it `__internallyParked` — its slice ended with a sleep in flight.
Its resume then arrives and is **refused** (`fiber-resume-refused`), because a quarantined
fiber has no valid suspension; the guard's contract is "the parked body completes via its
own wake." Here that wake *is* the refused resume, so nothing ever completes:

- the fiber never resumes → the dispatch guard it holds is never released →
- `wxWasmDispatchParked()` stays true forever → `ProcessEvents` is Paint-only and
  `wxWasmMailboxDeliver` bails → **every** subsequent click is deferred and never drained,
  and timer delivery stops (the frozen 652).
- The × works because `wx_window_close` (`toplevel.cpp`) is ungated and synchronous.

The 8/4 triage saw the *outer* ring of this (deferred clicks + a drain gated on the same
predicate) and proposed flushing the queue at depth 0 — that cannot help: the depth never
returns to 0 because the holder is stranded.

## 5. Open: regression or pre-existing?

Undetermined. The quarantine guard and the aliasing repair are pre-existing (ported
verbatim into the scheduler at S2), but S4 changed *how* a quasi-modal parks
(`wxWasmRunNestedLoop` pump → `wxWasmBeginWait`/`wxWasmYieldUntil`). Both shapes park the
fiber mid-body, so the quarantine interaction plausibly predates S4 — but that must be
proven, not assumed. **A hand-edited legacy glue is not a valid comparison** (attempted
2026-08-05: stripping the scheduler and re-injecting `handlesleep.js` into a C-lane build
booted to a fatal `TypeError: … reading 'mode'`). The differential needs a real
`WX_SCHEDULER=0` docker build of `kicad_editor`, same flow.

## 6. Fix directions (ranked, none implemented)

1. **Don't drop a refused resume — defer it.** When `__refuseFiber` fires for a fiber in
   `__internallyParked`, record the pending resume and retry it when that fiber's park
   resolves (`__parkSleepBuf` already maps fiber → its sleep buffer, and the sleep's
   context leaving `__pendingSleepContexts` is the exact "now safe" signal). This is the
   same drop→deliver flip the whole mailbox migration is built on, applied one layer down.
   Caveat: doc 16 closed the *deferral family* for the root-hot case (a suspension broken
   at write time). This is a different case — a healthy fiber quarantined mid-body — so the
   closure does not automatically apply, but the round-6 evidence must be re-read first.
2. **Make a permanently-held interlock loud** (watchdog beacon after N seconds with a
   parked holder). Diagnostic only, but it turns this class from "UI mysteriously dead"
   into a one-line console verdict.
3. **Handler fibers** (the ledgered Design-B step): if parkable handlers own scheduler
   contexts, "a parked chain holds the global interlock" stops being representable. This is
   the structural cure and the S5 ledger's unlock for deleting the interlock entirely.
