# Asyncify `currData` contention in KiCad-WASM — research dossier

> **Status:** research / understanding only. No implementation has been chosen.
> Authored 2026-06. All line numbers are against the artifacts current at that time
> (`tests/apps/kicad/pcbnew.js`, `wxwidgets/src/wasm/*.cpp`,
> `kicad/thirdparty/libcontext/libcontext.cpp`, `wxwidgets/src/common/init.cpp`).

## Why this exists

While bringing up `tests/kicad/load-pcb.spec.ts` (load a real `.kicad_pcb` through
File→Open), three distinct errors surfaced. One is fixed; two remain and turned out to be
**the same underlying disease**: Emscripten Asyncify has a single global suspension register
(`Asyncify.currData` + `Asyncify.state`), but KiCad-WASM has **three independent subsystems**
that all drive it (tool coroutines, modal/clipboard sleeps, and the parked main loop). When any
two overlap, one reads a buffer that no longer belongs to it → **crash** (`index out of bounds`)
or **hang** (a swap unwinds but is never rewound).

## TL;DR

- **The single slot is not a WebAssembly/Binaryen law — it's a choice in Emscripten's JS
  runtime.** The Binaryen Asyncify pass is multi-buffer by design; `asyncify_start_unwind`/
  `asyncify_start_rewind` take the buffer pointer as an argument.
- **"Give each context its own buffer" is the standard, supported solution** — it's literally
  what Emscripten *fibers* are, and what QEMU/TinyGo/Pyodide do. We already do it for tool
  coroutines (each `wasm_fcontext` owns a buffer). The bug is that the **fiber path and the
  `handleSleep` path both blindly overwrite the one global `currData` register.**
- **We are not switching to JSPI.** The fix stays within Asyncify, in the wasm/shim layer.
- **The achievable universal fix** is a single cooperative scheduler that owns `currData` (and
  the fiber trampoline) and treats every suspendable thing — coroutines, modals, clipboard,
  fonts, and the main loop itself — as a registered context with its own buffer.

## Document index

| File | Contents |
|---|---|
| [`01-background-and-findings.md`](01-background-and-findings.md) | The originating session, the e2e test + logs, and the three concrete bugs (rtree=fixed; clipboard crash; tool-open hang). |
| [`02-asyncify-internals.md`](02-asyncify-internals.md) | The machine, in detail: what "sleeps", the single `currData`/`state`, the three producers, `handleSleep`/`fiber_swap`/trampoline, the #9153 shim, and full control-flow walkthroughs (startup→park, the hang, the crash, **de-parking** down to the JS line). |
| [`03-solutions-and-prior-art.md`](03-solutions-and-prior-art.md) | Is there a real solution? Per-context buffers, who has done it, why we're not switching to JSPI, and the unified-authority recipe with failure modes. Sources/URLs included. |
| [`04-decisions-tests-open-questions.md`](04-decisions-tests-open-questions.md) | How the fix options relate (what's subsumed vs. genuinely separate), the one diagnostic that decides scope, the combinatorial test matrix, and open questions. |
| [`05-design-a-js-asyncify-arbiter.md`](05-design-a-js-asyncify-arbiter.md) | Incremental design: keep current `EM_ASYNC_JS` sleeps and fibers, but put one JS arbiter in charge of `currData`, transition queueing, and the trampoline. Includes concept explanations. |
| [`06-design-b-fiber-first-runtime.md`](06-design-b-fiber-first-runtime.md) | Cleaner long-term design: make modals, clipboard, fonts, nested loops, and tools all scheduler-owned fiber-like contexts. Explains how this relates to de-parking and app lifetime. |
| [`07-decisions-and-outcome.md`](07-decisions-and-outcome.md) | **What was decided and shipped (2026-06-12):** root cause, red-green ledger, the arbiter NOT built and why, roads not taken with revisit triggers. |
| [`08-dom-port-regression.md`](08-dom-port-regression.md) | DOM-port regression investigation after rebasing onto the async hardening: traces, symbolized crash, ruled-out Asyncify/table/removelist hypotheses, and current stale-window diagnosis. |
| [`09-dom-window-lifetime-hypothesis.md`](09-dom-window-lifetime-hypothesis.md) | Concrete failure story and first fix experiment for the DOM-port stale `wxWindow` hypothesis: destructor ordering, DOM event reentry, and validation plan. |
| [`10-resolution-menubar-uaf.md`](10-resolution-menubar-uaf.md) | **RESOLVED:** the regression was a freed `wxMenuBar` left in a live frame's child list by `wxMenuBarBase::Detach()` (DOM-port only — the bar is a real child there). One-line fix in `wxMenuBar::Detach()`; full kicad suite green, zero corruption signatures. |
| [`11-asyncify-nesting-raytracer.md`](11-asyncify-nesting-raytracer.md) | **Finding + decision:** the WASM 3D raytracer is single-core because `emscripten_sleep` can't nest on an already-unwinding Asyncify context — yielding to join worker threads aborts with `invalid state: 1` since the viewer renders inside a suspended wx modal pump. Multi-core pool (~6–7×) built + parked; unpark needs a *nestable* yield (fiber/JSPI). |
| [`19-quasimodal-fiber-strand.md`](19-quasimodal-fiber-strand.md) | **DIAGNOSED 2026-08:** the Symbol Properties dialog hang — a tool fiber parks mid-body, the stale-fiber guard refuses (and drops) its resume, the dispatch interlock is never released, every click is deferred forever. Live-captured frozen state; ranked fixes; regression-vs-pre-existing still open. |
| [`20-design-b-core-plan.md`](20-design-b-core-plan.md) | **PLAN (2026-08):** the remaining Design B core — every parkable activity becomes a scheduler context that yields instead of parking in place, which deletes the guessing layer (quarantine/consume-once/interlock) rather than tuning it. Phases D0–D6, 6–10 wk, with the memory and partial-migration risks called out. |
| [`17-mailbox-scheduler-plan.md`](17-mailbox-scheduler-plan.md) | **PLAN (2026-08):** the mailbox/scheduler implementation plan — Design B's phasing revised with the July–August guard record (dispatch interlock, open-settle gate, v0.1.28 schedule-don't-dispatch). Test inventory with per-test fate (keep / rewrite / retire / new), 7 steps S0–S6 with gates and rollback, ≈5–7 wk. Supersedes 12/13's phasing; overturns 13 §6f's "no scheduler needed". |

