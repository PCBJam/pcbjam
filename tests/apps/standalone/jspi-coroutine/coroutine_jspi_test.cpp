// jspi-coroutine — validates the JSPI libcontext backend (PCBJAM_JSPI) through
// the EXACT protocol coroutine.h drives it with, without linking wx or KiCad.
//
// MiniCoro below is a compact transcription of COROUTINE<>'s libcontext
// mechanics (doCall/jumpIn/jumpOut/callerStub, INVOCATION_ARGS, the
// CALL_CONTEXT::Continue root-bounce loop, the finish_fcontext completion
// hook) — kicad/include/tool/coroutine.h stays untouched; if that file's
// protocol changes, change this mirror too.
//
// Scenarios ported from the study prototype (.jspi-assets/jspi-proto), plus
// backend-specific cases: finished-activation reclaim, mid-body release
// census, ghost-jump refusal.
//
// Output contract (parsed by tests/jspi/jspi-coroutine.spec.ts):
//   [JSPI_CORO] CASE <name> PASS|FAIL(<detail>)
//   [JSPI_CORO] SUMMARY passed=<n> failed=<n>

#include <emscripten.h>
#include <emscripten/em_js.h>
#include <libcontext.h>

#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

// --- MiniCoro: coroutine.h's libcontext protocol, minimally ------------------

struct MiniCoro;

struct INVOCATION_ARGS
{
    enum { FROM_ROOT = 0, FROM_ROUTINE = 1, CONTINUE_AFTER_ROOT = 2 };
    int        type;
    MiniCoro*  destination;
    void*      context; // CALL_CONTEXT in KiCad; opaque here
};

struct CTX_SLOT
{
    libcontext::fcontext_t ctx = nullptr;
};

struct MiniCoro
{
    using Body = std::function<void( MiniCoro& )>;

    explicit MiniCoro( Body aBody ) : m_body( std::move( aBody ) ) {}

    ~MiniCoro()
    {
        // Mirror of coroutine.h's ownership rule: m_callee.ctx is the one
        // record we own. m_caller.ctx is BORROWED (the enterer's record or
        // the root, written by jump_fcontext's symmetric protocol) — the old
        // release here was the phantom-release bug the JSPI backend turned
        // into a live-coroutine kill.
        if( m_callee.ctx )
            libcontext::release_fcontext( m_callee.ctx );
    }

    bool Call( intptr_t aValue = 0 )
    {
        INVOCATION_ARGS args{ INVOCATION_ARGS::FROM_ROOT, this, nullptr };
        m_currentValue = aValue;
        m_callee.ctx = libcontext::make_fcontext( nullptr, 128 * 1024, callerStub );
        m_running = true;
        INVOCATION_ARGS* ret = jumpIn( &args );
        return continueAfterRoot( ret );
    }

    bool Resume( intptr_t aValue = 0 )
    {
        if( !m_running )
            return false;
        INVOCATION_ARGS args{ INVOCATION_ARGS::FROM_ROOT, this, nullptr };
        m_resumeValue = aValue;
        INVOCATION_ARGS* ret = jumpIn( &args );
        return continueAfterRoot( ret );
    }

    void Yield( intptr_t aValue = 0 )
    {
        m_yieldValue = aValue;
        jumpOut();
        m_currentValue = m_resumeValue;
    }

    void RunMainStack( std::function<void()> aFunc )
    {
        m_mainFn = std::move( aFunc );
        m_argsOut = { INVOCATION_ARGS::CONTINUE_AFTER_ROOT, this, nullptr };
        jumpOutWith( &m_argsOut );
        m_currentValue = m_resumeValue;
    }

    bool     Running() const { return m_running; }
    intptr_t CurrentValue() const { return m_currentValue; }
    intptr_t YieldValue() const { return m_yieldValue; }
    size_t   EntryCount() const { return m_entryCount; }

    // -- protocol internals (transcribed from coroutine.h) --
    static void callerStub( intptr_t aData )
    {
        auto& args = *reinterpret_cast<INVOCATION_ARGS*>( aData );
        MiniCoro* cor = args.destination;

        ++cor->m_entryCount;
        cor->m_body( *cor );
        cor->m_running = false;

        // the 3-line JSPI hook coroutine.h carries under PCBJAM_JSPI
        libcontext::finish_fcontext( cor->m_callee.ctx );

        cor->jumpOut();
        // JSPI backend: the finishing jumpOut RETURNS (sentinel) and this
        // frame unwinds, completing the activation.
    }

