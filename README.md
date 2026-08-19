# KiCad WebAssembly Port

Run KiCad PCBnew in the browser using WebAssembly.

## Quick Start

### Full Build (KiCad + All Tests)

```bash
# 1. Initialize submodules
git submodule update --init --recursive

# 2. Build KiCad WASM (Docker, ~10 min incremental, ~1-2 hours full)
./docker/build.sh

# 3. Build wxWidgets for local testing
./scripts/build-wx-wasm.sh

# 4. Build wxWidgets test apps
./scripts/build-wasm-test.sh

# 5. Run all tests
cd tests && npm install
npm test              # wxWidgets tests (256 tests)
npm run test:kicad    # KiCad tests (2 tests)
```

### wxWidgets Only (No Docker)

```bash
# Requires: Node.js 18+ (Emscripten SDK auto-installed on first build)
./scripts/build-wx-wasm.sh
./scripts/build-wasm-test.sh
cd tests && npm install && npm test
```

## Project Structure

```
kicad-wasm/
├── kicad/                  # KiCad source (git submodule)
├── wxwidgets/              # wxWidgets source (git submodule)
├── wasm/                   # WASM compatibility layer
│   ├── bindings/           # Embind bindings for JavaScript
│   ├── cmake/              # CMake find modules
│   ├── kiplatform/         # Platform abstraction (app, UI, printing)
│   ├── libcontext/         # Coroutine/fiber implementation
│   ├── shims/              # Runtime JavaScript shims
│   └── stubs/              # Stub implementations (libgit2, curl)
├── scripts/                # Build scripts
│   ├── build-wx-wasm.sh   # Build wxWidgets for WASM
│   ├── build-wasm-test.sh          # Build wxWidgets test apps
│   ├── deps/               # Dependency build scripts
│   ├── kicad/              # KiCad build scripts
│   ├── common/             # Shared utilities
│   └── config/             # Build config wrappers
├── docker/                 # Docker build environment
├── tests/                  # Playwright E2E tests
│   ├── e2e/                # Test specs
│   └── apps/               # WASM test applications
├── tools/                  # External tools (local emsdk install)
└── output/                 # Build output (pcbnew.js, pcbnew.wasm)
```

## Feature Branches

Curated design docs and research notes for each feature live in
[`docs/features/<branch-name>/`](docs/features/) (committed).

`./scripts/create-feature-patches.sh [branch-name]` generates per-branch patches
(`root.patch`, `kicad.patch`, `wxwidgets.patch`) into a local `features/<branch-name>/`
scratch dir. That dir is gitignored — the patches are local history, not committed.

## Two Build Workflows

### 1. KiCad Build (Docker)

Full KiCad PCBnew build using Docker:

```bash
# Build KiCad WASM
./docker/build.sh

# Copy output to test directory
./tests/scripts/setup-kicad-wasm.sh

# Run KiCad tests
cd tests && npm install && npm run test:kicad
```

Output: `output/pcbnew.js`, `output/pcbnew.wasm`

See [docs/build.md](docs/build.md) for detailed build documentation.

#### Creating an isolated worktree (with submodule branches)

For an experiment or feature you can work in a disposable git worktree so the
main checkout stays pristine. This repo has three submodules
(`kicad`, `wxwidgets`, `web/pcbjam-shared`); a new worktree starts
with them empty, so initialize and branch each one:

```bash
# 1. Create the worktree on a new branch (off main), at a sibling path
git worktree add -b experiment/my-thing ../kicad-wasm-my-thing main

# 2. Check out the submodules INSIDE the worktree (working trees only;
#    git objects are shared with the main checkout)
cd ../kicad-wasm-my-thing
git submodule update --init kicad wxwidgets web/pcbjam-shared

# 3. Create a matching branch in each submodule (they start at detached HEAD)
git checkout -b experiment/my-thing                 # root already on it via -b above
for sm in kicad wxwidgets web/pcbjam-shared; do
  git -C "$sm" checkout -b experiment/my-thing
done
```

Then build from inside the worktree. Use an **isolated** Docker project — do NOT
set `COMPOSE_PROJECT_NAME` to another branch's project (e.g. `kicad-wasm-main`),
which can collide with other workflows; `docker/build.sh` auto-derives an isolated
project name from the worktree branch. The first build provisions deps
(wxWidgets + OCC) from scratch. To keep the machine responsive, cap
parallelism:

