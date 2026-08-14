# 23 — The JSPI runtime (current architecture)

Status: 2026-08-14 · CURRENT · supersedes the TL;DR of this directory's
README ("we are not switching to JSPI" — we did, 2026-08) ·
lineage: 21 (park-site audit = the migration surface), 22 (the absorb plan
this replaced: one owner for every switch — JSPI delivered that owner as the
engine itself), doc 15 (stale-resume refusal), doc 18 (embind mutator/parker
classification).

This is the reference for how suspension works **now**. The numbered docs
01–22 are the Asyncify-era investigation log; read them as history.

## 1. The shape of the runtime

Every wasm entry point that can suspend is a **promising export**. A
suspension inside one is a plain `await` in an imported JS function: the
engine parks that activation's native stack and returns a Promise to the JS
caller. No instrumentation pass, no unwind/rewind state machine, no shared
suspension register — the failure family the 01–22 docs fought (two
subsystems clobbering one `currData`) is unrepresentable.

What JSPI does **not** solve, and the two shims do:

- **The C spill stack is not switched per activation** (emscripten #27364).
  Both shims apply the "green-region" discipline proven red/green by
  `tests/apps/standalone/jspi-stack`: every activation gets its own spill
  region and the shared `__stack_pointer` is swapped only at window
  boundaries.
- **Engine re-entries are not serialized.** The scheduler's resume
  turnstile (§3) makes them so.

## 2. The promising-export census — three synchronized copies

The set of promising exports is declared in THREE places that must stay in
sync (a name missing from one produces a SuspendError at runtime, not a
build error — see `docs/debugging/DEBUG.md` §3):

| copy | consumer |
|---|---|
| `scripts/common/jspi-exports.txt` | `-sJSPI_EXPORTS=@…` at link (`build-kicad-target.sh`) |
| `jspi-scheduler.js` `installExportWraps([...])` | activation tracking + spill regions for the same names |
| `tests/apps/Makefile.wasm` `WX_JSPI_EXPORTS` | the wx test apps + races/coroutine harness links |

The census is the wx KEEPALIVE entries that can park (`wx_dom_event`,
`wx_dom_mouse`, `wx_window_*`, `ProcessEvents`, the three ticks), `main`,
and `pcbjam_libctx_entry` (the coroutine entry export). Regenerate by grep,
not from memory. The embind parkers (§5) are a fourth surface but carry
their own declaration (`emscripten::async()`), not a census entry.

## 3. The scheduler/turnstile contract (`jspi-scheduler.js`)

**Windows.** A promising export's execution is a sequence of windows: the
FIRST window runs synchronously from its JS caller (a real JS frame, tracked
by `_actStack` push/pop), each RESUMED window is entered by the engine from
a promise reaction (no JS frame of ours — tracked by `_windowLive`). The
wasm executing at any moment belongs to `_actStack`'s top when non-empty,
else `_windowLive`.

**Suspension records.** Every park lands in `_suspended` (id → record with
`kind`, `waitKind`, `token`, `sp`, `suspendedAt`). Wait kinds: the wx token
waits (`modal`, `nested`, `clipboard`, `font`), the KiCad lib bridge (`lib`,
`fp-lib`), the shim's own yields (`frame`, `sleep`, `promise`), and the
coroutine hooks (`libctx-enter` = an enterer awaiting a yield, `libctx` = a
coroutine parked on its own yield). `__wxWaitDump()` is a live view of all
of it.

**Resume turnstile.** SP swaps happen only at microtask boundaries and for
at most ONE activation between wasm re-entries. Ready resumes queue in
`_resumeReady`; `_pumpResume` arms exactly one (SP → its region, record →
`_windowLive`) and resolves its gate; the engine's re-entry is the only
reaction on that gate. The next pump runs when that window ends — its next
suspension or its completion, both observed. A window stuck armed >2 s while
resumes queue is force-cleared with a beacon (a suspension bypassed the
shim).

**Mutator FIFO.** The doc-18 mutator class (`kicadCollabApply`, saves, theme
flips, …) must not enter wasm while a board load is in flight — the open
activation is suspended mid-load and a mutator entering between its parks
would mutate the board under it. The wrap queues them while
`kicadOpenFileBusy()` is true and drains the FIFO in order, time-boxed,
once it clears. Semantic exclusion; nothing engine-specific about it.

**Mailbox lane.** Timer/wheel callbacks queue via `enqueueAfter` and are
delivered in order from a fresh task through the `_wxWasmMailboxTick`
promising export; a suspension inside a delivered handler parks the tick's
own activation. A throwing handler triggers containment: `wx_dispatch_abandon`
plus resolution of the top `nested`/`modal` waits, so a parked quasi-modal
is never left unresolvable.

## 4. libcontext: ownership, refusal, quarantine

The KiCad coroutine backend (`kicad/thirdparty/libcontext/libcontext.cpp`,
wasm32 platform) runs each coroutine as ONE promising activation with a
promise pair per switch (`yielded` / `resume`). Records are tombstones —
never freed, ~48 B, censused — so every stale-handle path is refused
loudly instead of corrupting memory.

**Ownership rule.** A `COROUTINE` owns exactly one record: `m_callee.ctx`.
`m_caller.ctx` is BORROWED — written by `jump_fcontext`'s symmetric
protocol, it names whoever entered you (or the root). The **2026-08-13
phantom-release bug**: `~CALL_CONTEXT` released the borrowed caller handle;
under the fiber backend that was survivable, under JSPI it killed a LIVE
coroutine's record mid-slice (the "dead tools" bug — every tool dead after
one dialog). Fixed twice over in `db81985`: the destructor releases only
what it owns, and the backend REFUSES release of a running record or of any
record on the current enterer chain (censused as
`release-of-running-ignored`).

