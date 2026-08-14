# Native wasm-EH × pthreads — findings and test coverage

> **Status:** native wasm-EH (`-fwasm-exceptions`) is the **default build**; the pthread test suite is
> green in Firefox + Chrome. Authored 2026-06-24, updated 2026-06-25. The exception-handling-side
> companion to the mechanism-deep [`../threading/README.md`](../threading/README.md) (the 3-layer
> thread model, the deadlock mechanics, the three failure modes). **Scope:** what native wasm-EH does
> to pthreads, and the test coverage that proves which patterns work.

## Why this exists

KiCad-WASM uses native WebAssembly exceptions instead of Emscripten JS exceptions for the bundle-size
win (pcbnew ~64.5 → ~36 MB gz). **Native-EH is the default build** — `build-wx-wasm.sh`,
`build-wasm-test.sh`, and `tests/apps/Makefile.wasm` compile `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm
-sWASM_LEGACY_EXCEPTIONS=1` (single-sourced from `scripts/common/env.sh`). It is the only build mode —
the legacy `-fexceptions` path has been removed. CI builds native. The threading question this doc answers: which pthread patterns work under native-EH, what is
the one exception-related risk it removes, and what is the (optional) upstreamable follow-up.

## TL;DR

- **Native-EH wx suite: green** in Firefox + Chrome (316 / 1 skipped / 0 failed, chromium — matching
  JS-EH). WebKit is blocked for *all* pthread apps by a separate, pre-existing COEP worker-load
  limitation (§2a), so the pthread specs run FF + Chrome.
- **The one native-EH-relevant risk is mode-c** — a C++ exception thrown on a pthread worker. Under
  `-fexceptions` the throw drives Asyncify on the worker and crashes (`"func is not a function"`);
  native-EH lowers exceptions to native wasm instructions, so a throwing worker task is safe. Every
  threading pattern below is green under native-EH; the throwing ones are green **only** under native-EH.
- **The real `BS::thread_pool` runs 16-core under native-EH**, including a task that throws on a worker
  (`threadpool-real`, §6) — the decisive proof that the `detach_task` single-thread shim can be dropped.
- **On-demand (non-warm) Worker creation works without editing KiCad** (`pthread-ondemand`, §6): the
  `nanosleep` override (§2b) makes a main-thread `sleep_for` join Asyncify-yield, so the event loop
  services the new-Worker handshake. This is the threading-doc **mode-(a) deadlock** cure, in the wasm
  layer.
- **A nested `emscripten_sleep` is legal** (§3): code dispatched by a wx modal pump's `ProcessEvents`
  runs at Asyncify `state == Normal`, so a worker-join that yields via `emscripten_sleep` inside an
  open modal suspends-and-resumes normally (`raytrace-modal`, §6). The threading-doc **mode-(b)** does
  **not** arise for this case, so no JS-land scheduler ("Design B") is needed for it.
- **The KiCad-10 `std::async` library preload is safe under native-EH** (`async-preload`, §6/§7): the
  worker parses S-expr (a throw = mode-c) and proxies its async fetch to main; native-EH makes the
  parse safe and the lazy join keeps main free to service the proxy.
- **The fork stays pristine.** The pool's `detach_task` shim is the original, unmodified KiCad code;
  the tests un-shim it via a build-generated header (§6/§D), so the KiCad submodule carries no
  wasm-specific change. The later, *optional* upstreamable step is the raw-threads→pool refactor (§4).

---

## 1. Suite status under native-EH

The native-EH wx app suite is **316 / 1 skipped / 0 failed** (chromium), matching JS-EH. Reaching it
required two things: clearing a set of build-pipeline gaps that surfaced as native-EH test failures
(committed this session, summarized below), and the §2 asyncify-imports fix for the raytracer cluster.

The build-pipeline gaps (all committed):

- **Post-link Asyncify find too narrow** — the loop matched only `standalone/*/*_test.wasm`, silently
  skipping `apps/minimal_test.wasm` and the coroutine-pthread repros / wxpt. Those linked but were
  never asyncify-instrumented → `asyncify_start_unwind not found`. Broadened to all freshly-linked app
  wasm.