```bash
KICAD_DOCKER_CPUS=4 ./docker/build.sh pcbnew -j 4
```

Tear down afterward with `git worktree remove ../kicad-wasm-my-thing` (and
`docker compose -p <project> down -v` to drop the isolated volumes).

#### Fresh worktree provisioning

Some test artifacts are gitignored and are NOT produced by the build pipeline,
so they don't carry into a newly-created git worktree — without them the
`gal-webgl` tests 404 ("Loading WASM...") and the `collab` specs fail with
`Could not resolve "@pcbjam/shared"`. After building (`docker/build.sh` +
`scripts/build-wx-wasm.sh`) and `cd tests && npm i`, run once per worktree:

```bash
./scripts/setup-worktree.sh   # idempotent: sysroot headers, gal-webgl harness, web/ pnpm install, collab bundle
```

### 2. wxWidgets Test Apps (Local)

Build standalone wxWidgets test apps for feature testing:

```bash
# Build wxWidgets for WASM
./scripts/build-wx-wasm.sh

# Build test apps
./scripts/build-wasm-test.sh

# Run wxWidgets tests
cd tests && npm install && npm test
```

Output: `tests/apps/standalone/`

## Prerequisites

### For KiCad Build (Docker)
- Docker Desktop with 16GB+ RAM allocated
- 10+ GB disk space for build cache

### For wxWidgets Build (Local)
- Node.js 18+ (for tests)
- Emscripten SDK (auto-installed on first build)

```bash
# Initialize submodules
git submodule update --init --recursive

# Install Emscripten SDK (auto-runs on first build, or run manually)
./scripts/setup-emsdk.sh
```

## Testing

```bash
cd tests
npm install

# Run all tests
npm test

# Run specific tests
npm run test:kicad          # KiCad tests only
npx playwright test menu    # Menu tests only
```

See [tests/README.md](tests/README.md) for test documentation.

### Screenshots

CI's Linux render is the source of truth for baseline screenshots. On each `main`
push, CI compares its render against the baselines (pinned by the R2-hosted
manifest — nothing screenshot-related is committed) and posts the diff (plus the
runtime-perf numbers) to Discord. To update baselines after an intended render
change, promote the CI run's screenshots in the morelli review app
(https://pcbjam-morelli-staging.pcbjam-staging.workers.dev) — pick the run,
review the diffs, bulk-select, Promote. CI uploads every run's renders to R2
for that purpose (30-day retention).

```bash
cd tests
npm run screenshots:fetch-manifest && npm run screenshots:fetch   # materialize baselines
npm run screenshots:check                                         # local gate: current vs baselines
```

See [tests/tools/screenshots/README.md](tests/tools/screenshots/README.md).

## Current Status

- **wxWidgets WASM**: Core widgets working (menus, dialogs, grids, trees, OpenGL)
- **KiCad PCBnew**: Builds and loads in browser, canvas rendering working
- **In Progress**: Testing wxWidgets features used by KiCad

## Documentation

See **[docs/README.md](docs/README.md)** for the full documentation map. Highlights:

- [Build System](docs/build.md) - Docker build details
- [Docker README](docker/README.md) - Container setup
- [Debugging Guide](docs/debugging/DEBUG.md) - Asyncify/WASM debugging
- [Tests README](tests/README.md) - Test infrastructure

## Landing page / website

The marketing site and landing page live in [`site/`](site/) (Astro), deployed as
static assets to Cloudflare R2.

**On every release, bump the build SHA.** `site/src/components/Footer.astro` has a
hardcoded `BUILD_SHA` constant that is shown in the footer and links to the
corresponding commit. Because the main-repo commit pins the KiCad and wxWidgets
submodule revisions implicitly, this is our GPLv3 **corresponding-source** pointer
(surfaced on `/licenses`). The site is static, so nothing sets it automatically —
update `BUILD_SHA` by hand to the deployed `pcbjam` commit each time you release.

## License

KiCad is GPL-3.0. This project follows the same license.

The site combines KiCad (GPLv3) with the wxWidgets fork; the wxWidgets WebAssembly
port files are LGPL v2 (without the wxWindows binary exception). See the
`/licenses` page (`site/src/content/legal/licenses.md`) for the full breakdown and
the corresponding-source offer.