    INVOCATION_ARGS* jumpIn( INVOCATION_ARGS* args )
    {
        return reinterpret_cast<INVOCATION_ARGS*>(
            libcontext::jump_fcontext( &m_caller.ctx, m_callee.ctx,
                                       reinterpret_cast<intptr_t>( args ) ) );
    }

    void jumpOut() { jumpOutWith( &m_argsFromRoutine ); }

    void jumpOutWith( INVOCATION_ARGS* args )
    {
        intptr_t r = libcontext::jump_fcontext( &m_callee.ctx, m_caller.ctx,
                                                reinterpret_cast<intptr_t>( args ) );
        auto* ret = reinterpret_cast<INVOCATION_ARGS*>( r );
        // like coroutine.h jumpOut: touch the returned args (sentinel-safe)
        m_lastContext = ret ? ret->context : nullptr;
    }

    // CALL_CONTEXT::Continue (coroutine.h:175-183) — service root bounces
    bool continueAfterRoot( INVOCATION_ARGS* ret )
    {
        while( m_running && ret && ret->type == INVOCATION_ARGS::CONTINUE_AFTER_ROOT )
        {
            m_mainFn();
            ++m_rootRuns;
            INVOCATION_ARGS args{ INVOCATION_ARGS::FROM_ROOT, this, nullptr };
            m_resumeValue = m_rootResumeValue;
            ret = jumpIn( &args );
        }
        return m_running;
    }

    Body                  m_body;
    CTX_SLOT              m_caller, m_callee;
    bool                  m_running = false;
    intptr_t              m_currentValue = 0, m_resumeValue = 0, m_yieldValue = 0;
    intptr_t              m_rootResumeValue = 77;
    size_t                m_entryCount = 0;
    int                   m_rootRuns = 0;
    void*                 m_lastContext = nullptr;
    std::function<void()> m_mainFn;
    INVOCATION_ARGS       m_argsFromRoutine{ INVOCATION_ARGS::FROM_ROUTINE, nullptr, nullptr };
    INVOCATION_ARGS       m_argsOut{ INVOCATION_ARGS::FROM_ROUTINE, nullptr, nullptr };
};

// --- JS census helpers -------------------------------------------------------
EM_JS( int, js_live_slot_count, (), {
    const L = globalThis.__libctxJspi;
    return L ? Object.keys( L.s ).length : -1;
} );
EM_JS( int, js_dead_parked, (), {
    const L = globalThis.__libctxJspi;
    return L ? L.deadParked : -1;
} );
EM_JS( int, js_ghost_count, (), {
    const L = globalThis.__libctxJspi;
    return L ? L.ghosts : -1;
} );
EM_JS( void, js_schedule_resume_marker, (), {
    globalThis.__timerFired = 0;
    setTimeout( () => { globalThis.__timerFired = 1; }, 10 );
} );
EM_ASYNC_JS( void, js_wait_ms, ( int ms ), {
    await new Promise( ( r ) => setTimeout( r, ms ) );
} );
EM_JS( int, js_timer_fired, (), { return globalThis.__timerFired | 0; } );

// --- test rig ----------------------------------------------------------------
static int g_passed = 0, g_failed = 0;

static void report( const char* name, bool ok, const std::string& detail = "" )
{
    if( ok )
    {
        ++g_passed;
        std::printf( "[JSPI_CORO] CASE %s PASS\n", name );
    }
    else
    {
        ++g_failed;
        std::printf( "[JSPI_CORO] CASE %s FAIL(%s)\n", name, detail.c_str() );
    }
}

