/*
 * Test-only deterministic repro lever for the production board-load trap
 * family ("index out of bounds" / "unreachable executed" in doRewind —
 * gal-refresh-timer investigation, docs/features/async/14-open-settle-gate.md
 * lineage).
 *
 * The surviving hypothesis after the v0.1.19 crash log (2026-07-31): a wx
 * timer callback is a FRESH JS→wasm entry (emscripten_async_call →
 * TimerCallbackFunc::Run → Notify). The main loop is Asyncify-parked in
 * wxWasmYieldToBrowser for most of wall-clock time, so a timer handler that
 * itself parks creates TWO live Asyncify contexts over the single-slot
 * Asyncify.currData — the emscripten #9153 family the handlesleep.js shim
 * silently repairs. Add a fiber swap (the collab entries run on
 * TOOL_MANAGER coroutines — emscripten_fiber_swap, which bypasses the shim's
 * allocateData accounting entirely) and the prod trap's exact second stack
 * (doRewind → finishContextSwitch under __asyncjs__wxWasmYieldToBrowser)
 * becomes constructible on demand.
 *
 * Natural occurrences need a timer handler that parks mid-paint (GAL init /
 * lib bridge) — scheduler-dependent, never reproduced locally in 10+
 * attempts. This lever makes the window deterministic: arm a one-shot wx
 * timer whose Notify() emscripten_sleep()s for a fixed time; the e2e then
 * hammers fiber-based collab entries through the window and asserts the
 * runtime SURVIVES (red on a build where the hypothesis holds).
 *
 * Production is unaffected: nothing fires unless kicadTestArmTimerPark is
 * called.
 */
#pragma once

#include <cstdio>
#include <string>

#include <emscripten.h>
#include <wx/app.h>
#include <wx/timer.h>

namespace pcbjam_timer_park
{

struct State
{
    int  parkMs = 0;
    int  fired  = 0;   // Notify() entries
    int  done   = 0;   // Notify() completions (park survived + rewound)
    bool parked = false;
};

inline State& state()
{
    static State s_state;
    return s_state;
}

/**
 * The timer under test. Notify() enters through the typed timer envelope and
 * execution-owner coordinator, exactly like the GAL refresh timer, and then
 * parks. Other due timers remain queued without polling until this owner
 * retires; a modal-scoped timer can run only through its exact child lease.
 */
class ParkingTimer : public wxTimer
{
public:
    void Notify() override
    {
        ++state().fired;
        state().parked = true;

        if( state().parkMs > 0 )
            emscripten_sleep( state().parkMs );

        state().parked = false;
        ++state().done;
    }
};

/** Arm one shot: fire in aDelayMs, park Notify() for aParkMs. */
inline bool arm( int aDelayMs, int aParkMs )
{
    // Lazy: a wxTimer needs the app/traits up, and by the time a test can
    // call embind the app long is.
    static ParkingTimer* s_timer = nullptr;

    if( !wxTheApp )
        return false;

    if( !s_timer )
        s_timer = new ParkingTimer();

    state().parkMs = aParkMs;
    return s_timer->StartOnce( aDelayMs );
}

/** JS-pollable progress of the armed shot. */
inline std::string stateJson()
{
    char buf[96];
    snprintf( buf, sizeof( buf ), "{\"fired\":%d,\"done\":%d,\"parked\":%s,\"parkMs\":%d}",
              state().fired, state().done, state().parked ? "true" : "false", state().parkMs );
    return buf;
}

} // namespace pcbjam_timer_park
