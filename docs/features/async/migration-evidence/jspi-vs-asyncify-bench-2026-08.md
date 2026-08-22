# JSPI vs Asyncify: editor benchmark (2026-08-14)

A/B benchmark of the `kicad_editor` app built two ways:

- **Arm A — asyncify**: `pcbjam` @ `29c61b8` (branch `staging`), emscripten **4.0.2**,
  `-sASYNCIFY=1` + host post-link pipeline (finalize → hoist-cpp-catches →
  `wasm-opt --asyncify` → `wasm-opt -O1`, Binaryen fork v130).
- **Arm B — JSPI**: worktree @ `9c475a8` (branch `experiment/jspi`), emscripten **6.0.6**,
  `-sJSPI`, single-phase link, no post-link transform (only the ~1 s env-shim patch).

**Stated confound, up front:** the two arms differ by emscripten major (4.0.2 vs
6.0.6) — libc/libc++/linker/JS-glue all moved with it. That skew is inseparable
from the backend switch (strict-JSPI needs emscripten 6); every number below is
"the shipped asyncify build vs the shipped JSPI build", not a pure
suspension-mechanism isolate. What IS matched: same KiCad commit (`4bfed3f1`),
wxWidgets 3.3.1, EH flags (`-fwasm-exceptions -sSUPPORT_LONGJMP=wasm
-sWASM_LEGACY_EXCEPTIONS=1`), mimalloc, memory config (256 MB initial / 4 GB
max), **DEBUG mode on both** (TU `-g -O1`, link `-O1 -g -gseparate-dwarf` — the
default), docker caps 10 CPU / 32 GB, `-j 10`, `BINARYEN_CORES=8`,
`HOIST_KEEP_NAMES` unset, runs serialized on an idle machine.

Machine: Apple M4 Max, 16 cores, 64 GB; Docker Desktop VM 12 CPU / 28 GiB;
macOS 26.5.2. Raw data: [`bench-data-2026-08/`](bench-data-2026-08/).

