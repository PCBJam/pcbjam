// races_test.cpp - Asyncify race-condition red-green harness.
//
// Reproduces the KiCad-WASM Asyncify failure modes deterministically so the shim
// fixes stay pinned by tests (see features/async/ research dossier):
//
//   - The app performs a fiber swap during OnInit BEFORE the main loop parks.
//     This is the load-bearing topology detail: it means main() is resumed via
//     Fibers.trampoline() when wxGUIEventLoop::DoRun() executes the
//     emscripten_set_main_loop(...,1) `throw "unwind"` park, so the throw tears
//     through the live trampoline do/while. Without the trampoline self-heal
//     shim that wedges Fibers.trampolineRunning=true forever and the FIRST
//     post-park fiber swap hangs (the KiCad schematic/PCB tool hang).
//     coroutine-nested/nested_test.cpp does NOT do a pre-park swap, which is
//     why it never reproduced that hang.
//
//   - EM_ASYNC_JS sleeps (modal dialogs, token waits) overlapping fiber swaps
//     reproduce the single-slot Asyncify.currData clobber family (the KiCad
//     clipboard "index out of bounds" crash).
//
// URL parameters:
//   ?only=<scenario>    run a single scenario instead of the default battery
//                       (used for scenarios that intentionally wedge/crash)
//   ?mode=sleep-park    make the LAST pre-park suspension a sleep instead of a
//                       fiber swap: the park throw then escapes through the
//                       sleep's wakeUp promise reaction as an unhandled
//                       "unwind" rejection (scenario unwind_through_promise)
//
// Output protocol (polled by tests/asyncify/asyncify-races.spec.ts):
//   [ASYNCIFY_RACES] CASE <name>
//   [ASYNCIFY_RACES] PASS <name>   /  FAIL <name> :: <detail>
//   [ASYNCIFY_RACES] WATCHDOG <name> state=.. currData=.. trampolineRunning=..
//   [ASYNCIFY_RACES] SUMMARY total=N passed=N failed=N

#include "wx/wx.h"
#include "wx/dialog.h"
#include "wx/evtloop.h"
#include "wx/timer.h"

#include "kicad_coroutine_harness.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/em_js.h>
#endif

#include <functional>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using coroutine_test::TestCoroutine;

namespace
{

constexpr int ID_SCENARIO_TIMER = wxID_HIGHEST + 700;
constexpr int ID_POLL_TIMER = wxID_HIGHEST + 701;

struct CaseContext
{
    bool                     passed = true;
    std::vector<std::string> failures;

