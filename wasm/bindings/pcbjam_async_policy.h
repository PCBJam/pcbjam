/*
 * PCBJAM_PARKER_POLICY — registration policy for the suspending embind
 * exports (the doc-18 "PARKER" class: kicadOpenFile / kicadOpenFiles /
 * kicadLibsReload, whose bodies park on wx wait tokens mid-load).
 *
 * They MUST be registered emscripten::async() so embind wraps the invoker in
 * WebAssembly.promising — the call returns a real Promise and the suspension
 * is legal. Without it the first park throws SuspendError ("trying to
 * suspend without WebAssembly.promising").
 *
 * Usage (note the macro carries its own leading comma):
 *     function( "kicadOpenFile", &kicadOpenFile PCBJAM_PARKER_POLICY );
 */
#pragma once

#ifdef __EMSCRIPTEN__
#define PCBJAM_PARKER_POLICY , emscripten::async()
#else
#define PCBJAM_PARKER_POLICY
#endif
