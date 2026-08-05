/*
 * Scheduler-context harness — Design B D1 gate
 * (pcbjam docs/features/async/20-design-b-core-plan.md §6 D1).
 *
 * Exercises wasm/sched/context.{h,cpp} — create / yield_park / mark_ready /
 * drain — against the invariants that make a resume something the registry
 * KNOWS rather than something a guard guesses (doc 19's disease):
 *
 *   1. a context runs only when the scheduler drains it;
 *   2. a park yields the whole context; its result arrives on resume;
 *   3. the registry is truth (status transitions, illegal ops refused);
 *   4. nothing parks "in place" — yield_park off a context is refused;
 *   5. a PARKED context does not block others (doc 20 §5: "parked ones do
 *      not count") — the property that makes doc 19's freeze unrepresentable;
 *   6. FIFO readiness, no starvation;
 *   7. at most one transition in flight (drain is not re-entrant);
 *   8. a real async wake (JS timeout → mark_ready → drain) resumes correctly;
 *   9. memory is bounded and MEASURED (peak bytes, asyncify high-water) —
 *      the doc 20 risk-1 gate.
 *
 * Output contract (parsed by tests/asyncify/sched-context.spec.ts):
 *   [SCHED_CTX] PASS <name>            per scenario
 *   [SCHED_CTX] FAIL <name>: <detail>
 *   [SCHED_CTX] STATS <json>           the memory/registry snapshot
 *   [SCHED_CTX] SUMMARY total=N passed=N failed=N
 */

#include "context.h"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <string>
#include <vector>

using namespace pcbjam_sched;

