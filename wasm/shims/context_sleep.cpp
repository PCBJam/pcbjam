/*
 * Main-thread sleep as a CONTEXT PARK (docs/features/async/22, Phase B).
 *
 * THE PROBLEM THIS SOLVES. `nanosleep` on the main thread yields via Asyncify
 * (see nanosleep_yield.c): it parks THE STACK IT STANDS ON. Doc 21 filed that
 * as K7, the "anywhere" class, and its worst caller is a loop inside a tool
 * body — TOOL_MANAGER::RunSynchronousAction spins
 *
 *     while( synchronousControl == STS_RUNNING ) { wxYield(); wxMilliSleep(1); }
 *
 * (kicad/common/tool/tool_manager.cpp:370-371). Every canvas edit/draw/move
 * action goes through it. An in-place park there means a tool stack sits
 * mid-Asyncify-suspension while a nested wxYield() dispatch runs on top of it,
 * and once the scheduler owns dispatch (Phase D) a star transfer aimed at that
 * stack rewinds a capture that is still in flight: `index out of bounds` in
 * doRewind — the blue screen, measured on four canvas-tool specs 2026-08-07.
 *
 * THE FIX. When the sleeping frame stands on a scheduler context that OWNS
 * that stack, the wait becomes what every other migrated wait already is: arm
 * a timed wake, YIELD THE CONTEXT, and let the scheduler resume it. Nothing
 * is suspended in place, so there is no in-flight capture for a transfer to
 * land on, and the caller's `for(;;)`-shaped poll keeps its exact semantics —
 * it just waits by yielding instead of by suspending.
 *
 * WHY HERE AND NOT IN KiCad. The loop is upstream KiCad code, and CLAUDE.md
 * asks the fork to stay close to upstream. Routing this through the sleep
 * primitive keeps KiCad and the wx core untouched AND fixes the whole K7 class
 * at once (every main-thread sleep_for/wxMilliSleep reached on a context), not
 * just the one caller that happened to be measured.
 *
 * WHY THE POLL DOESN'T NEED A SIGNAL. The waited-for state (an atomic set by a
 * later dispatch) has no wake source of its own, so this keeps polling — the
 * caller's contract. What changes is only which stack the wait suspends. The
 * dispatch that eventually flips the atomic runs on a DIFFERENT context: the
 * tick reuses an idle dispatch context or makes one when all are parked
 * deeper (the idle-reuse set), which is exactly why that change had to land
 * before this one.
 */

#include <wx/wasm/private/sched_context.h>
#include <wx/wasm/private/execution_owner.h>

#include <emscripten/emscripten.h>

#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <limits>

namespace
{

[[noreturn]] void fail_context_sleep( const char* aReason )
{
    wxWasmExecutionFailStop( aReason );
    std::abort();
}

EM_JS( int, schedule_context_sleep_wake,
       ( unsigned aContext, unsigned aToken, int aDelay ), {
    var scheduler = globalThis.__wxScheduler;
    if (!scheduler || typeof scheduler.scheduleContextSleep !== "function") {
        globalThis.__wxWasmFailed = true;
        console.error("[wx-scheduler] context-sleep owner is missing");
        return 0;
    }
    return scheduler.scheduleContextSleep(
            aContext >>> 0, aToken >>> 0, aDelay) ? 1 : 0;
} );

EM_JS( int, cancel_context_sleep_wake,
       ( unsigned aContext, unsigned aToken ), {
    var scheduler = globalThis.__wxScheduler;
    if (!scheduler || typeof scheduler.cancelContextSleep !== "function")
        return 0;
    return scheduler.cancelContextSleep(
            aContext >>> 0, aToken >>> 0) ? 1 : 0;
} );

bool cancel_context_sleep( pcbjam_sched::ContextId aContext,
                           pcbjam_sched::WakeToken aToken )
{
    return cancel_context_sleep_wake( aContext, aToken ) != 0;
}

}  // namespace