    void Expect( bool aCondition, const std::string& aMessage )
    {
        if( !aCondition )
        {
            passed = false;
            failures.push_back( aMessage );
        }
    }
};


std::string JoinFailures( const std::vector<std::string>& aFailures )
{
    std::ostringstream oss;

    for( std::size_t i = 0; i < aFailures.size(); ++i )
    {
        if( i > 0 )
            oss << " | ";

        oss << aFailures[i];
    }

    return oss.str();
}


void LogLine( const std::string& aLine )
{
#ifdef __EMSCRIPTEN__
    EM_ASM( { console.log( UTF8ToString( $0 ) ); }, aLine.c_str() );
#else
    std::printf( "%s\n", aLine.c_str() );
#endif
}

#ifdef __EMSCRIPTEN__

// --- JS helpers ----------------------------------------------------------------

// Park the calling stack until JS resolves the token (races_resolve_token_after).
EM_ASYNC_JS( int, races_await_token, ( int aToken ), {
    Module.__racesWaits = Module.__racesWaits || {};
    var p = new Promise( ( resolve ) => { Module.__racesWaits[aToken] = resolve; } );
    // JSPI: EVERY suspension must route through the scheduler's turnstile —
    // a raw await's engine-level resume bypasses the SP discipline and never
    // ends the current window (windowLive wedges the pump).
    var S = globalThis.__wxScheduler;
    if( S && S.backend === 'jspi' )
        return await S.promiseYield( p, 'races-token' );
    return await p;
} );

// Resolve a parked token after a JS-side delay (independent of the C++ world,
// so it fires even while every C++ stack is parked).
EM_JS( void, races_resolve_token_after, ( int aToken, int aValue, int aDelayMs ), {
    setTimeout( function() {
        var w = Module.__racesWaits && Module.__racesWaits[aToken];
        if( w ) { delete Module.__racesWaits[aToken]; w( aValue ); }
        else { console.log( '[ASYNCIFY_RACES] WARN resolve-token ' + aToken + ' had no waiter' ); }
    }, aDelayMs );
} );

// Plain parked sleep.
EM_ASYNC_JS( int, races_sleep_ms, ( int aMs ), {
    var S = globalThis.__wxScheduler;
    if( S && S.backend === 'jspi' ) {
        await S.sleepYield( aMs );  // turnstile-routed (see races_await_token)
        return 1;
    }
    await new Promise( ( r ) => setTimeout( r, aMs ) );
    return 1;
} );

// Schedule an async ccall into an exported C function on a FRESH JS/wasm stack.
// This is how the harness drives suspensions while every C++ stack is parked
// (mirrors KiCad's EndModal/clipboard work arriving on fresh event stacks).
EM_JS( void, races_schedule_ccall, ( const char* aFunc, int aDelayMs ), {
    var fn = UTF8ToString( aFunc );
    setTimeout( function() {
        try {
            var p = Module.ccall( fn, null, [], [], { async: true } );
            if( p && p.catch )
                p.catch( function( e ) { console.error( '[ASYNCIFY_RACES] ccall ' + fn + ' rejected: ' + e ); } );
        } catch( e ) {
            console.error( '[ASYNCIFY_RACES] ccall ' + fn + ' threw: ' + e );
        }
    }, aDelayMs );
} );

// Watchdog: if the scenario hasn't marked itself done in aMs, dump the Asyncify
// state and emit a FAIL line. JS-side, so it fires even when C++ is wedged.
EM_JS( void, races_arm_watchdog, ( const char* aName, int aMs ), {
    var name = UTF8ToString( aName );
    Module.__racesDone = Module.__racesDone || {};
    setTimeout( function() {
        if( !Module.__racesDone[name] ) {
            var st = ( typeof Asyncify !== 'undefined' ) ? Asyncify.state : 'n/a';
            var cd = ( typeof Asyncify !== 'undefined' ) ? ( Asyncify.currData || 0 ) : 'n/a';
            var tr = ( typeof Fibers !== 'undefined' ) ? Fibers.trampolineRunning : 'n/a';
            var nf = ( typeof Fibers !== 'undefined' ) ? Fibers.nextFiber : 'n/a';
            console.log( '[ASYNCIFY_RACES] WATCHDOG ' + name + ' state=' + st + ' currData=' + cd
                         + ' trampolineRunning=' + tr + ' nextFiber=' + nf );
            console.log( '[ASYNCIFY_RACES] FAIL ' + name + ' :: watchdog timeout (suspension never completed)' );
        }
    }, aMs );
} );

EM_JS( void, races_mark_done, ( const char* aName ), {
    Module.__racesDone = Module.__racesDone || {};
    Module.__racesDone[UTF8ToString( aName )] = true;
} );

// Quiescence invariant sampled from C++ between scenarios.
//
// Two things are deliberately NOT checked:
//   * Fibers.trampolineRunning — this can run on a stack itself resumed via
//     Fibers.trampoline(), in which case the guard is legitimately true.
//   * Asyncify.currData — under native wasm-EH the top-level event loop is a
//     per-frame-yield while-loop (wxWasmYieldToBrowser, an EM_ASYNC_JS rAF
//     suspend that re-arms every frame; see wxwidgets/src/wasm/evtloop.cpp). So
//     the main stack is asyncify-suspended between frames and currData is
//     legitimately churning — it is non-zero while a frame yield is pending, and
//     can momentarily hold a freed-but-not-yet-nulled buffer right after a
//     concurrent suspension resumes. That is a transient bookkeeping value, NOT a
//     leak (the buffers are _malloc/_free'd each frame — addresses are reused),
//     so requiring currData==0 here is a stale legacy assumption from the old
//     throw-to-park loop. A genuinely stuck suspension is caught by state != 0
//     (Suspending/Rewinding never clearing) and by the scenario watchdogs.
// What's left is the real invariant: the asyncify machine is back to Normal and
// no fiber is queued.
EM_JS( int, races_quiescent, (), {
    try {
        // JSPI glue still defines an Asyncify object (shared library file)
        // but with no state machine - Asyncify.state is undefined there, and
        // that is quiescent-by-construction (suspensions are engine-native).
        var stOk = ( typeof Asyncify === 'undefined' )
                   || Asyncify.state === undefined
                   || Asyncify.state === 0;
        var nfOk = ( typeof Fibers === 'undefined' ) || !Fibers.nextFiber;
        return ( stOk && nfOk ) ? 1 : 0;
    } catch( e ) {
        return 0;
    }
} );

EM_JS( void, races_log_state, ( const char* aTag ), {
    try {
        var tag = UTF8ToString( aTag );
        var st = ( typeof Asyncify !== 'undefined' ) ? Asyncify.state : 'n/a';
        var cd = ( typeof Asyncify !== 'undefined' ) ? ( Asyncify.currData || 0 ) : 'n/a';
        var tr = ( typeof Fibers !== 'undefined' ) ? Fibers.trampolineRunning : 'n/a';
        var nf = ( typeof Fibers !== 'undefined' ) ? Fibers.nextFiber : 'n/a';
        console.log( '[ASYNCIFY_RACES] STATE ' + tag + ' state=' + st + ' currData=' + cd
                     + ' trampolineRunning=' + tr + ' nextFiber=' + nf );
    } catch( e ) {}
} );

// Throw a raw JS error out of the current wasm frame. Used inside the nested
// quasi-modal pump to force the pump's `await ccall('ProcessEvents')` to reject
// (the c27fe8bf silent-stall path).
EM_JS( void, races_throw_js_error, (), {
    throw new Error( 'races forced pump error' );
} );

#endif // __EMSCRIPTEN__

} // namespace


