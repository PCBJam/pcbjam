/*
 * PCBJAM_PARKER_POLICY — registration policy for the suspending embind
 * exports (the doc-18 "PARKER" class: kicadOpenFile / kicadOpenFiles /
 * kicadLibsReload, whose bodies park on wx wait tokens mid-load).
 *
 * JSPI backend: they MUST be registered emscripten::async() so embind wraps
 * the invoker in WebAssembly.promising — the call returns a real Promise and
 * the suspension is legal. Without it the first park throws SuspendError
 * ("trying to suspend without WebAssembly.promising").
 *
 * Asyncify backend: no policy — the legacy contract stands (placeholder
 * return, callers gate on kicadOpenFileBusy; the scheduler shim owns the
 * await surface).
 *
 * Usage (note the macro carries its own leading comma):
 *     function( "kicadOpenFile", &kicadOpenFile PCBJAM_PARKER_POLICY );
 */
#pragma once

#ifdef PCBJAM_JSPI
#define PCBJAM_PARKER_POLICY , emscripten::async()
#else
#define PCBJAM_PARKER_POLICY
#endif