extern "C" {

// Exact scheduler control, not a wx pending event or a modal child command.
// The timer task only changes this ContextId from Parked to Ready and asks the
// scheduler for a separate fresh pump; it never executes model code under the
// mailbox's authority.
int EMSCRIPTEN_KEEPALIVE pcbjam_context_sleep_wake( unsigned aContext,
                                                    unsigned aToken )
{
    if( pcbjam_sched::current() != 0 ||
        pcbjam_sched::transition_in_flight() )
    {
        wxWasmExecutionFailStop(
                "context-sleep wake entered while scheduler was busy" );
        return 0;
    }

    if( !pcbjam_sched::mark_ready_owned(
            static_cast<pcbjam_sched::ContextId>( aContext ), 0,
            static_cast<pcbjam_sched::WakeToken>( aToken ) ) )
    {
        wxWasmExecutionFailStop(
                "context-sleep target refused its exact wake" );
        return 0;
    }

    EM_ASM( {
        var scheduler = globalThis.__wxScheduler;
        if( scheduler && typeof scheduler._armSchedPump === "function" )
            scheduler._armSchedPump();
    } );
    return 1;
}

/**
 * Park the running context for aMillisecs instead of suspending this stack.
 *
 * Returns 1 if the wait was taken as a context park, 0 if the caller must fall
 * back to the in-place Asyncify yield. That is the right answer when no
 * context owns this stack, when an ordinary wake is already deferred for this
 * context, or when a libcontext fiber is swapped in above a context. Yielding
 * in the last case would save the wrong stack (doc 22 §7 rule 4, enforced by
 * can_yield_here()).
 */
int pcbjam_context_sleep_ms( double aMillisecs )
{
    // A zero-duration sleep is a scheduling hint, not permission to suspend
    // the current stack. In particular, mimalloc calls sleep(0) while its heap
    // metadata is transient. Keep the primitive safe even if a future caller
    // bypasses nanosleep(), which enforces the same rule.
    if( !( aMillisecs > 0.0 ) )
        return 0;

    const pcbjam_sched::ContextId self = pcbjam_sched::current();

    if( !self || !pcbjam_sched::can_yield_here() )
        return 0;

    // A re-entrant ordinary wake which arrived while this context was Running
    // belongs to its next External park. Do not install an unrelated exact
    // timer lease in front of it; the in-place fallback preserves the pending
    // wake until that external park consumes it.
    if( pcbjam_sched::has_pending_wake( self ) )
        return 0;

    const pcbjam_sched::WakeToken token = pcbjam_sched::reserve_wake_token();

    if( !token )
    {
        fail_context_sleep(
                "context-sleep wake-token space is exhausted" );
    }

    // Round up: nanosleep must not return before the requested interval.
    // Clamp before the cast so a non-finite or very large value cannot
    // overflow it.
    const double rounded = std::ceil( aMillisecs );
    const double maximum = static_cast<double>( std::numeric_limits<int>::max() );
    int delay;

    if( !( rounded >= 1.0 ) )
        delay = 1;
    else if( rounded >= maximum )
        delay = std::numeric_limits<int>::max();
    else
        delay = static_cast<int>( rounded );

    if( !schedule_context_sleep_wake( self, token, delay ) )
    {
        fail_context_sleep(
                "context-sleep wake could not acquire its timer lease" );
    }

    const pcbjam_sched::ParkResult parked = pcbjam_sched::yield_park(
            "main-thread-sleep",
            pcbjam_sched::ParkWake::Cancellable(
                    token, &cancel_context_sleep ) );

    if( !parked.accepted )
    {
        if( !cancel_context_sleep( self, token ) )
            fail_context_sleep(
                    "failed context sleep could not revoke its timer lease" );

        fail_context_sleep(
                "context-sleep could not park its owning context" );
    }
    return 1;
}

}  // extern "C"