int main()
{
    // 1. first entry runs body exactly once, to first yield
    {
        int steps = 0;
        MiniCoro c( [&]( MiniCoro& me ) { steps++; me.Yield( 10 ); steps++; } );
        bool alive = c.Call( 5 );
        report( "first_entry_runs_once",
                alive && steps == 1 && c.YieldValue() == 10 && c.EntryCount() == 1 );
        c.Resume(); // let it finish
    }

    // 2. yield/resume preserves locals across suspensions
    {
        std::vector<int> seen;
        MiniCoro c( [&]( MiniCoro& me ) {
            int local = 100;
            me.Yield( local );
            local += (int) me.CurrentValue();
            me.Yield( local );
            local += (int) me.CurrentValue();
            seen.push_back( local );
        } );
        c.Call();
        bool ok = c.YieldValue() == 100;
        c.Resume( 11 );
        ok = ok && c.YieldValue() == 111;
        c.Resume( 22 );
        ok = ok && !c.Running() && seen.size() == 1 && seen[0] == 133;
        report( "yield_resume_preserves_state", ok );
    }

    // 3. deep recursion preserved across yields (spill-region proof)
    {
        std::function<int( MiniCoro&, int )> deep = [&]( MiniCoro& me, int d ) -> int {
            volatile int frame[32];
            for( int i = 0; i < 32; i++ ) frame[i] = d * 100 + i;
            if( d > 0 )
            {
                int below = deep( me, d - 1 );
                for( int i = 0; i < 32; i++ )
                    if( frame[i] != d * 100 + i ) return -1000000;
                return below + 1;
            }
            me.Yield( 1 );
            me.Yield( 2 );
            for( int i = 0; i < 32; i++ )
                if( frame[i] != i ) return -1000000;
            return 0;
        };
        int result = -1;
        MiniCoro c( [&]( MiniCoro& me ) { result = deep( me, 6 ); } );
        c.Call();
        c.Resume();
        c.Resume();
        report( "deep_stack_preserved_across_yield", !c.Running() && result == 6,
                "result=" + std::to_string( result ) );
    }

    // 4. nested coroutine: child created+run inside parent's body
    {
        std::string order;
        MiniCoro child( [&]( MiniCoro& me ) { order += "c1"; me.Yield(); order += "c2"; } );
        MiniCoro parent( [&]( MiniCoro& me ) {
            order += "p1";
            child.Call();
            order += "p2";
            me.Yield();
            child.Resume();
            order += "p3";
        } );
        parent.Call();
        bool mid = order == "p1c1p2";
        parent.Resume();
        report( "nested_coroutine_call_and_resume",
                mid && order == "p1c1p2c2p3" && !parent.Running() && !child.Running(),
                order );
    }

    // 5. parent yields while child stays suspended; child resumes intact
    {
        std::string order;
        MiniCoro child( [&]( MiniCoro& me ) {
            int keep = 42;
            order += "c1";
            me.Yield();
            order += ( keep == 42 ) ? "c2" : "cX";
        } );
        MiniCoro parent( [&]( MiniCoro& me ) {
            child.Call();
            order += "p1";
            me.Yield();          // parent suspends; child still parked
            order += "p2";
            child.Resume();      // child must resume with locals intact
            order += "p3";
        } );
        parent.Call();
        parent.Resume();
        report( "nested_parent_yield_preserves_suspend", order == "c1p1p2c2p3", order );
    }

    // 6. RunMainStack: functor runs on the caller's activation, then resume
    {
        std::string order;
        MiniCoro c( [&]( MiniCoro& me ) {
            order += "before-root;";
            me.RunMainStack( [&] { order += "on-root;"; } );
            order += "after-root(" + std::to_string( me.CurrentValue() ) + ");";
        } );
        c.Call();
        report( "root_bounce_continue_after_root",
                !c.Running() && c.m_rootRuns == 1
                    && order == "before-root;on-root;after-root(77);",
                order );
    }

    // 7. completion: body runs to the end, Running() flips, activation reclaimed
    {
        MiniCoro c( [&]( MiniCoro& me ) { me.Yield( 1 ); } );
        c.Call();
        c.Resume();
        report( "completion", !c.Running() );
    }

    // 8. resume after finish is refused (ghost contract), no re-entry
    {
        int entries = 0;
        MiniCoro c( [&]( MiniCoro& me ) { entries++; me.Yield(); } );
        c.Call();
        c.Resume();                       // finishes
        bool resumed = c.Resume( 99 );    // must refuse: m_running false short-circuits
        // force a backend-level ghost jump too. Contract update: the ghost
        // refusal must return the SENTINEL, never raw -1 — coroutine.h
        // dereferences the return unconditionally, and a live COROUTINE CAN
        // reach this path (a nested-dispatch partner's record dying
        // mid-flight). The old "coroutine.h can't reach the raw -1" premise
        // was disproven by the boot-time jumpOut OOB.
        intptr_t r = libcontext::jump_fcontext( &c.m_caller.ctx, c.m_callee.ctx, 0 );
        auto* sent = reinterpret_cast<INVOCATION_ARGS*>( r );
        bool sentinelShaped = r != -1 && r != 0
                              && sent->type == INVOCATION_ARGS::FROM_ROUTINE
                              && sent->context == nullptr;
        report( "resume_after_finish_does_not_reenter",
                !resumed && entries == 1 && sentinelShaped,
                "r=" + std::to_string( (long long) r ) );
    }

    // 9. interleaving multiple coroutines
    {
        std::string order;
        MiniCoro a( [&]( MiniCoro& me ) { order += "a1"; me.Yield(); order += "a2"; me.Yield(); order += "a3"; } );
        MiniCoro b( [&]( MiniCoro& me ) { order += "b1"; me.Yield(); order += "b2"; } );
        a.Call(); b.Call(); a.Resume(); b.Resume(); a.Resume();
        report( "interleaving_multiple_coroutines", order == "a1b1a2b2a3", order );
    }

    // 10. stress: many round trips
    {
        int n = 0;
        MiniCoro c( [&]( MiniCoro& me ) {
            for( int i = 0; i < 48; i++ ) { n++; me.Yield( i ); }
        } );
        c.Call();
        while( c.Running() )
            c.Resume();
        report( "stress_many_round_trips", n == 48, std::to_string( n ) );
    }

    // 11. transfer values round-trip through yields and resumes
    {
        intptr_t got = 0;
        MiniCoro c( [&]( MiniCoro& me ) {
            me.Yield( 1234 );
            got = me.CurrentValue();
        } );
        c.Call();
        bool y = c.YieldValue() == 1234;
        c.Resume( 4321 );
        report( "transfer_values_round_trip", y && got == 4321 );
    }

    // 12. yield INSIDE a C++ catch block under native wasm-EH — the case the
    //     HoistCppCatches binaryen pass existed for
    {
        std::string order;
        MiniCoro c( [&]( MiniCoro& me ) {
            try
            {
                order += "t";
                throw 42;
            }
            catch( int e )
            {
                order += "c" + std::to_string( e );
                me.Yield( e );
                order += "r" + std::to_string( (int) me.CurrentValue() );
            }
            order += "d";
        } );
        c.Call();
        c.Resume( 7 );
        report( "yield_inside_catch_block_wasm_eh",
                !c.Running() && order == "tc42r7d", order );
    }

    // 13. resume driven from a JS timer through the wait import (dispatch shape)
    {
        js_schedule_resume_marker();
        MiniCoro c( [&]( MiniCoro& me ) { me.Yield(); } );
        c.Call();
        js_wait_ms( 25 );                 // suspends main; timer fires meanwhile
        bool fired = js_timer_fired() == 1;
        c.Resume();
        report( "async_wait_resume_after_timer", fired && !c.Running() );
    }

    // 14. finished coroutines fully reclaim their JS slots + regions
    {
        int before = js_live_slot_count();
        {
            MiniCoro c( [&]( MiniCoro& me ) { me.Yield(); } );
            c.Call();
            c.Resume();
        }
        int after = js_live_slot_count();
        report( "finished_activation_reclaimed", before == after,
                std::to_string( before ) + "->" + std::to_string( after ) );
    }

    // 15. release while suspended mid-body: censused, never resumed
    {
        int deadBefore = js_dead_parked();
        int bodySteps = 0;
        {
            MiniCoro c( [&]( MiniCoro& me ) { bodySteps++; me.Yield(); bodySteps++; } );
            c.Call();
            // destructor releases while parked mid-body
        }
        int deadAfter = js_dead_parked();
        report( "midbody_release_censused",
                bodySteps == 1 && deadAfter == deadBefore + 1,
                "steps=" + std::to_string( bodySteps )
                    + " dead=" + std::to_string( deadAfter ) );
    }

    // 16. release of the RUNNING record is refused (legacy ~CALL_CONTEXT
    //     phantom-release shape): the coroutine keeps working afterwards
    {
        int deadBefore = js_dead_parked();
        std::string order;
        MiniCoro c( [&]( MiniCoro& me ) {
            order += "a";
            // what the old ~CALL_CONTEXT did: release the borrowed handle of
            // the coroutine that is executing RIGHT NOW
            libcontext::release_fcontext( me.m_callee.ctx );
            order += "b";
            me.Yield( 5 );      // must still park normally
            order += "c";
        } );
        c.Call();
        bool parked = c.Running() && c.YieldValue() == 5;
        c.Resume();             // must still be resumable (record not killed)
        report( "release_of_running_record_refused",
                parked && !c.Running() && order == "abc"
                    && js_dead_parked() == deadBefore,
                order + " dead=" + std::to_string( js_dead_parked() ) );
    }

    // 17. release of a record on the ENTERER CHAIN is refused: a child body
    //     releasing its (running) parent must not kill the parent
    {
        int deadBefore = js_dead_parked();
        std::string order;
        MiniCoro* parentPtr = nullptr;
        MiniCoro child( [&]( MiniCoro& me ) {
            order += "c1";
            // parent is mid-slice on the enterer chain right now
            libcontext::release_fcontext( parentPtr->m_callee.ctx );
            me.Yield();
            order += "c2";
        } );
        MiniCoro parent( [&]( MiniCoro& me ) {
            order += "p1";
            child.Call();
            order += "p2";
            me.Yield();         // parent must still park fine
            order += "p3";
            child.Resume();
        } );
        parentPtr = &parent;
        parent.Call();
        bool mid = order == "p1c1p2" && parent.Running();
        parent.Resume();        // parent record must still be alive
        report( "release_of_enterer_chain_refused",
                mid && order == "p1c1p2p3c2" && !parent.Running()
                    && !child.Running() && js_dead_parked() == deadBefore,
                order + " dead=" + std::to_string( js_dead_parked() ) );
    }

    // 18. destroy-while-parked quarantines WITHOUT poisoning the world:
    //     census +1 exactly once (double release idempotent), later jumps at
    //     the corpse return the sentinel, and fresh coroutines run clean
    {
        int deadBefore = js_dead_parked();
        int stepsAfterPark = 0;
        auto* victim = new MiniCoro( [&]( MiniCoro& me ) {
            me.Yield();
            stepsAfterPark++;   // must NEVER run
        } );
        victim->Call();
        libcontext::fcontext_t corpse = victim->m_callee.ctx;
        delete victim;          // release while parked mid-body -> quarantine
        int deadMid = js_dead_parked();
        libcontext::release_fcontext( corpse ); // idempotent second release
        bool alive = libcontext::context_alive( corpse );
        // a stray jump at the corpse must refuse with the sentinel
        libcontext::fcontext_t from = nullptr;
        intptr_t r = libcontext::jump_fcontext( &from, corpse, 0 );
        auto* sent = reinterpret_cast<INVOCATION_ARGS*>( r );
        bool sentinelShaped = r != -1 && r != 0
                              && sent->type == INVOCATION_ARGS::FROM_ROUTINE;
        // the scheduler keeps working: a fresh coroutine full lifecycle
        std::string order;
        MiniCoro after( [&]( MiniCoro& me ) { order += "x"; me.Yield(); order += "y"; } );
        after.Call();
        after.Resume();
        report( "destroy_while_parked_is_contained",
                deadMid == deadBefore + 1 && js_dead_parked() == deadBefore + 1
                    && stepsAfterPark == 0 && !alive && sentinelShaped
                    && order == "xy" && !after.Running(),
                "dead=" + std::to_string( js_dead_parked() )
                    + " steps=" + std::to_string( stepsAfterPark ) );
    }

    std::printf( "[JSPI_CORO] SUMMARY passed=%d failed=%d\n", g_passed, g_failed );
    return g_failed == 0 ? 0 : 1;
}
