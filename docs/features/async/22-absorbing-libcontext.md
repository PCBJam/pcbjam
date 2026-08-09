# 22 — Absorbing libcontext: one scheduler for JS ↔ Asyncify ↔ fibers

> **Status: PLAN (2026-08-06), not started.** Continues [`20`](20-design-b-core-plan.md)
> after its D-1/D0/D1 landed, its D2 was reverted, and its D3 met its goal by other means.
> Read [`20`](20-design-b-core-plan.md) §10 (work log) and [`21`](21-park-site-audit.md)
> (park-site table) first; this doc assumes both.
>
> **Decisions already taken by the user:** *absorb* (the scheduler takes over libcontext's
> wasm backend — one fiber system, not two cooperating ones), and the work continues on
> `feature/async-mailbox`.

## 1. The bug this exists to kill

The **blue screen**: `RuntimeError: index out of bounds` (and its siblings `unreachable
executed`, `indirect call to null`) raised from `Asyncify.doRewind`, killing the tab during
board loads. Its shape, in the field logs' own words: a context gets **recovered twice**, or
**recovered by a different fiber than the one that parked it**, or recovered from a buffer
another party has since overwritten (`aliased-wake-live: restoring currData=X over Y`).

This is *not* doc 19's hang. Doc 19 is fixed (a quasi-modal's nested loop no longer parks on
a coroutine stack), and that fix removed one *ingredient* — concurrent parks on fiber
stacks — without touching the cause. Anyone reading doc 20 alone may conclude the migration
is optional; measured against the blue screen it is not.

## 2. Why the guards cannot fix it (the real diagnosis)

`Asyncify.currData` is a single global slot naming "the context currently unwinding or
rewinding". Today **three layers each decide swaps and resumes with partial information**:

| layer | decides | guards it invented |
|---|---|---|
| libcontext (`kicad/thirdparty/libcontext/libcontext.cpp`) | every fiber↔fiber swap | `swap_suspended`, `jump-refused-parked`, `jump-refused-hot-main`, ghost-resume epochs |
| the JS shim (`scripts/common/shims/asyncify-scheduler.js`) | wake delivery, resume admission | `__internallyParked`, `__parkSleepBuf`, `__validSuspensions`, `fiber-resume-refused`, `aliased-wake-live` |
| wx (`wxwidgets/src/wasm/evtloop.cpp`) | whether dispatch may run | `wxWasmDispatchDepth` interlock, zero/restore around parks |

**The bookkeeping is already centralised — the decision is not.** S2 made `currData` a
single-writer accessor with a stray tripwire, and the shim already wraps
`Fibers.finishContextSwitch` and authorises the write. So the shim *sees* every swap; what
it cannot do is *prevent* one, because the decision to swap was made in libcontext, which
never told it. Each layer is therefore reduced to answering "is entering this fiber safe?"
by inference, and each invented its own heuristic. That thicket is the patchwork.

Centralising means moving **the decision**, not adding more observation.

## 3. Why the phases knotted (do not repeat this)

Doc 20 sequenced D2 (dispatch on a context) → D3 (waits yield contexts). Both orders fail:

