/*
 * Test-only deterministic lever: a SUSPENDING wx-timer handler running
 * concurrently with the main loop's per-frame suspension (gal-refresh-timer
 * investigation, docs/features/async/14-open-settle-gate.md lineage).
 *
 * A wx timer callback is a FRESH JS→wasm entry (emscripten_async_call →
 * TimerCallbackFunc::Run → Notify). The main loop spends most wall-clock time
 * suspended in wxWasmYieldToBrowser, so a timer handler that itself suspends
 * puts a second suspended activation in flight over the shared scheduler
 * state — the concurrency shape the scheduler's turnstile and the dispatch
 * interlock must absorb. While the handler is suspended,
 * wxWasmDispatchParked() reads true and every other due timer spins the 17 ms
 * retry loop — the [wx-timer] storm diagnostic window this lever opens on
 * demand.
 *
 * Natural occurrences need a timer handler that suspends mid-paint (GAL init
 * / lib bridge) — scheduler-dependent, never reproduced locally in 10+
 * attempts. This lever makes the window deterministic: arm a one-shot wx
 * timer whose Notify() emscripten_sleep()s for a fixed time; the e2e then
 * hammers coroutine-based collab entries through the window and asserts the
 * runtime SURVIVES.
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
 * The timer under test. Notify() runs as a fresh JS→wasm entry under
 * TimerCallbackFunc::Run's wxWasmDispatchGuard (src/wasm/timer.cpp), exactly
 * like the GAL refresh timer — then parks, which is what the GAL handler is
 * suspected of doing (paint → lib bridge / GAL init) on the crashing loads.
 * While it is parked, wxWasmDispatchParked() reads true, so every OTHER due
 * timer spins the 17 ms retry loop — the [wx-timer] storm diagnostic should
 * report the window, validating that channel too.
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