// ---------------------------------------------------------------------------------
// Exported helpers driven from JS on fresh stacks (fire-and-forget async ccalls).
// Globals because ccall'd plain C functions have no frame pointer.
// ---------------------------------------------------------------------------------

static int  g_token2Value = 0;       // out_of_order: second parker's result
static bool g_token2Done = false;
static std::vector<std::string>* g_oooSeq = nullptr;

static int  g_wdtBValue = 0;         // wakeup_during_transition: B-side result
static bool g_wdtBDone = false;

static wxDialog* g_activeModal = nullptr;

extern "C" {

// A complete fiber swap cycle on a fresh stack (Call + Resume to completion).
// Mirrors KiCad's EndModal-driven tool teardown swaps that clobber a parked sleep.
EMSCRIPTEN_KEEPALIVE void races_swap_once()
{
    TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 7 ); } );
    co.Call( 1 );
    co.Resume( 2 );
    LogLine( "[ASYNCIFY_RACES] SWAP-ONCE done" );
}

// Park a second, independent stack on token 2 (out_of_order scenario).
EMSCRIPTEN_KEEPALIVE void races_park_token2()
{
#ifdef __EMSCRIPTEN__
    LogLine( "[ASYNCIFY_RACES] OOO second parker parking" );
    g_token2Value = races_await_token( 2 );
    g_token2Done = true;

    if( g_oooSeq )
        g_oooSeq->push_back( "t2" );

    LogLine( "[ASYNCIFY_RACES] OOO second parker resumed" );
#endif
}

// Park a stack on token 11 (wakeup_during_transition B side).
EMSCRIPTEN_KEEPALIVE void races_wdt_park_b()
{
#ifdef __EMSCRIPTEN__
    LogLine( "[ASYNCIFY_RACES] WDT B parking" );
    g_wdtBValue = races_await_token( 11 );
    g_wdtBDone = true;
    LogLine( "[ASYNCIFY_RACES] WDT B resumed" );
#endif
}

// End the active modal from a fresh stack (mirrors KiCad's EndModal arriving
// while a clipboard sleep is parked).
EMSCRIPTEN_KEEPALIVE void races_end_active_modal()
{
    if( g_activeModal )
    {
        LogLine( "[ASYNCIFY_RACES] ending active modal from fresh stack" );
        g_activeModal->EndModal( wxID_OK );
    }
}

} // extern "C"


// ---------------------------------------------------------------------------------
// The scenario-driver frame
// ---------------------------------------------------------------------------------

class RacesDialog : public wxDialog
{
public:
    RacesDialog( wxWindow* aParent, const wxString& aTag ) :
            wxDialog( aParent, wxID_ANY, aTag, wxDefaultPosition, wxSize( 260, 120 ) )
    {
    }
};


class RacesFrame : public wxFrame
{
public:
    RacesFrame( const std::string& aOnly, bool aSleepParkMode ) :
            wxFrame( nullptr, wxID_ANY, "Asyncify Races Test", wxDefaultPosition,
                     wxSize( 900, 600 ) ),
            m_only( aOnly ),
            m_sleepParkMode( aSleepParkMode ),
            m_scenarioTimer( this, ID_SCENARIO_TIMER ),
            m_pollTimer( this, ID_POLL_TIMER )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );
        m_summary = new wxStaticText( panel, wxID_ANY, "Running asyncify race scenarios..." );
        sizer->Add( m_summary, 0, wxEXPAND | wxALL, 8 );
        panel->SetSizer( sizer );
        CreateStatusBar();

        Bind( wxEVT_TIMER, &RacesFrame::OnScenarioTimer, this, ID_SCENARIO_TIMER );
        Bind( wxEVT_TIMER, &RacesFrame::OnPollTimer, this, ID_POLL_TIMER );

        // Scenarios run AFTER the main loop parks (CallAfter fires on the first
        // rAF ticks) - the same place KiCad tool interactions live.
        CallAfter( [this]() { RunNext(); } );
    }

