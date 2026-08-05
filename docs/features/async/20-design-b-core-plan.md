# 20 — Design B core: parkable activities as scheduler contexts

> **Status: IN PROGRESS — D-1, D0, D1 DONE (2026-08-05, work log §10).** The remaining core of
> Design B ([`06`](06-design-b-fiber-first-runtime.md) B1+B2), scoped against what S0–S6
> actually built ([`17`](17-mailbox-scheduler-plan.md)) and motivated by the
> stranded-fiber hang ([`19`](19-quasimodal-fiber-strand.md)). Supersedes doc 12's
> phases 2–3 for this layer.

## 1. The one-sentence goal

**No activity may park "in place".** Every suspendable activity runs on a scheduler-owned
context (own stack + own asyncify buffer) and suspends by *yielding that context*, so a
context's state is always authoritative — never a fiber struct saying one thing while its
body sits in a `handleSleep` the fiber layer cannot see.

That hidden second suspension is the disease. Everything else in this plan follows from
curing it.

## 2. Why now — what the hang proved

Doc 19: a tool fiber's body parked inside a wait; the stale-fiber guard quarantined it
(correctly, given the ambiguity), then **refused its legitimate resume** and dropped it.
The fiber never released the dispatch guard, so the interlock froze the whole UI.

The guard is not the bug — the guard is the *cost* of the ambiguity. `__internallyParked`,
`__validSuspensions`, `__parkSleepBuf`, the libcontext `swap_suspended` refusals and the
ghost-resume epochs all exist to guess "is entering this fiber safe?". Under this plan the
question has a recorded answer, so the guessing layer is deleted rather than tuned.

## 3. What S0–S6 already gives us (do not rebuild)

