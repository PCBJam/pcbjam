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
| Real redraws/s @1× (vme-wren) | 7.8 | 9.4 | **+21 %** |
| Real redraws/s @4× throttle | 3.1 | 5.2 | **+68 %** |
| Wasm heap after big-board open | 962 MB | 802 MB | **−17 %** |
| Jetson 80.9 MB board open | 14.6 s, peak 1.90 GB | 8.6 s, peak 1.73 GB | **−41 %** |

The asyncify tax was real on every axis: bytes (instrumented code also
compresses ~2× worse), build time (a mandatory 6-GB-RSS host pass per link),
load (bigger download + more code to tier), compute (slower opens, fewer real
frames — the gap *widens* under CPU throttle, the doc-12 signature of
per-operation overhead rather than mere size), and memory.

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

**Interaction FPS** on vme-wren (Lissajous pan + wheel zoom, 6 s × 2 reps;
`rafFps` = main-thread rAF; `distinctFps` = distinct GAL glcanvas frames at a
~30 Hz pixel-hash sampler — the honest "real redraws" number, since rAF keeps
vsync-ticking when the GAL skips):

| Throttle | Asyncify raf / distinct | JSPI raf / distinct |
|---|---|---|
| 1× | 44.5–49.1 / **7.8** | 51.9–55.7 / **9.2–9.6** |
| 4× | 32.4–37.6 / **3.0–3.1** | 39.2–41.4 / **5.1–5.2** |
| 6× | 34.3–39.9 / **2.8–4.1** | 34.3–41.8 / **3.3–5.3** |

The distinct-frame gap grows from +21 % at 1× to +68 % at 4× — the same
"advantage widens under throttle" signature doc-12 used to prove lower
CPU-per-operation (as opposed to just a smaller module).

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

## 6. Reproduce

```bash
# build side (each arm, serialized; see §1 for scenario commands)
KICAD_NO_MONITOR=1 KICAD_KEEP_CONTAINER=1 ./docker/build.sh kicad_editor -j 10

# runtime side (from tests/, artifacts staged in tests/apps/kicad/)
cp kicad/qa/data/pcbnew/vme-wren.kicad_pcb tests/apps/kicad/board/
cp kicad/demos/jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb tests/apps/kicad/board/
BENCH_ARM=<arm> PERF_LARGE=1 npx playwright test --project=perf pcbnew-large-perf.spec.ts --workers=1
# → tests/bench-results/perf-bench-<arm>.ndjson
```