private:
    // ----- bookkeeping -----

    bool ShouldRun( const std::string& aName ) const
    {
        if( m_sleepParkMode )
            return aName == "unwind_through_promise";

        if( !m_only.empty() )
            return m_only == aName;

        // Default battery: everything that is safe to chain in one page load.
        // modal_in_modal_in_modal, wakeup_during_transition and
        // nested_quasi_modal_pump_error are ?only= singles - they intentionally
        // wedge/crash while their bugs are unfixed and would kill the chain.
        return aName == "post_park_fiber_swap"
               || aName == "sleep_inside_fiber_inside_modal"
               || aName == "out_of_order_sleep_resolution"
               || aName == "long_parked_sleep_clobbered_by_swap";
    }

    void Finalize( const std::string& aName, CaseContext&& aCtx )
    {
#ifdef __EMSCRIPTEN__
        races_mark_done( aName.c_str() );
#endif

        if( aCtx.passed )
            LogLine( "[ASYNCIFY_RACES] PASS " + aName );
        else
            LogLine( "[ASYNCIFY_RACES] FAIL " + aName + " :: " + JoinFailures( aCtx.failures ) );

        m_total += 1;
        m_passed += aCtx.passed ? 1 : 0;

        CallAfter( [this]() { RunNext(); } );
    }

    void CheckQuiescent( CaseContext& aCtx, const std::string& aWhere )
    {
#ifdef __EMSCRIPTEN__
        aCtx.Expect( races_quiescent() == 1,
                     "asyncify machine not quiescent " + aWhere
                     + " (state/currData/trampolineRunning/nextFiber - see STATE log)" );

        if( races_quiescent() != 1 )
            races_log_state( ( "non-quiescent-" + aWhere ).c_str() );
#endif
    }

    void RunNext()
    {
        static const std::vector<std::pair<std::string, void ( RacesFrame::* )()>> ALL = {
            { "post_park_fiber_swap", &RacesFrame::Scenario_PostParkFiberSwap },
            { "modal_in_modal_in_modal", &RacesFrame::Scenario_TripleModal },
            { "sleep_inside_fiber_inside_modal", &RacesFrame::Scenario_SleepInsideFiberInsideModal },
            { "out_of_order_sleep_resolution", &RacesFrame::Scenario_OutOfOrder },
            { "long_parked_sleep_clobbered_by_swap", &RacesFrame::Scenario_LongParkedSleep },
            { "wakeup_during_transition", &RacesFrame::Scenario_WakeupDuringTransition },
            { "nested_quasi_modal_pump_error", &RacesFrame::Scenario_NestedPumpError },
            { "unwind_through_promise", &RacesFrame::Scenario_UnwindThroughPromise },
        };

        while( m_nextIndex < ALL.size() )
        {
            const auto& entry = ALL[m_nextIndex];
            m_nextIndex += 1;

            if( ShouldRun( entry.first ) )
            {
                LogLine( "[ASYNCIFY_RACES] CASE " + entry.first );
                ( this->*( entry.second ) )();
                return;
            }
        }

        FinalizeSuite();
    }

    void FinalizeSuite()
    {
        std::ostringstream oss;
        oss << "[ASYNCIFY_RACES] SUMMARY total=" << m_total << " passed=" << m_passed
            << " failed=" << ( m_total - m_passed );
        LogLine( oss.str() );
        m_summary->SetLabel( wxString::Format( "Done: %d/%d passed", m_passed, m_total ) );
    }

    // ----- scenario 1: post_park_fiber_swap -------------------------------------
    // The KiCad hang topology. OnInit already did a fiber swap, so the park throw
    // went through the live trampoline. With the self-heal shim the guard is
    // reset and this swap works; historically (ablated heal, retired at doc 20
    // D-1) the guard stuck true, Call() never returned, and the watchdog fired.
    void Scenario_PostParkFiberSwap()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "post_park_fiber_swap", 2500 );
        races_log_state( "S1-pre-swap" );