> **Revised 2026-08-14 (evening).** The build, size, load and board-open numbers
> stand. The **interaction-FPS numbers were wrong and have been re-measured** —
> see [§4.4](#44-interaction-fps-re-measured-2026-08-14-evening). The original
> `distinctFps` counter hashed a 48×48 downscale of the canvas, which (a) misses
> redraws that change few pixels and (b) stalls the renderer through the pixel
> readback, badly so under software rasterisation. Frames are now counted from
> the WebGL command stream, the view is zoomed-to-fit before every measurement so
> each run sees the same geometry, and both a real GPU and a software rasteriser
> are reported. Direction of the result is unchanged; the magnitudes are not.
>
> **Second revision, same evening.** The two arms were never built the same way:
> the Asyncify pipeline always finished with a host-side `wasm-opt -O1`, while
> the JSPI build got **no Binaryen pass at all** (emcc only runs wasm-opt at link
> -O2+, and we link at -O1). So every number above compares an optimised module
> against an unoptimised one — in JSPI's favour, since JSPI won anyway. A
> post-link `wasm-opt` step has now been added to the build and re-benchmarked:
> [§6](#6-post-link-wasm-opt). The original unoptimised numbers are kept
> throughout; §7 adds the third arm.

## TL;DR

| Metric | Asyncify | JSPI | Δ |
|---|---|---|---|
| Editor wasm, raw | 113.1 MB | 94.1 MB | **−17 %** |
| Editor wasm, gzip −9 | 36.7 MB | 18.6 MB | **−49 %** |
| Editor wasm, brotli | 24.5 MB | 13.5 MB | **−45 %** |
| Post-link tail (per build!) | 63.4 s, 6.1 GB RSS | 1.6 s, 49 MB RSS | **−97 %** |
| Clean rebuild (warm ccache) | 165 s | 95 s | **−42 %** |
| Cold load (median of 5) | 2 576 ms | 1 538 ms | **−40 %** |
| Open vme-wren (27.7 MB board) | 6 465 ms | 3 551 ms | **−45 %** |
| GAL frames/s, vme-wren pan (GPU) | 12.7 | 19.5 | **+54 %** |
| GAL frames/s, vme-wren zoom (GPU) | 26.2 | 39.5 | **+51 %** |
| GAL frames/s, jetson pan (GPU) | 11.7 | 15.5 | **+32 %** |
| Wasm heap after big-board open | 962 MB | 802 MB | **−17 %** |
| Jetson 80.9 MB board open | 14.6 s, peak 1.90 GB | 8.6 s, peak 1.73 GB | **−41 %** |

| JSPI wasm, raw — **with `wasm-opt -O1`** | — | **63.3 MB** | **−36 %** vs unoptimised JSPI |
| JSPI wasm, brotli — **with `wasm-opt -O1`** | — | **10.6 MB** | **−15 %** vs unoptimised JSPI |

(The last two rows are the third arm added in [§6](#6-post-link-wasm-opt); every
other row is the original A/B, both arms as they were actually built.)

The asyncify tax was real on every axis: bytes (instrumented code also
compresses ~2× worse), build time (a mandatory 6-GB-RSS host pass per link),
load (bigger download + more code to tier), compute (slower opens, ~50–70 %
fewer rendered frames), and memory. The frame-rate advantage holds at a roughly
*constant ratio* across CPU throttle rates (+63 % / +51 % / +73 % at 1× / 4× /
6×), i.e. JSPI does less work per frame rather than merely loading a smaller
module. The earlier claim that the gap *widened* under throttle (+21 % → +68 %)
does not survive re-measurement — it was an artefact of the old counter being
clipped at 1×.

## 1. Build time

Scenarios (identical commands both arms, run serially): **S1** no-change
rebuild (`./docker/build.sh kicad_editor -j 10` twice, 2nd reported), **S2**
clean editor rebuild with warm ccache (`--clean-kicad`, twice), **S3** clean
rebuild with `CCACHE_DISABLE=1` (manual `compose exec`, compile cost only).

Both trees exhibit an **mtime ping-pong** in the wx re-enter (a reconfigure
regenerates files the next rsync restores → every other build pays a wx
reconfigure). Numbers are therefore given per observed mode; phase splits from
the `@KW@` markers.

| Scenario | Asyncify | JSPI |
|---|---|---|
| S1 no-change, quiet mode | **175 s** (cfg 40 + link 40 + finalize 4 + **asyncify 58**) | **154 s** (cfg 56 + link 46, tail ≈0) |
| S1 no-change, wx-churn mode | 427 s (wx 89 + cfg 132 + compile 124 + tail 63) | 379 s (first run after container recreate) |
| S2 clean, warm ccache, quiet | **165 s** (1 819 TU in 29 s + tail 61) | **95 s** (1 819 TU in 26 s) |
| S2 clean, wx-churn mode | 248 s | 122 s |
| S3 clean, no ccache (kicad only) | **365 s** (cfg 154 + compile 211) | **304 s** (cfg 136 + compile 168) |
| Container compile-only, steady | 91 s | — (contained in S2) |

Reading: the container-side compile is broadly comparable (emscripten 6 is
~15-20 % faster on the uncached compile); **the structural difference is the
host tail** — asyncify pays 58-63 s *on every single link*, JSPI pays ~1.6 s.
In the dev loop that is the difference between a ~2.5-minute and a ~4-minute
edit-to-browser cycle (or 7 min when the wx churn mode hits, which the tail
compounds).

Note: A-S3's wall figure included a 453 s wx rebuild triggered by the bench's
own `touch` of the wx build Makefile (used to pin the wx skip path) — excluded
above; the kicad configure+compile figures are uncontaminated.

## 2. Build memory

- **Container peak** (cgroup v2 `memory.peak`, fresh cgroup per run): both arms
  18–24 GiB across all scenarios — dominated by the `-j 10` compile and the
  DWARF-heavy `wasm-ld` link, essentially backend-independent.
- **Host post-link tail** (`/usr/bin/time -l`):
  - Asyncify: **63.4 s wall, 307 s user, peak RSS 6.09 GiB**
    (finalize ≈4 s + hoist+asyncify+`-O1` ≈58 s at `BINARYEN_CORES=8`).
    Historical logs show 59–154 s and one OOM-killed build (exit 137).
  - JSPI: **1.6 s wall, peak RSS 49 MB** (node env-shim patch).

## 3. Bundle size

Same-day builds, DEBUG mode, complete cold-load set
(`kicad_editor.{wasm,js}`, `wx.js`, `wx-dom.js`, `images.tar.gz`):

| | raw | gzip −9 | brotli |
|---|---|---|---|
| Asyncify wasm | 118 557 371 B (113.1 MB) | 36.7 MB | 24.5 MB |
| JSPI wasm | 98 664 038 B (94.1 MB) | 18.6 MB | 13.5 MB |
| Asyncify total set | 118.8 MB | 42.0 MB | 29.5 MB |
| JSPI total set | 99.8 MB | 23.8 MB | 18.5 MB |

The compressed delta (−49 % gzip) is much larger than the raw delta (−17 %):
asyncify's spilled-locals/branch-table instrumentation is high-entropy. The
over-the-wire cost of a cold editor load roughly **halves** under JSPI.
Side note: separate DWARF is 2.27 GB vs 1.91 GB (−16 %); dev-tools-only fetch.

Other apps (existing artifacts, not rebuilt today): pl_editor −19 %,
gerbview −19 %, calculator −26 %, occ_service −1 % (never asyncified),
ngspice_service 0 %.

## 4. Runtime

One harness for both arms: the jspi tree's Playwright 1.62.1 `perf` project
(bundled Chromium, no JSPI-specific launch flags), `tests/kicad/
pcbnew-large-perf.spec.ts`, artifact sets swapped in `tests/apps/kicad/` with
sha256 recorded per row (jspi `6f03e62d…`, asyncify `6dab4931…`). The harness
page seeds KiCad config for both settings versions (9.99 + 10.0) so the
asyncify binary boots wizard-free. Local static server serves wasm gzipped
(hence `transferSize` ≈ the gzip column above). Headless; per doc-12, headless
FPS is a comparative indicator, not an absolute.

**Cold load** (fresh context ×5, navigation → fully-ready editor):

| | Asyncify | JSPI |
|---|---|---|
| loadMs median (range) | 2 576 (2 521–2 629) | 1 538 (1 117–1 841) |
| wasm fetch (gzipped wire) | ~990 ms / 32.1 MB | ~570 ms / 17.1 MB |
| wasm heap at boot | 556.8 MB | 386.7 MB |

CDP-attach sanity: loadMs with a CDP session pre-attached fell inside each
arm's normal range (2 514 / 1 117 ms) — no tier-down artifact from the
throttling channel.

**Board open** (`Module.kicadOpenFile`, ×3 each):

| Board | Asyncify | JSPI |
|---|---|---|
| demo (155 KB, 15 fp) | 467 ms | 358–698 ms (par — too small to discriminate) |
| vme-wren (27.7 MB, 1 508 fp, 24 858 seg) | **6 465 ms** median, peak heap 962–1 183 MB | **3 551 ms** median, peak heap 802 MB |
| jetson-agx-thor (80.9 MB, 1 125 fp) | loaded, **14 584 ms**, peak 1.90 GB | loaded, **8 620 ms**, peak 1.73 GB |

Neither arm OOMs even on the 80.9 MB board — both stay well under the 4 GB cap.

### 4.4 Interaction FPS (re-measured 2026-08-14 evening)

**What the first pass got wrong.** `distinctFps` counted samples of a 48×48
downscale hash of the GAL canvas at ~30 Hz. That under-counts real redraws by
2–3.5× (a moving crosshair changes too few pixels to survive the downscale), it
is capped at the 30 Hz sample rate, and the `drawImage`+`getImageData` readback
it performs is itself expensive — under software rasterisation it was a
significant share of the very thing being measured. The `rafFps` column was
never a frame rate at all: rAF ticks on the compositor's schedule whether or not
the GAL redrew anything.

**The corrected metric.** A GAL frame ends with the compositor blitting to the
default framebuffer, so a *run* of draw calls issued while no framebuffer is
bound is exactly one completed frame. The run must be collapsed — the number of
present draws per frame varies with the AA mode (1 under supersampling, 2 under
`AA_NONE`, +1 when the crosshair is drawn) — but a run boundary happens once per
frame in every mode, so no divisor is needed. This is now what
`measureInteractionFps()` in `tests/kicad/utils/perf-utils.ts` reports, and what
CI records.

**Two further methodology fixes.** Each pattern gets a discarded warm-up drive
(the first pass pays first-time tessellation and measures caching, not steady
state), and the view is **zoomed to fit before every drive**. Without the reset a
preceding wheel-zoom leaves an arbitrary zoom level and the next pattern sees a
different amount of geometry — run-to-run spread reached 2×. With it, repeats
land within ~1% (measured: 21.3 / 21.3 / 21.1 fps over three runs). Zoom-to-fit
also means every number below is the *whole board in view*, i.e. the worst case.

Both arms were re-run back-to-back on the same machine in the same session, from
their own static servers (asyncify served read-only out of the `staging`
worktree's `output/`; the jspi tree's harness page and board fixtures shared by
both, so only the 5-file artifact set differs).

**vme-wren (27.7 MB, 1 508 fp, 24 858 seg) — GAL frames/s:**

| Renderer | Pattern | Asyncify | JSPI | Δ |
|---|---|---|---|---|
| GPU (ANGLE Metal) | crosshair only | 66.4 | 64.9 | −2 % |
| GPU (ANGLE Metal) | wheel zoom | 26.2 | **39.5** | **+51 %** |
| GPU (ANGLE Metal) | middle-drag pan | 12.7 | **19.5** | **+54 %** |
| Software (SwiftShader) | crosshair only | 59.5 | 65.9 | +11 % |
| Software (SwiftShader) | wheel zoom | 11.6 | **39.3** | **+239 %** |
| Software (SwiftShader) | middle-drag pan | 9.9 | 9.5 | −4 % |

**jetson-agx-thor (80.9 MB) — GAL frames/s:**

| Renderer | Pattern | Asyncify | JSPI | Δ |
|---|---|---|---|---|
| GPU (ANGLE Metal) | crosshair only | 66.0 | 63.7 | −3 % |
| GPU (ANGLE Metal) | wheel zoom | 16.0 | **19.4** | **+21 %** |
| GPU (ANGLE Metal) | middle-drag pan | 11.7 | **15.5** | **+32 %** |
| Software (SwiftShader) | any | **0** | **0** | — |

**CPU-throttle sweep** (vme-wren, GPU, middle-drag pan, GAL frames/s):

| Throttle | Asyncify | JSPI | Δ |
|---|---|---|---|
| 1× | 12.5 | 20.4 | **+63 %** |
| 4× | 4.1 | 6.2 | **+51 %** |
| 6× | 2.6 | 4.5 | **+73 %** |

Readings:

- **JSPI's interaction advantage is real and larger than first reported**: ~+50 %
  on vme-wren and ~+30 % on jetson, on a real GPU, where the first pass claimed
  +21 %.
- **Crosshair-only motion is identical on both arms** (~65 fps everywhere, zero
  vertex upload). Moving the cursor only re-composites; it never touches
  geometry, so the suspension backend has nothing to do with it. This is the
  control case, and it behaving as a control is a good sign for the rest.
- **The earlier "jetson saturates, the backend stops mattering" conclusion was an
  artefact** of the broken counter. On a real GPU the backend still separates the
  arms by ~30 % at 80.9 MB. What *is* true is that neither arm renders the jetson
  board at all under software rasterisation: no frame completes within a 6 s
  window, and re-running with a 45 s settle and a 20 s window still yields zero
  (rAF 2.8/s, 233 GL calls/s). A single redraw there takes over 20 seconds.
- **The advantage does not widen under throttle** — it is a roughly constant
  ratio (+51 % to +73 %, the spread being run noise). That still points at less
  work per frame rather than a pure module-size effect, but the original
  "+21 % → +68 % widening" reading was an artefact: the old counter's 30 Hz
  ceiling and under-counting compressed the measured 1× gap specifically.
- **Software-rasteriser numbers do not rank the arms reliably** — vme-wren pan is
  a tie (9.9 vs 9.5) while zoom is a 3.4× gap. Rank the backends on the GPU
  numbers; treat the software column as the CI-shaped regression signal it is.

Absolute frame rates here are lower than the old `distinctFps` figures would
suggest at first glance only because zoom-to-fit puts the entire board in view.
Load and board-open times re-measured in the same runs reproduced §4's originals
(e.g. vme-wren open 6 475 vs 2 088 ms; jetson open 14 510 vs 8 094 ms), which is
the cross-check that the new rig measures the same builds as the old one.

**Memory checkpoints** (wasm linear memory; Chromium `usedJSHeapSize` tracked
alongside, differences <10 %): boot 557 vs 387 MB; after vme-wren open 962 vs
802 MB; unchanged after the FPS sweep on both arms.

## 5. Methodology notes & gotchas

- Asyncify arm reused the warm `kicad-wasm-main` compose volume (62 GB); its
  branch-default `kicad-wasm-staging` volume is a cold stub — running without
  `COMPOSE_PROJECT_NAME=kicad-wasm-main` would have benchmarked a multi-hour
  cold dep build. The other session's tree was verified idle before/after and
  `git status` byte-identical.
- Container `memory.peak` read from a per-run fresh cgroup (`compose stop`
  between runs, `KICAD_KEEP_CONTAINER=1` so the read happens before teardown),
  plus a 5 s `docker stats` sampler (CSV in bench-data).
- The first S3 attempt died in wx's PCRE `aclocal` regen (manual `compose
  exec` skips build.sh's rsync, which perturbs the wx reconfigure check); fixed
  by pre-touching the wx build Makefile — which on arm A then triggered the wx
  rebuild noted in §1. Symmetric procedure both arms.
- The jspi-arm FPS rows in the archived ndjson appear twice: the first pass
  sampled the static `#canvas` (distinct ≈ 0, marked SUPERSEDED); the glcanvas
  re-run is authoritative and matches what `perf-utils.measureFpsDetailed` now
  does. Arm A ran entirely with the fixed sampler.
- Playwright clears `tests/test-results/` per invocation — it ate the arm B
  ndjson during the arm A run (reconstructed from the run logs, two timestamps
  approximate). The spec now writes to `tests/bench-results/` instead.
- The live dev app at :3048 was kept on the JSPI build throughout (its
  `public/wasm` symlink pointed at a stash during the swap window) and
  verified serving the JSPI wasm afterwards.

## 6. Post-link wasm-opt

**The asymmetry.** Arm A's pipeline ended with `wasm-opt --hoist-cpp-catches` →
`--asyncify` → **`-O1`** on the host. Arm B ended with nothing: emcc only runs
Binaryen at link `-O2`+ (`tools/link.py`, `should_run_binaryen_optimizer()`
returns `settings.OPT_LEVEL >= 2`), and at -O0/-O1 the pass list comes back empty
so `wasm-opt` is never even spawned. The section tables confirm it — the asyncify
module has **no name section** (its host `wasm-opt` stripped it) while the JSPI
module still carries **19.56 MB** of names, because `-sJSPI` sets `ASYNCIFY=2`,
which suppresses wasm-ld's `--strip-debug`, leaving wasm-opt as the only thing
that would have dropped them.

So §§3–4 compare an optimised module against an unoptimised one. That understates
JSPI: on a like-for-like code-section basis it was 66.7 MB (never optimised)
against asyncify's 106.3 MB (optimised).

**The build step.** Added to `scripts/kicad/build-kicad-target.sh` as step 8.2,
after the link and before `copy-output`. It runs in-container (wasm-opt ships
with emsdk, so CI's cached `--compile-only` phase covers it and the host
`--postprocess-only` phase stays pure-host). Defaults to `-O1`, matching the
Asyncify-era pipeline; override with `KICAD_WASM_OPT` (`-O2`, `-O1 -g` to keep
the name section, `off` to skip). No feature flags are passed: Binaryen reads the
module's own `target_features` section, so the enabled-feature list cannot drift
from the link. That same section is the skip signal — emcc strips it via
`--strip-target-features` whenever it ran the optimizer itself, so targets that
link at -O2/-Oz (`occ_service`, `kicad_tools`) are detected and skipped rather
than hard-coded by name. A stamp file makes it idempotent across relink-free
rebuilds, and a failure leaves the linked module untouched and fails the build.

**Cost: 9 s**, in a 121 s no-change rebuild (~7 %). For contrast the Asyncify host
tail cost 63.4 s and 6.09 GB RSS per link. The "wasm-opt OOMs on large modules"
comment that justified `-O0` in the release path is Asyncify-era: it predates
JSPI and was written when instrumentation had roughly doubled the function count.

**What it does to the module:** code 66.7 → 51.0 MB, name section 19.56 MB → 0,
`external_debug_info` preserved (so `-gseparate-dwarf` DWARF still resolves).

### 6.1 Size

| Editor wasm | Asyncify | JSPI | JSPI + `wasm-opt -O1` |
|---|---|---|---|
| raw | 118.6 MB | 98.7 MB | **63.3 MB** |
| gzip −9 | 38.5 MB | 19.5 MB | **16.1 MB** |
| brotli | 21.0 MB | 12.5 MB | **10.6 MB** |

Against unoptimised JSPI: **−36 % raw, −17 % gzip, −15 % brotli**. Against
asyncify: −47 % raw, −58 % gzip, −49 % brotli. The raw delta is much larger than
the compressed one because most of it is the name section, which compresses well.

### 6.2 Runtime

Three arms, same session, GPU (ANGLE Metal), zoom-to-fit, 6 s drives. Pan is the
headline: it repeats within ~2 %. Zoom was dropped from the harness entirely
after this run — the wheel drive continuously changes how much geometry is
visible, so it spread ±20 % run to run (34.7 / 42.1 / 27.1 on three identical
repeats) and discriminated nothing. The CI perf specs now drive a pure
middle-drag pan for the same reason. Cursor is the control: crosshair-only motion
touches no geometry.

| vme-wren, GPU | Asyncify | JSPI | JSPI + `wasm-opt -O1` |
|---|---|---|---|
| cold load | 2 145 ms | 1 153 ms | **1 063 ms** |
| open board | 6 347 ms | 3 381 ms | 3 317 ms |
| **pan, GAL fps** | 11.9 | 18.3 | **18.1** |
| cursor, GAL fps (control) | 65.4 | 64.8 | 65.3 |
| zoom, GAL fps (noisy) | 20.0 | 32.4 | 23.0 |

| jetson-agx-thor, GPU | Asyncify | JSPI | JSPI + `wasm-opt -O1` |
|---|---|---|---|
| cold load | 2 135 ms | 1 173 ms | **1 050 ms** |
| open board | 14 651 ms | 8 080 ms | 8 013 ms |
| **pan, GAL fps** | 11.4 | 14.3 | **14.4** |

**Reading: `wasm-opt -O1` is a size and startup win, not a frame-rate win.**
Frame rate is unchanged within noise on both boards (18.3 → 18.1 and 14.3 → 14.4
— the two arms are indistinguishable). Cold load improves 8–10 % (1 153 → 1 063
and 1 173 → 1 050), which is what a 36 % smaller download and less code to tier
buys. Board open is flat, consistent with it being dominated by parsing and
connectivity rather than code quality.

That frame rate does not move is the expected result rather than a
disappointment: the per-frame hot path is scene traversal in code LLVM already
optimised at the translation-unit level, and Binaryen `-O1` on top of clang -O1
mostly removes cross-module redundancy and dead weight. It also means the
original A/B's *interaction* conclusions are not disturbed by the asymmetry — the
JSPI-vs-asyncify frame-rate gap was never an artefact of the missing pass. The
size and load-time comparisons in §§3–4, however, were: JSPI's real advantage
there is larger than those sections state.

### 6.3 Every optimization level, measured

All seven Binaryen levels run on the same pristine unoptimised module
(98.7 MB), then each served against identical glue and benchmarked. `-O0` is the
control: it optimises nothing, so it isolates what a plain round-trip plus
dropping the name section is worth on its own.

| Level | wasm-opt wall | raw | gzip −9 | **brotli** | pan GAL fps | cold load |
|---|---|---|---|---|---|---|
| none | — | 98.7 MB | 19.47 MB | **12.51 MB** | 18.8 | 1 257–1 609 ms |
| `-O0` | 4 s | 72.3 MB | 17.39 MB | **11.21 MB** | 19.5 | ~1 145 ms |
| `-O1` *(shipped default)* | 8 s | 63.3 MB | 16.12 MB | **10.61 MB** | 19.5 | ~1 090 ms |
| `-O2` | 23 s | 60.7 MB | 15.95 MB | **10.66 MB** | **21.1** | ~1 090 ms |
| `-O3` | 98 s | 60.1 MB | 15.83 MB | **10.53 MB** | 20.4 | ~1 070 ms |
| `-O4` | 132 s | 60.1 MB | 15.86 MB | **10.56 MB** | 21.8 | ~1 094 ms |
| `-Os` | 48 s | 60.0 MB | 15.85 MB | **10.53 MB** | 22.1 | ~1 068 ms |
| `-Oz` | 97 s | 57.2 MB | 15.68 MB | **10.49 MB** | 20.4 | ~1 076 ms |

Pan is the mean of two reps where two were run (none, `-O0`, `-O2`, `-Oz`);
repeats agreed within ~5%, and the `settled` time — how long until the app goes
quiet after opening — repeated within 0.4% (e.g. none 6 941 / 6 938 ms against
`-O2` 6 106 / 6 123 ms), which is what gives confidence the gaps are real.

Three things fall out:

- **Most of the size win is not optimisation.** `-O0` — which does no
  optimisation at all — already captures 26.7% of the raw reduction, because the
  bulk of it is the 19.56 MB name section being dropped.
- **Compressed size is flat from `-O1` onward.** Brotli is what actually goes over
  the wire, and every level from `-O1` to `-Oz` lands in a 10.49–10.66 MB band —
  a 1.6% spread. Raw size keeps falling to `-Oz` (57.2 MB), which matters for
  parse and memory but not for download.
- **Build cost explodes for nothing.** `-O3`, `-O4`, `-Os` and `-Oz` cost 48–132 s
  against `-O2`'s 23 s and `-O1`'s 8 s, and buy at most 1.5% more brotli. `-O4`
  is not smaller than `-O3` at all (60 097 004 vs 60 091 979 bytes) while taking
  35% longer.

**Recommendation: `-O2` is the value pick** — 23 s for the best measured frame
rate (+13% pan over unoptimised, versus +4% at `-O1`) and essentially the same
download as anything more expensive. The build currently defaults to `-O1` to
mirror the Asyncify-era pipeline; moving it is a one-word change to
`KICAD_WASM_OPT`. Anything past `-O2` is not worth its build time on this module.

### 6.4 Release (non-debug) build

The build that ships is the **debug** one (`DEBUG_BUILD` defaults to 1). This
tests whether dropping debug mode buys anything, with `wasm-opt -O2` held
constant on both sides so the only variable is the compile/link mode:

| | Debug | Release |
|---|---|---|
| KiCad + deps + wx TUs | `-g -O1` | `-O2` |
| link | `-O1 -g -gseparate-dwarf` | `-O0` |
| post-link | `wasm-opt -O2` | `wasm-opt -O2` |

**Consistency first.** `check_stamp()` is only `[ -f "$stamp_file" ]` — it does
not encode the build mode — so flipping `DEBUG_BUILD=0` rebuilds KiCad while
silently reusing debug-built dependencies. That matters beyond lost optimisation:
wxWidgets' ABI depends on its debug level. Every stamp was therefore wiped and wx
forced through reconfigure, and the result verified by checking for DWARF, which
only a `-g` build emits: OCCT (`libTKernel`), cairo, freetype, harfbuzz,
boost_locale, protobuf, wx base, wx core and the KiCad objects all came back
DWARF-free. Since `env.sh` ties `-g -O1` and `-O2` to the same switch, no DWARF
proves the `-O2` branch. (`docker/build.sh` already forwards `DEBUG_BUILD` into
the container for exactly this reason — its comment notes that `--release` alone
reaches KiCad's flag block but never `DEBUG_CFLAGS`/`WX_DEBUG_FLAGS`.)

**Size — release is slightly *worse*:**

| | Debug + `wasm-opt -O2` | Release + `wasm-opt -O2` | Δ |
|---|---|---|---|
| raw | 60.7 MB | 62.5 MB | **+3.0 %** |
| gzip −9 | 15.95 MB | 16.24 MB | +1.8 % |
| brotli | 10.66 MB | 10.80 MB | +1.3 % |
| code section | 48.5 MB | 50.3 MB | +3.7 % |
| data section | 12.0 MB | 12.0 MB | — |

`-O2` inlines more, so it trades size for speed — the code section grows while
data is byte-identical.

**Speed — no measurable win:**

| vme-wren, GPU | Debug + `wasm-opt -O2` | Release + `wasm-opt -O2` |
|---|---|---|
| pan GAL fps (2 reps) | 19.4 / 19.5 | 19.0 / 20.8 |
| cold load | 1 091 / 1 041 ms | 1 067 / 1 081 ms |
| settle after open | 6 790 / 6 907 ms | 6 671 / 6 003 ms |

Frame rate is **+2.3 % on the means, inside run noise** (the release arm's two
reps, 19.0 and 20.8, straddle the debug arm's pair). Cold load is identical.
Settle is ~7 % faster, the only consistent signal.

**Reading: `clang -O2` and `wasm-opt -O2` are largely redundant here — you want
one of them, not both.** The measured jump is from *no* whole-module optimisation
to *any* (+4 % at `wasm-opt -O1`, +13 % at `-O2`); which tool supplies it barely
matters. That also explains the earlier observation that unoptimised debug loaded
much slower than the optimised variants: that gap was the 19.56 MB **name
section** inflating the download, not code quality. With names stripped on both
sides here, load times converge exactly.

So debug mode is not costing meaningful speed, and release costs 1–3 % more
bytes while giving up all debug info — no separate DWARF, no symbolised stack
traces. On this evidence there is no reason to switch, which is a useful thing to
know: the cheap `wasm-opt` step already captured what was available, and the
remaining render cost is structural (see §6.2's reading), not a missing flag.

**Still not measured:** LTO (`-flto`) and `-msimd128`, neither of which appears
anywhere in the build. LTO is the interesting one — this is a merged multi-app
binary, so there is a large cross-TU inlining surface that neither per-file
`-O2` nor Binaryen can reach. Also unmeasured: a `-O3`/`-Oz` *link* level, whose
metadce pass (gated on `OPT_LEVEL >= 3` or `SHRINK_LEVEL >= 1`, so it does not
engage at `-O2`) would drop unused JS-library and wasm exports.

## 7. Reproduce

```bash
# build side (each arm, serialized; see §1 for scenario commands)
KICAD_NO_MONITOR=1 KICAD_KEEP_CONTAINER=1 ./docker/build.sh kicad_editor -j 10

# runtime side (from tests/, artifacts staged in tests/apps/kicad/)
cp kicad/qa/data/pcbnew/vme-wren.kicad_pcb tests/apps/kicad/board/
cp kicad/demos/jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb tests/apps/kicad/board/
BENCH_ARM=<arm> PERF_LARGE=1 npx playwright test --project=perf pcbnew-large-perf.spec.ts --workers=1
# → tests/bench-results/perf-bench-<arm>.ndjson
```
