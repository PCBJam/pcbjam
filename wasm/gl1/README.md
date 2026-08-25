# wasm/gl1 — GL 1.x fixed-function pipeline on WebGL2

Emulation layer that lets KiCad's 3D viewer renderer (`RENDER_3D_OPENGL`,
pure GL 1.x fixed-function, compiled **unmodified**) render in the browser.
Supersedes the no-op link stubs of `wasm/stubs/gl_ffp_stub.c` (git history
has the old file): same public surface, real implementations.

TDD harness: `tests/3d-regression/` — 47 native-golden scenarios; parity via
`npm run 3d:check:parity` (see that README).

## How the symbols resolve

In the WASM build, `gl*` are plain C functions split between two providers:

- **Emscripten's WebGL library** (`-sMAX_WEBGL_VERSION=2`) owns every
  modern/WebGL2 name (`glClear`, `glDrawArrays`, `glTexImage2D`, buffers,
  shaders, stencil...).
- **This shim** owns the FFP-only names WebGL2 lacks (`glBegin`, display
  lists, matrix stack, `glLight*`/`glMaterial*`, client-array pointers,
  `glTexEnv*`, `glAlphaFunc`, GLU quadrics) — see `src/gl1_entry_ffp.cpp`.

The emulator must also *observe* a few Emscripten-owned calls (FFP `glEnable`
caps, draws over client arrays, matrix readback, state recorded inside
display lists). Those are intercepted with **wasm-ld `--wrap`**: every name in
`wrapped_symbols.txt` gets a `-Wl,--wrap=<sym>` flag at both link sites, the
interceptors live in `src/gl1_entry_wrapped.cpp`, and `__real_*` forwards to
the WebGL library. No kicad/wxwidgets sources are touched.

Link sites (both read `sources.txt` + `wrapped_symbols.txt`):

- `tests/3d-regression/wasm/Makefile` (the TDD harness)
- `scripts/kicad/build-kicad-target.sh` (`GL3D_LINK_FLAGS`, production
  `kicad_editor`)

## Draw routing

A `glDrawArrays`/`glDrawElements` call is FFP traffic iff BOTH hold:

- the CURRENT WebGL context is the shim's **owner context** (`contextIsOwner()`,
  adopted at the first FFP client-state mutation or `programSync()` in a
  context — a draw under any other context is a modern-GL consumer by
  definition and always passes through, even mid-display-list-recording);
- `GL_VERTEX_ARRAY` client state is enabled (only GL1 code calls
  `glEnableClientState`; the raytracer blit and the 2D WebGL GAL drive their
  own GLSL programs).

The owner gate exists because the client-state flag is process-global and an
interrupted FFP window (e.g. `MODEL_3D::BeginDrawMulti` loops crossing a JSPI
suspension) can leave it set — without the gate, the 2D GAL's draws got routed
through the FFP pipeline (the engine-toggle blank-viewer bug). Two further
hardenings from the same bug:

- **VAO isolation** (`ScopedDefaultVAO`, gl1_draw.cpp): draw executors bind
  VAO 0 for their attribute setup and restore the caller's binding — a routed
  draw arriving with the caller's VAO bound (the blit's attribute 0 collides
  with `ATTR_POSITION`) must never scribble it.
- `contextSync()` resets the client-array mirror entirely on a context change:
  enables, pointers and captured VBO names all described the dead context.

## Invariants that are easy to break (learned from the native goldens)

- **Display lists snapshot client arrays at record time.** The renderer sets
  `gl*Pointer`, records `glDrawArrays` inside `glNewList`, then `delete[]`s
  the arrays right after `glEndList` (`layer_triangles.cpp`) — a recorder
  that stores pointers reads freed memory. Copy eagerly at record.
- **Lights live in eye space, captured at `glLightfv` time.** `init_lights()`
  runs under an identity modelview → the directional lights are anchored to
  the camera. Re-deriving light directions at draw time breaks every lit
  scenario.
- **Do not "fix" mismatched normal counts.** `generate_middle_triangles`
  rejecting countersink walls (normals ≠ vertices) is upstream KiCad behavior
  the goldens document; tolerating it would *diverge* from native.
- **Lighting is per-vertex (Gouraud)** to match fixed-function output;
  per-fragment lighting visibly mismatches speculars on coarse meshes.
- **GL object caches are per-context, and the context is mortal.** Closing the
  3D viewer destroys its wxGLCanvas's WebGL context; reopening mints a new one
  in which the cached names (FFP program, stream/scratch VBOs) are invalid —
  every draw then dies with `INVALID_OPERATION` and the viewer is blank.
  `contextSync()` (gl1_state.cpp) detects the change in `programSync()` — the
  one choke point every shim draw crosses and a path the 2D GAL never reaches
  (a check in any `__wrap_*` would see the GAL's context and ping-pong the
  owner on 2D↔3D paint alternation) — and drops the caches so they rebuild
  lazily. Identity comes from a monotonic id stamped on Emscripten's
  per-context record — NOT the `EMSCRIPTEN_WEBGL_CONTEXT_HANDLE`, which
  Emscripten recycles (a destroy-then-create can return the same number).
  Display-list/immediate state is deliberately untouched: it is CPU-only, and
  the change can be detected mid-scene-rebuild (even inside `glNewList`).
  Known limit (pre-existing): two *simultaneously live* FFP contexts would
  thrash the caches on every alternation — the shim still assumes one live
  3D-viewer context at a time.

## Layout

```
sources.txt / wrapped_symbols.txt   single source of truth for both link sites
include/gl1_shim.h                  internal API + the state mirror
src/gl1_entry_ffp.cpp               the 52 FFP-only public entry points
src/gl1_entry_wrapped.cpp           __wrap_* interceptors (mechanism-aware TU)
src/gl1_state.cpp                   state singleton, capability routing
src/gl1_matrix.cpp                  MODELVIEW/PROJECTION stacks (+readback)
src/gl1_immediate.cpp               glBegin/glEnd + primitive conversion
src/gl1_dlist.cpp                   display-list recorder/replayer
src/gl1_draw.cpp                    draw execution (stream VBO, attrib setup)
src/gl1_shaders.cpp                 the FFP uber-program (ES 3.00) + uniforms
src/gl1_glu.cpp                     GLU quadrics (SGI tessellation) + gluPerspective
```