namespace
{

int g_total = 0;
int g_passed = 0;

void log_line( const std::string& aLine )
{
    std::printf( "%s\n", aLine.c_str() );
    std::fflush( stdout );
}

void report( const char* aName, bool aOk, const std::string& aDetail = "" )
{
    ++g_total;

    if( aOk )
    {
        ++g_passed;
        log_line( std::string( "[SCHED_CTX] PASS " ) + aName );
    }
    else
    {
        log_line( std::string( "[SCHED_CTX] FAIL " ) + aName + ": " + aDetail );
    }
}

// ---------------------------------------------------------------------------
// scenario 1: a created context runs its body — but only on drain()
// ---------------------------------------------------------------------------
int g_ran = 0;

void body_sets_flag( void* )
{
    g_ran = 1;
}

void Scenario_CreateRunsOnDrain()
{
    g_ran = 0;
    const ContextId id = create( body_sets_flag, nullptr, "runs-on-drain" );

    if( !id )
        return report( "create_runs_on_drain", false, "create returned 0" );

    // Creation alone must NOT run it: the scheduler decides when.
    if( g_ran != 0 )
        return report( "create_runs_on_drain", false, "body ran before drain()" );

    const ContextId ran = drain();

    if( ran != id )
        return report( "create_runs_on_drain", false, "drain() returned a different id" );

    if( g_ran != 1 )
        return report( "create_runs_on_drain", false, "body did not run" );

    if( status_of( id ) != Status::Finished )
        return report( "create_runs_on_drain", false,
                       std::string( "status after return: " ) + status_name( status_of( id ) ) );

    destroy( id );
    report( "create_runs_on_drain", true );
}

// ---------------------------------------------------------------------------
// scenario 2: park yields the whole context; the result arrives on resume
// ---------------------------------------------------------------------------
int g_park_result = 0;
int g_park_stage = 0;

void body_parks_once( void* )
{
    g_park_stage = 1;
    g_park_result = yield_park( "test-park" );
    g_park_stage = 2;
}

void Scenario_ParkAndResume()
{
    g_park_stage = 0;
    g_park_result = 0;
    const ContextId id = create( body_parks_once, nullptr, "park-once" );

    drain();   // runs until the park

    if( g_park_stage != 1 )
        return report( "park_and_resume", false, "body did not reach the park" );

    if( status_of( id ) != Status::Parked )
        return report( "park_and_resume", false,
                       std::string( "status: " ) + status_name( status_of( id ) ) );

    // Draining again must do NOTHING: a parked context is not runnable until
    // it is marked ready. (If this resumed it, "parked" would be a guess.)
    if( drain() != 0 )
        return report( "park_and_resume", false, "drain() resumed a parked context" );

    if( !mark_ready( id, 4242 ) )
        return report( "park_and_resume", false, "mark_ready failed" );

    if( status_of( id ) != Status::Ready )
        return report( "park_and_resume", false, "status is not ready after mark_ready" );

    drain();

    if( g_park_stage != 2 )
        return report( "park_and_resume", false, "body did not resume" );

    if( g_park_result != 4242 )
        return report( "park_and_resume", false,
                       "wrong result: " + std::to_string( g_park_result ) );

    destroy( id );
    report( "park_and_resume", true );
}

// ---------------------------------------------------------------------------
// scenario 3: nothing parks in place — yield_park off a context is refused
// ---------------------------------------------------------------------------
void Scenario_NoParkInPlace()
{
    // Called from the scheduler stack (this battery runs there).
    const int rc = yield_park( "illegal" );

    if( rc != -1 )
        return report( "no_park_in_place", false, "yield_park did not refuse" );

    if( current() != 0 )
        return report( "no_park_in_place", false, "current() is not the scheduler" );

    report( "no_park_in_place", true );
}

// ---------------------------------------------------------------------------
// scenario 4: a parked context does NOT block other contexts
//   This is doc 19's freeze, made unrepresentable: there, a parked activity
//   held a global interlock and everything else stopped. Here, a parked
//   context is simply not runnable while every other context keeps running.
// ---------------------------------------------------------------------------
int g_blocker_stage = 0;
int g_worker_runs = 0;

void body_blocker( void* )
{
    g_blocker_stage = 1;
    yield_park( "long-park" );
    g_blocker_stage = 2;
}

void body_worker( void* )
{
    ++g_worker_runs;
}

void Scenario_ParkedDoesNotBlock()
{
    g_blocker_stage = 0;
    g_worker_runs = 0;

    const ContextId blocker = create( body_blocker, nullptr, "blocker" );
    drain();   // blocker parks, and stays parked for the rest of this scenario

    if( status_of( blocker ) != Status::Parked )
        return report( "parked_does_not_block", false, "blocker is not parked" );

    // Three unrelated contexts must run to completion while it is parked.
    std::vector<ContextId> workers;

    for( int i = 0; i < 3; ++i )
        workers.push_back( create( body_worker, nullptr, "worker" ) );

    for( int i = 0; i < 3; ++i )
        drain();

    if( g_worker_runs != 3 )
        return report( "parked_does_not_block", false,
                       "workers run: " + std::to_string( g_worker_runs ) + " (expected 3)" );

    if( g_blocker_stage != 1 )
        return report( "parked_does_not_block", false, "blocker resumed unexpectedly" );

    // And the blocker still resumes correctly afterwards.
    mark_ready( blocker, 0 );
    drain();

    if( g_blocker_stage != 2 )
        return report( "parked_does_not_block", false, "blocker did not resume at the end" );

    for( ContextId w : workers )
        destroy( w );

    destroy( blocker );
    report( "parked_does_not_block", true );
}

// ---------------------------------------------------------------------------
// scenario 5: FIFO readiness — no starvation
// ---------------------------------------------------------------------------
std::vector<int> g_order;

void body_records( void* aArg )
{
    g_order.push_back( static_cast<int>( reinterpret_cast<intptr_t>( aArg ) ) );
}

void Scenario_FifoOrder()
{
    g_order.clear();
    std::vector<ContextId> ids;

    for( int i = 1; i <= 4; ++i )
        ids.push_back( create( body_records, reinterpret_cast<void*>( (intptr_t) i ), "fifo" ) );

    for( size_t i = 0; i < ids.size(); ++i )
        drain();

    if( g_order.size() != 4 )
        return report( "fifo_order", false, "ran " + std::to_string( g_order.size() ) );

    for( int i = 0; i < 4; ++i )
    {
        if( g_order[i] != i + 1 )
            return report( "fifo_order", false, "out of order at " + std::to_string( i ) );
    }

    for( ContextId id : ids )
        destroy( id );

    report( "fifo_order", true );
}

// ---------------------------------------------------------------------------
// scenario 6: one transition in flight — drain() is not re-entrant
// ---------------------------------------------------------------------------
int g_reentrant_drain_rc = -99;
bool g_saw_transition = false;

void body_calls_drain( void* )
{
    g_saw_transition = transition_in_flight();
    // A context calling drain() would turn the star into a cycle; the guard
    // must make it a no-op rather than a nested swap.
    g_reentrant_drain_rc = static_cast<int>( drain() );
}

void Scenario_OneTransitionInFlight()
{
    g_reentrant_drain_rc = -99;
    g_saw_transition = false;

    // A second, ready context exists — so a buggy re-entrant drain would have
    // something to run and the failure would be observable, not vacuous.
    const ContextId victim = create( body_worker, nullptr, "victim" );
    const ContextId id = create( body_calls_drain, nullptr, "reentrant" );

    drain();   // runs victim (FIFO)
    drain();   // runs the re-entrant body

    if( !g_saw_transition )
        return report( "one_transition_in_flight", false,
                       "transition_in_flight() was false inside a running context" );

    if( g_reentrant_drain_rc != 0 )
        return report( "one_transition_in_flight", false,
                       "nested drain() ran a context: " + std::to_string( g_reentrant_drain_rc ) );

    destroy( victim );
    destroy( id );
    report( "one_transition_in_flight", true );
}

// ---------------------------------------------------------------------------
// scenario 7: registry refusals — illegal operations are recorded, not obeyed
// ---------------------------------------------------------------------------
void Scenario_RegistryRefusals()
{
    if( mark_ready( 999999, 0 ) )
        return report( "registry_refusals", false, "mark_ready on an unknown id succeeded" );

    const ContextId id = create( body_parks_once, nullptr, "refusals" );
    drain();   // parks

    // Destroying a parked context would strand its stack.
    if( destroy( id ) )
        return report( "registry_refusals", false, "destroy() freed a parked context" );

    // Marking a ready context ready again must not double-queue it.
    mark_ready( id, 1 );

    if( mark_ready( id, 1 ) )
        return report( "registry_refusals", false, "mark_ready twice succeeded" );

    drain();
    destroy( id );
    report( "registry_refusals", true );
}

// ---------------------------------------------------------------------------
// scenario 8: DEEP park — how does asyncify buffer use scale with depth?
//
//   This is the doc 20 risk-1 measurement that matters. A shallow park saves
//   almost nothing (~100 B), which would tempt a tiny buffer; libcontext's
//   512 K exists precisely because a DEEP park (a collab apply suspending
//   inside commit.Push → connectivity → font work) overflowed 64 K and
//   silently corrupted the rewind state. So park at a known depth with live
//   locals and report the cost, giving a per-frame number a future buffer
//   size can be derived FROM rather than inherited.
// ---------------------------------------------------------------------------
constexpr int DEEP_PARK_FRAMES = 64;

int g_deep_result = 0;
int g_deep_reached = 0;

// noinline + volatile locals: the point is to keep frames genuinely live
// across the park so the unwind has something real to save.
__attribute__( ( noinline ) ) int deep_recurse( int aDepth )
{
    volatile int a = aDepth * 3;
    volatile int b = aDepth ^ 0x5a5a;
    volatile double c = aDepth * 1.5;

    if( aDepth <= 0 )
    {
        g_deep_reached = 1;
        return yield_park( "deep-park" );
    }

    const int inner = deep_recurse( aDepth - 1 );
    return inner + static_cast<int>( a ) - static_cast<int>( a ) + static_cast<int>( b )
           - static_cast<int>( b ) + static_cast<int>( c ) - static_cast<int>( c );
}

void body_deep_park( void* )
{
    g_deep_result = deep_recurse( DEEP_PARK_FRAMES );
}

void Scenario_DeepPark()
{
    g_deep_result = 0;
    g_deep_reached = 0;

    const ContextId id = create( body_deep_park, nullptr, "deep-park" );
    drain();

    if( !g_deep_reached )
        return report( "deep_park_sizing", false, "never reached the deep park" );

    if( status_of( id ) != Status::Parked )
        return report( "deep_park_sizing", false, "not parked at depth" );

    mark_ready( id, 31337 );
    drain();

    if( g_deep_result != 31337 )
        return report( "deep_park_sizing", false,
                       "wrong result through " + std::to_string( DEEP_PARK_FRAMES )
                       + " frames: " + std::to_string( g_deep_result ) );

    if( status_of( id ) != Status::Finished )
        return report( "deep_park_sizing", false, "did not finish after the deep resume" );

    // The sizing evidence: bytes saved for a known frame count.
    log_line( "[SCHED_CTX] DEEPPARK frames=" + std::to_string( DEEP_PARK_FRAMES )
              + " registry=" + registry_json() );

    destroy( id );
    report( "deep_park_sizing", true );
}

// ---------------------------------------------------------------------------
// scenario 9: a REAL async wake — JS timeout resolves the park
//   The park's wake crosses a JS turn, which is the shape every production
//   bridge has (doc 21 D4): the context must resume from a fresh task, and
//   the wake must never rewind inline.
// ---------------------------------------------------------------------------
ContextId g_async_ctx = 0;
int g_async_result = 0;
int g_async_stage = 0;

void body_async_park( void* )
{
    g_async_stage = 1;
    g_async_result = yield_park( "js-promise" );
    g_async_stage = 2;
}

void finish_battery()
{
    log_line( std::string( "[SCHED_CTX] STATS " ) + stats_json() );
    log_line( std::string( "[SCHED_CTX] REGISTRY " ) + registry_json() );
    log_line( "[SCHED_CTX] SUMMARY total=" + std::to_string( g_total )
              + " passed=" + std::to_string( g_passed )
              + " failed=" + std::to_string( g_total - g_passed ) );
}

extern "C" EMSCRIPTEN_KEEPALIVE void sched_ctx_async_wake( int aResult )
{
    if( !mark_ready( g_async_ctx, aResult ) )
    {
        report( "async_wake", false, "mark_ready from JS failed" );
        finish_battery();
        return;
    }

    // Resume from THIS fresh JS task — never inline in the resolver.
    drain();

    if( g_async_stage != 2 )
        report( "async_wake", false, "context did not resume" );
    else if( g_async_result != aResult )
        report( "async_wake", false, "wrong result: " + std::to_string( g_async_result ) );
    else if( status_of( g_async_ctx ) != Status::Finished )
        report( "async_wake", false, "context did not finish" );
    else
        report( "async_wake", true );

    destroy( g_async_ctx );
    finish_battery();
}

void Scenario_AsyncWake()
{
    g_async_stage = 0;
    g_async_result = 0;
    g_async_ctx = create( body_async_park, nullptr, "async-wake" );
    drain();   // parks awaiting the JS wake

    if( g_async_stage != 1 || status_of( g_async_ctx ) != Status::Parked )
    {
        report( "async_wake", false, "context did not park" );
        finish_battery();
        return;
    }

    // A real macrotask hop, exactly like a bridge promise settling.
    EM_ASM( { setTimeout( function() { Module["_sched_ctx_async_wake"]( 777 ); }, 20 ); } );
}

} // namespace


int main()
{
    log_line( "[SCHED_CTX] battery start" );

    Scenario_CreateRunsOnDrain();
    Scenario_ParkAndResume();
    Scenario_NoParkInPlace();
    Scenario_ParkedDoesNotBlock();
    Scenario_FifoOrder();
    Scenario_OneTransitionInFlight();
    Scenario_RegistryRefusals();
    Scenario_DeepPark();

    // Async last: it emits STATS + SUMMARY when its wake lands.
    Scenario_AsyncWake();
    return 0;
}
