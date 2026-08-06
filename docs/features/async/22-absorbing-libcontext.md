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

## 10. Open questions

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
