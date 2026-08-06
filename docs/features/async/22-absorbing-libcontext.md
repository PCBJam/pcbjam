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

## 11. Open questions

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
