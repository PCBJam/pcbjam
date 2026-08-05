# 20 — Design B core: parkable activities as scheduler contexts

> **Status: PLAN (2026-08-05), not started.** The remaining core of Design B
> ([`06`](06-design-b-fiber-first-runtime.md) B1+B2), scoped against what S0–S6 actually
> built ([`17`](17-mailbox-scheduler-plan.md)) and motivated by the stranded-fiber hang
> ([`19`](19-quasimodal-fiber-strand.md)). Supersedes doc 12's phases 2–3 for this layer.

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
| Registry/`park`/`resume`/`drain` | **stubs that throw — this plan fills them** |
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
  libcontext refusals → dev asserts, dispatch interlock + zero/restore sites, timer retry,
  open/fiber-busy/enumerate gates, and the legacy `WX_SCHEDULER=0` path with its C++ twins.
  Gate: full net, scheduler-only, zero references to deleted diagnostics.

**Effort: 6–10 weeks.** Doc 12's 4–6 week estimate predates what S1–S6 taught us; D2 and
D4 are each larger than any single step of the mailbox migration.

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
- **Rewrite at D6**: anything asserting quarantine/refusal beacons
  (`fiber-resume-park.spec.ts` flips from "refused" to "resumed after its park resolves"),
  interlock diagnostics.
- **New**: doc-19 strand red spec (D0, green at D3); dispatch-context exclusion invariant
  (D2); context-count/memory ceiling (D1); "no handleSleep on a fiber stack" assertion
  test (D4).

## 9. Decision this plan does not make

Whether to keep the legacy runtime alive through D0–D5. Carrying it doubles the surface at
exactly the moment the core changes; dropping it early removes the fallback that made
S1–S6 safe. Recommendation: **keep it until D3's red goes green, then drop it in D4** —
that is the first point where the new core is proven on the failure that motivated it.
