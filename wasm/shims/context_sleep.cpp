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

#include <cstdint>

// The scheduler mailbox (wx/wasm/private/mailbox.h). A timer message is the
// wake source: it is delivered from a fresh JS task on the main stack, which
// is where a resume is allowed to happen.
extern "C" void wxWasmMailboxEnqueueAfter( void ( *aFn )( void* ), void* aArg, int aMillisecs );

// Does some wx pump already own this context's wake (the main loop's rAF, a
// dispatch context's tick)? Parking such a context here would give it TWO
// owners, and the second wake resumes a capture the first already consumed —
// measured 2026-08-07 as a doRewind trap through wxWasmArmFrameWake. Those
// contexts keep the in-place yield; the tool coroutines this exists for have
// no other wake source, which is precisely why their wait must park.
extern "C" int wxWasmContextWakeIsPumpOwned( unsigned aId );

namespace
{

void wake_sleeper( void* aArg )
{
    const pcbjam_sched::ContextId id =
            static_cast<pcbjam_sched::ContextId>( reinterpret_cast<uintptr_t>( aArg ) );

    // mark_ready never resumes inline (doc 13 §1.4); drain_all performs the
    // entry from this clean mailbox-tick stack.
    if( pcbjam_sched::mark_ready( id, 0 ) )
        pcbjam_sched::drain_all();
}

}  // namespace

extern "C" {

/**
 * Park the running context for aMillisecs instead of suspending this stack.
 *
 * Returns 1 if the wait was taken as a context park, 0 if the caller must fall
 * back to the in-place Asyncify yield — which is the right answer whenever no
 * context owns this stack: the main loop itself, a bridge entered before the
 * scheduler exists, or a libcontext fiber swapped in above a context (yielding
 * there would save the WRONG stack — doc 22 §7 rule 4, enforced by
 * can_yield_here()).
 */
int pcbjam_context_sleep_ms( double aMillisecs )
{
    const pcbjam_sched::ContextId self = pcbjam_sched::current();

    if( !self || !pcbjam_sched::can_yield_here() )
        return 0;

    if( wxWasmContextWakeIsPumpOwned( self ) )
        return 0;

    // Round up: a 0 ms mailbox delay would re-enter this poll in the same
    // macrotask chain and spin the CPU exactly as the sleep exists to avoid.
    int delay = static_cast<int>( aMillisecs );

    if( delay < 1 )
        delay = 1;

    wxWasmMailboxEnqueueAfter( &wake_sleeper,
                               reinterpret_cast<void*>( static_cast<uintptr_t>( self ) ),
                               delay );
    pcbjam_sched::yield_park( "main-thread-sleep" );
    return 1;
}

}  // extern "C"