**Refusal sentinel.** A refused transition returns a pointer to a static
INVOCATION_ARGS-shaped sentinel (`FROM_ROUTINE`, null destination/context) —
**never raw −1**. `coroutine.h` dereferences jump returns unconditionally,
and a live coroutine CAN legitimately observe a refusal (a nested-dispatch
partner dying mid-flight); the old "unreachable" premise was disproven by a
boot-time OOB. The doc-15 stale-resume contract also survives translation:
`js_libctx_resume` refuses to resume a coroutine parked on a FOREIGN wait
(its turnstile record's `waitKind` isn't `libctx`) — the legitimate wake is
that wait's own resolution — ringing `libctxRefusedResume`.

**Quarantine / destroy-while-parked.** Releasing a coroutine parked
mid-body marks the record dead, bumps `deadParked`, drops its turnstile
record, and hands a parked enterer the sentinel so it un-hangs. A late wake
for a quarantined record is dropped by the pump (never re-enter a freed
body); a stray jump at the corpse gets the sentinel; double release is
idempotent. Contained: the rest of the world keeps scheduling.

## 5. Embind call shapes (the delivery-mechanics table)

How a JS→wasm call may interact with suspension is decided at registration:

| shape | suspension | semantics |
|---|---|---|
| plain embind `function(...)` | **must not suspend** | first park throws SuspendError (strict on Firefox ≥153) |
| `emscripten::async()` (bare) | legal | **rerun hazard**: embind re-executes the invoker when the awaited promise settles — observed during the migration as the triple-poke (one `kicadTestFiberParkPoke()` call landing three body executions). Use only for idempotent bodies, or don't. |
| raw KEEPALIVE export in the JSPI census | legal | one-shot: the body runs once per call, the call returns the activation's promise — the wx entry points' shape |
| `PCBJAM_PARKER_POLICY` + scheduler parker wrap | legal | `async()` under the hood, plus activation tracking, an 8 MB spill region (board parses are deep), and turnstile serialization — `kicadOpenFile` / `kicadOpenFiles` / `kicadLibsReload` |

This table is why the `kicadTestFiberPark*` levers stayed sync-registered:
neither legal shape can deliver a *mid-park* poke (the parker wrap would
defer it — the exact race the levers exist to stage). They are manual
Chromium-only probes; their contracts are pinned by the §6 battery instead.

## 6. The coroutine contract battery (18 cases)

`tests/apps/standalone/jspi-coroutine/coroutine_jspi_test.cpp` — a wx-free
MiniCoro mirroring `tool/coroutine.h`'s protocol exactly over the real
libcontext. Node + browser, single-thread + pthread builds
(`tests/jspi/jspi-coroutine.spec.ts`). What the families pin:

- **Lifecycle** (1, 7, 10, 11): entry runs the body exactly once to first
  yield; completion flips `Running()`; values round-trip; 48-yield stress.
- **Spill-stack discipline** (2, 3): locals and a 6-deep recursive frame
  survive suspension — the green-region proof at protocol level.
- **Nesting / enterer inference** (4, 5): child-in-parent routing, a parent
  yielding over a parked child — direction inferred from the enterer chain.