#endif
        CaseContext ctx;

        {
            TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 42 ); } );

            bool running = co.Call( 1 );
            ctx.Expect( running, "post-park fiber should yield" );
            ctx.Expect( co.LastReturnValue() == 42, "yield value should be 42" );

            running = co.Resume( 2 );
            ctx.Expect( !running, "post-park fiber should finish" );
        }

#ifdef __EMSCRIPTEN__
        races_log_state( "S1-post-swap" );
#endif
        CheckQuiescent( ctx, "after post-park swap" );
        Finalize( "post_park_fiber_swap", std::move( ctx ) );
    }

    // ----- scenario 2: modal_in_modal_in_modal ----------------------------------
    // Three nested ShowModal sleeps (LIFO park stack three deep), closed
    // innermost-first, each from a timer firing inside the innermost pump.
    void Scenario_TripleModal()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "modal_in_modal_in_modal", 6000 );
#endif
        m_tripleCtx = std::make_unique<CaseContext>();
        m_tripleSeq.clear();

        m_pendingScenario = [this]() { TripleLevelB(); };
        m_scenarioTimer.StartOnce( 40 );

        RacesDialog dlgA( this, "tripleA" );
        m_dlgA = &dlgA;
        int ra = dlgA.ShowModal();   // parks this (scenario) stack
        m_dlgA = nullptr;

        // Resumes only after B and C closed.
        m_tripleSeq.push_back( "A" );
        m_tripleCtx->Expect( ra == 101, "modal A should return 101, got " + std::to_string( ra ) );
        m_tripleCtx->Expect( m_tripleSeq.size() == 3 && m_tripleSeq[0] == "C" && m_tripleSeq[1] == "B"
                                     && m_tripleSeq[2] == "A",
                             "modals should resume LIFO (C,B,A)" );

        CheckQuiescent( *m_tripleCtx, "after triple modal" );
        Finalize( "modal_in_modal_in_modal", std::move( *m_tripleCtx ) );
        m_tripleCtx.reset();
    }

    void TripleLevelB()
    {
        m_pendingScenario = [this]() { TripleLevelC(); };
        m_scenarioTimer.StartOnce( 40 );

        RacesDialog dlgB( this, "tripleB" );
        m_dlgB = &dlgB;
        int rb = dlgB.ShowModal();   // parks the A-pump tick stack
        m_dlgB = nullptr;

        m_tripleSeq.push_back( "B" );
        m_tripleCtx->Expect( rb == 102, "modal B should return 102, got " + std::to_string( rb ) );

        if( m_dlgA )
            m_dlgA->EndModal( 101 );
    }

    void TripleLevelC()
    {
        m_pendingScenario = [this]() {
            if( m_dlgC )
                m_dlgC->EndModal( 103 );
        };
        m_scenarioTimer.StartOnce( 40 );

        RacesDialog dlgC( this, "tripleC" );
        m_dlgC = &dlgC;
        int rc = dlgC.ShowModal();   // parks the B-pump tick stack
        m_dlgC = nullptr;

        m_tripleSeq.push_back( "C" );
        m_tripleCtx->Expect( rc == 103, "modal C should return 103, got " + std::to_string( rc ) );

        if( m_dlgB )
            m_dlgB->EndModal( 102 );
    }

    // ----- scenario 3: sleep_inside_fiber_inside_modal ---------------------------
    // Modal sleep parked -> fiber started inside its pump -> fiber body parks in
    // ANOTHER sleep -> resolves -> fiber yields -> resumes -> modal closes.
    // Three different buffers (modal malloc, fiber struct, sleep malloc) in flight.
    void Scenario_SleepInsideFiberInsideModal()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "sleep_inside_fiber_inside_modal", 6000 );
