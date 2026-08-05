# 21 — Park-site audit (doc 20 D0 deliverable)

> **Status: AUDIT (2026-08-05).** The classification doc 20 §6 D0 calls for: every
> Asyncify park site in the tree, classified by **whose stack it suspends** — *tool
> fiber* / *entry stack* / *main loop* — with the routing decision per site. Method as
> doc 18: enumerate every `EM_ASYNC_JS` / `emscripten_sleep` primitive, follow each to
> its callers, record evidence as file:line. Inventory taken AFTER D-1 (the legacy
> twins `startModal` / `wxWasmRunNestedLoop` / the popup pump no longer exist).

## 0. Why the class matters (the doc-19 lens)

- **On-fiber parks** are the *strand class*: a tool fiber that parks mid-body trips the
  stale-fiber quarantine, and its legitimate resume can be refused → the fiber never
  completes, the dispatch guard it holds never releases, the UI freezes (doc 19 §4).
- **Entry-stack parks** are the *interlock-holder class*: the parked chain holds
  `wxWasmDispatchDepth` (or is zeroed around the park by hand), so dispatch degrades to
  Paint-only until the promise settles. Recoverable — but it is the reason the
  quarantine/consume-once guessing layer exists at all.
- **Main-loop parks** that *complete every tick* are safe by construction
  (doc 13 §6c): nothing stays suspended across a dispatch.

D1–D4 give the first two classes their own scheduler contexts; the third stays as-is
unless D5 is taken.

## 1. Inventory (14 production sites, 3 test levers)

Headline: **8 wx sites, 9 KiCad/bridge sites** (counting the clipboard quartet as 4 and
the ngspice pair as 2); after D-1 no site has a legacy twin — one code path per site.

| # | site | file:line | parks | wake source | route |
|---|---|---|---|---|---|
| W1 | `wxWasmYieldUntilJs` — the wait primitive (modal + nested quasi-modal) | wx `evtloop.cpp:175` | **fiber** (dialog opened from a tool action — the doc-19 case) or **entry** (plain handler chain) | wait-registry `resolveWait` | **D3** — context yield |
| W2 | `wxWasmYieldToBrowser` — per-frame yield | wx `evtloop.cpp:292` | **main loop**, completes every frame | rAF | safe (doc 13 §6c); scheduler-owned only if **D5** is taken |
| W3 | `wxDomPopupMenuModal` | wx `window.cpp:723` | **fiber** (canvas context menu runs inside a TOOL_MANAGER coroutine) or entry | `wxShowContextMenu` promise | **D3** — same yield as W1 (wait-shaped) |
| W4 | clipboard quartet `js_{write,read,has,clear}*Clipboard` | wx `clipbrd.cpp:38/76/120/147` | **entry or fiber** (copy/paste actions; `SetData`→`:261`, `GetData`→`:331`) | `navigator.clipboard` promise | **D4** — bridge helper |
| W5 | `js_enumerateFonts` | wx `fontenum.cpp:33` (caller `:119`) | **entry** (font enumeration in dialog/startup paths) | Local Font Access promise | **D4** |
| K1 | `pcbjam_libs_request_js` — symbol libs | `sch_io_pcbjam_lib.cpp:58` | **entry** (open flows, busy-gated) and **fiber** (lazy chooser loads; `kicadLibsReload` is fibered — doc 18 asymmetry 3) | `kicadLibs.request` promise | **D4** |
| K2 | `pcbjam_fp_libs_request_js` — footprint libs | `pcb_io_pcbjam_fp.cpp:58` | same shape as K1 (board-open inline preload; fp chooser lazy) | same | **D4** |
| K3 | `pcbjam_3d_request_js` — 3D model fetch | `pcbjam_model_fetch.cpp:51` | **entry or fiber** (3D cache `EnsureModelFile`: viewer open, raytracer prep, STEP export) | 3D provider promise | **D4** |
| K4 | `js_occExportRequest` — STEP export | `wasm/stubs/exporter_step_stub.cpp:59` | **entry** (export dialog flow) | occ-service worker promise | **D4** |
| K5 | `js_occLoadModelRequest` — OCE model load | `wasm/stubs/oce_plugin_stub.cpp:64` | **entry or fiber** (3D cache load path) | occ-service worker promise | **D4** |
| K6 | `js_ngspice_request` / `js_ngspice_get_vec` | `wasm/stubs/sharedspice_client.cpp:60/82` | **entry** (sim frame actions; `get_vec` has the known pre-existing asyncify crash) | ngspice-service worker promise | **D4** |
| K7 | `__wasm_main_thread_yield_ms` — the nanosleep shadow | `wasm/shims/nanosleep_yield.c:32` | **whatever main-thread stack calls `sleep_for`** — the "anywhere" class (raytracer join loops today) | setTimeout | **D4**, plus a caller sweep: each `sleep_for` reached on the main thread is a park site of its own |
| T1 | open-gate test park (`testParkMs` sleeps) | `wasm/bindings/{pcbnew,eeschema,pl_editor,kicad_editor}_embind.cpp` ×8 | **entry** (deliberate) | timeout | keep — stages the open-window collisions |
| T2 | timer park lever | `wasm/bindings/timer_park.h:73` | mailbox-delivered timer entry (deliberate) | timeout | keep |
| T3 | fiber park lever | `wasm/bindings/fiber_park.h:78` | **fiber mid-body (deliberate — stages exactly the doc-19 strand)** | timeout | keep; its refusal pin flips red→green at D6 |

