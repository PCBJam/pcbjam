# 17 — Mailbox/scheduler implementation plan (Design B, post-August revision)

> **Status: PLAN (2026-08-05), not started.** Supersedes the *phasing* of
> [`12`](12-design-b-asyncify-implementation-plan.md)/[`13`](13-design-b-engineering-spec.md)
> with what we learned July–August; the architecture is unchanged from [`06`](06-design-b-fiber-first-runtime.md).
> The mailbox = doc 12's `readyQueue + drain()`. Companion visual: the "context switches &
> collisions" dossier artifact (fig 3 = target architecture).

## 1. Why reopen this — what changed since June

Doc 13 §6f closed the scheduler question: "no Phase-1 scheduler nor Phase-2 root fiber was
needed — the while-loop main loop + the pre-existing currData shim suffice." That verdict is
overturned by the July–August record. Since it was written we shipped, one collision at a time:

- the wx **dispatch interlock** (`wxWasmDispatchDepth` + save/zero/restore around every pump park),
- the timer **17 ms park-retry** + retry-storm telemetry,
- the **open-settle gate** (`BusyGuard`/`kicadOpenFileBusy`/`waitForOpenSettled` + `pcbjam_open::busy()` refusals),
- the **fiber-busy** (`kicadCollabFiberBusy`) and **enumerate** gates,
- three **libcontext refusal layers** (`jump-refused-parked`, consume-once, quarantine, ghost-epoch),
- the **512 KB** per-fiber buffer bump,
- and finally v0.1.28's **schedule-don't-dispatch** fix (`wxWasmScheduleProcessEvents` →
  `wxWasmTopLevelTick`) for the 68/1 board-load killer.

[`16`](16-fiber-resume-guard.md) calls guard-layer iteration "at its ceiling." Every one of
those guards is a hand-rolled, site-specific "defer this stimulus until safe" — a scattered
mailbox built one trap at a time. This plan builds the real one.

**Two constraints, both empirically proven in June (do not relitigate):**

1. **Queue transitions, not calls.** A FIFO of *calls* head-of-line blocks when a handler parks
   (open, ShowModal, clipboard all do); a *permanent* park deadlocks fiber swaps outright
   (13 §6b: "cannot stop an async operation in flight"). The queue admits many parked contexts
   and serializes only unwind/rewind transitions — which forces parkable handlers onto fibers.
2. **All writers or none, per subsystem.** A stray `currData` writer behind the scheduler
   corrupts silently (12 §risks). Migration is per-subsystem cutover with dev-build assertions
   on stray writes — never gradual softening of a guard while its collision partner still exists.