#endif
        m_sifimCtx = std::make_unique<CaseContext>();

        m_pendingScenario = [this]() { RunSleepInsideFiber(); };
        m_scenarioTimer.StartOnce( 40 );

        RacesDialog dlg( this, "sifim" );
        m_dlgA = &dlg;
        int result = dlg.ShowModal();
        m_dlgA = nullptr;

        m_sifimCtx->Expect( result == wxID_OK, "sifim modal should return wxID_OK" );
        CheckQuiescent( *m_sifimCtx, "after sleep-inside-fiber-inside-modal" );
        Finalize( "sleep_inside_fiber_inside_modal", std::move( *m_sifimCtx ) );
        m_sifimCtx.reset();
    }

    void RunSleepInsideFiber()
    {
#ifdef __EMSCRIPTEN__
        CaseContext* ctx = m_sifimCtx.get();

        {
            TestCoroutine co( [ctx]( TestCoroutine& self ) {
                // Parks the FIBER stack in a malloc'd sleep buffer while the
                // modal sleep is also parked.
                int r = races_sleep_ms( 150 );
                ctx->Expect( r == 1, "fiber-side sleep should return 1" );
                self.Yield( 901 );
            } );

            bool running = co.Call( 1 );
            ctx->Expect( running, "fiber should yield after its sleep" );
            ctx->Expect( co.LastReturnValue() == 901, "fiber yield value should be 901" );

            running = co.Resume( 2 );
            ctx->Expect( !running, "fiber should finish" );
        }

        if( m_dlgA )
            m_dlgA->EndModal( wxID_OK );
#endif
    }

    // ----- scenario 4: out_of_order_sleep_resolution -----------------------------
    // Two sleeps parked on independent stacks, resolved FIFO (not LIFO).
    void Scenario_OutOfOrder()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "out_of_order_sleep_resolution", 4000 );

        m_oooCtx = std::make_unique<CaseContext>();
        m_oooSeqStore.clear();
        g_oooSeq = &m_oooSeqStore;
        g_token2Done = false;
        g_token2Value = 0;

        // Second parker arrives on a fresh stack at +50ms; resolutions at
        // +600 (token 1, parked FIRST) and +1000 (token 2) - FIFO order.
        races_schedule_ccall( "races_park_token2", 50 );
        races_resolve_token_after( 1, 11, 600 );
        races_resolve_token_after( 2, 22, 1000 );

        int v1 = races_await_token( 1 );   // parks THIS stack

        // Resumed at +600 while token 2 still parked.
        m_oooSeqStore.push_back( "t1" );
        m_oooCtx->Expect( v1 == 11, "token 1 value should be 11" );

        // Wait (event-driven, not blocking) for the second parker to finish.
        m_pollPredicate = []() { return g_token2Done; };
        m_pollBudgetMs = 3000;
        m_onPollDone = [this]( bool aOk ) {
            m_oooCtx->Expect( aOk, "second parker should resume within budget" );
            m_oooCtx->Expect( g_token2Value == 22, "token 2 value should be 22" );
            m_oooCtx->Expect( m_oooSeqStore.size() == 2 && m_oooSeqStore[0] == "t1"
                                      && m_oooSeqStore[1] == "t2",
                              "continuations should run in resolution order t1,t2" );
            g_oooSeq = nullptr;
            CheckQuiescent( *m_oooCtx, "after out-of-order resolution" );
            Finalize( "out_of_order_sleep_resolution", std::move( *m_oooCtx ) );
            m_oooCtx.reset();
        };
        m_pollTimer.Start( 50 );
#else
        CaseContext ctx;
        Finalize( "out_of_order_sleep_resolution", std::move( ctx ) );
#endif
    }

    // ----- scenario 5: long_parked_sleep_clobbered_by_swap ------------------------
    // The KiCad clipboard crash shape: a long-parked sleep crossed by complete
    // fiber-swap cycles on fresh stacks. The scheduler shim restores the sleep's
    // buffer at wakeUp; historically (no save/restore, ablation retired at doc 20
    // D-1) doRewind read a clobbered currData -> "index out of bounds".
    void Scenario_LongParkedSleep()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "long_parked_sleep_clobbered_by_swap", 4000 );

        CaseContext ctx;

        races_schedule_ccall( "races_swap_once", 300 );
        races_schedule_ccall( "races_swap_once", 600 );
        races_resolve_token_after( 3, 33, 1200 );

        int v = races_await_token( 3 );   // parked for 1.2s, swaps land mid-park

        ctx.Expect( v == 33, "long-parked sleep should resume with 33" );
        CheckQuiescent( ctx, "after long-parked sleep" );
        Finalize( "long_parked_sleep_clobbered_by_swap", std::move( ctx ) );
#else
        CaseContext ctx;
        Finalize( "long_parked_sleep_clobbered_by_swap", std::move( ctx ) );
#endif
    }

    // ----- scenario 6 (?only= single): wakeup_during_transition -------------------
    // The KiCad "ENTER at state=2" family: a modal teardown arrives on a fresh
    // stack while a token sleep is parked inside the modal's own pump, then the
    // token resolves into the half-torn-down world. Closest deterministic analog
    // of the clipboard-poll + EndModal collision.
    void Scenario_WakeupDuringTransition()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "wakeup_during_transition", 5000 );