- **Root bounce** (6): `RunMainStack` runs the functor on the caller's
  activation and resumes with the payload (`CONTINUE_AFTER_ROOT`).
- **wasm-EH interplay** (12): yield INSIDE a `catch` block — the case the
  HoistCppCatches binaryen pass existed for, now native.
- **Dispatch shape** (13): resume driven from a JS timer through the wait
  import.
- **Reclaim + ghosts** (8, 14): finished activations release their JS slots
  and regions; a post-finish jump refuses with the SENTINEL (shape-checked).
- **Release semantics** (15, 16, 17, 18): mid-body release censused and
  never resumed; release of the RUNNING record refused (the phantom-release
  shape); release on the enterer chain refused; destroy-while-parked fully
  contained (census +1 exactly once, corpse jumps sentinel, fresh
  coroutines unaffected).

## 7. Services under emscripten 6

Emscripten 6 **removed `Module.mainScriptUrlOrBlob`**. The pthread glue now
spawns its workers from `_scriptName` = `self.location.href` — for a
blob-booted service worker that is the *wrapper blob itself*, so every
pthread child re-executes the wrapper. `occ-worker.js` / `ngspice-worker.js`
handle it with the **em-pthread realm trick**: if `globalThis.name ===
"em-pthread"`, just `importScripts(GLUE)` and get out of the way (the glue
tail self-instantiates into pthread-child mode). Without the branch the
wrapper re-boots a whole service per pthread — the observed worker-spawn
storm with the pool never filling.

**KNOWN GAP (CDN cross-origin pthreads, editor path):** `boot.ts` used to
pin the pthread worker script via `mainScriptUrlOrBlob` — same-origin URL
directly, cross-origin CDN base via a same-origin `blob:` that
`importScripts` the CDN glue (with ACAO + CORP headers). With the option
gone, the *editor's* cross-origin pthread spawn path has no equivalent pin;
same-origin serving works. Not fixed in the cleanup — tracked here.

## 8. Exception policy

- **`wxApp::OnExceptionInMainLoop`** (`wxwidgets/src/wasm/app.cpp`): a
  throwing event handler must not tear down the app. The wx default exits
  the main loop — which reads as a silent clean shutdown mid-session. The
  override logs `[wx-app] unhandled exception in event handler: …` and
  returns true: the loop lives.
- **JS-side containment**: `wx-dom.js` contains rejections escaping a
  dispatch, and both delivery lanes' error paths call
  `wx_dispatch_abandon()` + resolve the top `nested`/`modal` waits — a
  throwing handler under an open quasi-modal must not strand the parked
  modal wait (the doc-19 family under new mechanics).
- **Coroutine traps**: an entry activation that rejects prints
  `[libctx-jspi] … entry REJECTED` with the stack, and the enterer receives
  the refusal sentinel — a trapped tool body is contained, not amplified.

## 9. Known gaps & upstream issues

- **Firefox slow wasm tier** — big promising modules run slow on FF;
  observed as FootprintEnumerate rows never appearing in 60 s (remote read
  path). Upstream #42199. The firefox leg of `footprint-browse-remote` is
  gated on it.
- **Editor write bridge rot** — symbol/footprint WRITE flows wedge at the
  New Symbol/Footprint dialog on both engines (pre-dates the migration; the
  web-e2e-rot 01 gap stands). Read paths are green.
- **3D raytracer engine toggle inert** — the toolbar toggle does not engage
  the raytracer on the webgl-era wasm; pinned KNOWN-ISSUE in
  `tests/kicad/3d-viewer-deadlock.spec.ts`.

## 10. Migration evidence

- **Workflow results**: `migration-evidence/wf-result-11.json` /
  `wf-result-12.json` (the durable spike output; the rest of the
  `.jspi-assets/` spike tree was scratch and is gone — its ignore rule came
  from a global git-excludes file, not this repo's `.gitignore`).
- **The investigation log**: docs [`01`](01-background-and-findings.md)–[`22`](22-absorbing-libcontext.md)
  in this directory (Asyncify-era; historical).
- **The migration commits**: parent `3f09a46` + `e14faec` + `db81985`
  (phases 0–7, pipeline retirement, ownership fix + suite green) with
  `3ee174e` (un-skip sweep), kicad `012d95ecb4`, wxwidgets `1b5f0e31f4`;
  the JSPI-only cleanup commit followed on `experiment/jspi`.
