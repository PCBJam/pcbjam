<!-- STATUS: GUARD + REGRESSION IMPLEMENTED (updated 2026-08-11).
     The temporary pre-fix control was RED with stormTurns=60. The fixed shim was GREEN with
     mainZeroSleepCalls>0, stormTurns=0, sleepTurned=1, completed=1. The broad removelist expansion remains DEFERRED:
     its call-graph evidence is from the Aug 6 editor module and must be repeated against a
     freshly rebuilt module from this branch before those optimization exclusions are applied. -->

# Nanosleep shim zero-duration guard + mimalloc contention regression

## Context

The asyncify investigation established that **memory allocation can suspend on the main thread**: emscripten's vendored mimalloc uses `sleep(0)` as its spin-wait yield (`mi_atomic_yield` fallback — wasm32-emscripten matches no arch case in `include/mimalloc/atomic.h`), and `wasm/shims/nanosleep_yield.c` unconditionally converts main-thread `nanosleep` into an Asyncify event-loop yield. Under cross-thread delayed-free contention, malloc's slow path can unwind mid-allocation — a latent reentrancy hazard that also blocks the planned allocator removelist entries (~14K-function instrumentation win).

Adversarial verification (real kicad_editor binary + emsdk 4.0.2 sources) proved: the `sleep(0)` chain is the allocator's **only** suspend path; all four mimalloc spin sites sleep constant 0; mimalloc is the module's **only zero-duration sleeper** (all other nanosleep callers are ≥1 ms constants); `std::this_thread::yield`/`sched_yield` don't route through nanosleep. Hence an `ms == 0` early return in the shim severs the path completely and affects nothing else.

**Implemented here:** (1) the zero-duration guard in the shim; (2) a standalone red/green C++ wasm test that exercises the mimalloc contention path and detects main-thread event-loop turns — RED before the fix, GREEN after.

**Deferred:** the memory-touching additions to `scripts/common/asyncify-removelist.txt`. The recorded audit remains useful evidence, but an Asyncify removelist is an assertion about the complete current call graph. Re-run the audit against the newly built editor module before applying the candidates below.

Out of scope (explicit follow-up): apply the candidate removelist only after the fresh audit, and then rebuild `kicad_editor` and run the editor/3D e2e suites. Removelist changes take effect only during the app's post-process step.

## Part 1 — shim fix (IMPLEMENTED)

**File:** `pcbjam/wasm/shims/nanosleep_yield.c`.

In `nanosleep()`: after computing `ms`, wrap the yield/sleep branch in `if (ms > 0.0)` — zero-duration requests return 0 immediately on both main thread and workers (a 0 ms blocking sleep is a no-op anyway; `sleep(0)` arrives as exactly `{0,0}` per musl, so the guard fires deterministically). Extend the header comment: mimalloc's `mi_atomic_yield` is `sleep(0)` (spin-politeness hint, must NOT become an event-loop yield mid-malloc); a zero-duration sleep never promised an event-loop turn; verified 2026-08-10 that mimalloc is the only zero-duration caller in the module.

Rebuild consequences: only binaries that link the shim — future KiCad app builds, `pthread-ondemand`, and the new test. Already-built `output/*.wasm` unchanged. (CI: touching `wasm/**` busts the testapps cache — expected.)

## Part 2 — the test (IMPLEMENTED)

### App: `tests/apps/standalone/mimalloc-storm/mimalloc_storm_test.cpp`

Plain `int main()` app (non-wx — template: `standalone/coroutine-pthread/main_repro.cpp`), pthreads + asyncify + **`-sMALLOC=mimalloc`** (used nowhere in the test tree today) + the nanosleep shim.

**Storm** (turns the nanosecond `MI_DELAYED_FREEING` windows into a hit-rate game we control):
- Main thread allocates batches of small same-size blocks (64 B → pages fill fast → full pages enter delayed-free mode; ~200k blocks ≈ ~200 full pages/round).
- W worker `std::thread`s free the previous round's blocks in tight loops (every cross-thread free of a full page runs the two-CAS `DELAYED_FREEING` bracket).
- Main concurrently churns alloc/free in the same size class and calls `mi_collect(true)` each round (`extern "C" void mi_collect(bool)` — public API, headers not on include path; reaches `_mi_heap_delayed_free_all`, the spin site).
- Bounded by ITERATION counts (no wall-clock). Early-exit once ≥50 turns observed (keeps pre-fix RED runs fast); parameters tuned empirically at the red-validation step.