#endif
        m_wdtCtx = std::make_unique<CaseContext>();
        g_wdtBDone = false;
        g_wdtBValue = 0;

        m_pendingScenario = [this]() { RunWdtInsidePump(); };
        m_scenarioTimer.StartOnce( 40 );

        RacesDialog dlg( this, "wdt" );
        g_activeModal = &dlg;
        int result = dlg.ShowModal();
        g_activeModal = nullptr;

        m_wdtCtx->Expect( result == wxID_OK, "wdt modal should return wxID_OK" );

        // The B-side sleep resolves after the modal is gone.
        m_pollPredicate = []() { return g_wdtBDone; };
        m_pollBudgetMs = 3000;
        m_onPollDone = [this]( bool aOk ) {
            m_wdtCtx->Expect( aOk, "B-side sleep should resume after modal teardown" );
            m_wdtCtx->Expect( g_wdtBValue == 2, "B-side value should be 2" );
            CheckQuiescent( *m_wdtCtx, "after wakeup-during-transition" );
            Finalize( "wakeup_during_transition", std::move( *m_wdtCtx ) );
            m_wdtCtx.reset();
        };
        m_pollTimer.Start( 50 );
    }

    void RunWdtInsidePump()
    {
#ifdef __EMSCRIPTEN__
        // Park a fresh stack on token 11 (B side) at +0ms - it outlives the modal.
        races_schedule_ccall( "races_wdt_park_b", 0 );
        // Tear the modal down from a fresh stack at +200ms (while B is parked
        // AND this pump-tick stack is parked on token 10 below).
        races_schedule_ccall( "races_end_active_modal", 200 );
        // Resolve THIS stack's token at +300ms (after the modal teardown began)
        // and B's at +350ms - both land in the post-teardown turbulence.
        races_resolve_token_after( 10, 1, 300 );
        races_resolve_token_after( 11, 2, 350 );

        int a = races_await_token( 10 );   // parks this pump-tick stack
        m_wdtCtx->Expect( a == 1, "A-side token should resolve to 1" );

        // Immediately extend the in-flight window with a fiber swap cycle.
        TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 5 ); } );
        co.Call( 1 );
        bool running = co.Resume( 2 );
        m_wdtCtx->Expect( !running, "post-wake fiber should finish" );
#endif
    }

    // ----- scenario 7 (?only= single): nested_quasi_modal_pump_error --------------
    // c27fe8bf's wxWasmRunNestedLoop pump catches a ProcessEvents rejection and
    // stops pumping WITHOUT resolving its promise: the nested DoRun stays parked
    // forever (silent stall). Red until the wx-layer resolve-on-error fix.
    void Scenario_NestedPumpError()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "nested_quasi_modal_pump_error", 3000 );

        CaseContext ctx;

        // Queue the bomb as a PENDING EVENT: the nested pump's ProcessEvents ->
        // ProcessPendingEvents dispatches it, so the JS error propagates out of
        // the pump's awaited ccall and rejects it. (A wx timer would NOT work:
        // wasm timers fire via emscripten_async_call/callUserCallback and
        // bypass the pump entirely.)
        CallAfter( []() { races_throw_js_error(); } );

        wxGUIEventLoop nestedLoop;
        LogLine( "[ASYNCIFY_RACES] entering nested quasi-modal loop" );
        nestedLoop.Run();   // wxWasmRunNestedLoop parks here
        LogLine( "[ASYNCIFY_RACES] nested loop returned" );

        ctx.Expect( true, "" );   // reaching this line at all is the fix
        CheckQuiescent( ctx, "after nested pump error" );
        Finalize( "nested_quasi_modal_pump_error", std::move( ctx ) );
#else
        CaseContext ctx;
        Finalize( "nested_quasi_modal_pump_error", std::move( ctx ) );
#endif
    }

    // ----- scenario 8 (mode=sleep-park): unwind_through_promise -------------------
    // OnInit made the LAST pre-park suspension a sleep, so the park throw escaped
    // through that sleep's wakeUp promise reaction. The spec asserts no "unwind"
    // reaches pageerror/console; this C++ side just proves the app stayed alive.
    void Scenario_UnwindThroughPromise()
    {
        CaseContext ctx;

        // A post-park fiber swap doubles as a liveness check in this mode too.
        TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 77 ); } );
        bool running = co.Call( 1 );
        ctx.Expect( running && co.LastReturnValue() == 77, "post-park fiber should work" );
        co.Resume( 2 );

        CheckQuiescent( ctx, "after sleep-park startup" );
        Finalize( "unwind_through_promise", std::move( ctx ) );
    }

    // ----- timers -----

    void OnScenarioTimer( wxTimerEvent& )
    {
        if( m_pendingScenario )
        {
            auto scenario = std::move( m_pendingScenario );
            m_pendingScenario = nullptr;
            scenario();
        }
    }

    void OnPollTimer( wxTimerEvent& )
    {
        if( !m_pollPredicate )
        {
            m_pollTimer.Stop();
            return;
        }

        m_pollBudgetMs -= 50;
        bool ok = m_pollPredicate();

        if( ok || m_pollBudgetMs <= 0 )
        {
            m_pollTimer.Stop();
            m_pollPredicate = nullptr;
            auto done = std::move( m_onPollDone );
            m_onPollDone = nullptr;

            if( done )
                done( ok );
        }
    }