## The single decisive next step

Before designing anything, **measure whether `Asyncify.currData` is clean (null) at the moment
`wxGUIEventLoop::DoRun()` throws `"unwind"`** (and at the first rAF tick, and at the first
post-startup `emscripten_fiber_swap`). That one fact determines whether the universal fix must
also reshape the main loop ("de-parking") or whether a per-context `currData` authority alone
suffices. Details in [`04-decisions-tests-open-questions.md`](04-decisions-tests-open-questions.md).

---

## RESOLUTION (2026-06-12) — see [`07-decisions-and-outcome.md`](07-decisions-and-outcome.md) and `docs/features/asyncify-arbiter/`

The decisive measurement was answered **by code trace and then pinned by a deterministic
test** (`tests/asyncify/asyncify-races.spec.ts` + `tests/apps/standalone/asyncify-races/`):

- At the park throw, Asyncify state IS clean (`currData==null`, `state==Normal`) — **but the
  JS stack is necessarily still inside `Fibers.trampoline()`'s `do/while`** (any OnInit-era
  fiber swap means main is trampoline-resumed from then on). The throw skips the
  `trampolineRunning = false` reset → the guard wedges → the first post-idle swap hangs.
  That IS the §5 hang; "orphaned currData" (mechanism #1) is structurally impossible.
  The self-heal (`inject-dyncall-shims.sh` §3c, commit `18a9de0`) is therefore the
  *structural cure*, not a band-aid — **no de-parking needed**.
- When main's last pre-park suspension is a *sleep*, the same throw instead escapes through
  the sleep's wakeUp promise reaction → the long-mystifying `uncaught exception: unwind`
  rejections. Fixed in `scripts/common/shims/handlesleep.js` (catches the sentinel like
  `callMain` does).
- The full Design-A arbiter was NOT needed: at production semantics (`-sASSERTIONS=0`),
  out-of-order and overlapping-sleep scenarios are already handled by the per-sleep buffer
  capture in `handlesleep.js`. The remaining bugs were wx-layer: single-slot
  `Module._endModal` broke 3-deep nested modals (now a LIFO resolver stack), and the
  modal/nested-loop pumps stalled silently on ProcessEvents rejection (now resolve-on-error).
  Clipboard `IsSupported` no longer runs the 2 s async probe.
- De-parking (02 §7) and Design B remain documented options, unneeded for correctness today.
- Upstream status (researched): the Fibers/Asyncify code is unchanged since 2020; the
  single-slot family is WONTFIX (#9153, #12270, #13302, #16291, #18412). The trampoline
  try/finally would be a good upstream PR.
