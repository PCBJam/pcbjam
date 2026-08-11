# Sourcetrail code graph for the KiCad WASM port

Interactive symbol-level code graph (classes, calls, includes, inheritance) of the
merged `kicad_editor` build — all 2,176 TUs: pcbnew, eeschema, common, 3D viewer,
and the `wasm/` port layer — indexed by [Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail).
Lives in `pcbjam/sourcetrail/`: README, scripts and project files are tracked; the heavy
artifacts (index db, compile db, libc++ headers) are ignored via the local `.gitignore`
and rebuilt with the steps below.

## What's in this folder

| File | Purpose |
|---|---|
| `kicad-wasm.srctrlprj` / `.srctrldb` | Sourcetrail project + indexed database (~440 MB) |
| `compile_commands.json` | Transformed compile db the indexer consumes |
| `transform_compile_db.py` | Turns the container's emscripten compile db into the above |
| `libcxx-11/` | Pinned libc++ 11.1.0 headers (see Tricks) |
| `asyncify_candidates.py` | Ranks subsystems safe for the asyncify removelist |
| `sample.srctrlprj` + `sample_compile_commands.json` | 6-file smoke test for the pipeline |

## Install

- **Sourcetrail 2021.4.19** — the last free release (the maintained fork paywalls binaries):
  <https://github.com/CoatiSoftware/Sourcetrail/releases/tag/2021.4.19>, macOS dmg → `/Applications`,
  then `xattr -dr com.apple.quarantine /Applications/Sourcetrail.app`. It's x86_64 — needs Rosetta 2
  on Apple Silicon (works fine).
- Nothing else: python3 stdlib only; header mirrors are exported from the Docker build.

## Run

```bash
# browse (GUI)
open -a Sourcetrail /Users/V/IdeaProjects/pcbjam-private/pcbjam/sourcetrail/kicad-wasm.srctrlprj

# (re)index from the terminal — ABSOLUTE project path, see Tricks
/Applications/Sourcetrail.app/Contents/MacOS/Sourcetrail index \
  --project-file /Users/V/IdeaProjects/pcbjam-private/pcbjam/sourcetrail/kicad-wasm.srctrlprj
```

Full index ≈ 12 min all-cores. In the GUI there is no single whole-project graph: search a
symbol (Cmd+F — e.g. `BOARD`, `KIPLATFORM`) and click it; the graph pane centers on it and
expands as you click nodes/edges.

### Refreshing after a KiCad rebuild

The compile db comes from the `main`-branch Docker build cache (KiCad's CMake exports it
by default — no reconfigure needed). From `pcbjam/`:

```bash
source scripts/common/versions.sh
COMPOSE_PROJECT_NAME=kicad-wasm-main docker compose -f docker/docker-compose.yml up -d --build

# compile db + generated sources/headers + .rsp files + deps/wx includes
docker compose -p kicad-wasm-main -f docker/docker-compose.yml exec -T kicad-wasm-builder bash -c \
  "cd /workspace && { find build-wasm/kicad-kicad_editor \( -name '*.h' -o -name '*.hpp' -o -name '*.hxx' \
   -o -name '*.hh' -o -name '*.inc' -o -name '*.rsp' -o -name '*.cc' -o -name '*.cpp' -o -name '*.cxx' \
   -o -name 'compile_commands.json' \) -type f; echo build-wasm/sysroot/include; \
   echo build-wasm/wxwidgets/lib/wx/include; } | tar -cf - -T -" | tar -xf - -C .

# emscripten sysroot headers -> tools/emsdk mirror (only after an emsdk bump)
docker compose -p kicad-wasm-main -f docker/docker-compose.yml exec -T kicad-wasm-builder \
  tar -cf - -C / emsdk/upstream/emscripten/cache/sysroot/include | tar -xf - -C tools/

cd sourcetrail
python3 transform_compile_db.py ../kicad-kicad_editor/compile_commands.json compile_commands.json
# then the `Sourcetrail index` command above
```

## Tricks (why this isn't just "point Sourcetrail at the cdb")

- **The bundled clang is ~LLVM 11.** Modern libc++ (emsdk 4.x's or the macOS SDK's) does not
  parse under it. The transform pins `libcxx-11/` via `-nostdinc++` and takes C headers from the
  emsdk musl sysroot mirror (`tools/emsdk/`). Expected residue: ~14 errors, all in the
  libc++11/musl locale seam (`_CTYPE_*`, `strtoull_l`, one fatal `xlocale.h`) — harmless to the graph.
- **Transform surgery:** `@CMakeFiles/*.rsp` response files are expanded inline (old clang's cdb
  loader can't); PCH is stripped (`-Xclang -include-pch` of clang-20 `.pch` binaries) and replaced
  with `-include cmake_pch.hxx`; emscripten-only flags (`-sFOO`, `-fwasm-exceptions`) dropped,
  `--target=wasm32-unknown-emscripten` + `-fexceptions` added; paths rewritten
  `/workspace` → `pcbjam/`, `/emsdk` → `pcbjam/tools/emsdk/`.
- **CLI hangs on relative `--project-file` paths.** Silently — idle event loop, log stops after
  "Maven executable path detection". Always pass absolute paths.
- **Global header paths are deliberately empty** in
  `~/Library/Application Support/Sourcetrail/ApplicationSettings.xml`. First launch auto-filled
  macOS-26-SDK paths, which poison every parse (see clang-11 point). Don't re-run header path
  detection from Preferences; `has_prefilled_header_search_paths=1` keeps it from coming back.
- **"N files (126 complete)" undersells the index.** A file counts as complete only if *every* TU
  touching it had zero errors; the 14 std-header errors are included nearly everywhere, so the
  flag cascades. The symbols/references themselves are all recorded.

## Asyncify removelist candidates

```bash
python3 asyncify_candidates.py
```

Computes, over the indexed call graph (187K call edges + override pseudo-edges for virtual
dispatch), which functions can NEVER reach a suspend point, aggregated per module. Seeds =
every `ShowModal`/`Yield`/`Sleep`/progress-dialog/`COROUTINE` function (**strict**), plus
`ProcessEvent`-style synchronous dispatch (**lenient** — a dispatched handler may suspend and
unwind through the dispatcher). Functions clean under *lenient* are candidates for
`scripts/common/asyncify-removelist.txt` (matching rules are documented in that file:
one prefix wildcard per symbol, e.g. `SHAPE_POLY_SET::*`).

Headline results from the 2026-08-07 index: `kiapi` generated protobuf (15.2K funcs),
`libs/kimath` (7.3K), `clipper2` (6.3K), `nlohmann_json`/`fmt`/`pegtl`/`zint` are 100% clean;
`pcbnew/router` is 1,820/1,827 clean (the 7 are the `Wait()` tool-integration layer — the PNS
shove/optimizer core never suspends).

**Caveats:** the C++ graph can't see calls through `std::function`, event tables, or raw function
pointers, and asyncify operates on the post-inlining *wasm* call graph, not C++ symbols. Before
shipping an entry: ground-truth with Binaryen's asyncify verbose/advise output in
`apply-asyncify.sh`, and rely on e2e — a wrong removal traps loudly (`unreachable`) at the first
unwind through it. Tweak seeds / path depths at the top of the script.