Also carried forward: **the root/scheduler context must never itself await JS** (13 §6b), and
**`ProcessEvents` must be driven wasm-side**, not via `await ccall(...,{async:true})`
(Emscripten #13302; 12 §prior-art). v0.1.28's fresh-task tick is the first brick of exactly that.

> **S1 lesson (2026-08-05, learned red-first):** the #13302 boundary constrains the MAILBOX
> too — delivering messages from inside pump-driven `ProcessEvents` puts a fiber-swapping
> handler inside the modal pump's awaited ccall and traps `unreachable`
> (`coroutine-nested` / `fiber_create_run_destroy_inside_modal`). Deliveries must enter via
> a dedicated plain export (`wxWasmMailboxTick`, self-armed from the shim, 17 ms retry while
> the interlock is held) — the mailbox changes *when* a message runs, never the kind of
> stack it runs on. This constraint binds every future lane (DOM input, embind) until S3
> removes the awaited-ccall pumps entirely.

## 2. Cutover mechanics

- **Build flag `WX_SCHEDULER=1`** producing parallel glue variants, same pattern as
  `races_test_noheal`/`races_test_nosleepfix`: during migration CI runs both runtimes; the
  legacy build stays the shippable fallback until step S5.
- **Guards become tripwires before they become dead code.** At each step, the superseded guard
  is *kept* but its firing beacon is asserted to be **zero** across the fuzz/e2e suite. A guard
  that still fires means the mailbox missed a path. Only a guard proven silent for a full step
  gets deleted (S5).
- **Observability stays on throughout:** `fcsTotal`/`rootHotTotal`, the flight recorder, and
  `window.__wxAsyncifyDump()` are migration instruments; `rootHotTotal == 0` is a standing
  assertion from S1 onward.
- Injection: lean **emscripten `--js-library`** for the scheduler (13 §7 open decision — resolve
  in S2; post-link injection stays the fallback since `inject-dyncall-shims.sh` already works).

## 3. Test inventory and fate

The dividing line: **outcome-level tests are the regression net and must stay green at every
step; mechanism-level tests are migration collateral** — each is retired or rewritten *at the
step that removes its mechanism*, never before.

### 3a. KEEP UNCHANGED (the net)

| Suite | Why it survives |
|---|---|
| Full `tests/kicad/` app e2e (~60 specs: `load-pcb`, `eeschema*`, `pcbnew*`, `*-collab`, `presence-*`, `drift-trio*`, `contextmenu-*`, `import-settings-modal-stack`, `3d-viewer*`, `gerbview*`, `roundtrip`, `save-hook`, perf + screenshot baselines) | Assert user-visible outcomes only. These are the gate for **every** step. |
| Standalone wx app battery (~70 apps under `tests/apps/standalone/`: `dialog`, `menu`, `popup`, `contextmenu`, `timer`, `clipboard`, `fontenum`, `filedialog`, `wizard`, `raytrace-modal`, `raytrace-threads`, `threadpool*`, …) | Outcome-level wx behavior; the June regressions (coroutines vs menus, 13 §6d) were caught here — keep all. |
| `coroutine` / `coroutine-nested` / `coroutine-pthread` | The historical red gate for exactly this work (12 §phase-0). |
| `asyncify-races` scenarios asserting **semantics**: `modal_in_modal_in_modal` (LIFO nesting is a semantic — it outlives the resolver-stack mechanism), `out_of_order_sleep_resolution`, `sleep_inside_fiber_inside_modal`, `post_park_fiber_swap`, `long_parked_sleep_clobbered_by_swap`, `wakeup_during_transition`, `unwind_through_promise` | Scenario *intent* is architecture-independent. Harness internals may need touch-ups per step, but the pass criteria stand. |
| `tests/web/fatal-overlay.spec.ts`, web suite, `open-flow` outcome cases (settle wait, dialog escape) | Containment and UX-level behavior are orthogonal to the runtime rewrite. |

### 3b. KEEP, BUT REWRITE THE ASSERTION TARGET (drop→deliver flips)

These currently assert that a guard **refused/dropped/no-op'd** something. Under the mailbox the
same stimulus is **deferred and delivered** — a strictly stronger guarantee, so the expected
outcome flips:

| Spec | Today asserts | Becomes |
|---|---|---|
| `kicad/fiber-resume-park.spec.ts` | mid-park `Resume()` is **refused** (`jump-refused-parked` beacon), parked body completes | the resume **message is queued** and the event is **delivered after** the park completes — nothing refused, nothing lost |
| `kicad/collab-load-fuzz.spec.ts` | open gate engages, collab entries **no-op**, gate releases | collab/presence messages **queue behind open** and apply afterwards without re-issuing (assert post-open presence bind succeeds) |
| `kicad/timer-park-repro.spec.ts` | runtime survives a parking timer; `[wx-timer]` retry beacons appear | runtime survives; timer notify is delivered exactly once, in order; **zero** retry beacons |
| `asyncify-races` `nested_quasi_modal_pump_error` | pump rejection doesn't leak the parked `DoRun` | (S4, when the pump dies) wait-resolution **error path cancels the modal and releases the context** — same invariant, no pump |

The drop→deliver flip is also a **product change** (events stop being silently swallowed during
loads) — note it in the release notes when S4 lands.

### 3c. CANNOT KEEP (assert deleted machinery — retire at the step shown)

| Test | Pins | Retires at |
|---|---|---|
| `races_test_noheal` / `races_test_nosleepfix` builds + their "shim-redundancy pins" specs | the legacy `handlesleep.js`/trampoline-heal shims | S2 — replaced by scheduler-ownership pins (same ablation idea, new subject) |
| `open-flow.test.ts` busy-**polling** unit cases (stuck-busy timeout, legacy title-heuristic fallback) | `kicadOpenFileBusy` polling as the settle protocol | S4 (open migration) — open becomes promise/message-based; keep the exported busy probe itself for old-wasm compat (see §6) |
| Assertions on interlock diagnostics (`[wx-dispatch] ERASED/NEGATIVE`, depth-restore sites) wherever specs grep for them | the dispatch interlock | S5 |
| v0.1.28 tick-error-path specifics (popping `_wxNestedLoopExit` in the `setTimeout` catch) | the pump-driven nested loop | S4 |

### 3d. NEW TESTS (written before the step they gate)

- **N1 · Single-writer tripwire** — dev-build assertion that any `currData` write outside a
  scheduler transition aborts loudly; plus a meta-spec that *introduces* a stray writer
  (ablation-style) and expects the abort. Gates S2.
- **N2 · Message ordering** — enqueue open, then collab/presence/drift messages; assert applied
  in order after open completes, none lost, none duplicated. Gates S1/S4.
- **N3 · No head-of-line blocking** — with an open/modal fiber parked, an input message is
  processed within a frame-budget bound (this is the regression test for constraint 1). Gates S4.
- **N4 · Wake-never-rewinds** — a promise resolving during a live transition only enqueues;
  generalization of `wakeup_during_transition` to fiber wakes. Gates S2.
- **N5 · FIFO fairness under flood** — old parked context is not starved by a stimulus storm
  (06 §starvation). Gates S2.
- **N6 · World-visibility reentrancy** — curated cases where C++ assumed "nothing changes while
  I block": model mutation landing while `ShowModal` is parked, sibling file restage during a
  parked open. Driven by the S1 embind audit (§6). Gates S4.
- **N7 · EH matrix** — the whole gate under `-fexceptions` **and** `-fwasm-exceptions`,
  including a modal opened from inside a `catch` (HoistCppCatches composition, 12 §risks).
  Gates every step.
- **N8 · Warm-load pressure** — the Leonardo recipe (REPRO_PROFILE + ≥120 MB ballast, 2–4 warm
  loads) as a CI-able job asserting `rootHotTotal == 0` and zero trap signatures. Standing from S1.
- **N9 · Pthread interplay** — `raytrace-modal` multi-core under the scheduler; unparking the
  doc-11 single-core limitation is a *stretch goal*, not a gate — but the suite must not regress.

## 4. Implementation steps

Each step: gate = full 3a net green (3 engines where applicable) + the step's own tests + N7/N8;
rollback = the `WX_SCHEDULER=0` build + a per-step tag.

- **S0 · Baseline + scaffolding (2–3 d).** Tag current mains. CI matrix runs both EH models.
  Add beacon-count extraction to the fuzz/e2e harness (guard-firing counters per run). Stand up
  the `WX_SCHEDULER` dual-glue build. Write N2 (red), N8.
  > **Work log 2026-08-05 — S0 mostly landed** on `feature/async-mailbox`:
  > local `mailbox-s0-baseline` tags in all 6 repos; `WX_SCHEDULER=1` injector path +
  > `scripts/common/shims/asyncify-scheduler.js` (observation-only skeleton, build marker
  > `[wx-scheduler] scaffolding installed`; legacy shim stays authoritative until S2;
  > remember the `.ci-cache-epoch` bump when shim behavior changes);
  > `tests/kicad/utils/guard-beacons.ts` (per-family counts, occurrence-recovery for
  > rate-limited beacons, `expectGuardsSilent`, `parseAsyncifyCounters`);
  > `REPRO_ASSERT=1` in `apps/tests/tools/repro-board-load.ts` (N8: fails on unsettled load,
  > missing recorder, `rootHotTotal>0`, trap signatures);
  > `tests/kicad/mailbox-ordering.spec.ts` (N2, `test.fixme` red — add-then-move ordering
  > probe; un-fixme at S1). **Still open in S0:** the CI workflow matrix for both EH models.
- **S1 · Mailbox front-end (≈1 wk).** One queue, drained by `wxWasmTopLevelTick`. Route into it:
  > **Work log 2026-08-05 — timers routed, dual battery green.** JS FIFO in the shim;
  > `wx/wasm/private/mailbox.h` + drain in `evtloop.cpp`; `timer.cpp` enqueues on scheduler
  > builds (runtime-gated on the shim marker; legacy path untouched; 17 ms retry kept as
  > tripwire). Delivery enters via the dedicated plain export `wxWasmMailboxTick` (see the
  > S1 lesson above — the first pump-embedded delivery design trapped in `coroutine-nested`
  > and was fixed red→green). Battery on BOTH variants: wx-chromium 28/28 (timer, dialog,
  > dialogs, contextmenu, popup) + coroutine-firefox 39/39 (incl. raytrace multicore) +
  > asyncify-firefox 7/7. App-side `WasmMailbox` wrapper (web/standalone/src/wasm/mailbox.ts,
  > 7 vitest green) keys on the proxy-safe `kicadOpenFileBusy` probe — PROXY_TO_PTHREAD makes
  > the window blind to the worker-side interlock; precision moves worker-side at S4.
  > **Still open in S1:** DOM-input lane, wiring the wrapper into the 14 production mutators
  > (needs the kicad wasm build + e2e), N2 un-fixme, beacon-silence assertions in fuzz runs.
  >
  > **Work log 2026-08-05 (later) — S1 COMPLETE except the CI matrix (deferred to the end
  > by request).** Wheel lane: parked wheel ticks enqueue a replay instead of dropping
  > (`app.cpp`; keys/mouse were already queue-shaped via `wxPostEvent`). Embind lane: the
  > shim wraps the doc-18 production mutators at the Module boundary — busy-window calls
  > queue and deliver post-settle via a time-boxed (8 ms/16 ms), unkillable pump; not-busy
  > calls stay byte-compatible sync. Fresh warm-cache docker `kicad_editor` build carries
  > the C lanes; staged into the harness. Verified: wx dual battery 30+39+7 on BOTH glue
  > variants; kicad trio dual-contract — legacy (drop semantics + expected retry storms) and
  > scheduler (N2 delivery/order green, fuzz deliver-flip green, `timerRetry` silence
  > tripwire ARMED and green = zero retry storms on the C-lane build). Fuzz's deterministic
  > gate caps queued hammer calls on the scheduler lane (6 iters) — the unbounded replay is
  > a debug-build assert-flood benchmark (`PCB_VIA::GetWidth` × 800 vias × 170k console
  > lines), not an ordering test; volume stays in the stress test. Two more recorded traps:
  > the injector idempotence marker collided with evtloop's EM_JS probe text (sentinel now
  > `__WX_SCHEDULER_SHIM_SOURCE__`), and a pump whose setTimeout chain can die wedges the
  > queue forever — the pump body is now exception-proof with a `[wx-scheduler]` beacon.
  timer `Notify` (replacing the direct callback body; the 17 ms retry stays as tripwire), DOM
  input (formalizing today's `wxPostEvent`/`CallAfter` deferrals), and a JS-side wrapper for
  **mutating** embind entries (enqueue + returned promise). Deliverable alongside: the **sync
  embind audit** (§6). Guards all stay. **Gate:** net green; timer-retry and open-gate/fiber-busy
  refusal beacons ≈ 0 across fuzz (they may still fire for pump-driven paths — record the
  residual and its source); N2 green for the wrapped entries.
- **S2 · Scheduler core (1–2 wk).** `handlesleep.js` → `asyncify-scheduler.js` (13 §1): context
  registry, deferred drain with explicit transition-completion signals (wrap
  `_asyncify_stop_rewind`/`maybeStopUnwind`, never JS `finally`), fiber tracking at
  `emscripten_fiber_swap` (`fiber+20` buffers), trampoline ownership. **Gate:** races battery
  green **with the legacy shim ablated**; N1/N4/N5 green; libcontext refusal beacons ≈ 0.
  > **Work log 2026-08-05 — S2 core LANDED and gated.** The scheduler shim now REPLACES
  > handlesleep.js on WX_SCHEDULER=1 builds (injector either-or; the S1 "append-after"
  > ordering is gone). Ported name-identical: capture/restore, wake-window flags
  > (`__wakingRoot` is read by libcontext EM_JS!), consume-once/quarantine fiber guard,
  > counters, flight recorder, trampoline heal (external catch-reset wrap). NEW:
  > **deferred wakes** — a sleep wake arriving mid-transition (state≠Normal or trampoline
  > live) queues and drains from a clean macrotask (the aliased-wake class is now
  > structural, not detective); **N1 accessor** — `Asyncify.currData` is a property with a
  > single-writer tripwire (pure-JS writes need scheduler authorization; wasm-frame writes
  > pass; strict mode throws), meta-tested by introducing a stray.
  > **Gates all green:** asyncify-firefox 9/9 (7 races + new N1 meta + N4 books — on glue
  > with NO legacy shim, so the redundancy pins are now subsumption pins), coroutine 39/39,
  > wx-chromium 30/30, kicad trio 3/3 on the C-lane build. Injector legacy path verified
  > unchanged. **Deliberately left for S3:** the formal ctx-Map registry + park/resume
  > methods (stubs that throw), wasm-side ProcessEvents; **open:** N5 flood spec, both-EH
  > matrix (CI, deferred). Build-system note: `build-wasm-test.sh` only re-injects freshly
  > relinked apps — a variant flip without C changes needs the strip+reinject converter
  > (one-shot python in the work log commit) or a clean build.
- **S3 · Root context + wasm-side ProcessEvents (≈1 wk).** The tick resumes the root context
  which calls `ProcessEvents` on the wasm side — the `await ccall(...,{async:true})` boundary
  (#13302) is removed. The root context never awaits JS (13 §6b). **Gate:** net green with
  emphasis on `contextmenu*`, `menu`, `popup`, coroutine apps (the June regression pair,
  13 §6d, must both stay green simultaneously).
  > **Work log 2026-08-05 — S3 LANDED and gated.** All three remaining `await ccall(
  > 'ProcessEvents',{async:true})` pumps — modal (`dialog.cpp` startModal), nested loop
  > (`evtloop.cpp` wxWasmRunNestedLoop), popup (`wx-dom.js`) — now drive ProcessEvents as a
  > PLAIN export call on scheduler builds (runtime-gated on the shim marker; legacy paths
  > byte-identical). With the v0.1.28 top-level tick, NO pump awaits a suspending export
  > anymore: the #13302 boundary is gone from the scheduler variant entirely. Overlapping
  > pump ticks are parked-safe by ProcessEvents' existing gate; a chain that dies mid-park
  > surfaces via the window error taps instead of the pump's await-catch (containment
  > unchanged: fatal-screen + `wx_dispatch_abandon`). **Gates:** asyncify 9/9, coroutine
  > 39/39 (the June pair green simultaneously), wx-chromium modal-heavy 45/45 (+menu,
  > wizard, filedialog), kicad 6/6 incl. import-settings-modal-stack + contextmenu-scrollbar
  > on a fresh warm-cache C-lane build. **N5 landed** alongside (scheduler-shim.test.ts:
  > 500-call flood strict-FIFO, time-box chunking proven, wake-drain FIFO — 3/3).
  > **Left open:** the doc-12 "root fiber" formalization (main loop as ctx object,
  > `set_main_loop`-style top-off-asyncify) — not needed for the #13302 goal; revisit at S4
  > if the waits migration wants real park/resume methods.
- **S4 · Waits migration, one wait at a time (1–2 wk).** Implement
  `wasm_begin_async_wait`/`wasm_yield_until`/`wasm_resolve_wait` (13 §2). Order, lowest-risk
  first, each sub-step flipping its own specs (§3b/3c) and deleting its own pump:
  1. nested/quasi-modal loop (`wxWasmRunNestedLoop` + `_wxNestedLoopExit` die),
  2. popup menu (`wxDomPopupMenuModal` + the wx-dom.js pump die),
  3. modal dialog (`startModal` + `_wxModalResolvers` die),
  4. clipboard + font enum,
  5. **open** last — the biggest semantic flip (gates → ordering; N2/N3/N6 are the gate).
  > **Work log 2026-08-05 — S4 LANDED and gated (waits 1–3; 4–5 resolved by scoping).**
  > The doc-13 §2 API exists as `wx/wasm/private/yieldwait.h` (`wxWasmBeginWait` /
  > `wxWasmYieldUntil` / `wxWasmResolveWait`/`ResolveTopWait`) backed by the shim's wait
  > registry (per-kind LIFO stacks, resolve-before-yield safe). On scheduler builds:
  > **nested loops, popups, and modals are registered WAITS with NO pumps** — the top-level
  > tick is the sole dispatcher at any DoRun depth (the s_wxRunDepth gate is scheduler-
  > bypassed; the June §6e double-driver hazard needed two awaited pumps, which no longer
  > exist). Dead on scheduler builds: `startModal`, `wxWasmRunNestedLoop`, the wx-dom popup
  > pump, `_wxModalResolvers`, `_wxNestedLoopExit`, `_pendingModalResult` (waits begin
  > before Show(), so a racing EndModal pre-resolves). Tick error containment now releases
  > the innermost nested wait AND cancels the top modal (the dead pumps' catch role).
  > Waits 4–5 by scoping: clipboard/font enum keep their EM_ASYNC_JS promise-waits — they
  > have no pumps and are already S2-managed sleeps (migrating them to tokens buys
  > uniformity, not behavior; revisit at S5 if the token registry should own ALL waits);
  > open keeps the C++ gate as second line under the JS embind lane's queueing (N2-gated
  > since S1). **Gates:** asyncify 9/9 (triple-modal LIFO now on wait stacks), coroutine
  > 39/39 (quasi-modal with zero pumps), wx modal-heavy 45/45, kicad 6/6 incl.
  > modal-stack + contextmenu-scrollbar on a fresh warm-cache build.
- **S5 · Guard demolition (few d).** Delete: dispatch interlock + save/zero/restore sites,
  timer retry, `ProcessEvents` Paint-only gate, `s_wxRunDepth` gate, open-settle/fiber-busy/
  enumerate gates. Downgrade libcontext refusals to dev-build assertions; keep counters-only
  beacons. Retire §3c leftovers. **Gate:** net green with `WX_SCHEDULER=1` as the only build;
  a full-suite run shows zero references to deleted diagnostics.
  > **Work log 2026-08-05 — S5 executed as DEFAULT-FLIP + LEDGER, with a correction.**
  > This step's original demolition list over-promised relative to what S1–S4 built: the
  > §3b fate table assumed handler-fibers ("serialization is the scheduler's job"), but
  > parks still suspend ordinary dispatch chains in place — so the **dispatch interlock,
  > the ProcessEvents parked gate, the zeroed-interlock windows around waits, and the C++
  > open/fiber-busy gates remain LOAD-BEARING second lines**, not dead weight. Deleting
  > them now would reopen the fp-selector trap class. What S5 delivered instead:
  > **WX_SCHEDULER=1 is the DEFAULT build** (injector flip; `WX_SCHEDULER=0` = explicit
  > legacy opt-out; `.ci-cache-epoch` 9→10), gated on the FULL kicad-firefox suite against
  > the scheduler build, not just the trio.
  > **Flip gate result:** full suite 136 passed on BOTH variants (an accidental legacy run
  > — `setup:kicad` re-syncs `output/` over staged glue, converter beware — gave the
  > fallback a free full net). Scheduler run: 30 skips (N2 runs there), 2 fails triaged:
  > `ngspice-probe` bg_run = rerun-passes flake; `occ-probe` glb = fails IDENTICALLY on
  > legacy → pre-existing local occ_service issue, tracked outside this plan.
  >
  > **Demolition ledger — each deletion with its unlock condition:**
  > 1. Legacy opt-out + `handlesleep.js` + C++ legacy paths (`startModal`,
  >    `wxWasmRunNestedLoop`, popup pump, `_wxModalResolvers`/`_wxNestedLoopExit`,
  >    `emscripten_async_call` timer entry, timer 17 ms retry branch, `s_wxRunDepth` tick
  >    gate): delete TOGETHER, after CI runs scheduler-only across the full matrix
  >    (3 engines × both EH). They're compiled once for both variants — no partial delete.
  > 2. Dispatch interlock + Paint-only gate + zero/restore windows: delete only when
  >    parkable handlers run on scheduler-owned fiber contexts (the remaining Design-B
  >    step this plan never scoped). Until then they are the mutual-exclusion story.
  > 3. C++ `pcbjam_open::busy()` / `kicadCollabFiberBusy` gates: keep as second line under
  >    the JS embind lane; revisit only with (2).
  > 4. libcontext refusals: KEEP ACTIVE (not downgraded) — `jump-refused-parked` fires
  >    BEFORE the doomed unwind write, the one place prevention works (doc 16); the JS
  >    consume-once layer is the backstop, not a replacement.
- **S6 · Lifetime (few d).** Cleanup ordering vs the scheduler; teardown deferred to
  unload/explicit exit; `ScheduleExit` → scheduler wake (12 §phase-4).
  > **Work log 2026-08-05 — S6 LANDED.** The scheduler latches DEAD when the main loop
  > exits (DoRun's top-level return → `shutdown("main loop exited")`): queued mutators
  > reject, queued messages/wakes drop, pumps stop — stranded work beacons
  > (`shutdown ... stranded:`) instead of surfacing as a post-teardown UAF.
  > `wxWasmMailboxDeliver` gained ProcessEvents' `!wxTheApp` teardown parity. Unit-gated
  > (scheduler-shim.test.ts 4/4 incl. shutdown; 11/11 with WasmMailbox) + full battery
  > (asyncify 9/9, coroutine 39/39, wx modal-heavy 45/45) + kicad 6/6 — all on
  > DEFAULT-injected glue: the docker postprocess → setup:kicad pipeline now produces
  > scheduler builds with no manual conversion. Deferred with the ledger: OnExit/
  > wxEntryCleanupReal-to-unload reshaping (12 §phase-4's fuller lifetime) — the current
  > quit flow (wxAppTopWindowClosed → loop exit → cleanup) plus the DEAD latch covers the
  > teardown-delivery hazard the step exists for.

**Effort: ≈ 5–7 weeks** (doc 12 said 4–6 for the runtime alone; the added week is §3's test
work, which is where the safety comes from). S1 and S2 each end in a shippable state; S4 is the
first step with user-visible semantic changes.

## 5. Risks (delta vs doc 12 — its register still applies)

- **The drop→deliver flip changes behavior**, not just internals: events that guards silently
  swallowed will now arrive late instead of never. N6 exists to find C++ code that can't cope.
- **Dual-build drift** — the `WX_SCHEDULER=0` fallback rots if not in CI; keep it in the matrix
  until S5, then delete it the same week (a permanently-maintained dual runtime is its own bug farm).
- **Process traps** (learned the hard way): `npm run test:kicad` is *not* the CI set — gate on
  the full CI project set; rebuild wx into the consuming apps after every wx change (host-wx
  staleness); `pnpm install` after pulls.

## 6. Open decisions (resolve at the step noted)

- **js-library vs post-link injection** for the scheduler (S2; lean js-library for durability).
- **No-scheduler fast path** for plain wx test apps with no fibers (S2; likely yes, gated on
  "any non-main context registered", 13 §7).
- **Sync embind policy** (S1 audit): pure reads that never dispatch/park stay synchronous;
  everything else becomes a promise-returning message. The audit's deliverable is the exact
  allowlist, checked by a lint or a dev-build assert.
  > **DONE 2026-08-05 → [`18-embind-audit.md`](18-embind-audit.md):** 79 exports — 47 mutators
  > (14 production + 3 saves to wrap; 33 test-only stay direct), 20 pure-reads (the allowlist,
  > with the model-walk caveat), 9 park-capable. Asymmetries to fix listed there (ungated
  > pure-reads, pl_editor bare-stack applies, ungated `kicadLibsReload`).
- **`kicadOpenFileBusy` compatibility**: `open-flow.ts` feature-detects it and legacy wasm
  builds rely on the fallback — keep the export, backed by scheduler state, until the web app
  drops support for pre-scheduler wasm.
- **Raytracer unpark** (doc 11): the scheduler makes a nestable yield possible — schedule as a
  follow-up feature, not part of this plan's gates.
