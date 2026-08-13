/*
 * Truthful "kicadOpenFile in flight" signal for the web shell.
 *
 * kicadOpenFile runs OpenProjectFiles under Asyncify: the embind call unwinds
 * back to JS long before the load finishes, and the chain stays parked (and
 * resumes, and parks again) across the whole multi-second load. Any bare
 * embind entry that walks the model while that chain is parked mid-mutation
 * (collab snapshot, presence bind) can virtual-dispatch through a half-built
 * item and trap ("indirect call signature mismatch").
 *
 * The guard is RAII on the open's C++ stack frame: an Asyncify unwind does not
 * run destructors and a rewind resumes past the constructor, so the count is
 * held for the park's entire lifetime and drops exactly when OpenProjectFiles
 * truly returns. A trap escaping the open leaves this diagnostic count stuck;
 * the execution-owner fail-stop rejects later stateful command tickets.
 */
#pragma once

#include <wx/utils.h>

namespace pcbjam_open
{

inline int& busyCount()
{
    static int s_count = 0;
    return s_count;
}

/**
 * Held for the whole open. `busyCount` remains a truthful progress and legacy
 * compatibility probe. It is not an admission authority: open bodies and all
 * live-model commands enter through the wx execution-owner coordinator.
 */
struct BusyGuard
{
    BusyGuard() { ++busyCount(); }
    ~BusyGuard() { --busyCount(); }
};

/** JS-pollable: is a kicadOpenFile chain still in flight (possibly parked)? */
inline bool busy()
{
    return busyCount() > 0;
}

/**
 * Test-only deterministic park (tests/kicad/collab-load-fuzz.spec.ts): with a
 * nonzero value, kicadOpenFile context-parks for this many ms on entry and
 * again after OpenProjectFiles returns — busy guard held, model fully loaded.
 * Natural in-load parks (thread-pool futex waits) are scheduler-dependent and
 * never happen on a fast idle machine, so the guard would be untestable in CI
 * without this window. 0 (the default) is a no-op in production.
 */
inline int& testParkMs()
{
    static int s_ms = 0;
    return s_ms;
}

/**
 * Exercise the same scheduler-aware sleep path as a real load wait.
 *
 * Calling emscripten_sleep() here would bypass nanosleep_yield.c and park the
 * execution-owner stack in place.  That is the old mechanism this test is
 * intended to detect, not the mechanism used by production wxMilliSleep()
 * callers.  Keeping the hook behind this helper also prevents the four open
 * bindings from drifting apart.
 */
inline void testParkIfArmed()
{
    const int ms = testParkMs();

    if( ms > 0 )
        wxMilliSleep( static_cast<unsigned long>( ms ) );
}

} // namespace pcbjam_open
