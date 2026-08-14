# Documentation Map

A central index of the documentation in this repo. The goal of the project is to
build KiCad with WASM and run it in a browser.

> Note: per-area `README.md` files stay next to the code they describe (they're linked
> below). Cross-cutting guides live under `docs/`. Per-feature design notes live under
> [`features/`](features/).

## Start here

- [Project README](../README.md) — overview, prerequisites, quick start, project structure
- [CLAUDE.md](../CLAUDE.md) — project/agent context and contribution conventions

## Build

- [docs/build.md](build.md) — Docker-based KiCad WASM build system (single-phase build, outputs, memory)
- [docker/README.md](../docker/README.md) — Docker build environment, branch-specific containers, troubleshooting
- [wasm/README.md](../wasm/README.md) — WASM compatibility layer (overrides/shims without patching KiCad)

## Debugging & WASM runtime

- [docs/debugging/DEBUG.md](debugging/DEBUG.md) — debugging guide: the JSPI runtime's observability (`__wxWaitDump`, beacons), reading a SuspendError, the harnesses
- [docs/features/async/23-jspi-runtime.md](features/async/23-jspi-runtime.md) — the JSPI runtime architecture (scheduler/turnstile, libcontext backend, embind call shapes)
- [docs/debugging/learning.md](debugging/learning.md) — historical: Asyncify + consecutive modal dialogs, the lock pattern (asyncify era)
- [docs/research/threading_1.md](research/threading_1.md) — historical deep dive: the Asyncify single-slot `currData` collision bug and its era's fix
- [docs/research/threading_2.md](research/threading_2.md) — external research that pre-studied the alternatives (JSPI/WasmFX/state machines), QEMU analysis

## Architecture

- [wasm/README.md](../wasm/README.md) — WASM compatibility layer structure
- [web/README.md](../web/README.md) — web app (create/open KiCad projects), tech stack, URL routing, WASM artifact serving

## Testing

- [tests/README.md](../tests/README.md) — Playwright test infrastructure, element registry, logs, screenshots
- [tests/WHATWORKS.md](../tests/WHATWORKS.md) — wxWidgets-in-WASM feature coverage matrix and KiCad readiness
- [tests/GL_README.md](../tests/GL_README.md) — Emscripten legacy GL immediate-mode quirks (color-per-vertex)
- [tests/gal-regression/README.md](../tests/gal-regression/README.md) — GAL visual regression suite (native OpenGL vs WebGL WASM)

## Feature design docs

Per-feature design notes and porting records live under [`features/`](features/):

- [web-init](features/web-init/) — web app spec
- [schematic](features/schematic/) — eeschema WASM bring-up
- [symbol-editor](features/symbol-editor/) — symbol editor (eeschema kiface launcher)
- [gerbview](features/gerbview/) — Gerber viewer port
- [pl-editor](features/pl-editor/) — page-layout editor port (incl. file-dialog usability fixes)
- [browser-tools](features/browser-tools/) — tool-activation / coroutine deep dives
- [fix-asyncify-O2-and-modal-promise-rejection](features/fix-asyncify-O2-and-modal-promise-rejection/) — RTree wasm overflow bug investigation

### Archived / historical

[`features/archive/`](features/archive/) holds docs whose work is done or superseded
(each carries a status banner):

- [webgl](features/archive/webgl/) — WebGL-GAL strategy/plan (since implemented in `kicad/common/gal/webgl/`)
- [ipc-api](features/archive/ipc-api/) — IPC-API guard cleanup TODO (revert not yet actioned)
