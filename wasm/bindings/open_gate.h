/*
 * Truthful "kicadOpenFile in flight" signal for the web shell.
 *
 * kicadOpenFile runs OpenProjectFiles under Asyncify: the embind call unwinds
 * back to JS long before the load finishes, and the chain stays parked (and
 * resumes, and parks again) across the whole multi-second load. Any bare
 * embind entry that walks the model while that chain is parked mid-mutation
 * (collab snapshot, presence bind) can virtual-dispatch through a half-built
 * item and trap ("indirect call signature mismatch" — same class as the wx
 * dispatch interlock and the drift-trio #10b fiber-busy probe, but through a
 * JS entry neither of those covers).
 *
 * The guard is RAII on the open's C++ stack frame: an Asyncify unwind does not
 * run destructors and a rewind resumes past the constructor, so the count is
 * held for the park's entire lifetime and drops exactly when OpenProjectFiles
 * truly returns (the same primitive as wxWasmDispatchGuard). A trap escaping
 * the open leaves the count stuck — the JS poll times out and degrades.
 */
#pragma once

namespace pcbjam_open
{

inline int& busyCount()
{
    static int s_count = 0;
    return s_count;
}

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
 * nonzero value, kicadOpenFile Asyncify-parks for this many ms on entry and
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

} // namespace pcbjam_open