- **Repro apps mixed EH models** — the coroutine-pthread `*_repro` apps hardcoded JS-EH in their link
  recipes while their compile inherited native-EH → `undefined symbol: __cpp_exception`. Made them
  EH-aware so they follow the default (native) and only carry `-fexceptions` under `WX_LEGACY_EH`.
- **`build-wasm-test.sh` swallowed make failures** — it continued to the post-link after a failed
  make, leaving apps half-instrumented (read as mass test failures). Now aborts loudly.

After those, the only real native-EH-specific signal was the raytracer threading cluster, fixed in §2.

---

## 2. The asyncify-imports fix (`emscripten_sleep`)

`coroutine-raytrace.spec.ts` aborted with `Aborted(invalid state: 1)`. The mechanism:

- `invalid state: 1` is `Asyncify.handleSleep` aborting because the state is **Unwinding** — a second
  suspend starting before the first rewinds. Logging every `handleSleep`, the state sequence at the
  abort is exactly **`0,1`**: two `emscripten_sleep`s back-to-back with **no rewind between**. So a
  function calls `emscripten_sleep`, the unwind arms (state→Unwinding), and the **same function calls
  `emscripten_sleep` again before returning**. A correctly Asyncify-instrumented function has a
  post-call "if Unwinding, save locals and return" check after every suspend point; this one doesn't →
  **Asyncify never instrumented it.**
- `main()` is **not** re-entered (a `[MAINCALL]` probe fired exactly once; the abort stack only *shows*
  `main`'s frames because Asyncify's unwind/rewind runs inside a `setTimeout`-driven `doRewind` that
  keeps the JS stack live).
- **Why un-instrumented:** binaryen's Asyncify instruments only functions that can reach a *listed*
  async import. The post-link list was curated for the wx apps, which yield via **fibers**
  (`startModal, js_*, invoke_*, __asyncjs__*, emscripten_fiber_swap`). It **omitted `emscripten_sleep`**,
  which the raytracer yields via. `env.emscripten_sleep` *is* a wasm import, so binaryen can match it —
  it just wasn't told to.

### The exact JS-EH ↔ native-EH difference

Under **JS-EH**, Asyncify runs **in-link** and emcc **auto-adds** `emscripten_sleep` (+
`idb_*`/`wget`/`scan_registers`/`lazy_load`) to the imports. Under **native-EH** we run Asyncify
**post-link by hand**, with an explicit list that dropped those auto-imports. That is the entire
difference — not a fundamental native-EH × pthread incompatibility, and not a handleSleep-vs-arbiter
question (the `currData` shim was never involved).

### The fix

Added `env.emscripten_sleep` (+ `scan_registers`, `lazy_load_code`, `wget`, `wget_data`, `idb_*`) to
the post-link asyncify-imports — now the shared **`scripts/common/asyncify-imports.txt`**, consumed by
the unified **`apply-asyncify.sh`** that both the wx-test and KiCad builds call (the two near-duplicate
scripts were folded into one; the old `hoist-and-asyncify.sh` is gone). So the KiCad list gets
`emscripten_sleep` too, pre-empting the identical latent bug when its threading is un-shimmed.

| Check | Result |
|---|---|
| Full wx suite, Chromium | **316 / 1 skipped / 0 failed** |
| `coroutine-raytrace.spec.ts` — all 6 (B1/B2/B1-local/B3 + speedup + A neg-control) | **6/6 pass** |
| multi-core speedup | **serial 1342 ms → parallel 142 ms = 9.45× on 16 cores** |
| raytrace `#m=5` default (drains pool → on-demand creation) / `#m=1`, Chromium + Firefox | **SUCCESS, workersRan=16** |

The default `m=5` — which *drains* the pre-warmed pool and forces on-demand Worker creation —
succeeds, so the fix also resolves the threading-doc **mode-(a) deadlock**: the `sleep_for` join now
yields via an instrumented `emscripten_sleep` instead of busy-spinning and starving the worker
handshake.

### 2a. The WebKit issue (separate, pre-existing)