Notes:

- W1 absorbed the legacy modal/nested/popup pumps at S4+D-1; it is now the **single**
  wait primitive — and exactly the site doc 20 §3 calls out: "API is right,
  implementation parks in place." D3 swaps its implementation for a context yield;
  nothing above it changes.
- W3 is wait-shaped but bypasses the registry (it awaits the menu promise directly).
  D3 should route it through the same context yield as W1 — either by registering a
  "popup" wait or by the D4 promise helper; decided at D3, not here.
- K1/K2's **fiber** lane is the second half of the doc-19 exposure: a chooser's lazy
  lib load parks the tool fiber that owns the chooser. Any strand fix that only covers
  W1 leaves K1/K2 able to reproduce the same freeze.
- K7 is the only site whose caller set is open-ended (anything reaching `nanosleep` on
  the main thread). The D4 gate ("no handleSleep on a fiber stack") is what turns an
  unaudited new caller from a silent hazard into a loud assertion failure.

## 2. pthread scoping (doc 20 risk 4, settled for D1)

- Every site above parks the **main browser thread's** Asyncify state only. No park
  site exists on a worker: `nanosleep_yield.c:41` branches workers to
  `emscripten_thread_sleep` (real blocking sleep — workers may block).
- The symbol-lib bridge has a second, **non-Asyncify** path for library pthreads:
  `sch_io_pcbjam_lib.cpp:112` (`pcbjam_libs_request_on_main`) proxies the request to
  the main thread via `emscripten_proxy_*` and **blocks the worker** until
  `pcbjam_libs_finish` (`:49`) releases it; a global lock (`:167-181`) serializes
  concurrent worker loads. This path never touches Asyncify and is OUT of the context
  migration's scope — but D1's scheduler must not assume "all lib loads park" either:
  a proxied load holds no context.
- Consequence for D1: contexts are a main-thread-only concept; the scheduler registry
  needs no cross-thread story. The raytracer interplay (K7) is confined to "main
  thread yields while a worker boots" — unchanged by D1–D4.

## 3. What D4's assertion must cover

"No `handleSleep` park happens inside a fiber" (doc 20 §6 D4) must trip on: W1/W3 if
D3 left a path unmigrated, W4, K1, K2, K3, K5, and any K7 caller reached from a tool
coroutine. Sites T1–T3 are exempt by name (they exist to stage parks). The assertion
belongs in the scheduler shim (it already owns `Fibers` bookkeeping and the
`__pendingSleepContexts` list), gated to dev/test builds at D4 and promoted per D6.

## 4. Red spec (the other D0 deliverable)

The doc-19 strand lands as `tests/kicad/quasimodal-strand.spec.ts`: open a schematic,
double-click a symbol → Symbol Properties (quasi-modal on a tool fiber = W1's fiber
lane), click OK → the dialog must close and dispatch must stay live. RED today by the
doc-19 mechanism; goes green at D3. Marked `test.fail()` so the battery stays runnable
while red — when D3 lands, Playwright flags "expected to fail but passed", forcing the
flip to a plain green pin.
