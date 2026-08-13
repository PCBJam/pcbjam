/*
 * Scheduler-context harness — Design B D1 gate
 * (pcbjam docs/features/async/20-design-b-core-plan.md §6 D1).
 *
 * Exercises wx/wasm/private/sched_context.h — create / yield_park /
 * mark_ready / drain — against the invariants that make a resume something the registry
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

#include "wx/wasm/private/sched_context.h"
#include "wx/wasm/private/execution_owner.h"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <string>
#include <vector>

using namespace pcbjam_sched;

namespace
{
ContextId g_last_inplace_park_begin = 0;
ContextId g_last_inplace_park_end = 0;
}

// This harness does not link wx, so provide the two production leaf exports
// which let the handleSleep shim attribute an in-place park to the exact fiber
// stack that owns it.
extern "C" unsigned EMSCRIPTEN_KEEPALIVE wxWasmSchedInplaceParkBegin()
{
    const ContextId id = context_owning_current_stack();

    if( id )
        note_inplace_park( id, +1 );

    g_last_inplace_park_begin = id;
    return id;
}


extern "C" void EMSCRIPTEN_KEEPALIVE wxWasmSchedInplaceParkEnd( unsigned aId )
{
    if( aId )
        note_inplace_park( aId, -1 );

    g_last_inplace_park_end = aId;
}

// Defined with the production readiness predicate below. The in-place-park
// reducer calls it from a later browser task, which is the exact stack where
// the old current()==0-only predicate admitted a colliding native entry.
extern "C" int EMSCRIPTEN_KEEPALIVE wxWasmNativeEntryReady();

EM_JS( int, sched_ctx_seed_generated_fiber_guard,
       ( unsigned aFiber ), {
    if (typeof Fibers === "undefined" || !Fibers.__validSuspensions
        || !Fibers.__internallyParked || !Fibers.__parkSleepBuf)
        return 0;
    aFiber = aFiber >>> 0;
    Fibers.__validSuspensions.add(aFiber);
    Fibers.__internallyParked.add(aFiber);
    Fibers.__parkSleepBuf.set(aFiber, 0x1234);
    return 1;
} );

EM_JS( int, sched_ctx_generated_fiber_guard_contains,
       ( unsigned aFiber ), {
    if (typeof Fibers === "undefined" || !Fibers.__validSuspensions
        || !Fibers.__internallyParked || !Fibers.__parkSleepBuf)
        return -1;
    aFiber = aFiber >>> 0;
    return Fibers.__validSuspensions.has(aFiber)
            || Fibers.__internallyParked.has(aFiber)
            || Fibers.__parkSleepBuf.has(aFiber) ? 1 : 0;
} );


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
    const ParkResult parked = yield_park( "test-park" );
    g_park_result = parked.accepted ? parked.value : -1;
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
    const ParkResult parked = yield_park( "illegal" );

    if( parked.accepted )
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
// semantic owner reducer: a physical context may park without making the
// shared model available to unrelated stateful work
// ---------------------------------------------------------------------------
enum class ReducerPhase
{
    StableBefore,
    Half,
    StableAfter
};

struct ReducerJob
{
    wx_wasm_execution::WorkClass workClass;
    wx_wasm_execution::ScopeToken targetScope;
    const char* name;
    void (*run)();
};

struct AdmittedReducerJob
{
    ReducerJob job;
    wx_wasm_execution::Admission admission;
};

wx_wasm_execution::Coordinator g_owner_coordinator;
wx_wasm_execution::OwnerToken g_owner_a;
wx_wasm_execution::OwnerToken g_modal_child;
wx_wasm_execution::LeaseToken g_modal_lease;
ContextId g_owner_context = 0;
ReducerPhase g_reducer_phase = ReducerPhase::StableBefore;
std::vector<ReducerJob> g_owner_jobs;
std::vector<std::string> g_owner_log;
std::string g_owner_failure;
int g_owner_wait_result = 0;
int g_half_reads = 0;
int g_half_mutations = 0;
int g_half_wrong_scope_runs = 0;
int g_modal_input_runs = 0;
int g_modal_timer_runs = 0;
int g_model_generation = 0;
int g_modal_scope_anchor = 0;
int g_main_scope_anchor = 0;
wx_wasm_execution::ScopeToken g_modal_scope;
wx_wasm_execution::ScopeToken g_main_scope;

void owner_fail(const std::string& detail)
{
    if (g_owner_failure.empty())
        g_owner_failure = detail;
}

void reducer_read()
{
    if (g_reducer_phase == ReducerPhase::Half)
        ++g_half_reads;

    g_owner_log.push_back("B:read");
}

void reducer_mutate()
{
    if (g_reducer_phase == ReducerPhase::Half)
        ++g_half_mutations;

    ++g_model_generation;
    g_owner_log.push_back("C:mutate");
}

void reducer_modal_input()
{
    ++g_modal_input_runs;
    g_owner_log.push_back("M:input");
}

void reducer_modal_timer()
{
    ++g_modal_timer_runs;
    g_owner_log.push_back("T:chooser");
}

void reducer_wrong_scope_input()
{
    if (g_reducer_phase == ReducerPhase::Half)
        ++g_half_wrong_scope_runs;

    g_owner_log.push_back("X:wrong-input");
}

void reducer_unscoped_pending()
{
    if (g_reducer_phase == ReducerPhase::Half)
        ++g_half_wrong_scope_runs;

    g_owner_log.push_back("P:unscoped");
}

void reducer_main_timer()
{
    if (g_reducer_phase == ReducerPhase::Half)
        ++g_half_wrong_scope_runs;

    g_owner_log.push_back("T:main");
}

void admitted_reducer_entry(void* arg)
{
    AdmittedReducerJob* admitted = static_cast<AdmittedReducerJob*>(arg);
    admitted->job.run();
}

bool DrainOneOwnerJob()
{
    // Skip an ineligible ordinary head so an explicit child-lease item later
    // in the queue can keep the modal usable. Deferred ordinary jobs retain
    // their relative order.
    for (size_t i = 0; i < g_owner_jobs.size(); ++i)
    {
        const wx_wasm_execution::Admission admission =
                g_owner_coordinator.Admit(g_owner_jobs[i].workClass,
                                          g_owner_jobs[i].targetScope);

        if (!admission)
            continue;

        AdmittedReducerJob admitted{g_owner_jobs[i], admission};
        g_owner_jobs.erase(g_owner_jobs.begin() + i);

        if (admission.kind == wx_wasm_execution::AdmissionKind::Child)
            g_modal_child = admission.owner;

        const ContextId context = create(admitted_reducer_entry, &admitted,
                                         admitted.job.name);

        if (!context)
        {
            owner_fail("could not create admitted job context");
            return false;
        }

        drain();

        if (status_of(context) != Status::Finished)
            owner_fail(std::string(admitted.job.name) + " did not finish");

        destroy(context);

        if (!g_owner_coordinator.Release(admission.owner))
            owner_fail(std::string("could not release ") + admitted.job.name);

        return true;
    }

    return false;
}

void DrainOwnerJobs()
{
    while (DrainOneOwnerJob())
    {
    }
}

void owner_a_entry(void*)
{
    const wx_wasm_execution::Admission admission =
            g_owner_coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);

    if (!admission || admission.kind != wx_wasm_execution::AdmissionKind::Root)
    {
        owner_fail("A could not acquire the root owner");
        return;
    }

    g_owner_a = admission.owner;

    // Model runOnFiber: the scheduling call owns the initial reference, while
    // the affiliated body retains one that survives after Call() returns.
    if (!g_owner_coordinator.Retain(g_owner_a)
        || !g_owner_coordinator.Release(admission.owner))
    {
        owner_fail("A could not transfer ownership to its affiliated body");
        return;
    }

    g_owner_log.push_back("A:enter");
    g_reducer_phase = ReducerPhase::Half;
    g_owner_log.push_back("A:half");

    g_modal_lease = g_owner_coordinator.OpenLease(
            g_owner_a, wx_wasm_execution::ModalWorkMask, g_modal_scope);

    if (!g_modal_lease)
        owner_fail("A could not open its modal child lease");

    // This is the real scheduler-context park. A's C stack and wait result are
    // physical scheduler state; g_owner_a is independent semantic state.
    const ParkResult parked = yield_park("execution-owner-half");
    g_owner_wait_result = parked.accepted ? parked.value : -1;

    if (g_owner_wait_result != 707)
        owner_fail("A resumed from the wrong exact wake");

    if (!g_owner_coordinator.CloseLease(g_modal_lease))
        owner_fail("A could not close its child lease after resume");

    g_reducer_phase = ReducerPhase::StableAfter;
    g_owner_log.push_back("A:return");

    if (!g_owner_coordinator.Release(g_owner_a))
        owner_fail("A could not release its root owner");
}

void CheckExactAffiliatedBranchEligibility()
{
    wx_wasm_execution::Coordinator coordinator;
    int scopeAnchor = 0;
    const wx_wasm_execution::ScopeToken scope =
            wx_wasm_execution::ScopeFromPointer(&scopeAnchor, 41);
    const wx_wasm_execution::Admission root =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);

    if (!root || !coordinator.Retain(root.owner)
        || !coordinator.Release(root.owner))
    {
        owner_fail("could not create retained parent for affiliated reducer");
        return;
    }

    const wx_wasm_execution::LeaseToken lease = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, scope);
    const wx_wasm_execution::Admission child = coordinator.Admit(
            wx_wasm_execution::WorkClass::UserInput, scope);

    if (!lease || !child || !coordinator.Retain(child.owner)
        || !coordinator.Release(child.owner))
    {
        owner_fail("could not create retained child for affiliated reducer");
        return;
    }

    if (coordinator.CanRunAffiliated(root.owner))
        owner_fail("retained parent ran across its active child branch");

    if (!coordinator.CanRunAffiliated(child.owner))
        owner_fail("exact active child continuation was not eligible");

    if (!coordinator.Release(child.owner))
    {
        owner_fail("could not release exact child continuation");
        return;
    }

    if (coordinator.CanRunAffiliated(root.owner))
        owner_fail("parent ran at child-zero while its lease remained open");

    if (!coordinator.BeginClose(lease) || !coordinator.LeaseReady(lease)
        || !coordinator.CloseLease(lease))
    {
        owner_fail("could not close exact affiliated reducer lease");
        return;
    }

    if (!coordinator.CanRunAffiliated(root.owner))
        owner_fail("parent did not become eligible after exact lease close");

    if (!coordinator.Release(root.owner))
        owner_fail("could not release affiliated reducer parent");
}

void Scenario_ExecutionOwnerHalfReducer()
{
    g_owner_coordinator = wx_wasm_execution::Coordinator{};
    g_owner_a = {};
    g_modal_child = {};
    g_modal_lease = {};
    g_reducer_phase = ReducerPhase::StableBefore;
    g_owner_jobs.clear();
    g_owner_log.clear();
    g_owner_failure.clear();
    g_owner_wait_result = 0;
    g_half_reads = 0;
    g_half_mutations = 0;
    g_half_wrong_scope_runs = 0;
    g_modal_input_runs = 0;
    g_modal_timer_runs = 0;
    g_model_generation = 0;
    g_modal_scope = wx_wasm_execution::ScopeFromPointer(
            &g_modal_scope_anchor, 17);
    g_main_scope = wx_wasm_execution::ScopeFromPointer(
            &g_main_scope_anchor, 23);

    CheckExactAffiliatedBranchEligibility();

    g_owner_context = create(owner_a_entry, nullptr, "owner-A");
    drain();

    if (status_of(g_owner_context) != Status::Parked
        || g_reducer_phase != ReducerPhase::Half || !g_owner_a)
    {
        return report("execution_owner_half_reducer", false,
                      "A did not hold Half while physically parked");
    }

    // B and C are unrelated model work. The other three deferred callbacks
    // deliberately look like modal work by class, but do not carry the exact
    // target scope. Only the chooser-owned timer and M carry both the class
    // and scope permitted by A's child lease.
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::Ordinary,
                            {},
                            "root-read-B", reducer_read});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::Ordinary,
                            {},
                            "root-mutate-C", reducer_mutate});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::UserInput,
                            wx_wasm_execution::ScopeFromPointer(
                                    &g_modal_scope_anchor, 18),
                            "wrong-generation-input-X",
                            reducer_wrong_scope_input});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::PendingEvents,
                            {},
                            "unscoped-pending-P", reducer_unscoped_pending});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::ModalLifecycle,
                            g_main_scope,
                            "main-frame-timer", reducer_main_timer});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::ModalLifecycle,
                            g_modal_scope,
                            "chooser-owned-timer", reducer_modal_timer});
    g_owner_jobs.push_back({wx_wasm_execution::WorkClass::UserInput,
                            g_modal_scope,
                            "modal-input-M", reducer_modal_input});

    DrainOwnerJobs();

    if (g_modal_timer_runs != 1 || g_modal_input_runs != 1
        || g_owner_jobs.size() != 5)
    {
        owner_fail("only matching modal work did not bypass the deferred head");
    }

    if (g_half_reads != 0 || g_half_mutations != 0
        || g_half_wrong_scope_runs != 0 || g_model_generation != 0)
        owner_fail("unrelated stateful work entered while A exposed Half");

    if (!g_modal_child || g_modal_child.id == g_owner_a.id
        || g_modal_child.parent != g_owner_a.id)
    {
        owner_fail("modal child did not receive a distinct descendant owner");
    }

    if (g_owner_coordinator.RootOwner() != g_owner_a)
        owner_fail("child input replaced A instead of borrowing its lease");

    // Closing stops further child admission before the exact wake. Only the
    // wake of A's physical ContextId can move the model out of Half.
    if (!g_owner_coordinator.BeginClose(g_modal_lease))
        owner_fail("could not begin modal lease close");

    if (!g_owner_coordinator.LeaseReady(g_modal_lease))
        owner_fail("modal lease was not ready after its exact child reached zero");

    if (g_owner_coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                                  g_modal_scope))
        owner_fail("closing modal lease admitted new input before the exact wake");

    if (!mark_ready(g_owner_context, 707))
        owner_fail("exact wake could not mark A ready");

    drain();

    if (status_of(g_owner_context) != Status::Finished
        || g_reducer_phase != ReducerPhase::StableAfter)
    {
        owner_fail("exact wake did not finish A");
    }

    // A is complete, so ordinary root work now drains in original FIFO order.
    DrainOwnerJobs();

    const char* expected[] = {
        "A:enter", "A:half", "T:chooser", "M:input", "A:return",
        "B:read", "C:mutate", "X:wrong-input", "P:unscoped", "T:main"
    };

    if (g_owner_log.size() != sizeof(expected) / sizeof(expected[0]))
    {
        owner_fail("unexpected execution-log length");
    }
    else
    {
        for (size_t i = 0; i < g_owner_log.size(); ++i)
        {
            if (g_owner_log[i] != expected[i])
            {
                owner_fail("execution order differs at index " + std::to_string(i));
                break;
            }
        }
    }

    if (!g_owner_jobs.empty() || g_half_reads != 0 || g_half_mutations != 0
        || g_half_wrong_scope_runs != 0 || g_model_generation != 1
        || g_owner_coordinator.RootOwner())
    {
        owner_fail("reducer did not finish in a stable, idle state");
    }

    destroy(g_owner_context);
    report("execution_owner_half_reducer", g_owner_failure.empty(), g_owner_failure);
}

// A positive main-thread sleep parks the exact root context. Browser input
// which arrives during that park cannot acquire a second root, but the resumed
// owner must be able to consume it from its next wxYield(). Ordinary service
// work remains queued until the root transaction has really returned.
struct NestedPumpReducerJob
{
    wx_wasm_execution::WorkClass workClass;
    wx_wasm_execution::ScopeToken targetScope;
    wx_wasm_execution::LeaseToken leaseProvenance;
    const char* name;
};

wx_wasm_execution::Coordinator g_nested_pump_coordinator;
wx_wasm_execution::OwnerToken g_nested_pump_owner;
std::vector<NestedPumpReducerJob> g_nested_pump_jobs;
std::vector<std::string> g_nested_pump_log;
std::string g_nested_pump_failure;
ContextId g_nested_pump_context = 0;
WakeToken g_nested_pump_wake = 0;
int g_nested_pump_stage = 0;
int g_nested_pump_mouse_runs = 0;
int g_nested_pump_ordinary_runs = 0;
bool g_nested_pump_ordinary_waited = false;

bool cancel_nested_pump_sleep(ContextId, WakeToken)
{
    // The reducer consumes this exact timer wake, so cancellation is not
    // expected. A valid revoker is still part of a Cancellable park lease.
    return true;
}

void RunNestedPumpReducerJob(const NestedPumpReducerJob& job)
{
    g_nested_pump_log.push_back(job.name);
    if (job.workClass == wx_wasm_execution::WorkClass::Ordinary)
        ++g_nested_pump_ordinary_runs;
    else if (job.workClass == wx_wasm_execution::WorkClass::UserInput)
        ++g_nested_pump_mouse_runs;
}

void DrainNestedPumpReducerSnapshot()
{
    size_t budget = g_nested_pump_jobs.size();

    while (budget > 0)
    {
        bool progressed = false;

        for (size_t i = 0; i < g_nested_pump_jobs.size(); ++i)
        {
            const NestedPumpReducerJob& candidate = g_nested_pump_jobs[i];
            if (!g_nested_pump_coordinator.CanRunNestedIngress(
                    g_nested_pump_owner, candidate.workClass,
                    candidate.targetScope, candidate.leaseProvenance))
            {
                continue;
            }

            const NestedPumpReducerJob job = candidate;
            g_nested_pump_jobs.erase(g_nested_pump_jobs.begin() + i);
            RunNestedPumpReducerJob(job);
            --budget;
            progressed = true;
            break;
        }

        if (!progressed)
            return;
    }
}

void nested_pump_root_entry(void*)
{
    const wx_wasm_execution::Admission root =
            g_nested_pump_coordinator.Admit(
                    wx_wasm_execution::WorkClass::Ordinary);

    if (!root || root.kind != wx_wasm_execution::AdmissionKind::Root)
    {
        g_nested_pump_failure = "positive-sleep body did not acquire root";
        return;
    }

    g_nested_pump_owner = root.owner;
    g_nested_pump_log.push_back("root:positive-sleep");
    g_nested_pump_stage = 1;

    const ParkResult parked = yield_park(
            "root-positive-sleep",
            ParkWake::Cancellable(
                    g_nested_pump_wake, &cancel_nested_pump_sleep));

    if (!parked.accepted || parked.value != 19)
    {
        g_nested_pump_failure = "root did not resume from its exact sleep wake";
    }

    g_nested_pump_stage = 2;
    g_nested_pump_log.push_back("root:yield-enter");

    // This models the staged-ingress portion of the production wxYield path.
    DrainNestedPumpReducerSnapshot();

    g_nested_pump_ordinary_waited =
            g_nested_pump_jobs.size() == 1
            && g_nested_pump_jobs[0].workClass
                    == wx_wasm_execution::WorkClass::Ordinary
            && g_nested_pump_ordinary_runs == 0;
    g_nested_pump_log.push_back("root:yield-exit");
    g_nested_pump_stage = 3;

    if (!g_nested_pump_coordinator.Release(root.owner)
        && g_nested_pump_failure.empty())
    {
        g_nested_pump_failure = "root refused release after nested yield";
    }
}

bool CheckNestedPumpModalPolicy()
{
    wx_wasm_execution::Coordinator coordinator;
    int scopeAnchor = 0;
    int otherAnchor = 0;
    int nestedAnchor = 0;
    const wx_wasm_execution::ScopeToken scope =
            wx_wasm_execution::ScopeFromPointer(&scopeAnchor, 301);
    const wx_wasm_execution::ScopeToken staleScope =
            wx_wasm_execution::ScopeFromPointer(&scopeAnchor, 300);
    const wx_wasm_execution::ScopeToken otherScope =
            wx_wasm_execution::ScopeFromPointer(&otherAnchor, 301);
    const wx_wasm_execution::ScopeToken nestedScope =
            wx_wasm_execution::ScopeFromPointer(&nestedAnchor, 301);
    const wx_wasm_execution::Admission root = coordinator.Admit(
            wx_wasm_execution::WorkClass::Ordinary);
    const wx_wasm_execution::LeaseToken lease = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, scope);
    const wx_wasm_execution::Admission child = coordinator.Admit(
            wx_wasm_execution::WorkClass::UserInput, scope);

    if (!root || !lease || !child)
        return false;

    if (!coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::UserInput,
                scope, lease)
        || coordinator.CanRunNestedIngress(
                root.owner, wx_wasm_execution::WorkClass::UserInput,
                scope, lease)
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::Ordinary,
                scope, lease)
        // Global browser resize/focus are ModalLifecycle work. Even a
        // synchronous callback on the modal child's stack must stage them;
        // owner mapping alone is not permission to run them inline.
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::ModalLifecycle,
                {}, {})
        || coordinator.CanRunNestedIngress(
                root.owner, wx_wasm_execution::WorkClass::ModalLifecycle,
                {}, {})
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::UserInput,
                scope, {})
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::UserInput,
                staleScope, lease)
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::PendingEvents,
                otherScope, lease))
    {
        return false;
    }

    // Opening L2 does not immediately make its parent (the L1 child) eligible
    // to consume work transferred to L2. This is the nested-modal form of the
    // ShowModal pre-park interval: only L2's own admitted child may run it.
    const wx_wasm_execution::LeaseToken nestedLease = coordinator.OpenLease(
            child.owner, wx_wasm_execution::ModalWorkMask, nestedScope);

    if (!nestedLease
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::PendingEvents,
                nestedScope, nestedLease))
    {
        return false;
    }

    const wx_wasm_execution::Admission nestedChild = coordinator.Admit(
            wx_wasm_execution::WorkClass::PendingEvents, nestedScope);

    if (!nestedChild
        || !coordinator.CanRunNestedIngress(
                nestedChild.owner,
                wx_wasm_execution::WorkClass::PendingEvents,
                nestedScope, nestedLease)
        || coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::PendingEvents,
                nestedScope, nestedLease)
        || !coordinator.Release(nestedChild.owner)
        || !coordinator.BeginClose(nestedLease)
        || coordinator.CanRunNestedIngress(
                nestedChild.owner,
                wx_wasm_execution::WorkClass::PendingEvents,
                nestedScope, nestedLease)
        || !coordinator.LeaseReady(nestedLease)
        || !coordinator.CloseLease(nestedLease)
        || !coordinator.CanRunNestedIngress(
                child.owner, wx_wasm_execution::WorkClass::PendingEvents,
                scope, lease))
    {
        return false;
    }

    return coordinator.Release(child.owner)
           && coordinator.BeginClose(lease)
           && coordinator.LeaseReady(lease)
           && coordinator.CloseLease(lease)
           && coordinator.Release(root.owner);
}

void Scenario_ExecutionOwnerPositiveSleepNestedPump()
{
    g_nested_pump_coordinator = wx_wasm_execution::Coordinator{};
    g_nested_pump_owner = {};
    g_nested_pump_jobs.clear();
    g_nested_pump_log.clear();
    g_nested_pump_failure.clear();
    g_nested_pump_context = 0;
    g_nested_pump_wake = reserve_wake_token();
    g_nested_pump_stage = 0;
    g_nested_pump_mouse_runs = 0;
    g_nested_pump_ordinary_runs = 0;
    g_nested_pump_ordinary_waited = false;

    if (!g_nested_pump_wake || !CheckNestedPumpModalPolicy())
    {
        return report(
                "execution_owner_positive_sleep_nested_pump", false,
                "nested-pump wake allocation or modal policy failed");
    }

    g_nested_pump_context = create(
            nested_pump_root_entry, nullptr, "positive-sleep-nested-pump");
    drain();

    if (!g_nested_pump_context
        || status_of(g_nested_pump_context) != Status::Parked
        || g_nested_pump_stage != 1 || !g_nested_pump_owner)
    {
        return report(
                "execution_owner_positive_sleep_nested_pump", false,
                "root did not establish its exact positive-sleep park");
    }

    // Keep Ordinary at the head to prove that it neither runs nor hides the
    // later mouse-up which the current root is allowed to continue.
    g_nested_pump_jobs.push_back(
            {wx_wasm_execution::WorkClass::Ordinary,
             {}, {}, "ordinary:service"});
    g_nested_pump_jobs.push_back(
            {wx_wasm_execution::WorkClass::UserInput,
             {}, {}, "input:mouse-up"});

    if (g_nested_pump_coordinator.Admit(
                wx_wasm_execution::WorkClass::UserInput))
    {
        g_nested_pump_failure =
                "parked input incorrectly acquired another root owner";
    }

    if (mark_ready_owned(
            g_nested_pump_context, 19, g_nested_pump_wake + 1)
        || status_of(g_nested_pump_context) != Status::Parked)
    {
        g_nested_pump_failure = "stale timer token consumed the root park";
    }

    if (!mark_ready_owned(
            g_nested_pump_context, 19, g_nested_pump_wake))
    {
        g_nested_pump_failure = "exact timer token did not wake the root";
    }

    drain();

    const char* expected[] = {
        "root:positive-sleep", "root:yield-enter", "input:mouse-up",
        "root:yield-exit"
    };

    if (status_of(g_nested_pump_context) != Status::Finished
        || g_nested_pump_stage != 3 || g_nested_pump_mouse_runs != 1
        || !g_nested_pump_ordinary_waited
        || g_nested_pump_log.size() != sizeof(expected) / sizeof(expected[0]))
    {
        if (g_nested_pump_failure.empty())
            g_nested_pump_failure =
                    "exact wake/yield did not consume only the mouse-up";
    }
    else
    {
        for (size_t i = 0; i < g_nested_pump_log.size(); ++i)
        {
            if (g_nested_pump_log[i] != expected[i])
            {
                g_nested_pump_failure =
                        "nested-pump execution order differs at index "
                        + std::to_string(i);
                break;
            }
        }
    }

    // Once the original root has returned, the deferred Ordinary job can
    // acquire a fresh root. Run it only after the assertion above.
    if (!g_nested_pump_jobs.empty())
    {
        const wx_wasm_execution::Admission ordinary =
                g_nested_pump_coordinator.Admit(
                        wx_wasm_execution::WorkClass::Ordinary);
        if (!ordinary)
        {
            if (g_nested_pump_failure.empty())
                g_nested_pump_failure = "deferred Ordinary never became eligible";
        }
        else
        {
            const NestedPumpReducerJob job = g_nested_pump_jobs.front();
            g_nested_pump_jobs.erase(g_nested_pump_jobs.begin());
            RunNestedPumpReducerJob(job);
            if (!g_nested_pump_coordinator.Release(ordinary.owner)
                && g_nested_pump_failure.empty())
            {
                g_nested_pump_failure = "deferred Ordinary root refused release";
            }
        }
    }

    destroy(g_nested_pump_context);
    report("execution_owner_positive_sleep_nested_pump",
           g_nested_pump_failure.empty(), g_nested_pump_failure);
}

// A popup menu handles selection in its exact JS completion path. Its lease
// therefore admits only lifecycle work for the opener's target family. A
// generic canvas event cannot borrow that lease merely because it came from
// the same top-level window.
void Scenario_ExecutionOwnerPopupScopePolicy()
{
    wx_wasm_execution::Coordinator coordinator;
    int popup_scope_anchor = 0;
    int other_scope_anchor = 0;
    const wx_wasm_execution::ScopeToken popup_scope =
            wx_wasm_execution::ScopeFromPointer(&popup_scope_anchor, 101);
    const wx_wasm_execution::ScopeToken stale_popup_scope =
            wx_wasm_execution::ScopeFromPointer(&popup_scope_anchor, 100);
    const wx_wasm_execution::ScopeToken other_scope =
            wx_wasm_execution::ScopeFromPointer(&other_scope_anchor, 101);
    std::string failure;

    const wx_wasm_execution::Admission root =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);

    if (!root || root.kind != wx_wasm_execution::AdmissionKind::Root)
        failure = "could not acquire popup opener root";

    const wx_wasm_execution::LeaseToken lease = coordinator.OpenLease(
            root.owner,
            wx_wasm_execution::WorkBit(
                    wx_wasm_execution::WorkClass::ModalLifecycle),
            popup_scope);

    if (failure.empty() && !lease)
        failure = "could not open popup lifecycle lease";

    if (lease && coordinator.CloseLease(lease) && failure.empty())
        failure = "popup lease closed before BeginClose";

    if (failure.empty()
        && coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                             popup_scope))
    {
        failure = "generic popup-scope input borrowed lifecycle-only lease";
    }

    if (failure.empty()
        && coordinator.Admit(wx_wasm_execution::WorkClass::ModalLifecycle,
                             stale_popup_scope))
    {
        failure = "stale target generation borrowed popup lease";
    }

    if (failure.empty()
        && coordinator.Admit(wx_wasm_execution::WorkClass::ModalLifecycle,
                             other_scope))
    {
        failure = "unrelated target borrowed popup lease";
    }

    const wx_wasm_execution::Admission lifecycle = coordinator.Admit(
            wx_wasm_execution::WorkClass::ModalLifecycle, popup_scope);

    if (failure.empty()
        && (!lifecycle
            || lifecycle.kind != wx_wasm_execution::AdmissionKind::Child))
    {
        failure = "matching popup lifecycle callback was not admitted";
    }

    // Model a popup callback whose runOnFiber body outlives the shallow event
    // handler. Close may be requested after the handler reference returns,
    // but the parked opener must not wake while the retained child is live.
    if (lifecycle && !coordinator.Retain(lifecycle.owner) && failure.empty())
        failure = "could not retain popup lifecycle child";

    if (lifecycle && !coordinator.Release(lifecycle.owner) && failure.empty())
        failure = "could not release popup handler reference";

    if (lease && !coordinator.BeginClose(lease) && failure.empty())
        failure = "could not begin popup close";

    if (lease && coordinator.LeaseReady(lease) && failure.empty())
        failure = "popup became ready while its retained child was live";

    if (failure.empty()
        && coordinator.OpenLease(
                lifecycle.owner,
                wx_wasm_execution::WorkBit(
                        wx_wasm_execution::WorkClass::ModalLifecycle),
                popup_scope))
    {
        failure = "closing popup child opened a descendant lease";
    }

    if (failure.empty()
        && coordinator.Admit(wx_wasm_execution::WorkClass::ModalLifecycle,
                             popup_scope))
    {
        failure = "closing popup admitted another lifecycle callback";
    }

    if (lifecycle && !coordinator.Release(lifecycle.owner) && failure.empty())
        failure = "could not release retained popup child";

    if (lease && !coordinator.LeaseReady(lease) && failure.empty())
        failure = "popup did not become ready at exact child-zero";

    // A lease can keep its parent token as structural provenance after the
    // opener's last executing reference returns. Retain must not resurrect
    // that zero-reference owner into a new executor.
    if (root && !coordinator.Release(root.owner) && failure.empty())
        failure = "could not release popup opener root";

    if (failure.empty() && coordinator.Retain(root.owner))
        failure = "retained a structural zero-reference popup owner";

    if (lease && !coordinator.CloseLease(lease) && failure.empty())
        failure = "could not close popup lease";

    if (failure.empty() && coordinator.RootOwner())
        failure = "popup policy left a root owner behind";

    report("execution_owner_popup_scope_policy", failure.empty(), failure);
}

// Startup is an ordinary owner acquired before the browser pump is published.
// It blocks every unrelated stateful entry until OnInit/OnRun reaches its
// explicit publication tail; service work does not consult this coordinator.
void Scenario_ExecutionOwnerStartupBoundary()
{
    wx_wasm_execution::Coordinator coordinator;
    std::string failure;

    const wx_wasm_execution::Admission startup =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);

    if (!startup || startup.kind != wx_wasm_execution::AdmissionKind::Root)
        failure = "startup could not acquire the root owner";

    if (failure.empty()
        && coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary))
    {
        failure = "ordinary work entered before startup publication";
    }

    if (startup && !coordinator.Release(startup.owner) && failure.empty())
        failure = "startup owner refused terminal release";

    const wx_wasm_execution::Admission firstTick =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);

    if (failure.empty()
        && (!firstTick
            || firstTick.kind != wx_wasm_execution::AdmissionKind::Root
            || firstTick.owner == startup.owner))
    {
        failure = "first post-startup tick did not receive a fresh owner";
    }

    if (firstTick && !coordinator.Release(firstTick.owner) && failure.empty())
        failure = "first post-startup owner refused terminal release";

    if (failure.empty() && coordinator.RootOwner())
        failure = "startup boundary left an owner behind";

    report("execution_owner_startup_boundary", failure.empty(), failure);
}

// A mailbox timer can expire behind an already-running child. Its scope alone
// is not sufficient provenance: the same dialog object can open a new lease
// generation before the native-entry arbiter delivers the mailbox tick. Pin
// the timer at scheduling time to L1 and prove that reopening the same scope
// as L2 cannot admit it.
void Scenario_ExecutionLeaseProvenanceReopen()
{
    wx_wasm_execution::Coordinator coordinator;
    int scope_anchor = 0;
    int other_scope_anchor = 0;
    const wx_wasm_execution::ScopeToken scope =
            wx_wasm_execution::ScopeFromPointer(&scope_anchor, 71);
    const wx_wasm_execution::ScopeToken other_scope =
            wx_wasm_execution::ScopeFromPointer(&other_scope_anchor, 71);
    std::string failure;

    const wx_wasm_execution::Admission root =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);
    const wx_wasm_execution::LeaseToken lease1 = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, scope);
    const wx_wasm_execution::Admission blocker = coordinator.Admit(
            wx_wasm_execution::WorkClass::UserInput, scope);

    // This timer cannot run yet because L1 already has a child. Capture the
    // exact lease generation now, where wxWasmMailboxEnqueueAfterScoped()
    // schedules it, before either the JS delay or native-entry queue waits.
    const wx_wasm_execution::LeaseToken queuedProvenance =
            wx_wasm_execution::LeaseProvenanceForIngress(
                    wx_wasm_execution::WorkClass::ModalLifecycle, scope,
                    coordinator.ActiveLease());

    if (!root || !lease1 || !blocker)
        failure = "could not construct the blocked L1 ingress";
    else if (queuedProvenance != lease1)
        failure = "scoped timer did not capture exact L1 provenance";
    else if (wx_wasm_execution::LeaseProvenanceIsStale(
                     queuedProvenance, coordinator.ActiveLease(),
                     coordinator.LeaseAccepting()))
    {
        failure = "L1 provenance was stale while L1 was accepting";
    }
    else if (wx_wasm_execution::LeaseProvenanceForIngress(
                     wx_wasm_execution::WorkClass::Ordinary, scope, lease1))
    {
        failure = "ordinary work captured a child lease capability";
    }
    else if (wx_wasm_execution::LeaseProvenanceForIngress(
                     wx_wasm_execution::WorkClass::UserInput,
                     other_scope, lease1))
    {
        failure = "unrelated scope captured L1 provenance";
    }

    if (lease1 && !coordinator.BeginClose(lease1) && failure.empty())
        failure = "could not begin L1 close";

    if (failure.empty()
        && !wx_wasm_execution::LeaseProvenanceIsStale(
                queuedProvenance, coordinator.ActiveLease(),
                coordinator.LeaseAccepting()))
    {
        failure = "closing L1 did not make queued L1 timer stale";
    }

    if (blocker && !coordinator.Release(blocker.owner) && failure.empty())
        failure = "could not release L1 blocker";

    if (lease1
        && (!coordinator.LeaseReady(lease1)
            || !coordinator.CloseLease(lease1))
        && failure.empty())
    {
        failure = "could not finish L1 close";
    }

    const wx_wasm_execution::LeaseToken lease2 = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, scope);

    if (failure.empty() && (!lease2 || lease2 == lease1))
        failure = "same scope did not receive a distinct L2 generation";

    bool staleEnvelopeRan = false;
    if (failure.empty()
        && !wx_wasm_execution::LeaseProvenanceIsStale(
                queuedProvenance, coordinator.ActiveLease(),
                coordinator.LeaseAccepting()))
    {
        // This is the queue-drain decision. Calling Admit() here would borrow
        // L2; the stale predicate must discard the envelope before that call.
        const wx_wasm_execution::Admission staleAdmission = coordinator.Admit(
                wx_wasm_execution::WorkClass::ModalLifecycle, scope);
        staleEnvelopeRan = static_cast<bool>(staleAdmission);
        if (staleAdmission)
            coordinator.Release(staleAdmission.owner);
    }

    if (failure.empty() && staleEnvelopeRan)
        failure = "queued L1 timer borrowed reopened L2";

    const wx_wasm_execution::LeaseToken freshProvenance =
            wx_wasm_execution::LeaseProvenanceForIngress(
                    wx_wasm_execution::WorkClass::UserInput, scope,
                    coordinator.ActiveLease());
    const wx_wasm_execution::Admission freshAdmission =
            failure.empty()
                    && !wx_wasm_execution::LeaseProvenanceIsStale(
                            freshProvenance, coordinator.ActiveLease(),
                            coordinator.LeaseAccepting())
            ? coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                                scope)
            : wx_wasm_execution::Admission{};

    if (failure.empty()
        && (!freshAdmission
            || freshAdmission.kind
                    != wx_wasm_execution::AdmissionKind::Child
            || freshAdmission.lease != lease2))
    {
        failure = "fresh L2 input did not borrow exact L2";
    }

    if (freshAdmission
        && !coordinator.Release(freshAdmission.owner) && failure.empty())
    {
        failure = "could not release fresh L2 child";
    }

    if (lease2
        && (!coordinator.BeginClose(lease2)
            || !coordinator.LeaseReady(lease2)
            || !coordinator.CloseLease(lease2))
        && failure.empty())
    {
        failure = "could not close L2";
    }

    if (root && !coordinator.Release(root.owner) && failure.empty())
        failure = "could not release provenance reducer root";

    if (failure.empty() && coordinator.RootOwner())
        failure = "provenance reducer left an owner behind";

    report("execution_lease_provenance_reopen", failure.empty(), failure);
}

// A nested modal L2 can begin closing while its opener is still parked inside
// the accepting parent modal L1. Browser input for L1 must retain L1's exact
// generation at receipt time, but it must not enter while L2 remains the active
// lease or while L1's original child transaction is still live. Prove that the
// receipt query hands the capability back without changing admission semantics.
void Scenario_ExecutionIngressReceiptHandback()
{
    wx_wasm_execution::Coordinator coordinator;
    int parent_scope_anchor = 0;
    int child_scope_anchor = 0;
    const wx_wasm_execution::ScopeToken parentScope =
            wx_wasm_execution::ScopeFromPointer(&parent_scope_anchor, 81);
    const wx_wasm_execution::ScopeToken childScope =
            wx_wasm_execution::ScopeFromPointer(&child_scope_anchor, 82);
    std::string failure;

    const wx_wasm_execution::Admission root =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);
    const wx_wasm_execution::LeaseToken parentLease = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, parentScope);
    const wx_wasm_execution::Admission parentChild = coordinator.Admit(
            wx_wasm_execution::WorkClass::UserInput, parentScope);
    const wx_wasm_execution::LeaseToken childLease = coordinator.OpenLease(
            parentChild.owner, wx_wasm_execution::ModalWorkMask, childScope);

    if (!root || !parentLease || !parentChild || !childLease)
        failure = "could not construct nested accepting leases";
    else if (coordinator.ActiveLease() != childLease
             || coordinator.IngressReceiptLease() != childLease)
    {
        failure = "accepting L2 was not both active and published";
    }

    if (childLease && !coordinator.BeginClose(childLease) && failure.empty())
        failure = "could not begin L2 close";

    if (failure.empty() && coordinator.ActiveLease() != childLease)
        failure = "L2 stopped being active before its close completed";
    else if (failure.empty() && coordinator.LeaseAccepting())
        failure = "closing L2 still accepted native admission";
    else if (failure.empty()
             && coordinator.IngressReceiptLease() != parentLease)
    {
        failure = "receipt capability did not hand back from L2 to L1";
    }

    const wx_wasm_execution::LeaseToken parentReceipt =
            wx_wasm_execution::LeaseProvenanceForIngress(
                    wx_wasm_execution::WorkClass::UserInput, parentScope,
                    coordinator.IngressReceiptLease());
    const wx_wasm_execution::LeaseToken closingChildReceipt =
            wx_wasm_execution::LeaseProvenanceForIngress(
                    wx_wasm_execution::WorkClass::UserInput, childScope,
                    coordinator.IngressReceiptLease());

    if (failure.empty() && parentReceipt != parentLease)
        failure = "L1 browser input did not capture exact L1 provenance";
    else if (failure.empty() && closingChildReceipt)
        failure = "closing L2 input captured an ancestor capability";
    else if (failure.empty()
             && coordinator.IngressReceiptIsStale(parentReceipt))
    {
        failure = "L1 receipt was discarded while closing L2 hid admission";
    }

    const wx_wasm_execution::Admission whileChildClosing =
            coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                              parentScope);
    if (failure.empty() && whileChildClosing)
        failure = "L1 input entered while closing L2 was still active";

    if (childLease
        && (!coordinator.LeaseReady(childLease)
            || !coordinator.CloseLease(childLease))
        && failure.empty())
    {
        failure = "could not finish L2 close";
    }

    if (failure.empty()
        && coordinator.IngressReceiptIsStale(parentReceipt))
    {
        failure = "handed-back L1 receipt became stale after L2 closed";
    }

    const wx_wasm_execution::Admission whileParentChildLive =
            coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                              parentScope);
    if (failure.empty() && whileParentChildLive)
        failure = "L1 input entered before its original child returned";

    if (parentChild
        && !coordinator.Release(parentChild.owner) && failure.empty())
    {
        failure = "could not release the original L1 child";
    }

    const wx_wasm_execution::Admission handedBack =
            failure.empty()
                    && !coordinator.IngressReceiptIsStale(parentReceipt)
            ? coordinator.Admit(wx_wasm_execution::WorkClass::UserInput,
                                parentScope)
            : wx_wasm_execution::Admission{};

    if (failure.empty()
        && (!handedBack
            || handedBack.kind != wx_wasm_execution::AdmissionKind::Child
            || handedBack.lease != parentLease))
    {
        failure = "handed-back receipt did not enter exact L1 once eligible";
    }

    if (handedBack
        && !coordinator.Release(handedBack.owner) && failure.empty())
    {
        failure = "could not release handed-back L1 input";
    }

    if (parentLease
        && (!coordinator.BeginClose(parentLease)
            || coordinator.IngressReceiptLease()
            || !coordinator.LeaseReady(parentLease)
            || !coordinator.CloseLease(parentLease))
        && failure.empty())
    {
        failure = "L1 close retained a browser receipt capability";
    }

    if (root && !coordinator.Release(root.owner) && failure.empty())
        failure = "could not release receipt handback root";

    if (failure.empty() && coordinator.RootOwner())
        failure = "receipt handback reducer left an owner behind";

    report("execution_ingress_receipt_handback", failure.empty(), failure);
}

// ScheduleExit() can target an outer loop while an inner modal loop is active.
// Closing the ancestor must revoke its future admission immediately, but it
// must neither wake nor pop out of LIFO order. The inner lease closes first;
// only after its opener returns does the already-closing outer lease become
// ready exactly once.
void Scenario_ExecutionAncestorCloseLifo()
{
    wx_wasm_execution::Coordinator coordinator;
    int outer_scope_anchor = 0;
    int inner_scope_anchor = 0;
    const wx_wasm_execution::ScopeToken outerScope =
            wx_wasm_execution::ScopeFromPointer(&outer_scope_anchor, 91);
    const wx_wasm_execution::ScopeToken innerScope =
            wx_wasm_execution::ScopeFromPointer(&inner_scope_anchor, 92);
    std::string failure;

    const wx_wasm_execution::Admission root =
            coordinator.Admit(wx_wasm_execution::WorkClass::Ordinary);
    const wx_wasm_execution::LeaseToken outerLease = coordinator.OpenLease(
            root.owner, wx_wasm_execution::ModalWorkMask, outerScope);
    const wx_wasm_execution::Admission outerChild = coordinator.Admit(
            wx_wasm_execution::WorkClass::UserInput, outerScope);
    const wx_wasm_execution::LeaseToken innerLease = coordinator.OpenLease(
            outerChild.owner, wx_wasm_execution::ModalWorkMask, innerScope);

    if (!root || !outerLease || !outerChild || !innerLease)
        failure = "could not construct the nested modal branch";

    if (failure.empty() && !coordinator.BeginClose(outerLease))
        failure = "ancestor close was refused while the child was active";
    else if (failure.empty() && !coordinator.BeginClose(outerLease))
        failure = "repeated ancestor close was not idempotent";
    else if (failure.empty() && coordinator.LeaseReady(outerLease))
        failure = "ancestor became ready before its descendant closed";
    else if (failure.empty() && coordinator.CloseLease(outerLease))
        failure = "ancestor popped out of LIFO order";
    else if (failure.empty() && coordinator.ActiveLease() != innerLease)
        failure = "ancestor close replaced the active inner lease";
    else if (failure.empty() && coordinator.IngressReceiptLease() != innerLease)
        failure = "ancestor close revoked the still-accepting inner lease";

    if (innerLease
        && (!coordinator.BeginClose(innerLease)
            || !coordinator.LeaseReady(innerLease)
            || !coordinator.CloseLease(innerLease))
        && failure.empty())
    {
        failure = "could not close the exact inner lease first";
    }

    if (failure.empty() && coordinator.LeaseReady(outerLease))
        failure = "outer lease woke before its inner opener returned";

    if (outerChild
        && !coordinator.Release(outerChild.owner) && failure.empty())
    {
        failure = "could not return the inner opener to the outer lease";
    }

    if (outerLease
        && (!coordinator.LeaseReady(outerLease)
            || !coordinator.CloseLease(outerLease))
        && failure.empty())
    {
        failure = "already-closing outer lease did not become ready in order";
    }

    if (root && !coordinator.Release(root.owner) && failure.empty())
        failure = "could not release ancestor-close root";

    if (failure.empty() && coordinator.RootOwner())
        failure = "ancestor-close reducer left an owner behind";

    report("execution_ancestor_close_lifo", failure.empty(), failure);
}

// A and B are already in the native queue when B's synchronous submit starts
// draining. A runs first and fail-stops. Terminal cleanup therefore removes and
// destroys B before B's submit call returns. The old boolean API reported only
// "accepted", so B's caller read its freed `finished` flag and could delete it
// again. Pin the three-way stack witness independently of wx's browser plumbing:
// cleanup detaches the record before the destructor, a re-entrant cleanup sees
// nothing, and the caller observes AcceptedPayloadDiscarded without inspecting B.
struct SubmitDiscardReducerPayload
{
    int marker = 0x5a17;
};

struct SubmitDiscardReducerEnvelope
{
    SubmitDiscardReducerPayload *payload = nullptr;
    wx_wasm_execution::DispatchSubmissionHandshake *submission = nullptr;
};

int g_submit_discard_calls = 0;
int g_submit_caller_inspections = 0;
int g_submit_duplicate_transitions = 0;

void DiscardSubmitReducerEnvelope(SubmitDiscardReducerEnvelope& envelope)
{
    // Production wxWasmDiscardDispatchJob() has this same ordering: detach all
    // discoverable ownership before invoking user destruction.
    SubmitDiscardReducerPayload *payload = envelope.payload;
    wx_wasm_execution::DispatchSubmissionHandshake *submission =
            envelope.submission;
    envelope.payload = nullptr;
    envelope.submission = nullptr;

    if (!payload)
        return;

    if (!submission || !submission->MarkPayloadDiscarded())
        ++g_submit_duplicate_transitions;

    ++g_submit_discard_calls;
    delete payload;

    // Model a destructor which reports the same terminal failure recursively.
    // The detached envelope makes the second cleanup an exact no-op.
    DiscardSubmitReducerEnvelope(envelope);
}

void Scenario_ExecutionSubmitDiscardHandshake()
{
    g_submit_discard_calls = 0;
    g_submit_caller_inspections = 0;
    g_submit_duplicate_transitions = 0;

    wx_wasm_execution::DispatchSubmissionHandshake submission;
    SubmitDiscardReducerEnvelope queuedB{
        new SubmitDiscardReducerPayload(), &submission
    };

    // A's terminal body runs during B's submit and discards the detached queue.
    DiscardSubmitReducerEnvelope(queuedB);

    const wx_wasm_execution::DispatchSubmitDisposition disposition =
            submission.Disposition();

    // This is the caller-side branch used by app.cpp/domevents.cpp/toplevel.cpp.
    // A discarded result must return without reading the original raw pointer.
    if (disposition
        != wx_wasm_execution::DispatchSubmitDisposition::
                AcceptedPayloadDiscarded)
    {
        ++g_submit_caller_inspections;
    }

    // A second state transition would mean two queue records still believed
    // they owned the same stack witness.
    if (submission.MarkPayloadDiscarded())
        ++g_submit_duplicate_transitions;

    std::string failure;
    if (submission.IsAttached())
        failure = "discard left B attached to the submitter stack";
    else if (g_submit_discard_calls != 1)
        failure = "B discard did not run exactly once";
    else if (g_submit_duplicate_transitions != 0)
        failure = "B accepted a duplicate ownership transition";
    else if (g_submit_caller_inspections != 0)
        failure = "B caller inspected a payload already destroyed by A";

    report("execution_submit_discard_handshake", failure.empty(), failure);
}

// The runtime queue owns these counters, but their bookkeeping lives in the
// header-only owner model so the deterministic reducer can lock the observable
// contract without a browser-event flood. Coalescing does not increase depth;
// rejection does not consume capacity.
void Scenario_ExecutionQueueCounters()
{
    wx_wasm_execution::QueueCounters counters;
    int scope_anchor = 0;
    int other_scope_anchor = 0;
    const wx_wasm_execution::ScopeToken scope =
            wx_wasm_execution::ScopeFromPointer(&scope_anchor, 1);
    const wx_wasm_execution::ScopeToken other_scope =
            wx_wasm_execution::ScopeFromPointer(&other_scope_anchor, 1);

    counters.NoteEnqueued(1);
    counters.NoteEnqueued(4);
    counters.NoteEnqueued(2);
    counters.NoteCoalesced();
    counters.NoteCoalesced();
    counters.NoteRejected();

    std::string failure;

    if (wx_wasm_execution::IsValidWorkClass(
            static_cast<wx_wasm_execution::WorkClass>(3)))
    {
        failure = "combined permission bits formed an executable work class";
    }
    else if (wx_wasm_execution::MaxQueuedJobs != 4096)
        failure = "total execution queue bound changed unexpectedly";
    else if (!wx_wasm_execution::QueueHasCapacity(
                     wx_wasm_execution::MaxQueuedJobs - 1))
        failure = "execution queue refused its final bounded slot";
    else if (wx_wasm_execution::QueueHasCapacity(
                     wx_wasm_execution::MaxQueuedJobs))
        failure = "execution queue admitted a payload beyond its total bound";
    else if (counters.highWater != 4)
        failure = "queue high-water did not retain the maximum depth";
    else if (counters.coalesced != 2)
        failure = "queue coalescing count was not exact";
    else if (counters.rejected != 1)
        failure = "queue rejection count was not exact";
    else if (wx_wasm_execution::BrowserIngressCanRun(2, 1))
        failure = "later browser ingress crossed an unstaged receipt gap";
    else if (!wx_wasm_execution::BrowserIngressCanRun(1, 2))
        failure = "earlier browser ingress waited behind a later receipt gap";
    else if (!wx_wasm_execution::BrowserIngressCanRun(1, 0))
        failure = "browser ingress stayed blocked after the receipt gap closed";
    else if (!wx_wasm_execution::BrowserIngressCanRun(0, 1))
        failure = "an external receipt gap blocked independent native work";
    else if (!wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, true, true, true,
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope))
    {
        failure = "adjacent passive motion was not replaceable";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::None,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, true, true, true,
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope))
    {
        failure = "a discrete envelope did not form a barrier";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, true, true, true,
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, other_scope))
    {
        failure = "passive input coalesced across target scopes";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::LatestGeometry,
            wx_wasm_execution::WorkClass::ModalLifecycle, scope,
            true, true, true, true,
            wx_wasm_execution::CoalesceClass::LatestGeometry,
            wx_wasm_execution::WorkClass::ModalLifecycle, scope))
    {
        failure = "an affiliated continuation was not an ordering barrier";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, false, true, true,
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope))
    {
        failure = "different passive-input producers shared a coalescer";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::LatestGeometry,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, true, false, true,
            wx_wasm_execution::CoalesceClass::LatestGeometry,
            wx_wasm_execution::WorkClass::UserInput, scope))
    {
        failure = "different geometry targets shared a coalescing key";
    }
    else if (wx_wasm_execution::CanCoalesceAdjacent(
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope,
            false, true, true, false,
            wx_wasm_execution::CoalesceClass::PassiveMouseMove,
            wx_wasm_execution::WorkClass::UserInput, scope))
    {
        failure = "passive input coalesced across a removed discrete barrier";
    }

    report("execution_queue_counters", failure.empty(), failure);
}

// A verbose ngspice worker can finish while an unrelated root owner is parked.
// Its first copied batch then waits in the native semantic queue. This reducer
// models that exact pressure without allocating 64 MiB: two admitted leases
// fill the aggregate budget, the next batch is rejected without being charged,
// and delivery/discard each release their own claim exactly once.
void Scenario_ExecutionRetainedByteLease()
{
    wx_wasm_execution::RetainedByteBudget budget;
    constexpr std::size_t MiB = 1024u * 1024u;
    std::string failure;

    if (wx_wasm_execution::MaxQueuedRetainedBytes != 64u * MiB)
        failure = "native retained-byte limit changed unexpectedly";
    else if (!budget.TryRetain(40u * MiB))
        failure = "parked-owner batch was not admitted";
    else if (!budget.TryRetain(24u * MiB))
        failure = "final in-budget batch was not admitted";
    else if (budget.Retained() != 64u * MiB
             || budget.HighWater() != 64u * MiB)
        failure = "retained-byte aggregate/high-water was not exact";
    else if (budget.TryRetain(1))
        failure = "overflowing parked-owner batch was admitted";
    else if (budget.Retained() != 64u * MiB
             || budget.Rejections() != 1)
        failure = "rejection consumed capacity or was not counted";
    else if (!budget.Release(24u * MiB)
             || budget.Retained() != 40u * MiB)
        failure = "delivered batch did not release its exact lease";
    else if (!budget.Release(40u * MiB) || budget.Retained() != 0)
        failure = "discarded batch did not release its exact lease";
    else if (budget.Release(1))
        failure = "duplicate release did not detect accounting underflow";
    else if (budget.TryRetain(
                     wx_wasm_execution::MaxQueuedRetainedBytes + 1))
        failure = "single over-limit batch was admitted";
    else if (budget.Retained() != 0 || budget.Rejections() != 2)
        failure = "rejected batch left a retained-byte lease behind";

    report("execution_retained_byte_lease", failure.empty(), failure);
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
// Ready-FIFO publication is the runnable ownership edge. Every producer must
// obtain that edge before it consumes a wake lease or changes either endpoint
// of a transfer. A deterministic consume-once hook exercises the same return
// path as std::vector::push_back() throwing, without depending on heap layout.
// ---------------------------------------------------------------------------
int g_ready_publication_stage = 0;
int g_ready_publication_result = 0;
int g_ready_publication_cancel_calls = 0;
ContextId g_ready_publication_deferred = 0;
bool g_ready_publication_deferred_atomic = false;

void ready_publication_external_entry( void* )
{
    g_ready_publication_stage = 1;
    const ParkResult parked = yield_park( "ready-publication-external" );
    g_ready_publication_result = parked.accepted ? parked.value : -1;
    g_ready_publication_stage = 2;
}

bool ready_publication_cancel( ContextId, WakeToken )
{
    ++g_ready_publication_cancel_calls;
    return true;
}

void ready_publication_owned_entry( void* )
{
    g_ready_publication_stage = 1;
    const ParkResult parked = yield_park(
            "ready-publication-owned",
            ParkWake::Cancellable( 0x7101, &ready_publication_cancel ) );
    g_ready_publication_result = parked.accepted ? parked.value : -1;
    g_ready_publication_stage = 2;
}

void ready_publication_retained_entry( void* )
{
    g_ready_publication_stage = 1;
    const ParkResult parked = yield_park(
            "ready-publication-retained", ParkWake::RetainedExact( 0x7102 ) );
    g_ready_publication_result = parked.accepted ? parked.value : -1;
    g_ready_publication_stage = 2;
}

void ready_publication_deferred_entry( void* )
{
    g_ready_publication_deferred = current();
    mark_ready( g_ready_publication_deferred, 0x7103 );

    fail_next_ready_fifo_allocation_for_test();
    const ParkResult refused = yield_park( "ready-publication-deferred-fails" );
    g_ready_publication_deferred_atomic =
            !refused.accepted
            && current() == g_ready_publication_deferred
            && status_of( g_ready_publication_deferred ) == Status::Running
            && has_pending_wake( g_ready_publication_deferred );

    const ParkResult resumed = yield_park( "ready-publication-deferred-retry" );
    g_ready_publication_result = resumed.accepted ? resumed.value : -1;
}

alignas( 16 ) char g_ready_publication_start_stack[64 * 1024];
alignas( 16 ) char g_ready_publication_transfer_source_stack[64 * 1024];
alignas( 16 ) char g_ready_publication_transfer_target_stack[64 * 1024];
ContextId g_ready_publication_start = 0;
ContextId g_ready_publication_transfer_source = 0;
ContextId g_ready_publication_transfer_target = 0;
bool g_ready_publication_transfer_atomic = false;
intptr_t g_ready_publication_start_value = 0;

void ready_publication_start_entry( void* )
{
    Context* self = find( current() );
    g_ready_publication_start_value = self ? self->transfer : -1;

    for( ;; )
        yield_park( "ready-publication-start-retired", ParkWake::None() );
}

void ready_publication_transfer_target_entry( void* )
{
    for( ;; )
        yield_park( "ready-publication-transfer-target", ParkWake::None() );
}

void ready_publication_transfer_source_entry( void* )
{
    Context* target = find( g_ready_publication_transfer_target );
    const intptr_t oldTransfer = target ? target->transfer : -1;

    fail_next_ready_fifo_allocation_for_test();
    const intptr_t refused = fiber_transfer(
            g_ready_publication_transfer_source,
            g_ready_publication_transfer_target, 0x7105 );

    target = find( g_ready_publication_transfer_target );
    g_ready_publication_transfer_atomic =
            refused == 0
            && current() == g_ready_publication_transfer_source
            && status_of( g_ready_publication_transfer_source ) == Status::Running
            && target && target->status == Status::Fresh
            && target->transfer == oldTransfer;

    for( ;; )
        yield_park( "ready-publication-transfer-source-retired", ParkWake::None() );
}

void Scenario_ReadyPublicationIsTransactional()
{
    // create(): neither registry discoverability nor live accounting survives
    // a failed FIFO claim.
    fail_next_ready_fifo_allocation_for_test();
    const ContextId failedCreate =
            create( body_sets_flag, nullptr, "ready-publication-create-fails" );

    if( failedCreate )
    {
        drain();
        destroy( failedCreate );
        return report( "ready_publication_is_transactional", false,
                       "create published a context without a FIFO claim" );
    }

    // Ordinary, cancellable-exact, and retained-exact wakes all keep their
    // Parked lease and accept the same legitimate wake after the refusal.
    g_ready_publication_stage = 0;
    ContextId id = create( ready_publication_external_entry, nullptr,
                           "ready-publication-external" );
    drain();
    fail_next_ready_fifo_allocation_for_test();

    if( mark_ready( id, 0x7001 ) || status_of( id ) != Status::Parked
        || !find( id )
        || find( id )->park_wake.kind != ParkWakeKind::External
        || !mark_ready( id, 0x7101 ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "ordinary wake lease was consumed before FIFO publication" );
    }

    drain();

    if( g_ready_publication_stage != 2 || g_ready_publication_result != 0x7101 )
        return report( "ready_publication_is_transactional", false,
                       "ordinary wake did not resume with the retry value" );

    destroy( id );

    g_ready_publication_stage = 0;
    g_ready_publication_result = 0;
    g_ready_publication_cancel_calls = 0;
    id = create( ready_publication_owned_entry, nullptr,
                 "ready-publication-owned" );
    drain();
    fail_next_ready_fifo_allocation_for_test();

    if( mark_ready_owned( id, 0x7002, 0x7101 )
        || status_of( id ) != Status::Parked || !find( id )
        || find( id )->park_wake.kind != ParkWakeKind::Cancellable
        || find( id )->park_wake.token != 0x7101
        || !mark_ready_owned( id, 0x7102, 0x7101 ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "owned wake lease was consumed before FIFO publication" );
    }

    drain();

    if( g_ready_publication_stage != 2 || g_ready_publication_result != 0x7102
        || g_ready_publication_cancel_calls != 0 )
    {
        return report( "ready_publication_is_transactional", false,
                       "owned wake retry lost its result or revoked a live callback" );
    }

    destroy( id );

    g_ready_publication_stage = 0;
    g_ready_publication_result = 0;
    id = create( ready_publication_retained_entry, nullptr,
                 "ready-publication-retained" );
    drain();
    fail_next_ready_fifo_allocation_for_test();

    if( mark_ready_retained( id, 0x7003, 0x7102 )
        || status_of( id ) != Status::Parked || !find( id )
        || find( id )->park_wake.kind != ParkWakeKind::RetainedExact
        || find( id )->park_wake.token != 0x7102
        || !mark_ready_retained( id, 0x7103, 0x7102 ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "retained wake lease was consumed before FIFO publication" );
    }

    drain();

    if( g_ready_publication_stage != 2 || g_ready_publication_result != 0x7103 )
        return report( "ready_publication_is_transactional", false,
                       "retained wake did not resume with the retry value" );

    destroy( id );

    // A resolve-before-park remains pending, and the source remains Running,
    // if its immediate Ready publication fails.
    g_ready_publication_deferred = 0;
    g_ready_publication_deferred_atomic = false;
    g_ready_publication_result = 0;
    id = create( ready_publication_deferred_entry, nullptr,
                 "ready-publication-deferred" );
    drain();

    if( !g_ready_publication_deferred_atomic || status_of( id ) != Status::Ready )
        return report( "ready_publication_is_transactional", false,
                       "deferred wake failure changed the running context" );

    drain();

    if( g_ready_publication_result != 0x7103 || status_of( id ) != Status::Finished )
        return report( "ready_publication_is_transactional", false,
                       "deferred wake retry did not resume exactly once" );

    destroy( id );

    // fiber_start(): a failed claim keeps both Fresh status and the old
    // protocol value. The next publication must still start normally.
    g_ready_publication_start_value = 0;
    g_ready_publication_start = fiber_create(
            ready_publication_start_entry, nullptr,
            g_ready_publication_start_stack,
            sizeof( g_ready_publication_start_stack ), 32 * 1024,
            "ready-publication-start" );
    Context* start = find( g_ready_publication_start );
    const intptr_t oldStartTransfer = start ? start->transfer : -1;
    fail_next_ready_fifo_allocation_for_test();

    if( !start || fiber_start( g_ready_publication_start, 0x7004 )
        || start->status != Status::Fresh
        || start->transfer != oldStartTransfer
        || !fiber_start( g_ready_publication_start, 0x7104 ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "fiber_start changed its target before FIFO publication" );
    }

    drain();

    if( g_ready_publication_start_value != 0x7104
        || status_of( g_ready_publication_start ) != Status::Parked
        || !fiber_release( g_ready_publication_start ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "fiber_start retry did not preserve the protocol value" );
    }

    g_ready_publication_start = 0;

    // fiber_transfer(): the allocation attempt happens while the source is
    // physically Running. Failure must leave the source running and the target
    // Fresh, with no transfer value published to either endpoint.
    g_ready_publication_transfer_atomic = false;
    g_ready_publication_transfer_source = fiber_create(
            ready_publication_transfer_source_entry, nullptr,
            g_ready_publication_transfer_source_stack,
            sizeof( g_ready_publication_transfer_source_stack ), 32 * 1024,
            "ready-publication-transfer-source" );
    g_ready_publication_transfer_target = fiber_create(
            ready_publication_transfer_target_entry, nullptr,
            g_ready_publication_transfer_target_stack,
            sizeof( g_ready_publication_transfer_target_stack ), 32 * 1024,
            "ready-publication-transfer-target" );

    if( !g_ready_publication_transfer_source
        || !g_ready_publication_transfer_target
        || !fiber_start( g_ready_publication_transfer_source, 0 ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "could not establish the transfer allocation reducer" );
    }

    drain_all();

    if( !g_ready_publication_transfer_atomic
        || status_of( g_ready_publication_transfer_source ) != Status::Parked
        || status_of( g_ready_publication_transfer_target ) != Status::Fresh
        || !fiber_release( g_ready_publication_transfer_source )
        || !fiber_release( g_ready_publication_transfer_target ) )
    {
        return report( "ready_publication_is_transactional", false,
                       "fiber_transfer failure partially changed an endpoint" );
    }

    g_ready_publication_transfer_source = 0;
    g_ready_publication_transfer_target = 0;
    report( "ready_publication_is_transactional", true );
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
        const ParkResult parked = yield_park( "deep-park" );
        return parked.accepted ? parked.value : -1;
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
// scenario 9: a foreign stack may NOT yield someone else's context
//
//   The D3 blocker, pinned. A KiCad tool coroutine is a libcontext fiber
//   swapped in ON TOP of whatever dispatched it. If that fiber calls a wait,
//   the registry still says "the dispatch context is running" while the live
//   stack belongs to the tool fiber — so a naive yield would save the TOOL
//   fiber's stack into the DISPATCH context's fiber struct and hand it to the
//   next resume. Silent, total, and undetectable after the fact.
//
//   Here a raw emscripten fiber (the same thing libcontext builds on) is
//   swapped in above a context and calls yield_park. It must be REFUSED, and
//   the context must remain usable afterwards.
// ---------------------------------------------------------------------------
emscripten_fiber_t g_foreign_fiber;
emscripten_fiber_t g_host_return;
alignas( 16 ) char g_foreign_stack[64 * 1024];
alignas( 16 ) char g_foreign_asyncify[16 * 1024];
// The host side of the swap needs its OWN asyncify buffer: emscripten_fiber_swap
// unwinds the outgoing fiber into it. A zero-initialised emscripten_fiber_t has
// a null asyncify stack and traps on the first swap.
alignas( 16 ) char g_host_asyncify[16 * 1024];

int g_foreign_yield_rc = -99;
int g_foreign_ran = 0;
ContextId g_host_ctx = 0;

// PROBE_YIELD=0 isolates plain fiber-on-context nesting (no yield at all), so
// "does nesting itself work?" is answerable separately from "is the yield
// refused?". Both answers matter to D3 and they are different questions.
int g_probe_yield = 1;

void foreign_fiber_entry( void* )
{
    g_foreign_ran = 1;

    // We are on the foreign fiber's stack, but the registry still says the
    // host context is running. This must NOT be allowed to yield it.
    if( g_probe_yield )
    {
        const ParkResult parked = yield_park( "from-a-foreign-stack" );
        g_foreign_yield_rc = parked.accepted ? parked.value : -1;
    }

    emscripten_fiber_swap( &g_foreign_fiber, &g_host_return );
}

void body_hosts_foreign_fiber( void* )
{
    // Exactly libcontext's shape: the current stack (this context's) becomes a
    // fiber we can be swapped back into, and the tool-like fiber is entered
    // from it.
    emscripten_fiber_init_from_current_context( &g_host_return, g_host_asyncify,
                                                sizeof( g_host_asyncify ) );
    emscripten_fiber_init( &g_foreign_fiber, foreign_fiber_entry, nullptr,
                           g_foreign_stack, sizeof( g_foreign_stack ),
                           g_foreign_asyncify, sizeof( g_foreign_asyncify ) );
    emscripten_fiber_swap( &g_host_return, &g_foreign_fiber );
}

// Step 1: can a fiber nest inside a context AT ALL? (No yield involved.)
void Scenario_FiberNestsInContext()
{
    g_foreign_yield_rc = -99;
    g_foreign_ran = 0;
    g_probe_yield = 0;

    const ContextId host = create( body_hosts_foreign_fiber, nullptr, "nest-probe" );
    drain();

    if( !g_foreign_ran )
        return report( "fiber_nests_in_context", false, "the nested fiber never ran" );

    if( status_of( host ) != Status::Finished )
        return report( "fiber_nests_in_context", false,
                       std::string( "host status: " ) + status_name( status_of( host ) ) );

    destroy( host );
    report( "fiber_nests_in_context", true );
}

// Step 2: and does a yield FROM that nested fiber get refused?
void Scenario_ForeignStackRefused()
{
    g_foreign_yield_rc = -99;
    g_foreign_ran = 0;
    g_probe_yield = 1;

    g_host_ctx = create( body_hosts_foreign_fiber, nullptr, "foreign-host" );
    drain();

    if( !g_foreign_ran )
        return report( "foreign_stack_refused", false, "the foreign fiber never ran" );

    if( g_foreign_yield_rc != -1 )
        return report( "foreign_stack_refused", false,
                       "yield_park did not refuse (rc=" + std::to_string( g_foreign_yield_rc )
                       + ") - it would have saved the wrong stack" );

    // The host context must be intact: it ran to completion after the foreign
    // fiber returned, rather than being left in a half-yielded state.
    if( status_of( g_host_ctx ) != Status::Finished )
        return report( "foreign_stack_refused", false,
                       std::string( "host context status: " )
                       + status_name( status_of( g_host_ctx ) ) );

    // And the scheduler is still healthy enough to run something else.
    g_ran = 0;
    const ContextId after = create( body_sets_flag, nullptr, "after-foreign" );
    drain();

    if( g_ran != 1 )
        return report( "foreign_stack_refused", false,
                       "the scheduler was left unusable after the refusal" );

    destroy( after );
    destroy( g_host_ctx );
    report( "foreign_stack_refused", true );
}

// ---------------------------------------------------------------------------
// FIBER LANE scenarios (doc 22 Phase A) — the symmetric semantics libcontext's
// wasm backend adapts onto. These pin what the adapter relies on: a fresh
// fiber enters at its entry, a swap suspends the swapper, enterability is
// registry truth, releasing a suspended fiber is legal, a stale id refuses
// instead of use-after-free, and the star lane is undisturbed throughout.
// ---------------------------------------------------------------------------
ContextId g_fiber_root = 0;

ContextId fiber_root()
{
    // Adopted once for the whole battery, like libcontext's main context.
    if( !g_fiber_root )
        g_fiber_root = fiber_adopt_current( 64 * 1024, "test-root" );

    return g_fiber_root;
}

alignas( 16 ) char g_fiber_a_stack[64 * 1024];
ContextId g_fiber_a = 0;
int g_fiber_a_runs = 0;
int g_fiber_a_saw_current = -1;
int g_fiber_a_saw_root_enterable = -1;
int g_fiber_a_saw_self_enterable = -1;

void fiber_a_entry( void* )
{
    // Never returns, like libcontext's trampoline: run, swap back, repeat.
    for( ;; )
    {
        ++g_fiber_a_runs;
        g_fiber_a_saw_current = ( fiber_current() == g_fiber_a ) ? 1 : 0;
        g_fiber_a_saw_root_enterable = fiber_enterable( g_fiber_root ) ? 1 : 0;
        g_fiber_a_saw_self_enterable = fiber_enterable( g_fiber_a ) ? 1 : 0;
        fiber_swap( g_fiber_a, g_fiber_root );
    }
}

void Scenario_FiberRoundtrip()
{
    if( !fiber_root() )
        return report( "fiber_roundtrip", false, "could not adopt the root" );

    Context* rootContext = find( g_fiber_root );

    if( !rootContext || !rootContext->adopted_root
        || rootContext->c_stack.size == 0
        || pcbjam_sched::context_owning_current_stack() != g_fiber_root )
    {
        return report( "fiber_roundtrip", false,
                       "adopted root does not own the exact main-stack range" );
    }

    g_fiber_a_runs = 0;
    g_fiber_a = fiber_create( fiber_a_entry, nullptr, g_fiber_a_stack,
                              sizeof( g_fiber_a_stack ), 32 * 1024, "fiber-a" );

    if( !g_fiber_a )
        return report( "fiber_roundtrip", false, "fiber_create failed" );

    if( status_of( g_fiber_a ) != Status::Fresh || !fiber_enterable( g_fiber_a ) )
        return report( "fiber_roundtrip", false, "a fresh fiber should be enterable" );

    if( g_fiber_a_runs != 0 )
        return report( "fiber_roundtrip", false, "body ran before the first swap" );

    if( !fiber_swap( g_fiber_root, g_fiber_a ) )
        return report( "fiber_roundtrip", false, "first swap refused" );

    // Back here: the fiber ran once and swapped back to the root.
    if( g_fiber_a_runs != 1 )
        return report( "fiber_roundtrip", false,
                       "runs=" + std::to_string( g_fiber_a_runs ) + " after first swap" );

    if( fiber_current() != g_fiber_root )
        return report( "fiber_roundtrip", false, "root is not fiber_current() again" );

    if( status_of( g_fiber_a ) != Status::Suspended || !fiber_enterable( g_fiber_a ) )
        return report( "fiber_roundtrip", false,
                       std::string( "suspended fiber status: " )
                       + status_name( status_of( g_fiber_a ) ) );

    // What the fiber observed mid-run: it was current, the suspended root was
    // enterable, and it itself (Running) was not — registry truth, no guessing.
    if( g_fiber_a_saw_current != 1 )
        return report( "fiber_roundtrip", false, "fiber did not see itself as current" );

    if( g_fiber_a_saw_root_enterable != 1 )
        return report( "fiber_roundtrip", false, "suspended root was not enterable" );

    if( g_fiber_a_saw_self_enterable != 0 )
        return report( "fiber_roundtrip", false, "a RUNNING fiber claimed to be enterable" );

    // Re-entry takes the loop again — the second swap resumes, not restarts.
    if( !fiber_swap( g_fiber_root, g_fiber_a ) || g_fiber_a_runs != 2 )
        return report( "fiber_roundtrip", false, "second swap did not re-run the body" );

    report( "fiber_roundtrip", true );
}

// ---------------------------------------------------------------------------
// Binary layout must not decide whether a fiber works. Before fiber_create()
// normalized caller-owned stack bounds, std::make_unique<char[]>() happened
// to return either an 8- or 16-byte-aligned address. An unrelated function or
// test changed the heap layout and could therefore turn the first EM_ASM on a
// fiber into readEmAsmArgs' `unreachable` trap. Exercise every possible input
// offset deterministically; each adopted sub-range must enter aligned, execute
// EM_ASM, and make a terminal handoff back to the root.
// ---------------------------------------------------------------------------
constexpr size_t MISALIGNED_STACK_BYTES = 64 * 1024;
alignas( 16 ) char g_misaligned_stack[MISALIGNED_STACK_BYTES + 32];
ContextId g_misaligned_fiber = 0;
int g_misaligned_entries = 0;
int g_misaligned_em_asm_value = 0;

void misaligned_fiber_entry( void* )
{
    ++g_misaligned_entries;
    g_misaligned_em_asm_value = EM_ASM_INT( { return 0x51A7; } );
    fiber_finish_swap( g_misaligned_fiber, g_fiber_root, 0xA11E );
}

void Scenario_FiberNormalizesEveryStackAlignment()
{
    if( !fiber_root() )
        return report( "fiber_normalizes_every_stack_alignment", false,
                       "could not adopt the root" );

    for( size_t offset = 0; offset < 16; ++offset )
    {
        g_misaligned_entries = 0;
        g_misaligned_em_asm_value = 0;
        g_misaligned_fiber = fiber_create(
                misaligned_fiber_entry, nullptr, g_misaligned_stack + offset,
                MISALIGNED_STACK_BYTES, 32 * 1024, "misaligned-stack" );

        if( !g_misaligned_fiber )
            return report( "fiber_normalizes_every_stack_alignment", false,
                           "fiber_create refused input offset "
                           + std::to_string( offset ) );

        if( !fiber_swap( g_fiber_root, g_misaligned_fiber ) )
            return report( "fiber_normalizes_every_stack_alignment", false,
                           "swap refused input offset " + std::to_string( offset ) );

        if( g_misaligned_entries != 1 || g_misaligned_em_asm_value != 0x51A7
            || status_of( g_misaligned_fiber ) != Status::Finished
            || fiber_current() != g_fiber_root )
        {
            return report( "fiber_normalizes_every_stack_alignment", false,
                           "bad terminal roundtrip for input offset "
                           + std::to_string( offset ) );
        }

        if( !fiber_release( g_misaligned_fiber ) )
            return report( "fiber_normalizes_every_stack_alignment", false,
                           "could not release offset " + std::to_string( offset ) );

        g_misaligned_fiber = 0;
    }

    report( "fiber_normalizes_every_stack_alignment", true );
}

void Scenario_FiberReleaseSuspended()
{
    // Fiber A is Suspended after the roundtrip. Releasing it mid-suspend is
    // LEGAL — libcontext refcounts drop never-finished coroutines — and the
    // stale id must then refuse instead of resuming freed state.
    if( !g_fiber_a || status_of( g_fiber_a ) != Status::Suspended )
        return report( "fiber_release_suspended", false, "precondition: fiber A suspended" );

    Context* releasedContext = find( g_fiber_a );
    const std::uintptr_t releasedFiber = releasedContext
            ? reinterpret_cast<std::uintptr_t>( &releasedContext->fiber ) : 0;

    if( !releasedFiber
        || !sched_ctx_seed_generated_fiber_guard( releasedFiber ) )
    {
        return report( "fiber_release_suspended", false,
                       "could not seed the generated fiber guard" );
    }

    if( !fiber_release( g_fiber_a ) )
        return report( "fiber_release_suspended", false, "release refused" );

    if( fiber_enterable( g_fiber_a ) )
        return report( "fiber_release_suspended", false, "released fiber still enterable" );

    if( fiber_swap( g_fiber_root, g_fiber_a ) )
        return report( "fiber_release_suspended", false,
                       "swap into a released fiber was allowed (use-after-free)" );

    report( "fiber_release_clears_generated_guard",
            sched_ctx_generated_fiber_guard_contains( releasedFiber ) == 0,
            "released raw fiber identity remained in the generated guard" );

    report( "fiber_release_suspended", true );
}

alignas( 16 ) char g_admission_fiber_stack[64 * 1024];
alignas( 16 ) char g_source_authority_target_stack[64 * 1024];
ContextId g_admission_fiber = 0;
ContextId g_source_authority_target = 0;
int g_admission_fiber_runs = 0;
int g_source_authority_target_runs = 0;

void admission_fiber_entry( void* )
{
    for( ;; )
    {
        ++g_admission_fiber_runs;
        fiber_swap( g_admission_fiber, g_fiber_root );
    }
}

void source_authority_target_entry( void* )
{
    ++g_source_authority_target_runs;
    fiber_swap( g_source_authority_target, g_fiber_root );

    ++g_source_authority_target_runs;
    fiber_finish_swap( g_source_authority_target, g_fiber_root, 0x5A );
}

void Scenario_FiberAdmissionRefusals()
{
    g_admission_fiber_runs = 0;
    g_admission_fiber = fiber_create(
            admission_fiber_entry, nullptr, g_admission_fiber_stack,
            sizeof( g_admission_fiber_stack ), 32 * 1024,
            "admission-refusals" );

    if( !g_admission_fiber
        || !fiber_swap( g_fiber_root, g_admission_fiber )
        || status_of( g_admission_fiber ) != Status::Suspended )
    {
        return report( "fiber_admission_refusals", false,
                       "could not establish a suspended target" );
    }

    // A Suspended status and a caller-side "suspended" protocol bit are both
    // insufficient while an in-place Asyncify capture still owns the body.
    // Every registry entry path must refuse before it writes or consumes a
    // fiber capture.
    note_inplace_park( g_admission_fiber, +1 );
    const bool startedStale = fiber_start( g_admission_fiber, 0 );
    const bool swappedStale = fiber_swap( g_fiber_root, g_admission_fiber );
    note_inplace_park( g_admission_fiber, -1 );

    if( startedStale || swappedStale || g_admission_fiber_runs != 1
        || fiber_current() != g_fiber_root
        || status_of( g_admission_fiber ) != Status::Suspended )
        return report( "fiber_admission_refusals", false,
                       "a stale in-place capture was queued or physically entered" );

    // Refusal is non-destructive. Once the exact in-place owner releases its
    // marker, the preserved symmetric suspension remains usable.
    if( !fiber_swap( g_fiber_root, g_admission_fiber )
        || g_admission_fiber_runs != 2
        || status_of( g_admission_fiber ) != Status::Suspended )
    {
        return report( "fiber_admission_refusals", false,
                       "refusal damaged the later legal suspension" );
    }

    // Two suspended contexts are not enough to authorize a physical swap.
    // We are standing on the root stack here. Supplying suspended B as aFrom
    // and suspended C as aTo used to make emscripten_fiber_swap save ROOT's
    // live rewind into B's fiber object, overwriting B's own suspension.
    g_source_authority_target_runs = 0;
    g_source_authority_target = fiber_create(
            source_authority_target_entry, nullptr,
            g_source_authority_target_stack,
            sizeof( g_source_authority_target_stack ), 32 * 1024,
            "source-authority-target" );

    if( !g_source_authority_target
        || !fiber_swap( g_fiber_root, g_source_authority_target )
        || status_of( g_source_authority_target ) != Status::Suspended
        || status_of( g_admission_fiber ) != Status::Suspended )
    {
        return report( "fiber_admission_refusals", false,
                       "could not establish two suspended direct-lane contexts" );
    }

    const bool forgedSourceSwap =
            fiber_swap( g_admission_fiber, g_source_authority_target );

    if( forgedSourceSwap || fiber_current() != g_fiber_root
        || g_source_authority_target_runs != 1
        || status_of( g_admission_fiber ) != Status::Suspended
        || status_of( g_source_authority_target ) != Status::Suspended )
    {
        return report( "fiber_admission_refusals", false,
                       "a suspended source id overwrote another stack's capture" );
    }

    // Refusal is transactional: the target's original saved suspension is
    // still valid and completes normally when the real root occupant enters it.
    if( !fiber_swap( g_fiber_root, g_source_authority_target )
        || g_source_authority_target_runs != 2
        || status_of( g_source_authority_target ) != Status::Finished
        || fiber_current() != g_fiber_root
        || !fiber_release( g_source_authority_target ) )
    {
        return report( "fiber_admission_refusals", false,
                       "source-authority refusal damaged the legal target capture" );
    }

    g_source_authority_target = 0;

    // The source argument cannot grant authority. A transfer called from the
    // scheduler/root stack must not park a different suspended context.
    if( fiber_transfer( g_admission_fiber, g_fiber_root, 17 ) != 0
        || status_of( g_admission_fiber ) != Status::Suspended )
    {
        return report( "fiber_admission_refusals", false,
                       "fiber_transfer accepted a non-owning source" );
    }

    if( !fiber_release( g_admission_fiber ) )
        return report( "fiber_admission_refusals", false,
                       "preserved suspended target refused release" );

    g_admission_fiber = 0;
    report( "fiber_admission_refusals", true );
}

// Ready is not merely a valid saved capture. It is an outstanding scheduler
// claim with an already-published transfer value and FIFO position. A second
// transfer into it must not merge those two independent activations.
alignas( 16 ) char g_ready_claim_source_stack[64 * 1024];
alignas( 16 ) char g_ready_claim_target_stack[64 * 1024];
ContextId g_ready_claim_source = 0;
ContextId g_ready_claim_target = 0;
int g_ready_claim_source_stage = 0;
int g_ready_claim_source_stayed_running = 0;
intptr_t g_ready_claim_observed_value = 0;

void ready_claim_source_entry( void* )
{
    g_ready_claim_source_stage = 1;
    (void) fiber_transfer( g_ready_claim_source, g_ready_claim_target, 0x2468 );
    g_ready_claim_source_stayed_running =
            status_of( g_ready_claim_source ) == Status::Running ? 1 : 0;
    Context* target = find( g_ready_claim_target );
    g_ready_claim_observed_value = target ? target->transfer : 0;
    g_ready_claim_source_stage = 2;

    for( ;; )
        yield_park( "ready-claim-source-finished", ParkWake::None() );
}

void ready_claim_target_entry( void* )
{
    for( ;; )
        yield_park( "ready-claim-target", ParkWake::None() );
}

void Scenario_ReadyClaimIsNotTransferable()
{
    constexpr intptr_t ORIGINAL_VALUE = 0x1357;
    g_ready_claim_source_stage = 0;
    g_ready_claim_source_stayed_running = 0;
    g_ready_claim_observed_value = 0;

    g_ready_claim_source = fiber_create(
            ready_claim_source_entry, nullptr, g_ready_claim_source_stack,
            sizeof( g_ready_claim_source_stack ), 32 * 1024,
            "ready-claim-source" );
    g_ready_claim_target = fiber_create(
            ready_claim_target_entry, nullptr, g_ready_claim_target_stack,
            sizeof( g_ready_claim_target_stack ), 32 * 1024,
            "ready-claim-target" );

    if( !g_ready_claim_source || !g_ready_claim_target
        || !fiber_start( g_ready_claim_source, 0 )
        || !fiber_start( g_ready_claim_target, ORIGINAL_VALUE ) )
    {
        return report( "fiber_ready_claim_is_not_transferable", false,
                       "could not establish two queued scheduler claims" );
    }

    // FIFO puts the source on the CPU while the target remains Ready. The
    // attempted transfer must return immediately without parking the source
    // or replacing the target's already-published value.
    drain();

    Context* target = find( g_ready_claim_target );
    const bool preserved = g_ready_claim_source_stage == 2
            && g_ready_claim_source_stayed_running == 1
            && status_of( g_ready_claim_source ) == Status::Parked
            && target && target->status == Status::Ready
            && target->transfer == ORIGINAL_VALUE
            && g_ready_claim_observed_value == ORIGINAL_VALUE;

    if( !fiber_release( g_ready_claim_source )
        || !fiber_release( g_ready_claim_target ) )
    {
        return report( "fiber_ready_claim_is_not_transferable", false,
                       "preserved scheduler claims refused cleanup" );
    }

    g_ready_claim_source = 0;
    g_ready_claim_target = 0;
    report( "fiber_ready_claim_is_not_transferable", preserved,
            "a transfer merged or replaced an existing Ready claim" );
}

alignas( 16 ) char g_fiber_b_stack[64 * 1024];
ContextId g_fiber_b = 0;
int g_fiber_b_runs = 0;
int g_coexist_stage = 0;
int g_coexist_result = 0;

void fiber_b_entry( void* )
{
    for( ;; )
    {
        ++g_fiber_b_runs;
        fiber_swap( g_fiber_b, g_fiber_root );
    }
}

void body_coexist_park( void* )
{
    g_coexist_stage = 1;
    const ParkResult parked = yield_park( "coexist-park" );
    g_coexist_result = parked.accepted ? parked.value : -1;
    g_coexist_stage = 2;
}

void Scenario_FiberAndStarCoexist()
{
    // One registry, two lanes: a PARKED star context must sit undisturbed
    // while symmetric fiber swaps happen, and resume cleanly afterwards —
    // production Phase A runs tool fibers while D1's star layer idles.
    g_coexist_stage = 0;
    g_fiber_b_runs = 0;

    const ContextId star = create( body_coexist_park, nullptr, "coexist-star" );
    drain();   // parks

    if( g_coexist_stage != 1 || status_of( star ) != Status::Parked )
        return report( "fiber_and_star_coexist", false, "star context did not park" );

    g_fiber_b = fiber_create( fiber_b_entry, nullptr, g_fiber_b_stack,
                              sizeof( g_fiber_b_stack ), 32 * 1024, "fiber-b" );

    if( !g_fiber_b || !fiber_swap( g_fiber_root, g_fiber_b ) || g_fiber_b_runs != 1 )
        return report( "fiber_and_star_coexist", false, "fiber roundtrip failed" );

    if( status_of( star ) != Status::Parked )
        return report( "fiber_and_star_coexist", false,
                       "fiber swaps disturbed the parked star context" );

    if( !mark_ready( star, 7 ) )
        return report( "fiber_and_star_coexist", false, "mark_ready failed" );

    drain();

    if( g_coexist_stage != 2 || g_coexist_result != 7 )
        return report( "fiber_and_star_coexist", false, "star context did not resume" );

    destroy( star );
    fiber_release( g_fiber_b );
    report( "fiber_and_star_coexist", true );
}

// A direct-lane coroutine completion is not a resumable suspension. The
// terminal handoff must mark the source Finished before control returns to the
// root, so its caller-owned C stack can be released immediately.
alignas( 16 ) char g_direct_terminal_stack[64 * 1024];
ContextId g_direct_terminal = 0;
int g_direct_terminal_runs = 0;

void direct_terminal_entry( void* )
{
    ++g_direct_terminal_runs;
    fiber_finish_swap( g_direct_terminal, g_fiber_root, 0xD1 );
}

void Scenario_FiberTerminalDirect()
{
    if( !fiber_root() )
        return report( "fiber_terminal_direct", false, "could not adopt the root" );

    g_direct_terminal_runs = 0;
    g_direct_terminal = fiber_create(
            direct_terminal_entry, nullptr, g_direct_terminal_stack,
            sizeof( g_direct_terminal_stack ), 32 * 1024,
            "direct-terminal" );

    if( !g_direct_terminal )
        return report( "fiber_terminal_direct", false, "fiber_create failed" );

    if( !fiber_swap( g_fiber_root, g_direct_terminal ) )
        return report( "fiber_terminal_direct", false, "initial swap refused" );

    if( g_direct_terminal_runs != 1 )
        return report( "fiber_terminal_direct", false,
                       "terminal body did not run exactly once" );

    if( status_of( g_direct_terminal ) != Status::Finished )
        return report( "fiber_terminal_direct", false,
                       std::string( "terminal source status: " )
                       + status_name( status_of( g_direct_terminal ) ) );

    if( fiber_current() != g_fiber_root )
        return report( "fiber_terminal_direct", false,
                       "terminal handoff did not restore the root" );

    if( !fiber_release( g_direct_terminal ) )
        return report( "fiber_terminal_direct", false,
                       "Finished source could not be released" );

    g_direct_terminal = 0;
    report( "fiber_terminal_direct", true );
}

// Production keeps a small vector of reusable dispatch-fiber ids. A terminal
// fiber still owns a scheduler Context, Asyncify buffer, and generated-JS guard;
// removing only the id leaks those resources. This reducer mirrors the
// release-before-erase loop in wxWasmDispatchOnContext(). A release refusal is
// terminal for the owner, so it must leave the id discoverable for diagnosis
// instead of pretending that reclamation succeeded.
bool RetireFinishedDispatchContexts(std::vector<ContextId>& contexts)
{
    for (size_t i = contexts.size(); i-- > 0;)
    {
        if (status_of(contexts[i]) != Status::Finished)
            continue;

        if (!fiber_release(contexts[i]))
            return false;

        contexts.erase(contexts.begin() + i);
    }

    return true;
}

alignas(16) char g_dispatch_retirement_stack[64 * 1024];
ContextId g_dispatch_retirement_fiber = 0;

void dispatch_retirement_entry(void *)
{
    fiber_finish_swap(g_dispatch_retirement_fiber, g_fiber_root, 0);
}

void Scenario_DispatchContextReleaseBeforeErase()
{
    if (!fiber_root())
    {
        return report("dispatch_context_release_before_erase", false,
                      "could not adopt the root");
    }

    g_dispatch_retirement_fiber = fiber_create(
            dispatch_retirement_entry, nullptr,
            g_dispatch_retirement_stack,
            sizeof(g_dispatch_retirement_stack), 32 * 1024,
            "dispatch-retirement");

    if (!g_dispatch_retirement_fiber
        || !fiber_swap(g_fiber_root, g_dispatch_retirement_fiber)
        || status_of(g_dispatch_retirement_fiber) != Status::Finished)
    {
        return report("dispatch_context_release_before_erase", false,
                      "could not produce a Finished dispatch fiber");
    }

    const ContextId released = g_dispatch_retirement_fiber;
    std::vector<ContextId> contexts{released};

    if (!RetireFinishedDispatchContexts(contexts))
    {
        return report("dispatch_context_release_before_erase", false,
                      "Finished dispatch fiber refused release");
    }

    if (!contexts.empty() || find(released))
    {
        return report("dispatch_context_release_before_erase", false,
                      "release did not reclaim both registry and owner record");
    }

    // status_of() deliberately maps an unknown monotonic id to Finished. Feed
    // the released id through once more to pin the refusal path: release must
    // fail, and the owner list must retain the id instead of erasing evidence.
    contexts.push_back(released);
    if (RetireFinishedDispatchContexts(contexts))
    {
        return report("dispatch_context_release_refusal_retains_id", false,
                      "a stale dispatch id reported successful release");
    }

    if (contexts.size() != 1 || contexts.front() != released)
    {
        return report("dispatch_context_release_refusal_retains_id", false,
                      "release refusal erased the owner record");
    }

    g_dispatch_retirement_fiber = 0;
    report("dispatch_context_release_before_erase", true);
    report("dispatch_context_release_refusal_retains_id", true);
}

// ---------------------------------------------------------------------------
// A release request while a direct fiber is parked inside handleSleep cannot
// free either the registry Context or the caller-owned C stack. The delayed JS
// wake still owns an Asyncify capture whose saved frames point into that stack.
// The primitive must refuse without mutation; libcontext turns that refusal
// into a terminal fail-stop. This reducer keeps running so it can prove the
// refused Context remains intact through the delayed wake and becomes safely
// releasable only after the body yields a real fiber suspension.
// ---------------------------------------------------------------------------
alignas( 16 ) char g_inplace_cancel_stack[64 * 1024];
ContextId g_inplace_cancel_fiber = 0;
int g_inplace_cancel_stage = 0;
int g_inplace_cancel_result = 0;
int g_inplace_cancel_callback_runs = 0;
int g_inplace_cancel_release_result = -1;
int g_inplace_cancel_owner_match = 0;
int g_inplace_cancel_query_during = 0;
int g_inplace_cancel_entry_ready_during = -1;
int g_generated_dom_deferred = 0;
int g_generated_dom_deliveries = 0;
int g_generated_dom_delivery_stage = 0;
int g_generated_dom_inline_deliveries = 0;
int g_generated_dom_fail_stops = 0;
bool g_generated_dom_queued = false;

EM_ASYNC_JS( int, sched_ctx_delayed_fiber_sleep, ( int aMs ), {
    await new Promise( function( resolve ) { setTimeout( resolve, aMs ); } );
    return 0x6d;
} );


void inplace_cancel_fiber_entry( void* )
{
    g_inplace_cancel_stage = 1;
    g_inplace_cancel_result = sched_ctx_delayed_fiber_sleep( 120 );
    g_inplace_cancel_stage = 2;

    // Establish a real symmetric suspension after the in-place wake tail has
    // ended. The root can then cancel this otherwise never-ending fiber.
    fiber_swap( g_inplace_cancel_fiber, g_fiber_root );

    for( ;; )
        fiber_swap( g_inplace_cancel_fiber, g_fiber_root );
}


extern "C" EMSCRIPTEN_KEEPALIVE void sched_ctx_cancel_inplace_fiber()
{
    ++g_inplace_cancel_callback_runs;
    g_inplace_cancel_owner_match =
            g_last_inplace_park_begin == g_inplace_cancel_fiber ? 1 : 0;
    g_inplace_cancel_query_during =
            context_has_inplace_park( g_inplace_cancel_fiber ) ? 1 : 0;
    g_inplace_cancel_entry_ready_during = wxWasmNativeEntryReady();
    g_inplace_cancel_release_result = fiber_release( g_inplace_cancel_fiber ) ? 1 : 0;

    // Generated Emscripten DOM callbacks enqueue their copied payload before
    // wxWasmRunOnDispatchContextScoped() makes its final inline-drain choice.
    // Model that exact tail while the direct fiber owns an in-place capture.
    g_generated_dom_queued = true;
    const int deliveriesBefore = g_generated_dom_deliveries;

    if( wxWasmNativeEntryReady() == 1 )
    {
        // This is the fail-stop at the head of wxWasmDispatchOnContext().
        if( any_context_has_inplace_park() )
            ++g_generated_dom_fail_stops;
        else
            ++g_generated_dom_deliveries;
    }
    else
    {
        ++g_generated_dom_deferred;
    }

    g_generated_dom_inline_deliveries +=
            g_generated_dom_deliveries - deliveriesBefore;
}

void drain_generated_dom_payload()
{
    if( !g_generated_dom_queued )
        return;

    if( wxWasmNativeEntryReady() != 1 )
    {
        ++g_generated_dom_fail_stops;
        return;
    }

    g_generated_dom_queued = false;
    ++g_generated_dom_deliveries;
    g_generated_dom_delivery_stage = g_inplace_cancel_stage;
}


void Scenario_FiberReleaseInplacePark()
{
    g_last_inplace_park_begin = 0;
    g_last_inplace_park_end = 0;
    g_inplace_cancel_stage = 0;
    g_inplace_cancel_result = 0;
    g_inplace_cancel_callback_runs = 0;
    g_inplace_cancel_release_result = -1;
    g_inplace_cancel_owner_match = 0;
    g_inplace_cancel_query_during = 0;
    g_inplace_cancel_entry_ready_during = -1;
    g_generated_dom_deferred = 0;
    g_generated_dom_deliveries = 0;
    g_generated_dom_delivery_stage = 0;
    g_generated_dom_inline_deliveries = 0;
    g_generated_dom_fail_stops = 0;
    g_generated_dom_queued = false;

    g_inplace_cancel_fiber = fiber_create(
            inplace_cancel_fiber_entry, nullptr, g_inplace_cancel_stack,
            sizeof( g_inplace_cancel_stack ), 32 * 1024,
            "inplace-cancel" );

    if( !g_inplace_cancel_fiber )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "fiber_create failed" );

    // This leaf cancellation runs while the longer sleep is still parked.
    // Timers are registered in this order and have separated deadlines, so
    // even a throttled browser must deliver cancellation first.
    EM_ASM( {
        setTimeout( function() {
            Module["_sched_ctx_cancel_inplace_fiber"]();
        }, 10 );
    } );

    if( !fiber_swap( g_fiber_root, g_inplace_cancel_fiber ) )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "initial fiber swap refused" );

    if( g_inplace_cancel_callback_runs != 1 )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "cancellation callback did not run exactly once" );

    if( !g_inplace_cancel_owner_match )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "handleSleep park was not attributed to the target fiber" );

    if( !g_inplace_cancel_query_during )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "park provenance query did not expose the live exact wake" );

    if( g_inplace_cancel_entry_ready_during != 0 )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "fresh browser task was admitted across the live in-place capture" );

    if( g_inplace_cancel_release_result != 0 )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "release freed a fiber whose delayed wake still owned its stack" );

    if( g_inplace_cancel_stage != 2 || g_inplace_cancel_result != 0x6d )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "delayed wake did not resume the preserved fiber body" );

    if( g_last_inplace_park_end != g_inplace_cancel_fiber )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "delayed wake did not close the exact in-place park" );

    if( context_has_inplace_park( g_inplace_cancel_fiber ) )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "park provenance remained live after its exact wake" );

    if( wxWasmNativeEntryReady() != 1 )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "native entry did not reopen after the exact wake closed the park" );

    if( g_generated_dom_deferred != 1 || !g_generated_dom_queued
        || g_generated_dom_inline_deliveries != 0
        || g_generated_dom_fail_stops != 0 )
    {
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "generated scoped DOM path did not defer safely" );
    }

    // One armed tick consumes the retained envelope. A duplicate tick is a
    // no-op, proving exactly-once delivery after the exact wake returned.
    drain_generated_dom_payload();
    drain_generated_dom_payload();

    if( g_generated_dom_deliveries != 1
        || g_generated_dom_delivery_stage != 2
        || g_generated_dom_fail_stops != 0 )
    {
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "generated scoped DOM path did not deliver exactly once after wake" );
    }

    if( status_of( g_inplace_cancel_fiber ) != Status::Suspended )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "fiber did not establish a safe suspension after wake" );

    if( !fiber_release( g_inplace_cancel_fiber ) )
        return report( "fiber_release_inplace_park_refused_until_wake", false,
                       "release stayed refused after the wake tail ended" );

    g_inplace_cancel_fiber = 0;
    report( "fiber_release_inplace_park_refused_until_wake", true );
    report( "generated_scoped_dom_defers_for_direct_inplace_park",
            true );
}

// ---------------------------------------------------------------------------
// A context park can own a cancellable external wake, such as the JavaScript
// timer behind a positive main-thread sleep. Releasing the coroutine must
// revoke that wake before its ContextId and caller-owned stack are reclaimed.
// This is distinct from an in-place Asyncify park: the latter cannot be
// cancelled and remains a hard release refusal until its own wake returns.
// ---------------------------------------------------------------------------
alignas( 16 ) char g_cancellable_park_stack[64 * 1024];
ContextId g_cancellable_park_fiber = 0;
ContextId g_cancellable_park_cancelled_id = 0;
WakeToken g_cancellable_park_cancelled_token = 0;
int g_cancellable_park_stage = 0;
int g_cancellable_park_cancel_calls = 0;

bool cancel_cancellable_park( ContextId aId, WakeToken aToken )
{
    ++g_cancellable_park_cancel_calls;
    g_cancellable_park_cancelled_id = aId;
    g_cancellable_park_cancelled_token = aToken;
    return true;
}

void cancellable_park_entry( void* )
{
    g_cancellable_park_stage = 1;
    yield_park( "cancellable-timed-park",
                ParkWake::Cancellable( 71, &cancel_cancellable_park ) );
    g_cancellable_park_stage = 2;
    for( ;; )
        yield_park( "cancellable-park-unexpected-resume" );
}

void Scenario_FiberReleaseCancellablePark()
{
    g_cancellable_park_stage = 0;
    g_cancellable_park_cancel_calls = 0;
    g_cancellable_park_cancelled_id = 0;
    g_cancellable_park_cancelled_token = 0;
    g_cancellable_park_fiber = fiber_create(
            cancellable_park_entry, nullptr, g_cancellable_park_stack,
            sizeof( g_cancellable_park_stack ), 32 * 1024,
            "cancellable-park" );

    if( !g_cancellable_park_fiber )
        return report( "fiber_release_cancels_owned_park", false,
                       "fiber_create failed" );

    if( !fiber_start( g_cancellable_park_fiber, 0 ) )
        return report( "fiber_release_cancels_owned_park", false,
                       "fiber_start refused" );

    drain_all();

    if( g_cancellable_park_stage != 1
        || status_of( g_cancellable_park_fiber ) != Status::Parked )
    {
        return report( "fiber_release_cancels_owned_park", false,
                       "fiber did not establish its cancellable park" );
    }

    const ContextId released = g_cancellable_park_fiber;
    if( !fiber_release( released ) )
        return report( "fiber_release_cancels_owned_park", false,
                       "release refused after a cancellable park" );

    if( g_cancellable_park_cancel_calls != 1
        || g_cancellable_park_cancelled_id != released
        || g_cancellable_park_cancelled_token != 71 )
    {
        return report( "fiber_release_cancels_owned_park", false,
                       "release did not revoke the exact external wake" );
    }

    if( fiber_enterable( released ) || g_cancellable_park_stage != 1 )
        return report( "fiber_release_cancels_owned_park", false,
                       "released park remained enterable or resumed" );

    g_cancellable_park_fiber = 0;
    report( "fiber_release_cancels_owned_park", true );
}

// An uncancellable callback still holds the ContextId. Null no longer means
// both "no callback" and "a callback we cannot revoke": release must refuse
// the latter until that source delivers its ordinary wake.
alignas( 16 ) char g_external_park_stack[64 * 1024];
ContextId g_external_park_fiber = 0;
int g_external_park_stage = 0;

void external_park_entry( void* )
{
    g_external_park_stage = 1;
    yield_park( "uncancellable-external-wake" );
    g_external_park_stage = 2;
    yield_park( "retired-after-external-wake", ParkWake::None() );
    for( ;; )
        yield_park( "unexpected", ParkWake::None() );
}

void Scenario_FiberReleaseExternalParkRefused()
{
    g_external_park_stage = 0;
    g_external_park_fiber = fiber_create(
            external_park_entry, nullptr, g_external_park_stack,
            sizeof( g_external_park_stack ), 32 * 1024,
            "external-park" );

    if( !g_external_park_fiber || !fiber_start( g_external_park_fiber, 0 ) )
        return report( "fiber_release_external_park_refused", false,
                       "fiber setup failed" );

    drain_all();

    if( fiber_release( g_external_park_fiber ) )
        return report( "fiber_release_external_park_refused", false,
                       "release reclaimed an uncancellable wake target" );

    if( status_of( g_external_park_fiber ) != Status::Parked
        || g_external_park_stage != 1 )
    {
        return report( "fiber_release_external_park_refused", false,
                       "release refusal mutated the parked context" );
    }

    if( !mark_ready( g_external_park_fiber, 0 ) )
        return report( "fiber_release_external_park_refused", false,
                       "external wake was refused" );

    drain_all();

    if( g_external_park_stage != 2
        || !fiber_release( g_external_park_fiber ) )
    {
        return report( "fiber_release_external_park_refused", false,
                       "context was not reclaimable after its wake was consumed" );
    }

    g_external_park_fiber = 0;
    report( "fiber_release_external_park_refused", true );
}

// wasm32 results use every bit. Admission therefore cannot be encoded in a
// negative sentinel: a valid pointer at or above 0x80000000 is negative when
// viewed as C++ int. This also pins the non-cancellable exact wait kind used by
// generic Promise/provider bridges.
alignas( 16 ) char g_retained_exact_stack[64 * 1024];
ContextId g_retained_exact_fiber = 0;
int g_retained_exact_accepted = 0;
uint32_t g_retained_exact_bits = 0;

void retained_exact_entry( void* )
{
    const ParkResult parked = yield_park(
            "retained-exact-wait", ParkWake::RetainedExact( 74 ) );
    g_retained_exact_accepted = parked.accepted ? 1 : 0;
    g_retained_exact_bits = static_cast<uint32_t>( parked.value );
    yield_park( "retired-after-retained-wake", ParkWake::None() );
    for( ;; )
        yield_park( "unexpected", ParkWake::None() );
}

void Scenario_RetainedExactNegativeResult()
{
    g_retained_exact_accepted = 0;
    g_retained_exact_bits = 0;
    g_retained_exact_fiber = fiber_create(
            retained_exact_entry, nullptr, g_retained_exact_stack,
            sizeof( g_retained_exact_stack ), 32 * 1024,
            "retained-exact" );

    if( !g_retained_exact_fiber
        || !fiber_start( g_retained_exact_fiber, 0 ) )
    {
        return report( "retained_exact_negative_result_is_data", false,
                       "fiber setup failed" );
    }

    drain_all();

    if( fiber_release( g_retained_exact_fiber ) )
        return report( "retained_exact_negative_result_is_data", false,
                       "release reclaimed a retained exact wake target" );

    if( mark_ready_retained( g_retained_exact_fiber, 1, 999 )
        || status_of( g_retained_exact_fiber ) != Status::Parked )
    {
        return report( "retained_exact_negative_result_is_data", false,
                       "a stale retained token consumed the park" );
    }

    constexpr uint32_t RESULT_BITS = 0x80000001u;
    if( !mark_ready_retained(
            g_retained_exact_fiber, static_cast<int>( RESULT_BITS ), 74 ) )
    {
        return report( "retained_exact_negative_result_is_data", false,
                       "matching retained wake was refused" );
    }

    drain_all();

    if( !g_retained_exact_accepted || g_retained_exact_bits != RESULT_BITS
        || !fiber_release( g_retained_exact_fiber ) )
    {
        return report( "retained_exact_negative_result_is_data", false,
                       "negative result was mistaken for admission failure" );
    }

    g_retained_exact_fiber = 0;
    report( "retained_exact_negative_result_is_data", true );
}

// A failed revoker cannot be treated as success. The exact wake remains the
// only legal way to resume the preserved context, and a stale token must not
// consume that lease.
alignas( 16 ) char g_refusing_cancel_stack[64 * 1024];
ContextId g_refusing_cancel_fiber = 0;
int g_refusing_cancel_calls = 0;
int g_refusing_cancel_stage = 0;

bool refuse_park_cancel( ContextId, WakeToken )
{
    ++g_refusing_cancel_calls;
    return false;
}

void refusing_cancel_entry( void* )
{
    g_refusing_cancel_stage = 1;
    yield_park( "refusing-cancellable-wake",
                ParkWake::Cancellable( 72, &refuse_park_cancel ) );
    g_refusing_cancel_stage = 2;
    yield_park( "retired-after-owned-wake", ParkWake::None() );
    for( ;; )
        yield_park( "unexpected", ParkWake::None() );
}

void Scenario_FiberReleaseCancelRefusalAndExactWake()
{
    g_refusing_cancel_calls = 0;
    g_refusing_cancel_stage = 0;
    g_refusing_cancel_fiber = fiber_create(
            refusing_cancel_entry, nullptr, g_refusing_cancel_stack,
            sizeof( g_refusing_cancel_stack ), 32 * 1024,
            "refusing-cancel" );

    if( !g_refusing_cancel_fiber || !fiber_start( g_refusing_cancel_fiber, 0 ) )
        return report( "owned_wake_token_and_cancel_refusal", false,
                       "fiber setup failed" );

    drain_all();

    if( fiber_release( g_refusing_cancel_fiber )
        || g_refusing_cancel_calls != 1
        || status_of( g_refusing_cancel_fiber ) != Status::Parked )
    {
        return report( "owned_wake_token_and_cancel_refusal", false,
                       "failed revocation did not preserve the context" );
    }

    if( mark_ready_owned( g_refusing_cancel_fiber, 1, 999 )
        || status_of( g_refusing_cancel_fiber ) != Status::Parked )
    {
        return report( "owned_wake_token_and_cancel_refusal", false,
                       "a stale token consumed the exact wake" );
    }

    if( !mark_ready_owned( g_refusing_cancel_fiber, 1, 72 ) )
        return report( "owned_wake_token_and_cancel_refusal", false,
                       "the matching exact wake was refused" );

    drain_all();

    if( g_refusing_cancel_stage != 2
        || !fiber_release( g_refusing_cancel_fiber ) )
    {
        return report( "owned_wake_token_and_cancel_refusal", false,
                       "context was not reclaimable after the exact wake" );
    }

    g_refusing_cancel_fiber = 0;
    report( "owned_wake_token_and_cancel_refusal", true );
}

// A wake deferred while Running belongs to the next ordinary external park.
// It must never silently consume a newly-created exact timer lease.
alignas( 16 ) char g_pending_exact_stack[64 * 1024];
ContextId g_pending_exact_fiber = 0;
int g_pending_exact_cancel_calls = 0;
int g_pending_exact_refusal = 0;
int g_pending_exact_result = 0;

bool cancel_pending_exact( ContextId, WakeToken token )
{
    if( token == 73 )
        ++g_pending_exact_cancel_calls;
    return true;
}

void pending_exact_entry( void* )
{
    mark_ready( current(), 55 );
    const ParkResult exact = yield_park(
            "must-not-consume-deferred-wake",
            ParkWake::Cancellable( 73, &cancel_pending_exact ) );
    g_pending_exact_refusal = exact.accepted ? 1 : 0;
    cancel_pending_exact( current(), 73 );
    const ParkResult deferred = yield_park( "consume-deferred-wake" );
    g_pending_exact_result = deferred.accepted ? deferred.value : -1;
    yield_park( "retired-after-deferred-wake", ParkWake::None() );
    for( ;; )
        yield_park( "unexpected", ParkWake::None() );
}

void Scenario_PendingWakeDoesNotConsumeExactLease()
{
    g_pending_exact_cancel_calls = 0;
    g_pending_exact_refusal = 0;
    g_pending_exact_result = 0;
    g_pending_exact_fiber = fiber_create(
            pending_exact_entry, nullptr, g_pending_exact_stack,
            sizeof( g_pending_exact_stack ), 32 * 1024,
            "pending-vs-exact" );

    if( !g_pending_exact_fiber || !fiber_start( g_pending_exact_fiber, 0 ) )
        return report( "pending_wake_does_not_consume_exact_lease", false,
                       "fiber setup failed" );

    drain_all();

    if( g_pending_exact_refusal != 0
        || g_pending_exact_cancel_calls != 1
        || g_pending_exact_result != 55
        || status_of( g_pending_exact_fiber ) != Status::Parked )
    {
        return report( "pending_wake_does_not_consume_exact_lease", false,
                       "deferred and exact wake ownership crossed" );
    }

    if( !fiber_release( g_pending_exact_fiber ) )
        return report( "pending_wake_does_not_consume_exact_lease", false,
                       "safe terminal park refused release" );

    g_pending_exact_fiber = 0;
    report( "pending_wake_does_not_consume_exact_lease", true );
}

// ---------------------------------------------------------------------------
// STAR-MODE TRANSFERS (doc 22 Phase B) — libcontext's symmetric contract kept,
// but every entry performed by the scheduler.
//
// The load-bearing claim: KiCad's TOOL_MANAGER calls cofunc->Call(evt) and
// reads Running() on the NEXT LINE, so a "call" must return only after the
// coroutine has yielded or finished. Under the star the caller parks and the
// scheduler resumes it — from the caller's C++ frame that is indistinguishable
// from a synchronous return, which is what makes the flip possible at all.
// ---------------------------------------------------------------------------
// A fiber entry must NEVER return — "if entry_func returns, the entire program
// will end" (emscripten fiber.h). libcontext's trampoline loops forever for
// exactly this reason; these harness bodies do the same by parking for good
// once their script is finished. (Getting this wrong wedges the battery with
// no output at all, which is how it was found.)
[[noreturn]] void park_forever()
{
    for( ;; )
        yield_park( "fiber-finished", ParkWake::None() );
}

alignas( 16 ) char g_tool_stack[64 * 1024];
alignas( 16 ) char g_caller_stack[64 * 1024];

ContextId g_star_caller = 0;
ContextId g_star_tool = 0;

int g_tool_entries = 0;
int g_tool_yields = 0;
intptr_t g_tool_saw_value = 0;
int g_caller_stage = 0;
intptr_t g_call_returned = 0;
int g_tool_running_after_call = -1;
int g_call_order_violation = 0;

// The "coroutine": runs, yields once, then finishes — libcontext's shape.
void star_tool_entry( void* )
{
    for( ;; )
    {
        ++g_tool_entries;
        g_tool_saw_value = 0;

        // KiYield(): hand control back to whoever called us.
        ++g_tool_yields;
        fiber_transfer( g_star_tool, g_star_caller, 0xB1 );

        // Resumed: finish and go back for good. This source must become
        // terminal before the caller can release its borrowed C stack.
        fiber_finish_transfer( g_star_tool, g_star_caller, 0xF1 );
    }
}

// The "TOOL_MANAGER": Call(), then read state on the next line.
void star_caller_entry( void* )
{
    g_caller_stage = 1;

    // Call(): the tool must have run and yielded by the time this returns.
    g_call_returned = fiber_transfer( g_star_caller, g_star_tool, 0xA1 );

    // THE assertion that decides whether Phase B is possible.
    g_tool_running_after_call = ( g_tool_entries == 1 && g_tool_yields == 1 ) ? 1 : 0;

    if( g_tool_entries != 1 )
        g_call_order_violation = 1;

    g_caller_stage = 2;

    // Resume(): drive it to completion.
    fiber_transfer( g_star_caller, g_star_tool, 0xA2 );
    g_caller_stage = 3;
    park_forever();
}

void Scenario_StarTransferKeepsCallSynchronous()
{
    g_tool_entries = 0;
    g_tool_yields = 0;
    g_caller_stage = 0;
    g_call_returned = 0;
    g_tool_running_after_call = -1;
    g_call_order_violation = 0;

    g_star_caller = fiber_create( star_caller_entry, nullptr, g_caller_stack,
                                  sizeof( g_caller_stack ), 32 * 1024, "star-caller" );
    g_star_tool = fiber_create( star_tool_entry, nullptr, g_tool_stack,
                                sizeof( g_tool_stack ), 32 * 1024, "star-tool" );

    if( !g_star_caller || !g_star_tool )
        return report( "star_transfer_call_is_synchronous", false, "fiber_create failed" );

    // The scheduler kicks the caller, then pumps until quiescent — exactly the
    // shape the production tick will have.
    if( !fiber_start( g_star_caller, 0 ) )
        return report( "star_transfer_call_is_synchronous", false, "fiber_start refused" );

    const size_t ran = drain_all().transitions;

    if( g_caller_stage != 3 )
        return report( "star_transfer_call_is_synchronous", false,
                       "caller did not run to completion (stage="
                       + std::to_string( g_caller_stage ) + ")" );

    if( g_call_order_violation )
        return report( "star_transfer_call_is_synchronous", false,
                       "the tool had not run when Call() returned - the synchronous "
                       "contract TOOL_MANAGER depends on is broken" );

    if( g_tool_running_after_call != 1 )
        return report( "star_transfer_call_is_synchronous", false,
                       "tool state wrong right after Call(): entries="
                       + std::to_string( g_tool_entries ) + " yields="
                       + std::to_string( g_tool_yields ) );

    if( g_call_returned != 0xB1 )
        return report( "star_transfer_call_is_synchronous", false,
                       "Call() returned the wrong transfer value: "
                       + std::to_string( g_call_returned ) );

    if( ran < 4 )
        return report( "star_transfer_call_is_synchronous", false,
                       "too few transitions (" + std::to_string( ran ) + ")" );

    if( status_of( g_star_tool ) != Status::Finished )
        return report( "fiber_terminal_star", false,
                       std::string( "terminal source status: " )
                       + status_name( status_of( g_star_tool ) ) );

    fiber_release( g_star_tool );
    fiber_release( g_star_caller );
    report( "fiber_terminal_star", true );
    report( "star_transfer_call_is_synchronous", true );
}

// A transfer chain three deep (root → A → B), the nested-Call shape, plus the
// proof that a parked star context in the OTHER lane is untouched throughout.
alignas( 16 ) char g_chain_a_stack[64 * 1024];
alignas( 16 ) char g_chain_b_stack[64 * 1024];

ContextId g_chain_root = 0;
ContextId g_chain_a = 0;
ContextId g_chain_b = 0;
int g_chain_trace[8];
int g_chain_len = 0;

void chain_note( int aMark )
{
    if( g_chain_len < 8 )
        g_chain_trace[g_chain_len++] = aMark;
}

void chain_b_entry( void* )
{
    for( ;; )
    {
        chain_note( 3 );
        fiber_transfer( g_chain_b, g_chain_a, 0 );
    }
}

void chain_a_entry( void* )
{
    for( ;; )
    {
        chain_note( 2 );
        fiber_transfer( g_chain_a, g_chain_b, 0 );   // nested "Call"
        chain_note( 4 );
        fiber_transfer( g_chain_a, g_chain_root, 0 );
    }
}

void chain_root_entry( void* )
{
    chain_note( 1 );
    fiber_transfer( g_chain_root, g_chain_a, 0 );
    chain_note( 5 );
    park_forever();
}

void Scenario_StarTransferChain()
{
    g_chain_len = 0;

    const ContextId parked_star = create( body_parks_once, nullptr, "coexist-during-chain" );
    drain();   // it parks and must stay parked across every transfer below

    g_chain_root = fiber_create( chain_root_entry, nullptr, g_caller_stack,
                                 sizeof( g_caller_stack ), 32 * 1024, "chain-root" );
    g_chain_a = fiber_create( chain_a_entry, nullptr, g_chain_a_stack,
                              sizeof( g_chain_a_stack ), 32 * 1024, "chain-a" );
    g_chain_b = fiber_create( chain_b_entry, nullptr, g_chain_b_stack,
                              sizeof( g_chain_b_stack ), 32 * 1024, "chain-b" );

    if( !g_chain_root || !g_chain_a || !g_chain_b )
        return report( "star_transfer_chain", false, "fiber_create failed" );

    fiber_start( g_chain_root, 0 );
    drain_all();

    // Strict order: root, A, B, back to A, back to root.
    const int expected[5] = { 1, 2, 3, 4, 5 };

    if( g_chain_len != 5 )
        return report( "star_transfer_chain", false,
                       "trace length " + std::to_string( g_chain_len ) + ", expected 5" );

    for( int i = 0; i < 5; ++i )
    {
        if( g_chain_trace[i] != expected[i] )
            return report( "star_transfer_chain", false,
                           "wrong order at " + std::to_string( i ) + ": "
                           + std::to_string( g_chain_trace[i] ) );
    }

    if( status_of( parked_star ) != Status::Parked )
        return report( "star_transfer_chain", false,
                       "the parked star context was disturbed by the transfers" );

    mark_ready( parked_star, 1 );
    drain();
    destroy( parked_star );

    fiber_release( g_chain_b );
    fiber_release( g_chain_a );
    fiber_release( g_chain_root );
    report( "star_transfer_chain", true );
}

// More than one production drain budget of finite star transfers must finish
// across fresh JavaScript tasks.  The old drain_all() returned after exactly
// 4096 transitions and left the Ready source in the FIFO with no owner for a
// later pump; this reducer crosses that boundary deliberately.
constexpr int BUDGET_CHAIN_TRANSFERS =
        static_cast<int>( DrainTransitionsPerPump ) + 733;
void Scenario_AsyncWake();
alignas( 16 ) char g_budget_chain_a_stack[64 * 1024];
alignas( 16 ) char g_budget_chain_b_stack[64 * 1024];
ContextId g_budget_chain_a = 0;
ContextId g_budget_chain_b = 0;
int g_budget_chain_remaining = 0;
int g_budget_chain_completed = 0;
int g_budget_chain_pumps = 0;
int g_budget_chain_same_task_recursion = 0;
bool g_budget_chain_in_pump = false;
bool g_budget_chain_active = false;

EM_JS( int, sched_ctx_arm_budget_continuation, (), {
    var scheduler = globalThis.__wxScheduler;
    if (!scheduler || scheduler.dead
        || typeof scheduler._armSchedPump !== "function") return 0;
    scheduler._armSchedPump();
    return scheduler._pumpArmed ? 1 : 0;
} );

void budget_chain_entry( void* aPeer )
{
    const ContextId peer = *static_cast<ContextId*>( aPeer );
    const ContextId self = current();

    for( ;; )
    {
        if( g_budget_chain_remaining-- <= 0 )
        {
            ++g_budget_chain_completed;
            yield_park( "budget-chain-finished", ParkWake::None() );
            continue;
        }

        fiber_transfer( self, peer, 0 );
    }
}

void finish_budget_chain_reducer()
{
    const bool complete = g_budget_chain_completed == 1;
    const bool crossedFreshTask = g_budget_chain_pumps >= 2;
    const bool quiescent = status_of( g_budget_chain_a ) == Status::Parked
                           || status_of( g_budget_chain_b ) == Status::Parked;

    if( !complete )
        report( "drain_budget_finite_continuation", false,
                "finite transfer chain did not complete exactly once" );
    else if( !crossedFreshTask )
        report( "drain_budget_finite_continuation", false,
                "chain never crossed a fresh task boundary" );
    else if( g_budget_chain_same_task_recursion != 0 )
        report( "drain_budget_finite_continuation", false,
                "continuation recursively re-entered the active pump" );
    else if( !quiescent )
        report( "drain_budget_finite_continuation", false,
                "finite chain did not reach a parked quiescent endpoint" );
    else
        report( "drain_budget_finite_continuation", true );

    fiber_release( g_budget_chain_a );
    fiber_release( g_budget_chain_b );
    g_budget_chain_a = 0;
    g_budget_chain_b = 0;
    g_budget_chain_active = false;
}

extern "C" EMSCRIPTEN_KEEPALIVE void sched_ctx_budget_chain_pump()
{
    if( g_budget_chain_in_pump )
    {
        ++g_budget_chain_same_task_recursion;
        return;
    }

    g_budget_chain_in_pump = true;
    ++g_budget_chain_pumps;
    const DrainResult result = drain_all();
    g_budget_chain_in_pump = false;

    if( result.disposition == DrainDisposition::ContinueOnFreshTask )
    {
        if( !sched_ctx_arm_budget_continuation() )
        {
            report( "drain_budget_finite_continuation", false,
                    "physical arbiter refused the fresh-task continuation" );
            g_budget_chain_active = false;
            Scenario_AsyncWake();
        }
        return;
    }

    if( result.disposition == DrainDisposition::Livelock )
    {
        report( "drain_budget_finite_continuation", false,
                "finite chain was classified as a livelock" );
    }
    else
    {
        finish_budget_chain_reducer();
    }

    // This scenario is asynchronous.  Continue the battery only after its
    // cross-task continuation reached quiescence.
    Scenario_AsyncWake();
}

void Scenario_DrainBudgetFiniteContinuation()
{
    g_budget_chain_remaining = BUDGET_CHAIN_TRANSFERS;
    g_budget_chain_completed = 0;
    g_budget_chain_pumps = 0;
    g_budget_chain_same_task_recursion = 0;
    g_budget_chain_active = true;
    g_budget_chain_a = fiber_create(
            budget_chain_entry, &g_budget_chain_b, g_budget_chain_a_stack,
            sizeof( g_budget_chain_a_stack ), 32 * 1024, "budget-chain-a" );
    g_budget_chain_b = fiber_create(
            budget_chain_entry, &g_budget_chain_a, g_budget_chain_b_stack,
            sizeof( g_budget_chain_b_stack ), 32 * 1024, "budget-chain-b" );

    if( !g_budget_chain_a || !g_budget_chain_b
        || !fiber_start( g_budget_chain_a, 0 ) )
    {
        report( "drain_budget_finite_continuation", false,
                "could not start finite transfer chain" );
        Scenario_AsyncWake();
        return;
    }

    sched_ctx_budget_chain_pump();
}

// Production scheduler-shim surface used by _armSchedPump().  The reducer
// deliberately exercises the same physical native-entry FIFO and readiness
// probe as wxWasmDrainSchedulerBatch(), while keeping this pure scheduler
// harness independent of wx.
extern "C" int EMSCRIPTEN_KEEPALIVE wxWasmNativeEntryReady()
{
    return current() == 0 && !transition_in_flight()
            && !any_context_has_inplace_park() ? 1 : 0;
}

extern "C" void EMSCRIPTEN_KEEPALIVE wxWasmSchedPump()
{
    if( g_budget_chain_active )
        sched_ctx_budget_chain_pump();
}

// ---------------------------------------------------------------------------
// scenario 10: a REAL async wake — JS timeout resolves the park
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
    const ParkResult parked = yield_park( "js-promise" );
    g_async_result = parked.accepted ? parked.value : -1;
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
    Scenario_ExecutionOwnerHalfReducer();
    Scenario_ExecutionOwnerPositiveSleepNestedPump();
    Scenario_ExecutionOwnerPopupScopePolicy();
    Scenario_ExecutionOwnerStartupBoundary();
    Scenario_ExecutionLeaseProvenanceReopen();
    Scenario_ExecutionIngressReceiptHandback();
    Scenario_ExecutionAncestorCloseLifo();
    Scenario_ExecutionSubmitDiscardHandshake();
    Scenario_ExecutionQueueCounters();
    Scenario_ExecutionRetainedByteLease();
    Scenario_FifoOrder();
    Scenario_OneTransitionInFlight();
    Scenario_RegistryRefusals();
    Scenario_ReadyPublicationIsTransactional();
    Scenario_DeepPark();
    Scenario_FiberNestsInContext();
    Scenario_ForeignStackRefused();
    Scenario_FiberRoundtrip();
    Scenario_FiberNormalizesEveryStackAlignment();
    Scenario_FiberReleaseSuspended();
    Scenario_FiberAdmissionRefusals();
    Scenario_ReadyClaimIsNotTransferable();
    Scenario_FiberAndStarCoexist();
    Scenario_FiberTerminalDirect();
    Scenario_DispatchContextReleaseBeforeErase();
    Scenario_FiberReleaseInplacePark();
    Scenario_FiberReleaseCancellablePark();
    Scenario_FiberReleaseExternalParkRefused();
    Scenario_RetainedExactNegativeResult();
    Scenario_FiberReleaseCancelRefusalAndExactWake();
    Scenario_PendingWakeDoesNotConsumeExactLease();
    Scenario_StarTransferKeepsCallSynchronous();
    Scenario_StarTransferChain();

    // The budget reducer and the final wake both cross real macrotask
    // boundaries. The reducer starts the wake scenario only after its finite
    // transfer chain becomes quiescent; that last wake emits STATS + SUMMARY.
    Scenario_DrainBudgetFiniteContinuation();
    return 0;
}