In WebKit the asyncify side runs (threads spawn) but the **pthread worker `.js` load is refused on
COEP** (`Refused to load worker because of Cross-Origin-Embedder-Policy`) even with COOP + COEP + CORP
all served and `crossOriginIsolated:true`. It is a WebKit/playwright-headless COEP-worker strictness
issue affecting **all** pthread apps, unrelated to EH. Tracked separately; the pthread specs run
FF + Chrome only.

### 2b. The `nanosleep` override (the on-demand cure)

`wasm/shims/nanosleep_yield.c` is a **strong `nanosleep` definition** that shadows musl's archive
member (`-Wl,--wrap=nanosleep` is not usable — it segfaults wasm-ld in
`lld::wasm::ImportSection::addImport`). On the **main thread** it yields via an `EM_ASYNC_JS` await
(= `emscripten_sleep` semantics, already in the post-link asyncify-imports); on a **worker** it stays a
real blocking `emscripten_thread_sleep`. So an *unmodified* KiCad `sleep_for` join on the main thread
pumps the event loop instead of busy-spinning, which lets on-demand Worker creation complete with no
KiCad edit (§6 `pthread-ondemand`).

---

## 3. Patterns that work — pool-vs-raw, and the nested-sleep case

Two earlier wx apps, plus the §6 additions:

| App / test | Thread pattern | native-EH |
|---|---|---|
| `threadpool_test.cpp` (`threadpool.spec.ts`) | create `hwc` `std::thread`s into the **pre-warmed** pool, short body, **`join()`** each | **PASS** |
| `raytrace_threads_test.cpp` (`coroutine-raytrace.spec.ts`) | raw detached/persistent `std::thread`, sleep/busy-wait join, default **drains** the pool → on-demand creation | **PASS** (after §2) |

Both raw and pool patterns work under native-EH; raw threads are **not** fundamentally broken. The
`threadpool` create-and-`join()` never calls `emscripten_sleep`, so it never tripped the missing
import; the raytracer yields via `emscripten_sleep`, so it did — which §2 closed.

**The nested-sleep case (mode-b is not a live blocker).** A worker-join that yields via
`emscripten_sleep` *inside an open `ShowModal` dialog* is legal. The modal pump runs `ProcessEvents`
via `ccall(async:true)`, so work it dispatches runs in a **fresh managed Asyncify entry at
`state == Normal`** — not nested inside an already-Unwinding frame. So the inner `emscripten_sleep`
suspends-and-resumes normally. `raytrace-modal` (§6) probes and logs `Asyncify.state == 0` to confirm
this; the threading-doc mode-(b) "Asyncify can't nest" only bites a *genuine* second unwind, which the
modal pump does not produce. **No JS-land scheduler ("Design B") is required for the "render inside a
modal" case.**

---

## 4. Optional follow-up (upstreamable): KiCad raw-threads → the pool

This is a *later, optional* cleanup — not required, since the wasm layer (native-EH + the nanosleep
override) already makes the threading patterns work on pristine KiCad. Per
[`../threading` §8](../threading/README.md), upstream KiCad has migrated only **1 of 7** raytracer
parallel sections to `GetKiCadThreadPool()` (`renderTracing`, and that one accidentally); the other six
are untouched **2018 OpenMP-translation** raw-thread code:

| Site | Pass | Today |
|---|---|---|
| `render_3d_raytrace_base.cpp:764` `shadeWorker` | post-process shading | raw `std::thread` + busy-wait, `#ifdef`'d serial in WASM |
| `render_3d_raytrace_base.cpp:835` `blurWorker` | blur/finish | same |
| `render_3d_raytrace_base.cpp:1456` `previewWorker` | preview | same |
| `image.cpp:525` `filterWorker` | `EfxFilter` AA/blur | same |
| `create_layer_items.cpp:848` `zoneWorker` | zone-fill geometry | same |
| `create_layer_items.cpp:1311` `simplifyWorker` | polygon simplify | same |

**The refactor = migrate these six to `submit_task()` + `multi_future::wait()`** (the `renderTracing`
shape, refined by upstream `bccf36538` to wait on *own* tasks only), and delete the
`#ifdef __EMSCRIPTEN__` serial fallbacks. Why it is the right *eventual* move:

- **Upstreamable, not a wasm hack** — precedent in the same file, a filed upstream issue
  ([GitLab #20911](https://gitlab.com/kicad/code/kicad/-/issues/20911), "ray tracing high system
  load"), and it removes dead OpenMP-era code. If accepted upstream, our fork carries **zero**
  divergence here.
- **Less divergence, not more** — it lets us drop the raytracer `#ifdef`s; combined with native-EH
  letting us drop the `detach_task` shim, net fork divergence goes *down* while threads come *on*.

Its prerequisite — that the real `BS::thread_pool` (persistent workers + `submit_task` +
`multi_future::wait()`) survives native-EH — **is proven** by §6 `threadpool-real` (16-core, including
a throwing worker task). So the refactor is de-risked; it is scheduled **after** the EH port's suite is
otherwise green, and remains optional because the wasm-layer fixes already deliver multi-core.

---

## 5. The 3D viewer

The 3D viewer is **live and single-threaded**: the raytracer's six raw-thread passes are `#ifdef`'d to
serial fallbacks in WASM, which is what ships. A separate multi-threaded spike exists (the
`WASM_RAYTRACE_POOL` work, ~6–7×) but is not the active path.

Two zero-KiCad-edit routes turn the live viewer multi-threaded:

- **The nanosleep override (§2b)** makes the existing `sleep_for` joins yield, so the raw-thread passes
  run multi-core without on-demand-creation deadlock and without main-thread jank — no KiCad change.
- **The §4 pool refactor** is the *upstream-clean* alternative: pool-based, drops the `#ifdef`s, and
  carries zero fork divergence if accepted upstream.

---

## 6. pthread test coverage

All four apps below compile the **real KiCad** thread-pool source and run on **pristine** KiCad/wx-core.
The specs are named `coroutine-*` so the merged config's `coroutine-firefox` / `coroutine-chrome`
projects (testMatch `/coroutine.*\.spec\.ts$/`) run them in Firefox + Chrome (WebKit excluded — §2a).

| Spec | App | What it proves | native-EH |
|---|---|---|---|
| `coroutine-threadpool-real.spec.ts` | `threadpool-real` | the **real `GetKiCadThreadPool()`** in every mode — submit / loop / blocks / detach / fanout / lifecycle, and a task that **throws** on a worker — 16-core, throw caught | **PASS** (throw mode green *only* under native-EH = mode-c) |
| `coroutine-pthread-ondemand.spec.ts` | `pthread-ondemand` | real pool drains the pre-warmed Workers, then raw fly-threads force **on-demand** creation; the nanosleep override yields the join → on-demand Workers boot → multi-core (control: a non-yielding busy-wait deadlocks) | **PASS** |
| `coroutine-raytrace-modal.spec.ts` | `raytrace-modal` | a worker-join run **inside an open `ShowModal`** — both a busy-wait join and an `emscripten_sleep` yield-join complete multi-core; the app probes `Asyncify.state == 0` to show the modal pump dispatches at Normal | **PASS** (mode-b does not arise) |
| `coroutine-async-preload.spec.ts` | `async-preload` | the KiCad-10 `std::async` library-preload shape: a worker parses S-expr (throws = mode-c) and proxies its fetch to main via `emscripten_proxy_sync_with_ctx`; modes simple / throw / shutdown / modal-during-preload | **PASS** (mode-c safe; 36 proxy round-trips through a modal, no crash) |

These also cover the older `coroutine-pthread.spec.ts` (fiber + pthread across activation paths) and
`threadpool.spec.ts` (raw create+join), both green. Together they exercise: the real pool API, raw
create+join, raw detached/persistent + sleep/busy-wait, on-demand creation, a worker-side throw, a
nested yield inside a modal, and a proxied async fetch off a worker — the full set of shapes the KiCad
threading uses.

### D. How the tests un-shim the pool without editing KiCad

KiCad's `bs_thread_pool.hpp` keeps its original `#ifdef __EMSCRIPTEN__` `detach_task` shim (which runs
pool tasks inline → single-threaded). To exercise the *real* pool, the test build **generates** an
un-shimmed copy: `tests/apps/Makefile.wasm`'s `POOL_UNSHIMMED` rule `sed`s `#ifdef __EMSCRIPTEN__` →
`#if 0` into `standalone/_pool_unshimmed/bs_thread_pool.hpp` (gitignored) and `-I`'s it ahead of the
KiCad header. So the KiCad submodule stays pristine; only the test compile sees the un-shimmed pool.

---

## 7. Library preload: `std::async` + the PCBJAM proxy under native-EH (the KiCad-10 bump)

> The path that turns the native-EH migration from a size win into a **prerequisite for tracking
> upstream**. Verified by `async-preload` (§6): works under native-EH.

**What changed upstream.** KiCad 10 (`d8ae50a667`, 2026-06-08, fixes GitLab #23872) (a) added an
*eager* library preload on board open — `if( Kiface().IsSingle() ) Kiface().PreloadLibraries()` in
`pcbnew/files.cpp` (`OpenProjectFiles`), and `IsSingle()` is exactly our standalone-webapp case; and
(b) changed `IFACE::PreloadLibraries`'s dispatch from `tp.submit_task( preload )` (our base,
`pcbnew/pcbnew.cpp:666`) to `std::async( std::launch::async, preload )` (KiCad-10 `pcbnew.cpp` ~1121).
**`std::async` spawns a real pthread worker that the `detach_task` pool shim does not cover** — the
shim only neutralizes the *pool*.

**The plugin gotcha (don't be fooled by the upstream loader).** Upstream library reads are synchronous
(`KICAD_SEXPR` plugin → `fopen`/`FILE_LINE_READER`). **Our fork is not on that path.** The webapp
writes the lib-table rows as `(type "PCBJAM")` / `(type "PCBJAM_FP")`
(`web/standalone/src/wasm/libs/source.ts:124,143`), so the runtime plugin is our **custom async bridge**
(`kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp`, `kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp`).
A surface read of the upstream loader will wrongly conclude "pure sync, safe" — **verify by the
lib-table row `type`, not the generic plugin.** The PCBJAM dispatch is dual-path
(`sch_io_pcbjam_lib.cpp:158`):

```cpp
if( emscripten_is_main_runtime_thread() )
    return pcbjam_libs_request_js(...);           // main: EM_ASYNC_JS → Asyncify suspend (works on main)
std::lock_guard lk( g_pcbjamProxyMutex );         // worker: serialize, then
emscripten_proxy_sync_with_ctx( queue, main, … ); // proxy the fetch to MAIN + futex-block the worker
```

**The two-level architecture (and how the pool shim warps it).**
- **Outer:** `std::async(preload)` = one real background worker running a watchdog loop
  (`sleep_for(150ms)` + poll `AsyncLoadProgress()`). Bypasses the shim.
- **Inner:** `adapter->AsyncLoad()` (`FOOTPRINT_LIBRARY_ADAPTER`) `submit_task`s N enumerate jobs to
  the pool → caught by the shim → run inline → so in our fork they execute *serially on the outer
  worker*. (Inner parallelism returns once the shim is dropped — also native-EH-gated.)

**What runs where, on the `std::async` worker:**

| Step | Suspends Asyncify on the worker? |
|---|---|
| `sleep_for(150ms)` watchdog | **No** — real worker sleep (`nanosleep`/Atomics.wait), not `emscripten_sleep`. |
| PCBJAM fetch of library bytes | **No** — proxied to main + futex-block; the `EM_ASYNC_JS` runs on *main*. |
| S-expr **parse** of the bytes (throws `IO_ERROR`) | **Yes under `-fexceptions`** → mode-c crash. **No under native-EH.** |
| modals / clipboard / fonts | Not reachable from non-UI parsing. |

**The join is lazy — which defuses the deadlock.** There is **no eager `.get()`**: `CancelPreload(true)`
calls `m_libraryPreloadReturn.wait()` but has **no callers**; `ProjectChanged()` only sets the abort
flag; the `std::async` future's **blocking destructor** fires only on **IFACE teardown** (shutdown,
main thread); and re-entry is guarded by `m_libraryPreloadInProgress` (so the future is never
*reassigned* mid-flight). So in normal operation **main never blocks on the preload future** → it stays
in its event loop → it services the PCBJAM proxy queue → the worker's fetches complete. No
normal-operation deadlock.

**Verified.** `async-preload` (§6) runs this shape under native-EH: the worker parse throws and is
caught (no mode-c crash), the proxy round-trips, and a modal opened during preload survives 36 proxy
round-trips with no crash (the `g_pcbjamProxyMutex` / "table index out of bounds" reentrancy hazard
does not fire). So the **KiCad-10 bump can keep `std::async` as-is under native-EH** — it does **not**
need a fork patch reverting to `tp.submit_task` (which would make preload block board-open on the main
thread). Residual: a real-shutdown ordering check (the blocking destructor while a load is in flight)
is covered by the `async-preload` shutdown mode but not yet under a live IFACE teardown.

**Contrast with the raytracer (§4):** the raytracer's raw threads are legacy OpenMP-era and
upstreamable to the pool. This `std::async` is a **deliberate** upstream choice (a dedicated preload
thread, off the compute pool), so "upstream it to the pool" is **not** the play — native-EH is.

---

## 8. Next steps (ordered)

1. **DONE — `coroutine-raytrace` root-caused and fixed (§2):** the post-link asyncify-imports list
   omitted `emscripten_sleep`. Suite 316/0; raytracer multi-core (9.45×).
2. **DONE — pthread coverage closed (§6):** the real-pool, on-demand, modal-nested, and `std::async`
   library-preload shapes are all green under native-EH on pristine KiCad/wx-core.
3. **Drop the `detach_task` shim for real** — `threadpool-real` proves the pool survives native-EH, so
   the next concrete step is enabling the un-shimmed pool in a KiCad build (DRC / zone-fill /
   connectivity on real Workers) and validating the docker build (the shared asyncify-imports change is
   untested there).
4. **Resolve the §2a WebKit COEP worker-load limitation** for pthread apps (currently the reason the
   pthread specs skip WebKit).
5. **Optional, later — the §4 refactor:** migrate the six raw-thread raytracer sections to the pool,
   delete the `#ifdef`s, upstream it.
6. **Track-only:** `PROXY_TO_PTHREAD` (DOM-bound GUI can't leave the main thread) and JSPI
   (incompatible with our main-loop architecture) — see [`../threading` §6–7](../threading/README.md).

## Cross-references

- [`../threading/README.md`](../threading/README.md) — the 3-layer model, deadlock mechanics, three
  failure modes, the full raw-thread inventory, and the upstream pool-migration analysis.
- [`../async/11-asyncify-nesting-raytracer.md`](../async/11-asyncify-nesting-raytracer.md),
  [`../async/12`](../async/12-design-b-asyncify-implementation-plan.md),
  [`../async/13`](../async/13-design-b-engineering-spec.md) — Asyncify nesting + the Design B scheduler
  (not required for the modal-pump case, §3).
- Apps + specs: `tests/apps/standalone/{threadpool-real,pthread-ondemand,raytrace-modal,async-preload,coroutine-pthread,threadpool,raytrace-threads}/`,
  `tests/e2e/coroutine-{threadpool-real,pthread-ondemand,raytrace-modal,async-preload,pthread,raytrace}.spec.ts`,
  `tests/e2e/threadpool.spec.ts`; the pool un-shim in `tests/apps/Makefile.wasm` (`POOL_UNSHIMMED`),
  the on-demand cure in `wasm/shims/nanosleep_yield.c`.
- **Library preload (§7):** `kicad/pcbnew/pcbnew.cpp:593` (`PreloadLibraries`),
  `kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp` +
  `kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp` (the async PCBJAM IO plugins),
  `web/standalone/src/wasm/libs/source.ts` (lib-table rows typed `PCBJAM`/`PCBJAM_FP`); upstream
  KiCad-10 `std::async` change `d8ae50a667` (GitLab #23872).
