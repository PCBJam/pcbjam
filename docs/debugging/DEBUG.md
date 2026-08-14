# Debugging guide — KiCad / wxWidgets WASM (JSPI runtime)

A practical reference for debugging this project: how the JSPI runtime is
wired, the observability surfaces built into it, and the recipes that actually
work here. It is **not** a writeup of any one bug — the numbered docs under
[`docs/features/async/`](../features/async/) carry those; the current
architecture is [`23-jspi-runtime.md`](../features/async/23-jspi-runtime.md).

If you're new to this codebase, read [§1](#1-the-runtime-in-one-paragraph) and
then go straight to [§2 (observability)](#2-observability) — most questions of
the form "why is nothing happening" are answered by one `__wxWaitDump()` call.

---

## 1. The runtime, in one paragraph

Suspension is JSPI: every wasm entry point that can park is a
**promising export** (`-sJSPI` + the census in
`scripts/common/jspi-exports.txt`), and every suspension awaits a real JS
promise. One scheduler — `scripts/common/shims/jspi-scheduler.js`, shipped as
a `--pre-js` — owns the discipline around that: it wraps the promising
exports so it always knows which **activation** is executing or suspended,
gives each activation its own **spill-stack region** (JSPI switches the
native stack per activation but *not* the C spill stack — emscripten #27364),
and serializes engine re-entries through a resume **turnstile** so only one
activation's SP can be armed between wasm entries. KiCad tool coroutines run
on the JSPI backend of `kicad/thirdparty/libcontext/` (one promising
activation per coroutine, own region, promise-pair yield/resume) and
integrate with the same turnstile. There is no post-link instrumentation, no
unwind/rewind state machine, and no rewind buffer to corrupt: what used to be
"asyncify state problems" are now ordinary promise/call-shape problems.

---

## 2. Observability

### 2.1 `__wxWaitDump()` — the first thing to run

Available on any app page (and printed automatically by the SuspendError
attributor). Returns one object:

| field | meaning |
|---|---|
| `dead` | scheduler shut down (teardown seen) |
| `waitsBegun` / `waitsResolved` | token-wait registry totals (modal, nested, clipboard, lib-bridge …) |
| `earlyWaitResolves` | waits resolved before their waiter parked (legal fast path) |
| `pendingWaits` | unresolved registry entries right now |
| `runningActivations` | promising exports currently on the JS stack |
| `suspendedActivations` | array of `{id, kind, waitKind, token, suspendedMs}` — every parked activation |
| `mutatorsWrapped` / `mutatorsDelivered` / `mutatorQueueDepth` | the embind mutator FIFO (queued while `kicadOpenFileBusy`) |
| `ring` | the last 64 scheduler events (see §2.2) |

Reading it: a wedge usually shows up as an entry in `suspendedActivations`
with a large `suspendedMs` and a `waitKind`/`token` that tells you *what* it
is waiting for; cross-check `pendingWaits` and the ring. `id`s of the form
`"lc<N>"` are libcontext coroutines; negative ids are untracked/anonymous
suspensions (boot-time `main`, foreign yields).

### 2.2 Ring counting recipes

`__wxScheduler._ring` holds `[epochMs, event, a, b]` tuples (last 256; the
dump slices the last 64). Useful counts:

```js
// stale resumes refused by the doc-15 contract (a = 'lc<id>')
__wxScheduler._ring.filter(e => e[1] === 'libctxRefusedResume').length

// turnstile self-heals — should be 0 in a healthy run
__wxScheduler._ring.filter(e => e[1] === 'forceClearWindow')

// wakes dropped at quarantined (released-while-parked) coroutines
__wxScheduler._ring.filter(e => e[1] === 'deadWakeDropped')

// park/resolve balance per wait kind
__wxScheduler._ring.filter(e => e[1] === 'park').map(e => e[2])
```

Other event names you will see: `beginWait`, `resolve`, `wrapped`,
`libctxQuarantine`, `shutdown`.

### 2.3 `__libctxJspi` — the coroutine census

The libcontext JSPI backend keeps its own JS-side census:

```js
Object.keys(__libctxJspi.s).length  // live coroutine slots (promise pairs)
__libctxJspi.tops                   // id -> spill-region top (SP swap target)
__libctxJspi.ghosts                 // ghost/refused transitions, ever
__libctxJspi.deadParked             // coroutines released while parked mid-body
```

Records are tombstoned, never freed C-side, so stale handles / double
releases / ghost resumes are refused loudly instead of corrupting anything —
each refusal bumps `ghosts` and prints a beacon (§2.4).

### 2.4 Beacon vocabulary

Everything the runtime is unhappy about is announced on the console with a
stable prefix. Test helpers count these (`tests/kicad/utils/wait-beacons.ts`);
when debugging by hand, grep the captured console for the prefix.

| beacon | source | meaning |
|---|---|---|
| `[libctx-jspi] ghost/refused transition … reason=<r>` | `libcontext.cpp` | a refused coroutine transition; `reason` is one of `ghost-enter`, `yield-no-cur`, `released-while-parked`, `dead-cur-substituted`, `yield-to-dead-enterer`, `release-of-running-ignored` |
| `[libctx-jspi] coroutine N entry REJECTED: <stack>` | `libcontext.cpp` | the coroutine's entry activation *rejected* (a trap inside the body); the enterer receives the refusal sentinel instead of hanging |
| `[libctx-jspi] REGION OVERFLOW: coroutine N …` | `libcontext.cpp` | the spill-region base canary tripped — a tool body outgrew its region |
| `[wx-scheduler] force-clearing stuck window …` | `jspi-scheduler.js` | turnstile self-heal: some suspension bypassed the shim (untracked raw await) and would otherwise block resumes forever |
| `[wx-scheduler] job tick error: …` | `evtloop.cpp` | a scheduled-job handler threw; containment fired |
| `[wx-scheduler] mailbox tick error: …` | `jspi-scheduler.js` | a delivered mailbox handler threw; `wx_dispatch_abandon` + top-wait resolution keep the app alive |
| `[wx-scheduler] shutdown (<why>) clean` / `… stranded:N` | `jspi-scheduler.js` | teardown contract — a clean exit *says so*; `stranded` counts waits that never resolved (asserted by `e2e/app-quit.spec.ts`) |
| `[wx-scheduler] SuspendError: …` | `jspi-scheduler.js` | see §3 — includes a full dump for targeting |
| `[wx-scheduler] LOST WAKE: …` | `jspi-scheduler.js` | watchdog: an activation parked >30 s on a token wait that is no longer registered |
| `[wx-scheduler] dropping wake for quarantined N` | `jspi-scheduler.js` | a late wake arrived for a released coroutine; refused (never re-enter a freed body) |
| `[wx-timer] retry storm: N retries …` | `timer.cpp` | a timer's `Notify` kept retrying against a held dispatch interlock — something is parked across ticks |
| `[wx-dispatch] ERASED … / NEGATIVE depth …` | `evtloop.cpp` | dispatch-interlock bookkeeping anomaly — depth accounting corrupt, report it |

A healthy run is beacon-silent apart from at most a `shutdown … clean`.

### 2.5 Tooling blind spots (read before trusting output)

- **Console is async** — `printf`/`console.*` reaches Playwright via CDP
  asynchronously; the *last delivered* line can lag the real failure point.
  Prefer state dumps (§2.1) and binary-outcome bisection over "the last log
  line".
- **Playwright hides the renderer** — it forces `--disable-breakpad` and only
  pipes the *browser* process stderr. To see the renderer's own stderr and a
  real crash reason, serve `tests/apps` with the COOP/COEP headers
  (`tests/serve.json`, e.g. `npx serve apps -c ../serve.json`) and open the
  page in a normal Chrome with crash reporting on.
- **macOS `sample`/`.ips`** see wasm frames as numeric offsets, not C++ names.

**Crash vs. hang vs. stall** — a failure with no exception is not necessarily
a crash. Find the renderer PID and inspect it:

```bash
ps -axo pid,%cpu,%mem,command | grep -i 'Google Chrome'
sample <rendererPID> 3        # what is the main thread doing?
```

- Idle in `CFRunLoop`/`mach_msg2_trap`, ~0% CPU → a *stall* (event loop
  alive, nothing scheduled). Under JSPI this almost always means a parked
  activation whose wake was lost or refused — go read `__wxWaitDump()` and
  the ring.
- Blocked on a futex / `Atomics.wait` → a pthread/lock issue.
- Spinning at 100% → an infinite loop.
- Gone + a `.ips` report → a real signal crash.

---

## 3. Reading a SuspendError

Chromium: `RangeError: Trying to suspend without WebAssembly.promising` (or
similar `Suspend…` wording). Firefox: `No matching WebAssembly.promising`.

Both mean the same **call-shape problem**: a *plain* (non-promising) entry
into wasm reached a suspending import. The suspension has nowhere to go — a
promising activation is created at the *export* boundary, not at the park
site — so the engine throws at the park.

The scheduler's attributor catches these globally and prints
`[wx-scheduler] SuspendError: …` with a full `__wxWaitDump()` — the engine
cannot say *which* export was entered plainly, but the dump (what is wrapped,
what was executing) is exactly the targeting data you need.

Fixes, in order of likelihood:

1. **A missing census entry.** The export can suspend but is not declared:
   add it to `scripts/common/jspi-exports.txt` *and* the scheduler wrap list
   in `jspi-scheduler.js` *and* `tests/apps/Makefile.wasm`'s
   `WX_JSPI_EXPORTS` (three synchronized copies — see doc 23).
2. **A plain embind registration.** Suspending embind exports must be
   registered `emscripten::async()` — use `PCBJAM_PARKER_POLICY`
   (`wasm/bindings/pcbjam_async_policy.h`).
3. **A genuinely illegal park** — code that must not suspend (a CLI/service
   target with no suspension backend, an `emscripten_set_main_loop` callback)
   grew a suspending call. Move the work behind a promising export instead.

---

## 4. The harnesses

### 4.1 `tests/apps/standalone/jspi-coroutine` — the coroutine contract battery

A wx-free MiniCoro that mirrors `tool/coroutine.h`'s protocol *exactly*
(INVOCATION_ARGS, callerStub + `finish_fcontext`, jumpIn/jumpOut,
CONTINUE_AFTER_ROOT) over the **real** `kicad/thirdparty/libcontext`. 18
cases: entry/yield/resume/completion, deep-stack preservation, nesting with
enterer inference, RunMainStack, value transfer, yield-inside-catch under
native wasm-EH, timer-driven resume, slot reclaim, ghost-resume refusal
(sentinel-shaped), mid-body release census, phantom-release refusal, and
destroy-while-parked containment.

```bash
cd tests/apps/standalone/jspi-coroutine
./build.sh                 # rebuild both variants against the real libcontext
node run.mjs               # single-thread build, node
node run_pt.mjs            # pthread build
# browser (both variants): tests/jspi/jspi-coroutine.spec.ts
```

Output contract: `[JSPI_CORO] CASE <name> PASS|FAIL(<detail>)`, then
`[JSPI_CORO] SUMMARY passed=<n> failed=<n>`. If `build.sh` dies inside
emscripten's python driver, point `EMSDK_PYTHON` at a modern interpreter
(≥3.10; 3.13 known-good).

### 4.2 `tests/jspi/suspend-races.spec.ts` — semantic suspension races

The suspension-race scenarios (nested modal LIFO, out-of-order wake
resolution, no-lost-wakes, nested-loop teardown-on-error), run against the
races harness built for JSPI. The scenarios express through public wx +
coroutine APIs, so they are exactly as meaningful under JSPI — only the
failure *modes* they'd catch differ (activation misnesting or a lost wait
token). `tests/jspi/jspi-stack.spec.ts` is the red/green proof of the
spill-stack discipline itself.

### 4.3 Isolated probes, generally

A standalone probe often *won't* reproduce a bug that needs the full app
runtime — don't over-trust a green probe. The reverse recipe still holds
too: stub-bisection (comment out a suspect call, rebuild, observe a binary
survives-or-fails outcome) beats staring at logs, because it does not depend
on console delivery order.

---

## 5. Browser notes

- **Firefox 153+ is the strict engine.** JSPI is on by default (Playwright
  ≥1.62 ships FF 153) and a *plain* embind call into a suspending body throws
  immediately. Chromium tolerates some shapes FF refuses — the sync
  `kicadTestFiberPark*` levers are usable for manual probing **on Chromium
  only**. If a suspension bug reproduces on one engine only, suspect a
  call-shape difference first (§3), not a logic difference.
- **Firefox runs big promising modules on a slow tier.** Observed as library
  enumeration slowness (FootprintEnumerate rows never appearing within 60 s
  on the remote read path); tracked upstream (#42199). The firefox leg of
  `footprint-browse-remote` is gated on it.
- **COOP/COEP.** SharedArrayBuffer/pthreads need cross-origin isolation
  headers; serve `tests/apps` with `tests/serve.json`.

---

## 6. Build-side debugging

- **The build is single-phase.** `docker/build.sh` compiles, links *and
  finalizes* inside the container; the only host step is
  `node scripts/common/patch-env-shim.mjs` (merges `Module.ENV` into the
  glue's `ENV` so `?trace=` works — seconds). `--compile-only` /
  `--postprocess-only` split the two when CI caches the compile. There is no
  post-link wasm rewriting to go wrong: what you linked is what runs.
- **Logs + monitor.** Builds redirect all output to
  `logs/<script>/<timestamp>.log`; `./scripts/build-monitor.sh` renders a
  live stage dashboard off the newest log (`--once` for a snapshot).
- **Docker compose project-name trap.** `build.sh` derives
  `COMPOSE_PROJECT_NAME` from the git branch (`kicad-wasm-<branch>`), so each
  branch has its own build-cache volume. Any *manual* `docker compose` run
  must export the same `COMPOSE_PROJECT_NAME` first or it silently targets a
  scratch volume.
- **Source diagnostic logging** (off by default, per-category at build time):

  ```bash
  ./docker/build.sh --debug --diag=gal,coroutine,ctor    # or: --diag=all
  ```

  | `--diag=` value | covers |
  |---|---|
  | `gal` | `[DIAG_GAL]` — GAL/WebGL pipeline (paint, context create/lock, init) |
  | `coroutine` | `[WASM_FCONTEXT]` coroutine switches + `[DIAG_TOOL]`/`[DIAG_DISP]` tool dispatch |
  | `ctor` | `[DIAG_CTOR]` — `PCB_EDIT_FRAME` startup milestones |

  Each value maps to a `-DKICAD_DIAG_*` define gating the `KI_DIAG_*` macros
  in `kicad/include/kicad_wasm_diag.h`; output goes to stdout
  (`[KICAD_OUT]`). Changing `--diag` changes `CMAKE_CXX_FLAGS` → forces a
  recompile (ccache-cached per flag combo).
- **Per-branch volumes + optimization level.** Switching `-O1`↔`-O2` busts
  ccache and forces a full recompile; plan accordingly.