private:
    std::string                      m_only;
    bool                             m_sleepParkMode;
    std::size_t                      m_nextIndex = 0;
    int                              m_total = 0;
    int                              m_passed = 0;

    wxTimer                          m_scenarioTimer;
    std::function<void()>            m_pendingScenario;

    wxTimer                          m_pollTimer;
    std::function<bool()>            m_pollPredicate;
    std::function<void( bool )>      m_onPollDone;
    int                              m_pollBudgetMs = 0;

    wxDialog*                        m_dlgA = nullptr;
    wxDialog*                        m_dlgB = nullptr;
    wxDialog*                        m_dlgC = nullptr;

    std::unique_ptr<CaseContext>     m_tripleCtx;
    std::vector<std::string>         m_tripleSeq;
    std::unique_ptr<CaseContext>     m_sifimCtx;
    std::unique_ptr<CaseContext>     m_oooCtx;
    std::vector<std::string>         m_oooSeqStore;
    std::unique_ptr<CaseContext>     m_wdtCtx;

    wxStaticText*                    m_summary = nullptr;
};


class RacesApp : public wxApp
{
public:
    bool OnInit() override
    {
        std::string only;
        bool sleepPark = false;

#ifdef __EMSCRIPTEN__
        // Params travel in the URL HASH (#only=...&mode=...), not the query:
        // `npx serve` cleanUrls-redirects *.html and drops the query string on
        // the way. The hash never reaches the server. (Query kept as fallback.)
        char onlyBuf[64] = { 0 };
        EM_ASM( {
            try {
                var p = new URLSearchParams( ( location.hash || "" ).replace( /^#/, "" ) );
                var v = p.get( 'only' ) || new URLSearchParams( location.search ).get( 'only' ) || "";
                stringToUTF8( v.slice( 0, 63 ), $0, 64 );
            } catch( e ) {}
        }, onlyBuf );
        only = onlyBuf;

        sleepPark = EM_ASM_INT( {
            try {
                var p = new URLSearchParams( ( location.hash || "" ).replace( /^#/, "" ) );
                var m = p.get( 'mode' ) || new URLSearchParams( location.search ).get( 'mode' );
                return ( m === 'sleep-park' ) ? 1 : 0;
            } catch( e ) { return 0; }
        } ) == 1;

        LogLine( "[ASYNCIFY_RACES] PARAMS only='" + only + "' sleepPark="
                 + std::to_string( sleepPark ? 1 : 0 ) );

        // JSPI: the ccall'd test levers are promising entries (JSPI_EXPORTS)
        // that can PARK — the shim must track their activations like the wx
        // entries, or their windows leak (untracked completion wedges the
        // resume turnstile until the watchdog clears it).
        EM_ASM( {
            if( globalThis.__wxScheduler && globalThis.__wxScheduler.installExportWraps )
                globalThis.__wxScheduler.installExportWraps(
                    [ 'races_swap_once', 'races_park_token2', 'races_wdt_park_b' ] );
        } );
#endif

        // THE LOAD-BEARING TOPOLOGY: complete a fiber swap cycle during OnInit.
        // From here on, main() runs inside Fibers.trampoline()'s do/while; the
        // upcoming emscripten_set_main_loop(...,1) park throw will tear through
        // that live frame (exactly what KiCad's startup tool burst does).
        {
            TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 1 ); } );
            co.Call( 1 );
            co.Resume( 2 );
            LogLine( "[ASYNCIFY_RACES] PRE-PARK-SWAP done" );
        }

#ifdef __EMSCRIPTEN__
        if( sleepPark )
        {
            // Make the LAST pre-park suspension a sleep: main is then resumed
            // from the sleep's wakeUp (trampoline frame already closed), and the
            // park throw escapes through the wakeUp promise reaction instead.
            races_sleep_ms( 30 );
            LogLine( "[ASYNCIFY_RACES] PRE-PARK-SLEEP done (sleep-park mode)" );
        }
#endif

        RacesFrame* frame = new RacesFrame( only, sleepPark );
        frame->Show();
        return true;
    }
};


wxIMPLEMENT_APP( RacesApp );