- **D2 alone** (measured, reverted): a quasi-modal opened from a tick handler suspends the
  dispatch context *inside* a still-in-place wait, adding an Asyncify layer beneath every
  libcontext fiber. The coroutine-nested battery died at
  `fiber_create_run_destroy_inside_modal` (`aliased-wake-live` → `fiber-resume-refused`).
  Growing a context pool made it worse (8 contexts burned in 30 ms — a context suspended in
  a modal is consumed for that modal's lifetime); falling back to entry-stack dispatch did
  not help either, because the extra layer exists the moment the context is suspended.
- **D3 alone** (measured, guarded): a wait must yield the context that **owns its stack**,
  and the doc-19 path's owner is a *tool coroutine*, not a scheduler context. `yield_park`
  now refuses that case (`foreignStackRefusals`) rather than saving the tool fiber's stack
  into the host context's fiber struct.

So the dependency is a knot: dispatch needs waits migrated, waits need tool coroutines to be
contexts, tool coroutines are libcontext's. **Absorbing libcontext is what unties it**, which
is why it comes first here rather than last.

## 4. Target architecture

```
browser tick ─► scheduler.drain()          ONE decision point
                  │  registry = truth; at most one transition in flight
                  ├─► dispatch context     (wx handlers)
                  ├─► tool contexts        (KiCad COROUTINEs — libcontext's clients)
                  ├─► wait contexts        (modal / nested / popup)
                  └─► bridge contexts      (lib, 3D, occ, ngspice, clipboard, font)
```

Invariants, all already implemented and tested in `wx/wasm/private/sched_context.h`:

1. **Star, not mesh** — contexts yield only to the scheduler; only the scheduler resumes.
   A resume is a registry lookup, never an inference.
2. **One transition in flight**; `drain()` is not re-entrant.
3. **Wakes never resume inline** — `mark_ready` queues, `drain` resumes from a clean stack.
4. **A context yields only its own stack** — enforced by stack-range ownership check.
5. **Buffers are owned**: one context, one stack, one asyncify buffer, never shared.

## 5. Phases

Estimates assume one engineer familiar with this stack, and are grounded in this run's
measured cycle costs (§8). The **A / BCD / E / F** split matters: A is landable alone
because it is behaviour-preserving; B+C+D **must land together** (§3).

### Phase A — absorb libcontext's wasm backend (3–5 d) · landable alone

Replace the body of libcontext's wasm implementation so `make_fcontext` / `jump_fcontext` /
`release_fcontext` become thin adapters over `pcbjam_sched`, keeping the exact same
observable semantics (symmetric swap, same return values, same `INVOCATION_ARGS` contract).
The registry now knows every tool fiber: its stack range, its buffer, its status.

- Keep libcontext's existing guards **as tripwires** that must never fire; do not delete.
- No caller changes. KiCad still calls `jump_fcontext`; TOOL_MANAGER is untouched.
- **Gate:** coroutine trio + coroutine-nested + races + full kicad suite unchanged, and
  zero tripwire firings across the fuzz suites.
- **Why it is safe alone:** semantics are identical; only the party doing the bookkeeping
  changes. This is the de-risking step D2 never had.

### Phase B — tool coroutines become scheduler contexts (1–2 wk) · the bulk

Flip the topology from symmetric to star: `COROUTINE::Resume`/`Call` become
mark-ready-and-drain; a coroutine yields to the scheduler rather than to its resumer.

- The seam is `CALL_CONTEXT`/`doCall`/`doResume` in `kicad/include/tool/coroutine.h` plus
  `TOOL_MANAGER`'s `m_activeState` handling.
- `RunMainStack` must keep working — it is now "run on the scheduler's caller context".
- Expect this to be most of the risk and most of the calendar time.

**Seam read in full after Phase A landed (2026-08-06) — the crux, stated precisely.**
`TOOL_MANAGER`'s contract is SYNCHRONOUS and the star's is not, and that single
mismatch is the phase:

- `dispatchInternal` does `st->cofunc->Call( st->initialEvent )` and then, on the very
  next line, `if( !st->cofunc->Running() ) finishTool( st )`
  (`common/tool/tool_manager.cpp:870-874`). So `Call` must run the coroutine to its
  first yield *before returning*. Same shape at `ShutdownTool` (`:592`) and the
  pending-wait resume (`:808`).
- The star says a resume happens from a clean stack via `drain()`, and `drain()`
  deliberately refuses re-entry — a context calling it would turn the star into a
  cycle. But dispatch RUNS on a stack the scheduler may own (that is Phase D), so
  "Call → drain" is re-entrant by construction unless dispatch is already a context.
  This is the same knot doc 20 §3 measured from the other side, and it is why B, C
  and D cannot be separated.
- `CALL_CONTEXT::Continue`'s `CONTINUE_AFTER_ROOT` loop
  (`coroutine.h:175-183`) is a second, hand-rolled scheduler: the coroutine jumps to
  the ROOT stack, the root runs `m_mainStackFunction`, then resumes the coroutine.
  Under the star this is just "park with a reason, let the scheduler run the functor,
  mark ready" — the loop should disappear rather than be ported.

**A Phase A measurement that changes B's shape:** `grace-ring-over-capacity: 33` —
KiCad holds 30+ coroutines that never finished and whose owners are gone, and still
jumps into them. Under the star every one needs a live context (128 KB + buffer each,
vs libcontext's 512 K), so **B must fix the lifetime, not just the topology**: give
`COROUTINE` an owning handle and destroy the context when the tool state is popped.
The grace ring is the measurement of exactly how much that is worth, and it should
fall out of the tree at the end of B, not survive into C.

**Divergence policy (§10 q4), now answerable:** Phase A touched KiCad only inside
`thirdparty/libcontext` — vendored code, no upstream conflict. B is the first phase to
restructure `coroutine.h` + `tool_manager.cpp`, which CLAUDE.md's "keep the fork close
to upstream" rule makes a real cost. Decide before starting: either accept the
divergence, or keep the star adapter entirely inside libcontext + `sched_context.h` and
leave both KiCad files untouched, which is likely possible because the whole seam is
`jump_fcontext` calls.

### Phase C — waits yield the owning context (3–5 d)

`wxWasmYieldUntil` becomes a context yield: look up the owner of the current stack (the
mechanism exists), park it, and let `resolveWait` mark it ready. The doc-19 main-stack
bounce (`wx/wasm/private/mainstack.h`) becomes unnecessary and should be **removed in the
same flip** — it is a mitigation for exactly the condition this phase eliminates.

### Phase D — dispatch on a context (3–5 d)

Doc 20's D2, retried. The reverted implementation is recoverable from git
(`design-b D2` in the work log) and was correct apart from its dependencies; the pool idea
in it is **wrong** and must not come back — one dispatch context suffices once waits yield.

> **B + C + D land as ONE commit.** Each alone regresses. Build them on a sub-branch,
> keep every guard as a tripwire, flip once, gate hard.

**Sub-branch `feature/async-star-flip` (2026-08-06): the core mechanism is built and
proven, the wiring is not.** Landed there: `fiber_transfer(from, to, value)` —
libcontext's symmetric swap expressed as a star transition (park the source, make the
target runnable, the scheduler performs every entry) — plus `fiber_start` (the lane's
entry point, since a transfer needs a running context to park) and `drain_all` (the
top-level pump, because a star transition only makes work *runnable*).

The question that decided whether B is possible at all is answered YES and pinned by
`star_transfer_call_is_synchronous`: **parking the caller and resuming it when the
callee yields is indistinguishable, in the caller's own C++ frame, from a synchronous
return.** So `TOOL_MANAGER`'s `Call(); if( !Running() )` contract survives the flip
untouched — which is what makes a KiCad-minimal Phase B realistic.

**The constraint that fixes the order of the remaining wiring — ONE root, not two.**
`ensure_scheduler_context()` adopts whatever stack first calls `drain()`, and
libcontext's `ensure_main_context()` adopts whatever stack first calls
`jump_fcontext`. In production both are the main stack, so the scheduler fiber and the
libcontext root would be two `emscripten_fiber_t`s describing the SAME stack — mutual
corruption the moment either is entered. In Phase A this was harmless (nothing in
KiCad ever called `drain()`); at the flip it is fatal. Therefore:

1. **D first, inside the flip:** dispatch moves onto its own context, so the main
   stack is only ever the scheduler and nothing else runs there.
2. libcontext's root then adopts **the running context** (the dispatch context), never
   the main stack.
3. Only then may `jump_fcontext` become `fiber_transfer`, because every caller is now
   provably on a context and can park.
4. C follows naturally: `wxWasmYieldUntil` yields the owning context, `resolveWait`
   marks it ready, and the doc-19 mainstack bounce comes out.

The tick becomes `fiber_start(dispatch, …)` + `drain_all()` from a fresh JS task.

**MEASURED PLAN CORRECTION (2026-08-06): D forces D5, and E cannot wait.** The wiring
above is implemented on the sub-branch (dispatch context + `wxWasmYieldUntil` yielding
its owner + the shim routing `resolveWait` to `mark_ready` + libcontext's root adopting
the running context + `jump_fcontext` becoming `fiber_transfer`). wx compiles, the
sched-context battery and 41 of 48 wx/asyncify tests stay green — but the coroutine and
coroutine-nested harnesses now fail with
`overlapped-wake: restoring currData=… over null`, the exact class this work exists to
remove, and the trace names the cause:

```
fcs old=…    new=…     w=0 rf=wxWasmTopLevelTick
fcs old=…    new=…     ROOT w=0 rf=dynCall_vi
[wx-asyncify] overlapped-wake: restoring currData=… over null
```

`wxGUIEventLoop::DoRun`'s top-level loop parks the MAIN stack every frame in
`wxWasmYieldToBrowser` (doc 21's W2, classified "safe by construction … unless D5 is
taken"). That classification held only while dispatch also ran on the main stack. Once
the scheduler swaps contexts from the tick, the main stack's per-frame Asyncify park and
the scheduler's transitions interleave over one `currData`.

So the one-root constraint is stronger than first written: **the main stack must be the
scheduler and nothing else — which means the main loop itself has to become a context
(D5), not merely dispatch (D).** D5 is therefore no longer optional and no longer
"decide with Phase E telemetry"; it is part of the same flip. By the same argument, any
remaining in-place Asyncify park under a context (doc 21's K1–K7 bridges and the T1–T3
levers) can reproduce this, so **E belongs in the flip too**, or each bridge must be
proven never to run beneath a context first.

Revised flip contents: **D5 + D + C + B + E**, landed together. That is a bigger single
commit than doc 22 §5 planned, and it is the honest consequence of the measurement —
the alternative (landing D without D5) is the partial migration this document forbids.

### What D5 actually costs (analysed 2026-08-07, before writing any of it)

> **DONE 2026-08-07 — see §10's D5 entry.** Options (1)+(2) below were both needed;
> delta-zero on the batteries; three non-D5 findings recorded there, including a real
> regression in the WIP libcontext change that must be fixed before the flip.

`wxGUIEventLoop::DoRun`'s top-level body is:

```
while( !m_shouldExit ) { wxWasmScheduleProcessEvents(); wxWasmYieldToBrowser(); }
```

The park is not incidental — it is how a *synchronous C++ frame* waits for the next
frame. A frame that must not park has only one other way to wait: **return**. So D5 is
not "run the loop on a context" bolted onto the current shape; it is:

1. the loop body moves to a main-loop context whose per-frame wait is `yield_park`;
2. `DoRun` **returns** to `main()`, and the app is thereafter driven by JS ticks calling
   the pump (a rAF loop marking the main-loop context ready, then `drain_all()`);
3. therefore `main()` must return without tearing wx down — the runtime stays alive
   (`EXIT_RUNTIME=0`, no wx cleanup on that path).

Step 3 is the real cost: it changes application lifetime, and the existing comments
record that this area was deliberately built to avoid exactly that
(`simulate_infinite_loop=1`'s unwind throw is fatal under native wasm-EH —
docs/features/wasm-exceptions/08+09). Returning normally is NOT that throw and should be
safe, but it needs its own gate: teardown paths, `~wxTopLevelWindowWasm`, the shutdown
latch in S6, and the "quit notify only from IsMainFrame" fix from v0.1.28 all live on
the assumption that DoRun returning means the app is ending.

**No smaller fix exists, and this was checked rather than assumed:** the scheduler
stack IS the main stack, so while the main stack is Asyncify-parked in the rAF yield,
any pump entry re-enters wasm on a stack that is logically suspended — which is the
`overlapped-wake` above. Since the loop parks every frame, there is no window in which
pumping is safe. Hence the park has to go, and hence the return.

**Recommended next move:** do D5 first and ALONE on the sub-branch, gated by the wx
battery + coroutine trio (no KiCad build needed — it is wx-only), because it is the
step most likely to be wrong and the cheapest to iterate on. Only once the main stack is
provably scheduler-only should D/C/B/E be re-enabled on top; they are already written
and committed here (`WIP star-flip`), currently sitting behind this blocker.

**Where the D5 change must go — traced, and it is not in the wasm layer.** The call
chain is `main()` → `wxEntry` → `wxApp::OnRun()` → `MainLoop()` → `wxEventLoop::Run()`
→ `wxGUIEventLoop::DoRun()`, and `wx/app.h:102` states the contract plainly: *"When
OnRun() returns, the program starts shutting down."* So `DoRun` returning is not a local
wasm-port decision — it propagates up into wx's own teardown.

That collides with CLAUDE.md's standing rule ("don't change the wxwidgets core unless
absolutely necessary; fix things in the wasm layer"). This is the case that rule's
escape hatch exists for, but it must be taken deliberately, not discovered mid-flip.
Three options, in the order they should be evaluated:

1. **A wasm-port `OnRun` override** that starts the main-loop context, returns to JS,
   and never lets wx's shutdown path run — keeps the change inside `src/wasm/`, which
   is where the rule wants it. Verify what `wxEntry` does after `OnRun` returns before
   assuming this is enough.
2. **A core `wxEntry`/`OnRun` change** gated behind `__WXWASM__`, if (1) cannot keep
   teardown from running.
3. **Keep `DoRun` from returning at all** by parking its frame on a context — rejected
   above, because the frame that waits for the next browser frame must either park the
   stack it stands on (the thing D5 removes) or return.

Whichever is chosen, the gate must cover teardown explicitly: `~wxTopLevelWindowWasm`,
S6's shutdown latch, and v0.1.28's "quit notify only from IsMainFrame" fix all encode
the current assumption that a returning `DoRun` means the app is ending.

### Phase E — bridges on contexts (1 wk)

Doc 21 §1's K1–K7 and W4/W5 through one `wasm_await_promise`-style helper. After this **no
`handleSleep` park happens on any fiber stack** — assert it. Take each bridge's deep-park
high-water from its own beacon and size buffers from that (doc 21 §2b); D1's ~34 B/frame is
a synthetic floor, not a budget.

### Phase F — delete the guard thicket (2–3 d)

Only now, and only guards that have been provably silent: libcontext's refusals, the shim's
quarantine/consume-once, the wx interlock and its zero/restore sites, the open/fiber-busy
gates. Flip `fiber-resume-park.spec.ts` from "refused" to "resumed after its park resolves".

**Total: ~4–6 weeks**, of which B is half.

## 6. Gates — what "done" means

The batteries never reproduced the blue screen, so they cannot certify it. Use all three:

1. **The crash's own repro** (the only proof that matters): `REPRO_PROFILE` + a ≥120 MB
   project + 2–4 warm loads; watch for the `68/N` counters and `kill-fiber` signature.
   Target: `rootHotTotal == 0`, zero `aliased-wake-live`, zero refusals.
2. **The full net**: kicad suite, wx battery, coroutine trio, races, `sched-context`,
   `quasimodal-strand` (now a green regression pin), the drift/collab fuzz suites.
3. **Tripwire silence**: every guard retained during A–E must record zero firings across a
   full fuzz run before Phase F deletes it.

Known-pre-existing failures to expect and NOT chase: `occ-probe` `glb` format matrix, and
`e2e/modal.spec.ts:125` (environment-sensitive; fails on unchanged binaries).

## 7. Invariants and traps learned in this run

Hard-won; each cost at least one build+test cycle.

1. **Fiber C stacks must be 16-byte aligned.** `EM_ASM` puts its argument buffer on the
   running stack and the glue asserts `buf % 16 == 0`; emscripten's malloc gives 8. A
   misaligned context traps in `readEmAsmArgs` on *every* `EM_ASM` (found via 107 wx
   failures). `AlignedBuffer` in `sched_context.h` handles it — do not hand a fiber a
   `std::vector<char>::data()`.
2. **`emscripten_stack_get_base()/end()` describe the CURRENT stack, not the main one.**
   `finishContextSwitch` calls `emscripten_stack_set_limits` with the incoming fiber's
   bounds, so a live query reports "on the main stack" from everywhere and detects nothing —
   silently. Capture the main stack's bounds once, where you are provably on it.
3. **Every `emscripten_fiber_t` needs its own asyncify buffer, including the host side of a
   swap.** A zero-initialised one has a null buffer and traps on first swap. This briefly
   looked like proof that fiber-on-context nesting was impossible; it is not —
   `fiber_nests_in_context` pins that it works.
4. **A wait must yield the context that owns its stack.** Yielding a context you merely sit
   on top of saves the wrong stack into its fiber struct: silent, total, undetectable after
   the fact.
5. **Partial migration is worse than none** — measured twice (§3). If a change leaves one
   participant parking in place while another expects contexts, it will regress.
6. **A parked context must not be freed, and a resume must never be inferred.** Both are
   registry lookups; keep them that way.
7. **Test-infrastructure trap:** `tests/apps/gal-webgl` + `build-wasm/sysroot` hold
   gitignored artifacts no normal build produces. Losing them looks like a 29-test mass
   regression. Fix: `scripts/setup-worktree.sh`. When triaging a mass failure, first run
   `find tests/apps -name '*.wasm' -newermt <last known good>` — it settles "my change vs
   the environment" in seconds.

## 8. Cycle costs (for planning)

Measured on the dev Mac, warm caches: wx rebuild ~5 min · all wx test apps ~10 min ·
`docker/build.sh kicad_editor` ~15 min · wx+asyncify+coroutine battery ~5 min · full kicad
suite ~8 min. So one full "change → verdict" loop on a KiCad-side change is ~25–30 min, and
a wx-only change ~20 min. Budget phases accordingly; batch experiments per build.

## 9. Where the pieces are

| what | where |
|---|---|
| context primitives + registry + memory gate | `wxwidgets/include/wx/wasm/private/sched_context.h` (header-only) |
| its harness + gate | `tests/apps/standalone/sched-context/`, `tests/asyncify/sched-context.spec.ts` |
| the scheduler shim (mailbox, waits, wakes, guards) | `scripts/common/shims/asyncify-scheduler.js` |
| libcontext's wasm backend (Phase A's target) | `kicad/thirdparty/libcontext/libcontext.cpp` |
| tool coroutine seam (Phase B) | `kicad/include/tool/coroutine.h`, `kicad/common/tool/tool_manager.cpp` |
| wait bridges (Phase C) | `wxwidgets/src/wasm/evtloop.cpp`, `dialog.cpp`, `window.cpp` |
| the doc-19 mitigation to remove at Phase C | `wxwidgets/include/wx/wasm/private/mainstack.h`, `wasm/bindings/main_stack_runner.h`, `TOOL_MANAGER::RunOnMainStackIfActiveTool` |
| park-site inventory | [`21`](21-park-site-audit.md) §1 |
| doc-19 regression pin | `tests/kicad/quasimodal-strand.spec.ts` |

Branch: `feature/async-mailbox`, unpushed across 6 repos. Baseline tags:
`mailbox-s0-baseline`, `d-1-pre-delete`. Tag before each phase's flip.

## 10. Work log

### Phase A — DONE, gate met (2026-08-06) ✅

Final gate: full kicad suite **139 passed / 1 failed** — the failure is the known
pre-existing `occ-probe` `glb` format matrix, i.e. the baseline exactly. wx battery
346 passed / 1 failed (pre-existing `e2e/modal.spec.ts:125`) / 3 skipped; coroutine
trio + nested + races + asyncify 48/48; sched-context 2/2 including three new
fiber-lane scenarios. **Tripwire sweep over every suite log: zero
`sched-divergence-*`, zero `swap-lost`, zero `fiber_swap()` refusals, zero
`FIBER-SWAP-NONENTERABLE`, zero `FIBER-RELEASE-RUNNING`, zero
`jump-into-reclaimed`, zero `grace-ring-evict`.** The registry's view agreed with
libcontext's protocol on every swap in the suite — which is the whole claim Phase A
had to earn before Phase B moves the decision.

**Landed (working tree, uncommitted):**

- `sched_context.h` grew the **fiber lane**: `fiber_adopt_current` / `fiber_create`
  (caller-owned C stack adopted, registry-owned asyncify buffer) / `fiber_swap` /
  `fiber_enterable` / `fiber_release`, with its own counters so the D1 star memory
  gate keeps meaning what it meant. Suspended-capture high-water is sampled
  **before** the resume consumes it (afterwards it always reads 0) — that number is
  Phase E's sizing input.
- `libcontext.cpp`'s wasm backend became the adapter: `wasm_fcontext` keeps only
  protocol state (return_to, transfer_value, epochs, refcounts); the
  `emscripten_fiber_t` + buffer live in the registry; every swap (jump and
  trampoline return) goes through `pcbjam_sched::fiber_swap`. `swap_suspended`
  stays AUTHORITATIVE for the parked-jump refusal and the registry only observes,
  beaconing `sched-divergence-*` on disagreement (see bug 3).
- `thirdparty/libcontext/CMakeLists.txt` gained the wx include path under
  EMSCRIPTEN. Harness + spec: 3 fiber-lane scenarios, fiber stats assertions.

**Four real bugs, every one caught by a tripwire rather than by guessing.** Each is
worth reading before Phase B, because three of them are the same mistake:

1. **Never infer the swap's `from` side.** The first cut derived it from the
   lane's "current", which goes stale across a handleSleep park exactly like
   `g_current_context` does — the wrong context got marked Suspended, the real
   swapper stayed "Running" forever, and every later jump into it was wrongly
   refused (a dispatch the legacy guard would have allowed). libcontext KNOWS who
   is swapping out; `fiber_swap(from, to)` now mirrors its answer, keeping the
   two layers in lockstep by construction.
2. **A release must always release.** libcontext's refcount drop deletes the
   struct unconditionally; the registry refusing a "Running" release while the
   caller frees anyway left a permanent ghost (plus a dangling
   `g_current_context` — the garbage-id beacon) that poisoned every later
   enterability answer. Now: release always, `FIBER-RELEASE-RUNNING` beacon.

3. **The registry must not OVERRULE the protocol, only record it.** Keying the
   parked-jump refusal on `fiber_enterable()` refused a dispatch the legacy
   backend permitted: Symbol Properties stopped opening (`quasimodal-strand`,
   a fiber the registry still called Running while `swap_suspended` said validly
   suspended). Phase A moves the BOOKKEEPING, not the decision. `swap_suspended`
   is authoritative again; every disagreement is now a recorded fact instead of a
   behaviour change, and those recordings are the evidence Phase B's flip gets
   designed on.
4. **Absorbing the buffer un-hid a KiCad use-after-free.** `TOOL_MANAGER` keeps raw
   `fcontext_t`s that outlive the `COROUTINE` owning them and jumps into them after
   the last refcount is gone. This "worked" for years for a reason worth writing
   down: the freed block was ~512 K (the asyncify buffer lived INSIDE the struct),
   and malloc parks that size in a large bin, so freed stayed readable essentially
   forever. Moving the buffer into the registry left a ~64-byte struct — recycled
   on the next call — so `sched_id` read back as a freelist pointer (`0x16554B0`),
   the swap was refused, and EVERY canvas tool wedged ("click never landed a
   selection", "box-select never selected anything", 19 suite failures). The change
   did not introduce the bug; it removed the size accident that concealed it.

**The rule all four share, and the one to carry into B–E: the registry may only
record what the protocol actually did — it may not guess it, and it may not refuse
anything the legacy code permitted.** Phase A is behaviour-preserving or it is
nothing.

**The grace ring (bug 4's containment, and a Phase B input).** Released contexts are
kept, not freed: the struct is never deleted (protocol state only now — tens of
bytes, cheaper than the accident it replaces, and it makes a stale jump land on a
real `sched_id`), and the FIBER (512 K + registry entry) is bounded by a 32-entry
ring. Eviction takes only coroutines that actually FINISHED — evicting by age alone
dropped long-lived tool coroutine #1 that `TOOL_MANAGER` re-enters, and `m`-move
plus lock-resist failed. An evicted context keeps its struct with `sched_id` zeroed
so a later jump takes the ghost contract callers already handle.

**Measured, and it is the number Phase B needs:** `grace-ring-over-capacity: 33`
fired in 4 specs — i.e. 33 released coroutines were live with NONE evictable,
because none had finished. So KiCad really does hold 30+ never-finished coroutines
whose owners are gone, and the ring cannot reclaim them: worst case that is ~16 MB
of retained asyncify buffers, and it grows with the working set rather than being
capped by the ring. This is not a leak Phase A may fix (that would change
behaviour); it is exactly what Phase B removes by giving coroutines
scheduler-owned lifetimes, and it should be re-measured after that flip.

**Process traps paid for in this run:**

- Build against the **libs volume** (`COMPOSE_PROJECT_NAME=kicad-wasm-libs`). A bare
  `docker/build.sh` creates a cold per-branch volume whose sysroot lacks glm and
  dies at the gl1 shim.
- `npx playwright test` does NOT sync `output/*.wasm` into `tests/apps/kicad/`; only
  `npm run test:kicad` (which runs `setup:kicad` first) does. A retest after a
  rebuild that shows byte-identical beacons is testing the OLD binary — this cost a
  full diagnosis cycle.
- A Docker VM at 100% disk fails builds with exit 137 and simultaneously crash-loops
  the user's unrelated postgres containers (`could not write lock file`). Diagnose
  and report; never prune or delete Docker state to clear it.

Baseline tags `phase-a-pre` on root/pcbjam/kicad/wxwidgets.

### D5 — built, measured, delta-zero (2026-08-07) ✅ with findings

Baseline tags `d5-pre` on root/pcbjam/kicad/wxwidgets. Option (1)+(2) from the analysis
above: the wasm `OnRun` override alone is NOT enough — verified: `wxEntryReal` runs
`OnExit()` (the `CallOnExit` destructor) and the `wxInitializer` destructor's
`wxEntryCleanup` right after `OnRun` returns — so a minimal `__WXWASM__`-gated change
in `init.cpp` accompanies it.

**Landed (wxwidgets, on the sub-branch):**

- `wxApp::OnRun()` (wasm port) calls `wxWasmDetachMainLoop(this)`: the whole stock main
  loop (`wxAppBase::OnRun` → `MainLoop` → `Run` → `DoRun`) moves onto a `wx-main-loop`
  fiber-lane context (1 MB stack / 512 K asyncify, same sizing as the dispatch context),
  so the loop object, its activator and `m_shouldExit` all live on the context stack and
  `ScheduleExit`/`IsInsideRun` keep working. On detach failure it falls back to the
  inline loop (pre-D5 shape) — nothing depends on the context existing.
- `DoRun`'s per-frame wait: `can_yield_here()` → arm a rAF wake → `yield_park("frame")`;
  else the old in-place `wxWasmYieldToBrowser`. The rAF callback and the first kick are
  both fresh JS tasks calling `wxWasmMainLoopPump` (Fresh → `fiber_start`, parked at
  "frame" → `mark_ready`, then `drain_all`) — mirroring `wxWasmDispatchOnContext`.
- **First entry MUST come from a clean task AFTER `main()` returns** (a `setTimeout` kick
  armed in the detach): entering from `OnRun`'s own frame would capture `main()`/`wxEntry`
  frames into the scheduler fiber's buffer and `main` would "return" inside a later
  pump's rewind.
- **Main-stack bounds are captured in the detach**, the last moment we provably stand on
  the main stack — `DoRun` now runs on the context, where the live-query trap (§7.2)
  would record the context's bounds and silently break `wxWasmOnCoroutineStack`.
- Teardown moved to the loop context's exit path: after the loop exits (S6 latch fires as
  before), the context entry runs `OnExit()` + `wxUninitialize()`, then parks forever.
  `init.cpp` (`__WXWASM__`-gated): `CallOnExit` skips `OnExit` when detached, and a
  `wxAtomicInc(gs_initData.nInitCount)` after `OnRun` pins `wxEntryCleanup` off — the
  loop context's own `wxUninitialize` balances it. `EXIT_RUNTIME` is unset (default 0)
  everywhere, so `main()` returning keeps the runtime alive.
- Doc 22 flip staging switches in evtloop.cpp: `wxWASM_STAR_DISPATCH` (Phase D tick
  dispatch, currently 0 — re-enable for the flip) and `wxWASM_D5_DETACH` (1).

**Gate: 387 passed / 3 skipped across wx battery + asyncify + coroutine projects with
D5 ON, and — the load-bearing number — the failure set is IDENTICAL with D5 OFF (same
tree, toggle flipped): D5 is delta-zero.** The per-frame scheduler↔loop-context swap
pairs are visible and clean in the flight recorder (`rf=wxWasmMainLoopPump`). The
failures themselves predate D5, and a working-tree bisection (revert one file at a time,
rebuild apps, rerun) decomposed them into three ingredients — none of them D5:

1. **The WIP `jump_fcontext`→`fiber_transfer` libcontext change moves the nested
   death from case 5 to case 2** (`baseline_fiber_alone`, `hot-main-swap-out` →
   `Aborted` inside the swap); reverting the one file moves it back — but does NOT
   make the suite green (see 2). Whether that is a semantic delta in the dormant
   fallback (`current()==0` → Phase A direct swap — a line-by-line audit found none:
   the `transfer_value` assignments are idempotent and the transfer branch is
   unreachable) or merely binary layout shifting the same cliff (finding 3 proves
   layout alone can) is UNDETERMINED. Treat it as a cliff datapoint, not a proven
   regression — do not burn a build cycle hunting a delta that may not exist. What
   IS corrected: the WIP-tip nested failure was blamed on the D wiring, but it
   reproduces with the D tick gated off.
2. **The Phase A scoreboard is stale for coroutine-nested TODAY:** at the exact Phase A
   state (wx `719fd98798`, Phase A shim + libcontext, freshly rebuilt), nested dies
   deterministically at `fiber_yield_across_modal_close` — `hot-main-swap-out`
   occurrence 3 → abort — on both engines. Nothing on the branch causes it; the 8/6
   green is not reproducible in today's environment. Re-baseline before attributing
   nested reds to a change.
3. **`asyncify-races` `wakeup_during_transition` sits on the same cliff:** green at
   Phase A wx, red with the WIP+D5-dark wx library on the same shim/libcontext — it
   flips with wx binary layout/timing, not with any active code path.

All three are the `hot-main-swap-out` wake-window class (doc 21's W/K sites): a
libcontext jump inside a root sleep-wake continuation writes a ~1 KB unrewindable
capture (`rem=` telemetry confirms), and whether the eventual rewind survives is
environment- and layout-sensitive. That fragility is not fixable at D5 — it is exactly
what C+B+E remove structurally (no in-place parks → no wake windows → no hot jumps), so
expect these harnesses to go green AT the flip, not before it.

**Still open from the teardown gate:** the detached exit path (loop exits → `OnExit` +
`wxUninitialize` on the context) compiles and is reachable but no battery spec drives a
real app quit through it; add one before the flip relies on it.
*(Closed the same day: `tests/e2e/app-quit.spec.ts` + a `wx_test_quit` hook in
`minimal_test.cpp` drive a real File→Quit-shaped exit and assert the S6 latch fires
"clean" with no traps — green in the D-on probe below.)*

### D-on probe (2026-08-07) — flip staging measured; the cliff solved; two Phase B gaps named

`wxWASM_STAR_DISPATCH=1` on top of D5 engages D (dispatch context) + C (waits park it)
+ B's transfer mechanism (libcontext root adopts the running context, jumps become
transfers) in one flip. Three build-measure cycles, each fixing what the previous named:

**1. THE "ENVIRONMENTAL CLIFF" WAS ADOPTED-STACK ALIGNMENT — §7 trap 1, live all week.**
The first D-on run killed the plain coroutine suite at its FIRST case with
`Aborted(Assertion failed)`; the JS stack named `readEmAsmArgs`'s `buf % 16 == 0`
assert. The coroutine harness allocates fiber stacks with `std::make_unique<char[]>` —
plain `new`, 8-byte aligned — and `fiber_create` adopted the range raw, so whether a
given stack landed 16-aligned was HEAP-HISTORY LUCK. Phase A moved the 512 K asyncify
buffers into registry-malloc'd blocks, shifting the heap layout for everything after —
which is why the deaths appeared this week, moved with any binary change, were
deterministic per build, and read as "environmental". **This retires the D5 entry's
findings 2 and 3 with a mechanism**: nested's case-5 death and the races layout flips
were alignment luck, not a mystery. Fix: `fiber_create` adopts the largest 16-aligned
sub-range (bottom up, size down, ≤30 bytes lost) and refuses stacks too small to align.
KiCad's real `COROUTINE` maps whole pages (aligned), which is why production never saw
it — only `new char[]` clients (the harness) sat on the cliff.

**2. With alignment fixed, D5+D reached 388 passed** — plain coroutine, coroutine-
pthread, `wakeup_during_transition` AND the new app-quit teardown spec all green.
Remaining: nested `fiber_create_run_destroy_inside_modal`
(`[sched-ctx] REFUSED mark_ready() on a running context` — the modal's wake was lost)
and races `nested_quasi_modal_pump_error` (watchdog, suspension never completed).

**3. THE ONE-ROOT BINDING WAS WRONG — the root's identity is a PER-JUMP question.**
The D wiring bound libcontext's root ONCE to `current()` at first jump (the dispatch
context). But mailbox timers and DOM handlers still enter on the MAIN stack until
Phase E completes, and a timer jumping a fiber from the main stack then used the
DISPATCH context's fiber struct as its from-side while that context sat PARKED in a
modal — overwriting the parked capture, marking it Running, and losing the modal's
resolve (`mark_ready() on a running context`). Landed in libcontext:
`resolve_root_identity()` (the running scheduler context, else a lazily-adopted
main-stack fiber) stamps the root at EVERY jump out, replacing the bind-once.

A second half was attempted and REVERTED the same day: routing a jump INTO the root
at "whoever entered me" (`entered_from_sched`), to cover a delayed yield-back after
other stacks re-stamped the root. It is wrong for `CONTINUE_AFTER_ROOT` — that
invocation jumps into the root struct meaning THE ACTUAL ROOT of the moment (to run
a main-stack functor), not the enterer, and misrouting it threw an uncaught C++
exception out of a rewind (`nested_coroutine_call_and_resume`). Correct routing is
invocation-aware — libcontext only sees the type inside `INVOCATION_ARGS` — which is
Phase B's redesign, not an adapter patch. The delayed-yield-back stale stamp is
therefore gap 3 below (it only bites with D on).

**4. That fix un-hid the last gap: FINISHED-COROUTINE TRANSFER LIVELOCK.** With the
routing correct, nested's case-3 mechanism is closed but the plain coroutine suite
livelocked: the recorder shows two finished coroutines' trampoline "bounce" loops
(`while(true)` re-entry ghost contract) expressed as star transfers, each bounce
marking the other Ready — a mutual re-queue that ping-pongs across ticks forever. One
symptom of the same incompleteness: `sched-divergence-enterable` storms on every
transfer jump, because `fiber_enterable()` predates the star statuses (a
transfer-parked context reads Parked, not Suspended). This is exactly the Phase B §5
scope ("give COROUTINE an owning handle", "the CONTINUE_AFTER_ROOT loop should
disappear rather than be ported") — not patchable at the adapter.

**Decision: `wxWASM_STAR_DISPATCH` back to 0.** D5 + the alignment fix + the
root-identity fix land as proven groundwork (all are correct or inert at D-off); the
flip re-enables the switch when Phase B owns coroutine lifetimes. The two gaps it must
close, each with a deterministic repro suite:

1. **Wake ordering**: a resolve arriving while the target context is Running must
   QUEUE (the S2 deferred-wake law applied to the registry), not refuse —
   `mark_ready() on a running context` is a lost wake today. Repro: nested case 3
   at D-on (pre-root-fix shape).
2. **Finished-coroutine lifetime**: transfers into/out of trampoline re-entry loops
   livelock; Phase B's owning handles + scheduler-owned lifetimes replace the ghost
   bounce. Repro: plain coroutine suite at D-on with the root-identity fix. Include
   the `fiber_enterable()` status mapping (Parked/Ready are valid suspensions for
   the cross-check) in the same change.
3. **Invocation-aware root routing**: a jump into the root struct must resolve to
   the actual-root-of-the-moment for `CONTINUE_AFTER_ROOT` but to the enterer's
   identity for a delayed yield-back (a coroutine resumed across JS turns after
   other stacks re-stamped the root). The adapter cannot tell them apart; the star
   topology (every party a context, `return_to` a registry id) makes the question
   disappear.

### Phase B at D-on (2026-08-07) — gaps 1+2 CLOSED, and the boundary found

Gaps 1 and 2 are fixed and the wx battery is **green at D-on: 395 passed, 1 failed
(the pre-existing `modal.spec.ts:125`)** — the first clean battery with dispatch
contexts, context waits and star transfers all live. What landed:

- **Terminal finish (gap 2).** `fiber_finish_transfer` marks a finished coroutine
  Finished — never re-queued, never re-entered — and `fiber_transfer` refuses into a
  Finished context, dropping the caller into libcontext's existing ghost contract.
  This replaces the trampoline's `while(true)` ghost re-entry, which as transfers had
  two finished coroutines marking each other Ready forever. `fiber_enterable` now
  accepts the star statuses (a transfer-parked context holds a capture as valid as a
  symmetric Suspended one), which also silenced the `sched-divergence-enterable`
  storm.
- **Dispatch is an IDLE-REUSE SET, not one context — doc 22's "one context suffices"
  was wrong.** A nested quasi-modal loop is a wait that only a LATER dispatch can
  resolve, so a single dispatcher parked in that loop can never be released:
  `nested_quasi_modal_pump_error` wedged exactly there. A tick now reuses any context
  parked at `dispatch-idle` and allocates only when all are parked deeper. This is
  NOT D2's pool (which took a fresh context per tick and grew with the tick rate);
  the live count is bounded by real modal-nesting depth — 1 in steady state.
- **`abandon_transition` (a new containment).** With a second dispatcher the race's
  bomb finally fired and revealed the next layer: an exception escaping a handler
  propagates out THROUGH `drain()`'s fiber swap, so its post-swap bookkeeping never
  runs, the registry stays "transition in flight", and every later pump refuses —
  a permanently dead pump and every outstanding wait stalled. The JS error paths now
  abandon the transition and POISON the half-unwound context (Finished; the dispatch
  set prunes it), mirroring `wx_dispatch_abandon`. `.ci-cache-epoch` → 12.

**THE BOUNDARY, measured on the full KiCad suite (135 passed / 5 failed vs the 139/1
baseline).** Four canvas-tool specs — eeschema draw-wires, pcbnew draw-lines,
pcbnew move-with-m, presence-locks move — die with `index out of bounds` in
`doRewind` ← `finishContextSwitch` ← `Fibers.trampoline` ← `maybeStopUnwind`: the
BLUE SCREEN itself, reproduced by the migration's own transitional state.

The reason the harness cannot see this, and the reason it is a boundary rather than a
bug: **real KiCad tool coroutines park IN PLACE inside their bodies** (a tool waiting
for the next event asyncify-parks on its own stack — doc 21's tool-side sites). A star
transfer turns one symmetric swap into a park-and-drain round trip, and doing that
over a stack that is already asyncify-parked mid-body rewinds state the fiber layer
cannot see. The harness's coroutines yield cleanly, so the transfer lane looks correct
there while KiCad's real tools break — the same "the harness models the shape, not the
parks" lesson as doc 19.

**Consequence for the plan: D cannot carry KiCad until the tool-body park sites are
contexts too.** That is C+E completion (every wait yields its owning context; no
`handleSleep` park on any fiber stack), which doc 22 §5 already requires before the
flip — this measurement just proves the ordering is not negotiable and that D-on
without it is precisely the partial migration §7.5 forbids.

**Landing state: `wxWASM_STAR_DISPATCH` back to 0**, with everything above kept —
all of it is correct-or-inert at D-off, and gaps 1+2 stay closed for the flip.

### The tool-body park site, NAMED (2026-08-07) — `RunSynchronousAction`'s spin loop

Traced rather than inferred, and it is ONE site, not the open-ended set doc 21's K7 row
feared:

```
TOOL_MANAGER::RunSynchronousAction        kicad/include/tool/tool_manager.h:197
  -> processEvent( event )                kicad/common/tool/tool_manager.cpp:366
  -> while( synchronousControl == STS_RUNNING ) {   :368
         wxYield();                                  :370   nested dispatch
         wxMilliSleep( 1 );                          :371   -> nanosleep
     }
        nanosleep (main thread)           wasm/shims/nanosleep_yield.c:41
          -> __wasm_main_thread_yield_ms                    :32  EM_ASYNC_JS
             = AN ASYNCIFY PARK OF THE STACK IT STANDS ON, in a loop, inside a tool body
```

**This is doc 21's K7 row, and its caller set is not "anything that sleeps" — for the
canvas tools it is exactly this one loop.** The evidence closing the case is that
`RunSynchronousAction`'s callers are precisely the tools whose specs died at D-on:
`pcbnew/tools/edit_tool_move_fct.cpp` (move-with-m, presence-locks move),
`eeschema/tools/sch_drawing_tools.cpp` (draw wires), the drawing/edit tools behind
draw-lines. The spec comments already described the symptom from the outside —
"KiCad's GAL updates the active tool's world-space cursor from the **asyncified**
pointer-move handler" — without naming the park; this is that park.

Why it is fatal under D-on specifically: the loop parks the stack it stands on and then
`wxYield()`s, so a nested dispatch runs tool work ON TOP of a stack that is mid-park.
Pre-D that stack was the entry stack and the fiber layer never tried to move it; with
dispatch on a context, a star transfer targets a context whose capture is mid-flight —
`doRewind` → `index out of bounds`.

**The fix shape (next increment): the wait must yield the owning context.** Replace the
spin with a context park — `synchronousControl` transitioning out of `STS_RUNNING`
marks the parked context ready — so the frame waits by yielding rather than by
sleeping-in-place. Notes for whoever takes it:

- This is a `tool_manager.cpp` change, i.e. the first Phase B edit to KiCad proper, so
  §5's divergence question comes due (accept it, or hide the park behind a wx-side
  helper the wasm port supplies and KiCad calls unconditionally — the latter keeps the
  fork close to upstream and is likely possible, since the loop only needs "wait until
  this atomic changes").
- `wxYield()` inside the loop must keep working: under the star it becomes "let the
  scheduler run other contexts", which is what a context park already does — so the
  yield call can likely go away with the sleep rather than be ported.
- Gate on the **KiCad suite** (the four canvas-tool specs are the red-to-green pins),
  never the harness battery — the harness has no `RunSynchronousAction` and will stay
  green either way. That is this session's most transferable lesson.

### The sleep moved to a context — and the REAL blocker surfaced (2026-08-07)

**Built and measured.** `wasm/shims/context_sleep.cpp`: a main-thread `nanosleep`
whose frame stands on a scheduler context that OWNS the stack arms a mailbox wake and
`yield_park`s that context instead of suspending the stack in place; anything else
falls back to the Asyncify yield. It lives in the sleep primitive rather than in
`tool_manager.cpp` deliberately — KiCad and the wx core stay untouched (CLAUDE.md's
fork rule), and the whole K7 class moves at once instead of the one measured caller.

**One correction paid for on the way, worth keeping in mind for every future park
site: a context may have only ONE wake owner.** The first cut parked whatever context
was current, including the MAIN-LOOP context — whose wake already belongs to the rAF
pump. The frame wake then resumed a capture the sleep wake had consumed:
`doRewind` trap arriving through `wxWasmArmFrameWake`, and the eeschema simulator spec
went red at D-off. `wxWasmContextWakeIsPumpOwned()` now excludes the main-loop and
dispatch contexts (their parks are the pumps' contract); tool coroutines, which have
no other wake source, are exactly the ones that park. **D-off re-verified at 139/1
with the shim in — it is correct-or-inert exactly as required.**

**At D-on the four canvas-tool specs still fail, and the trace names a DIFFERENT
cause — the one that actually blocks Phase D.** The fatal swap is
`fcs old=<libcontext ROOT> new=<tool coroutine> rf=dynCall_iiii`, and the JS stack
above it is `mouseEventHandlerFunc` → `registerMouseEventCallback`: **a DOM mouse
handler entering wasm DIRECTLY on the main stack**, not through the tick.

So the same tool coroutine is entered by two different mechanisms:

| entry | path | how the coroutine is resumed |
|---|---|---|
| the tick (`wxWasmTopLevelTick`) | dispatch context → `fiber_transfer` | STAR: parked by the scheduler, capture owned by the scheduler swap |
| a DOM mouse/key handler | main stack, `current() == 0` → direct-swap fallback | SYMMETRIC: entered by `emscripten_fiber_swap` from the root |

A coroutine suspended by a star transfer and later resumed by a direct symmetric swap
rewinds through an entry path its capture was not written for — `index out of bounds`
in `doRewind`. This is doc 22 §7 rule 5 (partial migration is worse than none) in its
purest measured form, and it explains why the harness stays green: its coroutines are
only ever entered from one place.

**Therefore the next Phase B/D increment is not another park site — it is the DOM
event entries.** Every `registerMouseEventCallback` / key / wheel / resize handler that
today runs wx dispatch inline on the main stack must instead hand its event to the
dispatch context (enqueue + pump), exactly as the tick already does. Only when EVERY
entry into a tool coroutine goes through the scheduler does the mixed-mode rewind
class disappear. Note this also subsumes the "one root" work: with no dispatch on the
main stack, `resolve_root_identity()` always answers "the running context".

**Landing state: `wxWASM_STAR_DISPATCH` back to 0**, context-sleep and its
pump-ownership guard kept (inert at D-off, verified 139/1).

### DOM entries on the dispatch context — THE CANVAS TOOLS GO GREEN (2026-08-07)

The increment the section above ordered, built and measured: **every entry that can
reach a tool coroutine now goes through the scheduler.**

- `wxWasmRunOnDispatchContext(fn, arg)` (evtloop.cpp) hands work to a dispatch context
  and pumps. It is SYNCHRONOUS in the common case — `drain_all` returns once the
  context parks at idle, i.e. after the job completed — so callers that need an answer
  still get one. It falls back to running inline when already on a dispatch context
  (same-stack recursion, as `wxYield` does) or when the registry says another context
  is running, which is the in-place-parked-bridge window Phase E closes.
- All four DOM callbacks (`MouseCallback`, `WheelCallback`, `TouchCallback`,
  `KeyCallback`) and the **mailbox tick** now route through it. Jobs are heap-owned
  with ownership going to *whoever finishes last*, because a job may park for a
  dialog's lifetime: the job deletes itself if the caller has given up, else the caller
  deletes it and reads its result. Keys keep their synchronous `preventDefault` (the
  job writes it before it can park; a job that parks anyway leaves the default — the
  browser cannot wait for a modal).
- The context-sleep wake had to learn the same lesson in reverse: now that the mailbox
  runs ON a context, `wake_sleeper` must not call `drain_all` from there (drain refuses
  re-entry, correctly). It marks ready and lets the outer `drain_all` — still pumping
  on the scheduler stack — perform the entry, with an armed pump as a backstop.

**Result at D-on: KiCad 136 passed / 3, and all four canvas-tool specs are GREEN**
(eeschema draw-wires, pcbnew draw-lines, pcbnew move-with-m, presence-locks move).
The mixed-mode rewind class — a coroutine entered by a star transfer from the tick and
by a direct symmetric swap from a DOM handler — is gone, which was Phase D's blocker.

**The 3 remaining, and 2 of them are pins measuring a world D5 deleted.** Besides the
pre-existing `occ-probe`, `timer-park-repro` and `quasimodal-strand`'s *staging* test
fail on ONE assertion: "scheduler shim observed the concurrent-park window", expected
`> 0`, got `0`. Everything else in those specs passes — `fired=true done=true
parked=true errors=0`, i.e. the parking timer handler parks, rewinds and survives.

That counter fires when `handleSleep` is entered while `currData` is non-null: **two
concurrent in-place Asyncify parks.** The lever stages "timer park × MAIN-LOOP YIELD
PARK" (its own header says so), and D5 removed the main loop's Asyncify park — so the
overlap cannot occur any more. The spec's comment even anticipates the shape of this:
"that assert fails only if the lever itself never created the overlap (a broken repro,
not a passing one)" — here the repro is not broken, its ingredient was deliberately
eliminated.

**Do NOT paper over this by relaxing the assert.** It is a Phase F decision, alongside
`fiber-resume-park.spec.ts`'s red→green flip: each lever gets re-pinned to the
post-migration invariant (the runtime survives AND no concurrent-park window is
observable) with the evidence recorded, or a replacement lever is built that stages a
still-possible overlap. Until then the honest statement is: at D-on those two specs
cannot stage their scenario, and the runtime behaviour they guard is green.

**Landing state: `wxWASM_STAR_DISPATCH` back to 0** (all of the above is inert there),
everything kept. **Next: Phase E** — the K1–K7 bridges are now the only in-place parks
left under a context, and they are what the `current() != 0` fallback above still
tolerates.

### Phase E, first attempt: K1 as a context wait — REVERTED, and what it cost

The bridge pattern doc 22 §5 calls for, tried on K1 (`sch_io_pcbjam_lib.cpp`, the
symbol-library request — chosen first because doc 21 makes it the doc-19 exposure: a
chooser's lazy load parks the TOOL COROUTINE that owns the chooser):

```
  before:  char* r = pcbjam_libs_request_js(op, lib, arg, kind);   // EM_ASYNC_JS, parks in place
  after:   int t = wxWasmBeginWait("lib");
           pcbjam_libs_request_start(t, op, lib, arg, kind);       // EM_JS, resolves the wait
           wxWasmYieldUntil(t);                                    // context park, or in-place fallback
           char* r = pcbjam_libs_take_result(t);
```

**Result: the KiCad suite went from 7 minutes to 1.2 HOURS — 111 passed, the rest
timing out, and the app going SILENT right after a library request.** A parked context
that nobody resumes. Reverted; the tree keeps the working `EM_ASYNC_JS`.

**A PRECONDITION the attempt discovered — re-add it WITH the next conversion, it is
not in the tree.** `wxWasmYieldUntil` must not park a context whose wait is already
resolved: `resolveWait` DELETES the entry, so a bridge whose promise settles before the
caller reaches the park leaves that context waiting for a wake nobody sends. The
in-place form had no such window (the same expression created and awaited the promise);
every bridge converted to this pattern re-opens it. The guard is four lines —

```cpp
EM_JS(int, wxWasmWaitPendingJs, (int token), {          // resolveWait deletes the entry
    return globalThis.__wxScheduler.waits.has(token) ? 1 : 0;
});
...
    if (self && pcbjam_sched::can_yield_here())
    {
        if (!wxWasmWaitPendingJs(token))    // already resolved: do NOT park
            return 0;
```

— and it was NOT the hang (the hang reproduced with it in place). It is deliberately
NOT landed: it sits in the wait path of every modal and nested loop, and the only build
that ever contained it was the broken one, so it has never been measured at D-off. It
belongs in the same commit as the bridge conversion it protects, gated together.

**Where the next attempt should start — hypotheses, in the order the evidence supports
them.** Not yet distinguished; do this with a focused repro (open a schematic with the
chooser, one lib request), not the full suite:

1. **The resolve never reaches the registry.** `resolveWait` routes a context-parked
   token to `Module["_wxWasmSchedResolveContextWait"]` + `_armSchedPump`; if either
   export is missing from the KiCad link (they are `EMSCRIPTEN_KEEPALIVE` in wx, but
   this is the first KiCad-side caller of the wait registry) the mark-ready silently
   never happens. Check `Module["_wxWasmSchedResolveContextWait"]` in the console
   first — it is one line and would explain the symptom exactly.
2. **The lib path runs where `can_yield_here()` is true but the resumer cannot reach
   it** — e.g. inside the chooser's modal, where the dispatch context is already
   parked at a "nested" wait and the lib wait parks it a second time (a context can
   hold only ONE park; the second yield would strand the first).
3. **Asyncify instrumentation closure.** Removing the `EM_ASYNC_JS` from this
   translation unit changes which functions binaryen instruments; the KiCad lib path
   now reaches an unwind only through `wxWasmYieldUntilJs`. If the closure no longer
   covers a frame in that path, the fallback park corrupts instead of suspending.

**Process note for the next attempt:** gate a bridge conversion on a SINGLE spec first
(`eeschema.spec.ts` or a chooser spec), not `npm run test:kicad` — this attempt cost a
1.2-hour suite run to learn one bit. The full suite is the confirmation, not the probe.

### Phase E retry: K1 LANDED — the strand was a certainty, not a race (2026-08-08)

**Gate: full KiCad suite 139 passed / 1 failed (pre-existing occ-probe glb) / 30
skipped in 7.2 min — the Phase A baseline exactly**, with the K1 conversion IN. The
casualty class went first: `eeschema-ui` 3/3 in 17.7 s (attempt 1 hung it at boot for
3 min per test), then strand + sim + modal-stack 6/6. Zero `[wx-wait]` beacons fired.

**The diagnosis, from evidence attempt 1 left behind rather than a rebuild.** The
broken run's playwright report survived (`tests/playwright-report`, 111 expected / 26
unexpected) and all 26 failures are the same shape: `#canvas` never appeared — BOOT
hangs, not chooser hangs. A live probe of the bare test page then supplied the missing
fact: **test pages install no `kicadLibs` provider at all.** So on every spec page the
converted bridge resolved its wait synchronously (no-hook → `resolveWait(token, 0)`
inside the same wasm turn), `resolveWait` DELETED the entry, and the C++ then parked a
context whose wake had already been spent. Not a race — a certainty on every
provider-less page, which is why 26 specs died broadly instead of one chooser flow.
(Hypothesis 1 was falsified first: both exports are real export assignments in the
surviving glue, and they come from the wx side of the link, identical in both builds.)

**The §"first attempt" guard is LOSSY and was NOT landed — this landed instead.** The
4-line `waits.has` guard returns 0 for an already-resolved wait, dropping the result
(a malloc'd payload pointer for lib requests, a return code for modals). The
result-preserving shape, all three pieces required together:

1. **Retention (shim):** `resolveWait` keeps a resolved-but-unawaited non-context
   entry in the map with `result` attached (counter `earlyWaitResolves`), instead of
   deleting it. Context-parked and promise-awaited resolves behave exactly as before.
2. **Peek-and-consume (wx):** `wxWasmYieldUntil` checks `waitEarlyResolved(token)`
   before parking a context and returns `takeWaitResult(token)` instead of parking;
   `waitPromise` consumes a retained entry too — which also fixes a PRE-EXISTING data
   loss (a synchronous C++ resolve before `wxWasmYieldUntilJs` used to return 0 with
   an "unknown token" warning).
3. **Deferred resolution (bridge contract):** a converted bridge must never call
   `resolveWait` synchronously from its start function — every path defers to at
   least a microtask. `pcbjam_libs_request_start` wraps the provider in
   `Promise.resolve(...)` so even a synchronous provider resolves on a microtask.

Beacons on the two previously-silent links stay in: a resolve for an unregistered
context-wait token, and a refused `mark_ready`, both warn with the token identity.

**Why attempt 1 "reproduced with the guard in place" could not be reproduced:** not
resolvable from surviving evidence; the equivalent-but-stronger mechanism gates green
today. The stale-sync trap (a retest against unsynced binaries) remains the likeliest
explanation. The retention design is landed regardless — it is strictly stronger.

**Honest coverage note:** the bare-page probe shows `waitsBegun == 0` at boot — K1's
main-thread path is THIN on test pages (the chooser path proxies from pthread
workers, untouched). The park-then-resolve half of the mechanism is exercised by
every modal at D-off (same `wxWasmYieldUntil` path); the async-provider half needs
the standalone/web smoke before Phase E is called done. For K2–K7: the retention and
peek live in shared code — only the defer-the-resolve contract must be repeated per
bridge.

**A latent break the battery rerun un-hid (NOT this retry's doing):**
`coroutine-pthread-ondemand` aborted at `missing function:
_Z23pcbjam_context_sleep_msd` on both engines. The 8/7 context-sleep commit added a
bare `extern int pcbjam_context_sleep_ms(double)` to `wasm/shims/nanosleep_yield.c`;
the test-app Makefile compiles that file with `$(CXX)` and its comment ("em++ keys
language off the .c extension") is wrong — em++ compiles it as C++, so the
declaration MANGLES, and the standalone apps do not link `context_sleep.cpp` at all.
Broken since 8/7; unnoticed because the wx battery was never rerun after that commit
(the KiCad gate was). Fix in `nanosleep_yield.c`: the declaration is now
`extern "C"`-guarded AND `__attribute__((weak))` with a null check — an app without
the scheduler shim falls back to the in-place Asyncify yield, which is exactly the
behaviour those apps pin. Lesson for the phase log: **a wx-shim commit gated only on
the KiCad suite can silently break the standalone battery — run both nets when
`wasm/shims/` changes.**

**Battery after the fix: 388 passed / 8 failed / 3 skipped — the failure set is
EXACTLY the documented pre-existing D-off landing set** (nested case-3 ×3 tests ×2
engines, `wakeup_during_transition` layout-sensitive, `modal.spec.ts:125`), with
pthread-ondemand green on both engines. The shim's resolveWait retention change is
regression-free against every modal/nested/popup wait the battery stages.

### Phase E: K2–K6 converted — the bridge set is COMPLETE (2026-08-08)

Same pattern as K1, one build, gated per-bridge then confirmed:

| bridge | file | wait kind |
|---|---|---|
| K2 footprint libs | `kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp` | `fp-lib` |
| K3 3D model fetch | `kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp` | `3d` |
| K4 STEP export | `wasm/stubs/exporter_step_stub.cpp` | `occ` |
| K5 OCE model load | `wasm/stubs/oce_plugin_stub.cpp` | `occ` |
| K6 ngspice ×2 | `wasm/stubs/sharedspice_client.cpp` | `ngspice` |

Every bridge: `beginWait` → start `EM_JS` (ALL resolutions deferred ≥ a microtask,
result marshalling moved into the resolve callback) → `wxWasmYieldUntil` → result as
the wait's int32 (pointers recovered via `(uint32_t)`). Worker/proxy paths untouched.

**Gates:** `pcbnew` + `3d-viewer-models` + `occ-export-models` + `eeschema-sim`
**8/8 in 1.8 min** — and the occ-export spec drove **17 real async provider requests
through converted K3 during a live K4 export**, which is the resolve-AFTER-park
coverage the K1 retry noted as thin (test pages resolve early; these two specs
install real providers). Full suite: **139 / 1 (pre-existing occ-probe glb) / 30 —
baseline held.** Battery not rerun: no wx or shim code changed; the stubs link only
into the KiCad apps.

**Converter-diet hardening (K1+K2):** `sym_convert` keeps `sch_io/` and
`pcb_convert` keeps `pcb_io/`, so those TUs can land in links WITHOUT the wx wasm
port. `wxWasmBeginWait`/`wxWasmYieldUntil` are declared WEAK there with a null guard
returning "request unavailable" — correct, since a converter diet can never have a
`/mnt/pcbjam` provider either. (Same class as the nanosleep lesson above.)

**Phase E remaining before it is DONE done:** the §5 assertion ("no `handleSleep`
park happens on any fiber stack — assert it") is not built, per-bridge deep-park
high-water beacons for buffer sizing are not collected, and the standalone/web smoke
with the production provider is still owed. The natural next measurement is a D-on
probe: with every bridge a token wait, the `current() != 0` inline fallback window
that D-on tolerated should now be structurally empty.

### D-on probe after the bridge set (2026-08-08) — no regressions, and the residual named

One variable (`wxWASM_STAR_DISPATCH` 0→1 on the committed tree): **KiCad 136 / 3 /
30 (+1 did-not-run, serial after the strand staging failure) — IDENTICAL to the
pre-conversion D-on state.** The 3: pre-existing occ-probe, and the two lever pins
(`timer-park-repro`, `quasimodal-strand` staging) whose staged overlap D5 removed —
the Phase F re-pin set. All four canvas-tool specs stay green; K2–K6 as token waits
cost D-on nothing.

**Beacon sweep: zero `[wx-wait]` beacons across the whole D-on suite** — no
unregistered-token resolves, no refused mark_readys. The only surviving warning
class is `overlapped-wake`/`hot-main-swap-out` (≤10 occurrences), ALL in the two
specs that deliberately stage collab entries DURING a parked board load
(`collab-load-fuzz`, `mailbox-ordering`) — and both specs PASS. That names the one
in-place park class left at D-on: **the awaited `kicadOpenFile` embind entry
parking the MAIN stack** (doc 21's entry-stack row, busy-gated). It is not a bridge
and not Phase E's scope — it is the flip's residual work (route opens through the
scheduler like everything else, or prove the guards hold under the blue-screen
repro).

Landing state: `wxWASM_STAR_DISPATCH` back to 0.

### Phase E telemetry (2026-08-08): fiber-stack park counter + per-kind high-water

Both landed inert-at-D-off, gates re-verified (battery 389/7 — a strict subset of
the documented pre-existing set, `wakeup_during_transition` happening to land green
exactly as its layout-sensitivity predicts; KiCad 139/1):

- **`inplaceParksOnFiberStack`** (shim counter + `fiberStackParks=` in the STATE
  dump, recorder line per occurrence): a FRESH in-place park that begins on a
  non-main stack, probed leaf-wise via `wxWasmProbeOnFiberStack()` (captured-bounds
  check — immune to §7 trap 2). **The flip's Phase E assertion is this counter == 0;**
  at D-off it simply measures the remaining doc-19-class exposure.
- **Per-wait-kind deep-park high-water** (`[wx-wait] high-water <kind>=<N>B` beacon
  on each new max): `wxWasmYieldUntil` copies the wait kind out pre-park (the
  resolve deletes the entry) and folds the registry's per-park live-capture sample
  (`Context::last_park_use`, set only on live samples) into a per-kind max. This is
  doc 21 §2b's buffer-sizing input, readable from any suite log.
- Measured immediately: at D-off the KiCad suite produces NO context parks from
  wxWasmYieldUntil's context path in dialog flows — spec dialogs open from DOM
  clicks dispatched inline on the main stack. The high-water instrument yields its
  data at D-on (and from queued-event flows); that is by design — it is flip
  telemetry.

### THE FLIP — LANDED (2026-08-08) ✅

`wxWASM_STAR_DISPATCH=1` permanently: dispatch contexts, context waits and star
transfers are the only runtime. Contents of the flip commit: the switch, the two
lever re-pins (below), and nothing else — every mechanism was already landed and
individually gated in the preceding increments.

**Gate 1 — KiCad suite: 138 / 2 / 30, effectively the 139/1 baseline.** The 2:
pre-existing occ-probe, plus an `ngspice-probe` bg-run streaming test that passed
4/4 on a solo rerun (parallel-load flake, the known class). **Both re-pinned lever
specs are GREEN**, including `quasimodal-strand`'s doc-19 test.

**Gate 2 — wx battery: 395 / 1 / 3 — the single red is pre-existing
`modal.spec.ts:125`.** §10's prediction ("these harnesses go green AT the flip")
held exactly: `coroutine-nested` case 3 on both engines and
`wakeup_during_transition` are green — the hot-main wake-window class is
structurally gone.

**Gate 3 — the blue screen's own repro (§6's only-proof-that-matters): 5/5 PASS.**
Freshly seeded V1d ballast project (123 MB, `e2e-mskn52sh-1/v1d-flip-mskn5akd-2`),
`REPRO_PROFILE` persistent context, 1 cold + 4 warm loads, `REPRO_ASSERT=1`:
every run settled (29–38 s), **`rootHotTotal=0` on all five, zero trap
signatures, zero aliased-wake-live, zero refusals.** Pre-v0.1.28 this recipe
killed warm loads 2–4 with 100% reproduction.

**The Phase E assertion HOLDS: `fiberStackParks=0` on every repro run** — across
five full board loads at the flip, no in-place Asyncify park ever began on a
fiber stack. `earlyWaitResolves=0` there too (the retention path is armed but a
prod-shaped load never needs it). No `[wx-wait]` high-water beacons during loads:
board-load lib requests run on the main stack (entry fallback) or on workers, so
no context ever parks under a wait during an open — consistent with the counter.

**Lever re-pins (the Phase F decision, taken at the flip as doc §10 planned):**
`timer-park-repro` and `quasimodal-strand` staging flip their overlap asserts
from "the shim observed the concurrent-park window" (>0) to **"no concurrent-park
window is observable" (==0)** — the staged overlap required the main loop's
in-place park, which D5 removed; the specs now pin the invariant the migration
exists to establish. Evidence recorded in both spec headers.

**Bounce decision (deviation from §5 Phase C's text, deliberate):** the doc-19
mainstack bounce STAYS for now. It is empirically green at the flip (strand
doc-19 passes through it), and its removal drags `mainstack.h`,
`main_stack_runner.h` and KiCad's `RunOnMainStackIfActiveTool` with it — a
separate increment with its own gate, queued for Phase F alongside the guard
deletions. Removing it inside the flip commit would have violated the
one-variable rule that every measurement in this doc is built on.

**Known-residual (named at the D-on probe, unchanged):** the awaited
`kicadOpenFile` embind entry still parks the MAIN stack in place during opens;
its overlap warnings are confined to the two specs that stage entries mid-load,
both green, and the repro proves the guards hold under real load. Candidate for
the same treatment as the bridges, or for retirement when Phase F deletes the
guards it leans on. Also noted during the repro: a cosmetic
`CanvasRenderingContext2D.arcTo: Negative radius` pageerror from the DOM
chrome's `drawRoundedRect` on warm loads — unrelated to the scheduler, worth its
own small fix.

### Phase F opens (2026-08-09): tripwire audit + the W4/W5 hole it found

**F1 — tripwire-silence audit across the flip-state logs (kicad suite, battery,
repro consoles).** SILENT at the flip: every libcontext refusal
(`jump-refused-*`, `swap-lost`, `jump-into-reclaimed`, `jump-ghost`),
`sched-divergence-*`, `hot-main-swap-out`/`jump-hot-into-main`,
`reentrant-state`, stray currData writes, `DRAIN-CAP`, `FIBER-RELEASE-RUNNING`,
`FIBER-SWAP-NONENTERABLE`, `grace-ring-evict`/`over-capacity`. FIRING, all
attributable: the races/lever harnesses (which STAGE the conditions and assert
the guards answer — spec coverage, not production paths), sched-context's own
refusal-path tests, `release-deferred` (grace-ring bookkeeping, not a guard),
one `TRANSITION-ABANDONED` (the races pump-error spec, staged) — and
`concurrent-park` in ordinary clipboard/dialogs/filedialog/print specs.

**That last class exposed a Phase E hole: W4 (clipboard quartet) + W5 (font
enumeration) were in §5 Phase E's scope ("K1–K7 and W4/W5") and were missed by
the K-table sweep. CONVERTED (F0)**: all five bridges are token waits (kinds
`clipboard`/`font`), same deferred-resolution contract, output writes in the
resolve callback. Gates: battery 395/1 (unchanged), kicad suite 139/1.

**Post-conversion attribution of the surviving `concurrent-park` firings:** the
stacks show the wx TEST HARNESS's own shell buttons doing `ccall` into
suspending exports from DOM handlers while a previous op's park is live — the
awaited-ccall ENTRY class (the `kicadOpenFile` family), not the bridges. A
bridge conversion cannot remove what an app-JS `ccall` entry does; that class
retires when the entry paths are routed through the scheduler or when the
harness pages stop calling suspending exports directly.

**Phase F consequence for the deletion list:** the interlock and the shim's
capture/restore machinery are NOT deletable yet — the ccall-entry class still
exercises them (and the specs prove they hold). Deletable-on-evidence:
libcontext's refusal thicket and the epochs/quarantine whose beacons are silent
— BUT several are load-bearing for the races/lever specs that assert them, so
each deletion must flip its spec in the same commit (the
`fiber-resume-park` red→green flip is the template). That is the next Phase F
increment after the bounce removal.

### Prod-provider smoke (2026-08-08) — done, with one pre-existing red bisected

Against the live web stack (playwright-web config, reference backend :3060):

- **`symedit-from-eeschema` PASSED** — the symbol-editor-from-eeschema flow drives
  converted K1 (`list`/`get`) through the REAL provider end-to-end, resolve-after-
  park included. Together with the kicad suite's `3d-viewer-models` +
  `occ-export-models` (real providers over converted K3/K4/K5, 17 live async
  requests during an export), the async-provider half of the bridge set is
  exercised.
- `eeschema-fp-selector` self-skips; `symbol-write-remote` / `footprint-browse-
  remote` are `test.fixme` (documented editor lib-bridge rot, pre-dating this
  work).
- **`eeschema-assign-footprints` fails — and a BISECT proves it pre-existing:** the
  fp `list bodies` call is issued but never settles, and the same failure
  reproduces byte-for-byte with kicad checked out at the K1-only commit (K2/K3
  still `EM_ASYNC_JS`). Provider/backend-side non-settlement in the CvPcb flow,
  adjacent to the documented lib-bridge rot — NOT a Phase E regression. Left red;
  belongs to the web-e2e-rot pile, not this migration.

1. **pthreads.** Doc 21 §2 settled that every Asyncify park is main-thread and the lib
   bridge's worker path is a blocking proxy. Phase A must re-check that libcontext is never
   driven from a worker before assuming the scheduler is main-thread-only.
2. **Buffer sizing.** Still unmeasured for real park sites (§5 Phase E). libcontext's 512 K
   is inherited, D1's 128 K is a guess with a synthetic floor behind it.
3. **D5 (main loop as a context)** stays optional. The 68/1 class is currently held closed
   by v0.1.28's scheduling trick; decide with Phase E's telemetry in hand, not before.
4. **Does Phase B change upstream-divergence policy?** It touches `coroutine.h` and
   `tool_manager.cpp` structurally. Worth deciding up front whether that divergence is
   acceptable or whether the adapter should stay entirely inside libcontext.