| Asset | Status |
|---|---|
| Single writer of `currData`/`state` + N1 stray tripwire | done (S2) |
| Deferred wakes, drain from a clean macrotask | done (S2) |
| Wait registry: tokens, per-kind LIFO, resolve-before-yield safe | done (S4) — **API is right, implementation parks in place** |
| No awaited-ccall pumps anywhere (#13302 boundary gone) | done (S3) |
| Mailbox for browser stimuli (timers, wheel, mutating embind) | done (S1) |
| Teardown latch | done (S6) |
| Registry/`park`/`resume`/`drain` | **done (D1)** — `wasm/sched/context.{h,cpp}`, star topology, not wired to production |
| Per-fiber 512 KB buffers (tool coroutines already are contexts, storage-wise) | done (pre-existing) |

The edges are Design-B shaped; the core is not. `wxWasmYieldUntil` is still an
`EM_ASYNC_JS` park of whatever stack calls it — which is exactly how a tool fiber's body
ends up with an invisible suspension.

## 4. Park-site inventory (the migration surface)

**wx** (`src/wasm/`): `wxWasmYieldUntilJs` (the wait primitive — the one that matters),
`wxWasmYieldToBrowser` (main loop, per-frame, completes every frame), `wxWasmRunNestedLoop`
+ `startModal` + `wxDomPopupMenuModal` (legacy-only since S4), clipboard ×4
(`clipbrd.cpp`), font enum (`fontenum.cpp`).

**KiCad/bridges**: symbol lib (`sch_io_pcbjam_lib`), footprint lib (`pcb_io_pcbjam_fp`),
3D model fetch (`pcbjam_model_fetch`), STEP export / OCE / ngspice stubs
(`wasm/stubs/*`), `nanosleep` shim, and the embind park levers
(`open_gate` test park, `timer_park.h`, `fiber_park.h`).

**Classification each site needs** (D0's deliverable): does it park on a *tool fiber*, on
a *fresh entry stack* (timer/DOM/embind), or on the *main loop*? Only the first two are
hazardous; the main loop's per-frame yield is safe by construction (S3/doc 13 §6c).

## 5. Architecture

```
browser tick ─► scheduler.drain()
                  │  picks the next READY context; at most one transition in flight
                  ├─► dispatch context   (runs wx handlers; ONE runnable at a time)
                  ├─► tool contexts      (KiCad COROUTINEs — already fibers)
                  └─► wait/bridge contexts (a lib fetch owns the context it suspends)

any activity that must wait:
   token = beginWait(kind)      → registry records the reason
   yieldUntil(token)            → SWAP the whole context out to the scheduler
   (JS resolves) resolveWait()  → mark READY; drain() resumes it by swapping in
```

Two consequences worth stating plainly:

- **Mutual exclusion becomes a scheduler policy, not a global flag.** The dispatch
  interlock exists to stop two handler chains interleaving over one widget tree. That
  invariant survives — but expressed as "at most one *runnable* dispatch context; parked
  ones do not count", which is precisely what today's ad-hoc `depth = 0` zero/restore
  around modal parks emulates by hand. The scheduler knows *why* a context is parked, so a
  parked opener no longer freezes delivery of everything else (doc 19's failure).
- **A refused resume becomes impossible**, because resume is not a guess: the registry says
  the context is parked and holds its buffer.

## 6. Phases (each gated; rollback = the previous tag)

- **D-1 · Drop the legacy runtime FIRST (3–4 d).** Decided 2026-08-05: we are on
  `feature/async-mailbox` with a green net and per-step tags, so the fallback's only real
  job — being rollback-able — is already served by git. Carrying it through D0–D6 would
  make every later phase dual-path work (two code paths per park site, dual-glue builds,
  two batteries per gate) for a runtime we intend to delete anyway. Delete, in one step:
  - `WX_SCHEDULER=0` branch in `inject-dyncall-shims.sh` + `shims/handlesleep.js`;
  - the `wxWasmMailboxEnabled()` runtime gating (every lane becomes unconditional);
  - wx legacy twins: `startModal`, `wxWasmRunNestedLoop` + `wxWasmExitNestedLoop`'s stack
    branch, the wx-dom popup pump, `_wxModalResolvers`, `_wxNestedLoopExit`,
    `_pendingModalResult`, the `emscripten_async_call` timer entry + its 17 ms retry
    branch, the wheel-drop branch, the `s_wxRunDepth <= 1` tick gate;
  - the ablation builds that pin the legacy shim (`races_test_noheal`,
    `races_test_nosleepfix`) and their "shim-redundancy pins" — doc 17 §3c always had
    these retiring with the shim; this is where it happens.

  This executes item 1 of doc 17's S5 demolition ledger early. It does **not** touch the
  interlock or the busy gates (ledger items 2–3) — those stay until D2/D6 as planned.
  **Gate:** full kicad suite + wx battery + coroutine + races (minus the retired ablation
  pins) green, scheduler-only, plus a tag before the deletion commit.
  **Cost accepted:** we lose the legacy comparison oracle for doc 19 — already a declined
  option (the legacy differential was explicitly dropped), so nothing is actually forgone.
- **D0 · Park-site audit + red spec (3–4 d).** Classify every site from §4 into
  on-fiber / on-entry-stack / main-loop, with the routing decision per site (doc 18's
  method). Land the doc-19 hang as a deterministic **red** e2e spec (Symbol Properties →
  click OK → dialog closes). Nothing else may proceed without that red.
- **D1 · Context primitives (1–2 wk).** Implement `park`/`resume`/`drain` for real on
  libcontext: create context, swap-out to the scheduler, resume by swap-in, registry as
  truth, one transition in flight. Exercised only by a dedicated test app — **no
  production path switched yet**. Gate: new unit/app tests + full battery unchanged.
- **D2 · Dispatch contexts (1–2 wk).** The tick resumes a dispatch context instead of
  running handlers on the entry stack; scheduler policy enforces one runnable dispatch
  context. The interlock stays, demoted to a **tripwire** asserting it never disagrees with
  the scheduler. Gate: full net + zero tripwire divergence across the fuzz suites.
- **D3 · Waits on contexts (1 wk).** `wxWasmYieldUntil` becomes a context yield. **The
  doc-19 red spec goes green here** — modal/nested/popup no longer park a tool fiber's body.
  Gate: red→green + battery + kicad suite.
- **D4 · Bridges on contexts (1–2 wk).** One helper (`wasm_await_promise`-style) routes
  lib/3D/clipboard/font/nanosleep/stub parks through the same yield. After this **no
  `handleSleep` park happens inside a fiber at all** — the quarantine guard is demoted to a
  dev-build assertion. Gate: battery + kicad + warm-load N8.
- **D5 · Main loop as a context (≈1 wk, B2).** Main becomes a scheduler context; the
  browser tick resumes the scheduler. Closes the 68/1 "swap inside main's own wake" class
  *by construction* rather than by the v0.1.28 scheduling trick. Gate: N8 warm-load
  pressure + `rootHotTotal == 0`.
- **D6 · Deletions (few d).** Per the S5 ledger, now unlocked: quarantine/consume-once,
  libcontext refusals → dev asserts, dispatch interlock + zero/restore sites,
  open/fiber-busy/enumerate gates. (The legacy runtime is already gone — D-1.)
  Gate: full net, scheduler-only, zero references to deleted diagnostics.

**Effort: 6–10 weeks**, and D-1's 3–4 days pay for themselves: every phase after it is
single-path work with one battery per gate instead of two. Doc 12's 4–6 week estimate
predates what S1–S6 taught us; D2 and D4 are each larger than any single step of the
mailbox migration.

## 7. Risks specific to this layer

1. **Memory.** Every context costs a stack + a 512 KB asyncify buffer. The Leonardo load
   already peaks ~633 MB. A dispatch-context pool plus tool contexts plus in-flight bridge
   contexts must be *bounded and measured* — D1 must ship a context-count/peak-RSS gate,
   and buffer sizes must be re-derived from `rem=` telemetry rather than inherited.
2. **Partial migration is worse than none** (doc 12). One park site left parking in place
   inside a fiber keeps the ambiguity alive while the guards that covered it are being
   removed. D0's audit is the contract; D4 must assert "no handleSleep on a fiber stack".
3. **Reentrancy becomes visible** (doc 06). Parked contexts observably share the world;
   C++ that assumed "nothing changes while I block" gets exposed. Needs the N6-style
   curated cases from doc 17 §3d extended to modal-open-while-mutating.
4. **pthreads.** Each thread has its own Asyncify state; the scheduler owns the main
   thread's contexts only. The raytracer/PROXY_TO_PTHREAD interplay must be scoped
   explicitly in D1, not discovered in D5.
5. **The #13302 boundary still binds.** Yields must never be driven from inside an awaited
   export; S3's plain-call discipline carries forward unchanged.
6. **Doc 16's write-time closure.** Round 6 closed *deferral* for the root-hot case because
   the suspension was broken when written. D5 must not re-introduce that shape: main's
   context must never be swapped out inside its own wake continuation.

## 8. Test fates (delta on doc 17 §3)

- **Keep**: the whole outcome net (kicad ~60 specs, wx app battery, coroutine trio, races
  semantics, N2/N5/N8).
- **Retire at D-1**: the legacy-shim ablation builds and their redundancy pins
  (`races_test_noheal`, `races_test_nosleepfix`) — they pin a runtime that no longer exists.
  Also ends the dual-variant battery discipline: one run per gate from here on.
- **Rewrite at D6**: anything asserting quarantine/refusal beacons
  (`fiber-resume-park.spec.ts` flips from "refused" to "resumed after its park resolves"),
  interlock diagnostics.
- **New**: doc-19 strand red spec (D0, green at D3); dispatch-context exclusion invariant
  (D2); context-count/memory ceiling (D1); "no handleSleep on a fiber stack" assertion
  test (D4).

## 9. Decisions taken

- **Legacy runtime: deleted first (D-1), not carried.** Git on a feature branch already
  provides rollback; carrying a second runtime through the core rewrite buys nothing and
  doubles every phase. Superseded the earlier "keep until D3" recommendation.
- **Still open:** whether D5 (main as a context) is worth its risk once D3+D4 have removed
  the ambiguity — the 68/1 class is currently held closed by v0.1.28's scheduling trick,
  and D5 replaces a working mitigation with a structural one. Re-evaluate with D4's
  telemetry in hand rather than committing now.

## 10. Work log

### D-1 — legacy runtime deleted (2026-08-05) ✅

Baseline tag `d-1-pre-delete` on root/pcbjam/kicad/wxwidgets/binaryen before the first
deletion. Four commits, one per deletion group:

- **D-1a** (pcbjam `e87d7f7`): `races_test_noheal`/`races_test_nosleepfix` link+inject
  variants out of `tests/apps/Makefile.wasm`; the shim-redundancy pin specs out of
  `asyncify-races.spec.ts`; `tests/README.md` open task resolved.
- **D-1b** (pcbjam `0a143ab`): injector injects asyncify-scheduler.js unconditionally —
  `WX_SCHEDULER=0`, `SHIM_DISABLE_HANDLESLEEP`, `SHIM_DISABLE_TRAMPOLINE_HEAL` deleted;
  `shims/handlesleep.js` deleted (423 lines); `.ci-cache-epoch` → 11.
- **D-1c** (wx `c44c684f7d`): every `wxWasmMailboxEnabled()` branch collapsed to the
  scheduler lane (timer enqueue, wheel replay, modal wait, nested wait, unconditional
  top-level tick, ungated deliver); probe deleted from mailbox.h; replaced by a
  fail-fast `wxWasmSchedulerAssertInstalled()` abort at DoRun entry.
- **D-1d** (wx `24843897e8` + pcbjam `1831668`): `startModal`, `wxWasmRunNestedLoop`,
  the wx-dom popup pump, `_wxModalResolvers`/`_endModal`/`_pendingModalResult`/
  `_wxNestedLoopExit`, and the bare `emscripten_async_call` timer entries deleted
  (timer parked-retry re-arms via the mailbox, kept as a tripwire); the scheduler
  shim's delivery-tick error path and diagnostics.js moved to wait-registry
  containment/observation.

**Gate (all scheduler-only, single battery):** wx app battery + asyncify (races +
scheduler core) + coroutine trio = 363 passed / 3 skipped / 0 failed; full kicad suite
= 138 passed / 30 skipped / 1 failed — the failure is the pre-existing local
occ-probe `glb` case (known-unrelated, predates D-1). Vestigial `startModal` scrubbed
from `ASYNCIFY_IMPORTS` (Makefile.wasm) and `asyncify-imports.txt` post-gate.

Consequence: every later phase is single-path — one code path per park site, one glue
per build, one battery per gate.

### D0 — park-site audit + red spec (2026-08-05) ✅

- **Audit** → [`21`](21-park-site-audit.md) (pcbjam `d4b25a0`): 14 production park sites
  (8 wx, 9 KiCad/bridge) + 3 deliberate test levers, each classified fiber /
  entry-stack / main-loop with its routing phase. W1 `wxWasmYieldUntilJs` and W3 popup →
  D3; the clipboard/font/lib/3D/occ/ngspice/nanosleep bridges → D4; W2's per-frame yield
  stays safe-by-construction unless D5 is taken. Doc 20 risk 4 (pthreads) settled: all
  Asyncify parks are main-thread-only; the lib bridge's worker path is a blocking
  proxy, not a park, so contexts stay a main-thread concept.
- **Red spec** → `tests/kicad/quasimodal-strand.spec.ts` (pcbjam `6ab0843`): a GREEN
  "staging" test (the window is real) plus the `test.fail()` doc-19 pin (OK must close
  the dialog). 6/6 identical: `closed=false dialogs=1 refused-resumes=1`. The overlap is
  structural — the parking timer is armed *after* the dialog opens, on top of the
  opener's open-ended fiber park.
- **Finding worth carrying into D1:** the strand reproduces on a **2-object fixture
  schematic**. Byte volume (the doc-17/gal-refresh dice-loader) is NOT an ingredient
  here; two concurrent parks suffice. That makes the doc-19 class strictly easier to
  hit than the 68/1 warm-load family, and it is why D3 — not D5 — is the phase that
  closes it.
- Retired `tests/kicad/dialog-deadlock-probe.spec.ts` (the 8/4 throwaway probe, and the
  tree's only determinism-lint violations).

### D1 — context primitives (2026-08-05) ✅

`wasm/sched/context.{h,cpp}` (pcbjam `01a6840`) + harness/gate (`4338bef`).

**The design decision that carries the phase:** contexts are a **star**, not libcontext's
symmetric swap. Contexts only ever swap OUT to the scheduler; only the scheduler swaps IN.
libcontext lets any stack jump to any other, which is *why* "is this target safe to enter?"
has no recorded answer there and must be guessed (`swap_suspended`, the parked/hot-main
refusals). Under the star, resume is a lookup — the registry says Parked/Ready and holds
the buffer — so doc 19's refused resume is not a thing that can happen, rather than a thing
guarded against. Enforced mechanically: one transition in flight (drain refuses re-entry,
so a context calling drain can't turn the star into a cycle), `mark_ready` never resumes
inline, `yield_park` off a context is refused ("nothing parks in place", made mechanical),
`destroy` on a non-Finished context is refused, FIFO ready queue, main-thread only.

**Gate (9 scenarios, no wx linked, assertions ON):** the load-bearing one is
`parked_does_not_block` — three workers run to completion while a context sits parked,
which is doc 19's freeze made unrepresentable: "parked" now means "not runnable", not
"holding a global interlock". Also `one_transition_in_flight` (with a second ready context
queued, so a buggy nested drain would actually run something and be caught), `async_wake`
(a real macrotask hop — every production bridge's shape), and `deep_park_sizing`.

**Memory (risk 1), measured not assumed:** ~34 B/frame, 2200 B for a 64-frame park, 1 MB
peak for 4 concurrent contexts, 0.1–1.7% of a 128 KB buffer. Sizes deliberately start at
128 KB C stack + 128 KB asyncify buffer instead of inheriting libcontext's 512 K.
**Caveat, load-bearing:** the harness's frames carry three locals each, so 34 B/frame is a
FLOOR, not a production estimate — real bridges save far more per frame, which is why
libcontext runs 512 K after a 64 K buffer silently overflowed. What D1 establishes is that
the apparatus works and what its units are; the sizing DECISION needs deep-park numbers
from real bridges, so it belongs to D3/D4, not here. A >75% buffer use beacons
`BUFFER-PRESSURE`, because that overflow corrupts silently rather than crashing.

Next: **D2** — the tick resumes a dispatch context instead of running handlers on the entry
stack; scheduler policy enforces one runnable dispatch context; the interlock stays but is
demoted to a tripwire asserting it never disagrees with the scheduler.