**Detector** (did main return to the event loop mid-storm?):
- Test-only counters in the linked nanosleep shim record all zero-duration
  calls and the main-runtime-thread subset. The test requires a main-thread
  count above zero, so worker-only contention cannot produce a false pass.
- `EM_ASM` arms a self-re-arming `setTimeout(0)` that increments `globalThis.__stormTurns`; a synchronous C++ storm can only let it run if an Asyncify unwind happened inside. Main checks the counter via `EM_ASM_INT` every k iterations.
- Phase 2 assertion (shim's load-bearing behavior unchanged): re-arm marker, `nanosleep(5 ms)` on main → the marker MUST have run (nonzero sleeps still yield).
- Console contract (repo idiom — `EM_ASM` console.log markers, self-terminating, documented in the file header):
  - `[MIMALLOC_STORM] START threads=W blocks=B rounds=R`
  - `[MIMALLOC_STORM] SUMMARY zeroSleepCalls=Z mainZeroSleepCalls=M stormTurns=N sleepTurned=0|1 completed=1`

### Build rules: `tests/apps/Makefile.wasm`

- `LDFLAGS_MIMALLOC_STORM` modeled on `LDFLAGS_COROUTINE_PTHREAD_NOWX` (line ~875: EH_FLAGS, ALLOW_MEMORY_GROWTH, ASYNCIFY=1 + stack size, DYNCALLS, -pthread, pool=`navigator.hardwareConcurrency`, STRICT=0, no wx) **plus `-sMALLOC=mimalloc`**.
- `.o` rule for the app; `nanosleep_yield.o` reuse per the `pthread-ondemand` pattern (`Makefile.wasm:681`, compiled `-c -pthread`); `.html` rule; `.PHONY: mimalloc-storm`; `all:` accumulation line.
- No `mallinfo_stub.c` (no OCC). No new suspending import (`env.__asyncjs__*` already in `scripts/common/asyncify-imports.txt`). Post-link asyncify (`apply-asyncify.sh --no-removelist`) + dyncall injection happen automatically via `build-wasm-test.sh`'s `find -newer` fan-out — no driver-script changes.

### Spec: `tests/e2e/mimalloc-storm.spec.ts`

- Placement in `tests/e2e/` → runs under the existing `wx-chromium` project; **zero playwright-config/CI edits** and passes `lint:ci-coverage`.
- Pattern copied from `tests/e2e/coroutine-pthread.spec.ts` (the non-wx precedent): `testLogger` fixture, best-effort `tryLoadApp(...).catch(() => {})` with the documented marker comment, then `expect.poll` for the `SUMMARY` line; parse it; assert `mainZeroSleepCalls > 0`, `stormTurns === 0`, `sleepTurned === 1`, `completed === 1`, and no page errors (favicon-filtered).
- Determinism compliance: no `waitForTimeout`, no inline retries, bounded C++ iterations; the app always emits a terminal SUMMARY (self-capping), so the poll is bounded.

## Part 3 — candidate asyncify-removelist additions (DEFERRED)

The following candidates were verified against the Aug 6 `kicad_editor` module. They are not present in the current removelist. Do not copy them into production based only on the allocator regression: first repeat the whole-module call-graph audit on a fresh build of this branch and then run the editor e2e suites with the resulting binary.

The earlier adversarial verification against the Aug 6 `kicad_editor` module found all proposed families safe, conditional on the Part 1 shim guard. These were the candidate patterns (see the traps below):

```
# --- Memory-touching families (safe ONLY with the nanosleep zero-duration guard:
# --- mimalloc's mi_atomic_yield is sleep(0); with the guard, no allocation path suspends.
# --- Also conditional: no one registers mi_register_deferred_free/output/error hooks or a
# --- suspending std::new_handler (all unregistered as of 2026-08-10 audit).
std::__2::basic_string<*>*
std::__2::char_traits<*>*
std::__2::vector<*>*
std::__2::__tree*
std::__2::to_string*
std::__2::__itoa*
std::__2::__split_buffer<*>*
std::__2::__shared_ptr_emplace<*>*
std::__2::__shared_ptr_pointer<*>*
std::__2::__shared_count*
std::__2::__shared_weak_count*
std::__2::deque<*>*
std::__2::__hash_table<*>*
std::__2::map<*>*
std::__2::__list_imp<*>*
std::__2::allocator*
boost::uuids::*
operator new*
operator delete*
aligned_alloc
mi_*
_mi_*
sbrk
# Deliberately NOT std::__2::__function* — type-erased std::function invocation (operator())
# is how tool/dialog callbacks run; 111 __func::operator() bodies reach startModal/wxMilliSleep
# directly (e.g. ShowPreferences, file dialogs), so __function frames must stay instrumented.
# Container entries above are still safe: containers only touch callables via their
# clone/destroy lifecycle ops, none of which reach a suspend (verified 2026-08-10).
```

**Authoring traps (verified the hard way):**
- **Bracket balance:** Binaryen's list parser tracks `<>()[]{}` nesting — an unbalanced pattern like `std::__2::basic_string<*` **aborts the whole asyncify pass** (`Fatal: failed to parse lists`). Template patterns must close the bracket: `basic_string<*>*`.
- **Breadth anchoring:** bare `basic_string*` sweeps in `basic_string_view`/`basic_stringbuf`/`basic_stringstream` (31 extra names); the `<`-anchored form excludes them. `__tree*` deliberately includes `__tree_node_base`/iterators (verified). Bare `vector*`/`char_traits*` (no namespace) are wrong forms.

**Key evidence:** zero direct suspend paths post-guard in every family; `__tree` comparators are monomorphized (no `call_indirect` in e.g. `__find_equal` with `std::less`); container-of-`std::function` ops (e.g. TOOL_MANAGER's `deque<function<void()>>::push_back`) only touch the functor's clone/move/destroy lifecycle slot — of 12,880 `__function` lifecycle ops in the module, zero reach a suspend; all 111 suspend-reaching `__function` members are `operator()` invocation bodies (the excluded family). `boost::uuids` (KIID) seeds `mt19937` once via synchronous `getentropy` (wasi import, not asyncify-relevant).

**Measured payoff** (single-threaded verbose runs, real hoisted module):

| Run | Removelist | Instrumented | Module size |
|---|---|---|---|
| A | current file | 80,871 (74%) | 253 MB |
| B | + allocator family | 66,499 (60%) | 218 MB |
| **C** | **+ all families above** | **60,047 (55%)** | **204 MB** |

Run C is a strict subset of B (sanity: zero additions); only non-matching warnings are the 5 pre-existing OCC entries (expected — OCC absent from this app). Audit validity: this binary / emsdk 4.0.2; re-run on emsdk bump or libc++ ABI-namespace change (artifacts in `$W`: `analysis.pkl`, `logC.txt`, `runC.wasm`).

## Part 4 — recorded execution

1. Built a temporary control with the old zero-duration behavior and ran `npx playwright test --project=wx-chromium e2e/mimalloc-storm.spec.ts`. It failed as intended with `stormTurns=60`.
2. Built the same test with the guard and reran the spec. It passed with `stormTurns=0 sleepTurned=1 completed=1`.
3. `npm run lint:ci-coverage` and the repository-wide determinism guard passed. Two swallowed waits in `kicad/footprint-chooser-close.spec.ts` were converted to bounded `expect.poll` assertions so the chooser regression now fails deterministically instead of hiding a timeout.
4. Did not add the candidate removelist entries. A fresh editor-module audit and editor e2e run remain required.

## Caveats and follow-up work

- `build-wasm-test.sh` requires `build-wasm/wxwidgets/wx-config` (wx libs built) and stubs the emsdk in-link asyncify — the emsdk lives at `tools/emsdk/` (installed via `scripts/setup-emsdk.sh` if absent).
- Reference precedents: `races_test.cpp` (via `git show HEAD:...`) for Asyncify-state probing from C++ if the setTimeout detector needs corroboration; `pthread_ondemand_test.cpp` for the watchdog/marker idiom.
- Repeat the removelist source/call-graph audit against the fresh editor binary, apply only the candidates that remain non-suspending, then run the full editor and 3D e2e suites.

## Verification summary (2026-08-11)

- RED: `stormTurns=60` with the old zero-duration behavior.
- GREEN: `mainZeroSleepCalls>0 stormTurns=0 sleepTurned=1 completed=1` with the guard, on identical storm parameters.
- GREEN proves that the synchronous allocation storm completes without an event-loop yield and that a 5 ms sleep still turns the event loop for worker boot.
- The pinned Emscripten source still selects mimalloc's `sleep(0)` fallback for wasm and calls `mi_atomic_yield` from its delayed-free page paths. No application source registers mimalloc deferred-free/output/error hooks or a `std::new_handler`.
- `lint:ci-coverage` and the determinism guard pass for the complete test corpus.
- Removelist results in Part 3 are historical measurements, not changes made by this branch. Fresh-binary audit, editor rebuild, and full editor/3D e2e coverage remain follow-up work.
