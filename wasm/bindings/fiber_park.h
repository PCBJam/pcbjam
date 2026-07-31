/*
 * Test-only repro lever for the DECODED production board-load trap
 * (docs/features/async/15-timer-park-repro.md round 3, 2026-07-31):
 * resuming a KiCad coroutine while its body is asyncify-parked inside
 * handleSleep.
 *
 * Two suspension protocols share one context on wasm. A coroutine suspended
 * by a real yield (fiber_swap) has valid rewind data in its fiber struct; a
 * coroutine whose body parked via handleSleep (lib-bridge wait,
 * emscripten_sleep) does NOT — its live state is in the sleep's buffer,
 * invisible to the fiber machinery and to TOOL_MANAGER. Resume() then swaps
 * into the STALE fiber data: finishContextSwitch → doRewind → "unreachable
 * executed", and every later entry reads poisoned Asyncify state ("index out
 * of bounds"). Impossible natively — a coroutine cannot be suspended without
 * yielding.
 *
 * The lever stages the prod state machine exactly:
 *   start(parkMs): Call() a coroutine that immediately KiYield()s — this
 *     writes VALID suspension data once and clears the fresh-entry path, the
 *     state every long-lived tool loop is in.
 *   prime(): Resume() it legitimately — the body then emscripten_sleep()s
 *     (the internal park; prime's Resume ghost-returns per the epoch
 *     machinery) and afterwards KiYield()s again.
 *   poke(): Resume() DURING the sleep — the fatal prod operation. Unfixed
 *     runtime: rewinds the stale suspension → the exact prod trap. Fixed
 *     runtime: the jump is refused (null INVOCATION_ARGS, same contract as
 *     jump-ghost) and the body completes undisturbed; a later poke() after
 *     the second KiYield resumes it for real.
 *
 * Production is inert: nothing runs unless start() is called.
 */
#pragma once

#include <cstdio>
#include <string>

#include <emscripten.h>
#include <tool/coroutine.h>

namespace pcbjam_fiber_park
{

struct State
{
    // 0 idle · 1 yielded-once (primed suspension) · 2 in the sleep park ·
    // 3 woke, yielded again · 4 resumed past second yield · 5 body returned
    int phase  = 0;
    int parkMs = 0;
    int pokes  = 0;
};

inline State& state()
{
    static State s_state;
    return s_state;
}

inline COROUTINE<int, int>*& co()
{
    static COROUTINE<int, int>* s_co = nullptr;
    return s_co;
}

inline int fiberBody( int )
{
    state().phase = 1;
    co()->KiYield();

    state().phase = 2;
    if( state().parkMs > 0 )
        emscripten_sleep( state().parkMs );

    state().phase = 3;
    co()->KiYield();

    state().phase = 4;
    return 0;
}

/** Call() + first KiYield: coroutine now has VALID fiber suspension data. */
inline bool start( int aParkMs )
{
    if( co() && co()->Running() )
        return false;   // one in flight; the spec drives one cycle at a time

    delete co();
    state() = State();
    state().parkMs = aParkMs;
    co() = new COROUTINE<int, int>( fiberBody );
    co()->Call( 0 );
    return state().phase == 1;
}

/** Legitimate Resume into the primed yield; the body then parks. Ghost-returns. */
inline bool prime()
{
    if( !co() )
        return false;

    return co()->Resume();
}

/**
 * Resume() regardless of the body's suspension state — what TOOL_MANAGER does
 * on the next event, unaware the body is asyncify-parked. Counted so the spec
 * can correlate pokes with phases.
 */
inline bool poke()
{
    if( !co() )
        return false;

    ++state().pokes;
    return co()->Resume();
}

inline std::string stateJson()
{
    char buf[112];
    snprintf( buf, sizeof( buf ),
              "{\"phase\":%d,\"pokes\":%d,\"parkMs\":%d,\"running\":%s}",
              state().phase, state().pokes, state().parkMs,
              ( co() && co()->Running() ) ? "true" : "false" );
    return buf;
}

} // namespace pcbjam_fiber_park
