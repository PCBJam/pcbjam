// races_test.cpp - Asyncify race-condition red-green harness.
//
// Reproduces the KiCad-WASM Asyncify failure modes deterministically so the shim
// fixes stay pinned by tests (see features/async/ research dossier):
//
//   - The app performs direct libcontext fiber cycles during OnInit, before the
//     detached wx main-loop context starts. Every possible caller-stack offset
//     is exercised, so adopted-stack alignment cannot depend on heap or binary
//     layout. The historical throw-to-park main loop no longer exists; the
//     detached loop is first entered by the scheduler from a fresh browser task.
//
//   - EM_ASYNC_JS sleeps (modal dialogs, token waits) overlapping fiber swaps
//     reproduce the single-slot Asyncify.currData clobber family (the KiCad
//     clipboard "index out of bounds" crash).
//
// URL parameters:
//   ?only=<scenario>    run a single scenario instead of the default battery
//                       (used for scenarios that intentionally wedge/crash)
//   ?mode=sleep-park    add a startup in-place sleep after the direct fiber
//                       cycles. This retains the historic unwinding-Promise
//                       regression gate while the detached loop itself starts
//                       later from a clean task (scenario unwind_through_promise).
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
#include "wx/wasm/private/execution_owner.h"

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

constexpr int ID_POLL_TIMER = wxID_HIGHEST + 700;
constexpr int ID_DIALOG_TIMER = wxID_HIGHEST + 701;
constexpr int ID_HANDBACK_PARENT = wxID_HIGHEST + 702;
constexpr int ID_HANDBACK_CHILD = wxID_HIGHEST + 703;

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
    return await new Promise( ( resolve ) => { Module.__racesWaits[aToken] = resolve; } );
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
//   * Asyncify.currData — the scheduler shim multiplexes this Emscripten global
//     across physical contexts. A parked context may own saved data while this
//     probe executes on another context, and a transition can restore it
//     transiently. A single global null check is therefore not a lifetime
//     invariant. Stuck work is caught by state != Normal, scheduler books, and
//     the scenario watchdogs.
// What's left is the real invariant: the asyncify machine is back to Normal and
// no fiber is queued.
EM_JS( int, races_quiescent, (), {
    try {
        var stOk = ( typeof Asyncify === 'undefined' ) || Asyncify.state === 0;
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

#endif // __EMSCRIPTEN__

} // namespace


// ---------------------------------------------------------------------------------
// Exported helpers driven from JS on fresh stacks (fire-and-forget async ccalls).
// Globals because ccall'd plain C functions have no frame pointer.
// ---------------------------------------------------------------------------------

static std::function<void()> g_oooTaskA;
static std::function<void()> g_oooTaskB;
static bool g_oooRootTail = false;
static int  g_oooQueueFailures = 0;

static std::function<void()> g_wdtBody;
static bool g_wdtBodyStarted = false;
static bool g_wdtModalReturned = false;
static int  g_wdtQueueFailures = 0;
static wx_wasm_execution::OwnerToken g_wdtCloseOwner;
static std::vector<std::string>* g_wdtTrace = nullptr;

static bool g_longParkedOwnerLive = false;
static int  g_queuedSwapRuns = 0;
static int  g_queuedSwapOverlaps = 0;
static int  g_queuedSwapFailures = 0;

static wxDialog* g_activeModal = nullptr;

static std::function<void()> g_handbackReleaseTask;
static wx_wasm_execution::OwnerToken g_handbackCloseOwner;
static int g_handbackQueueFailures = 0;

void races_run_handback_release( void* )
{
    if( g_handbackReleaseTask )
        g_handbackReleaseTask();
    else
        ++g_handbackQueueFailures;
}

void races_run_queued_swap( void* )
{
    ++g_queuedSwapRuns;

    // Record an admission error without performing the unsafe swap. The
    // reducer must fail deterministically, not corrupt the following case.
    if( g_longParkedOwnerLive )
    {
        ++g_queuedSwapOverlaps;
        return;
    }

    TestCoroutine co( []( TestCoroutine& self ) { self.Yield( 7 ); } );
    bool running = co.Call( 1 );

    if( !running || co.LastReturnValue() != 7 )
    {
        ++g_queuedSwapFailures;
        return;
    }

    running = co.Resume( 2 );

    if( running )
        ++g_queuedSwapFailures;
}

void races_run_ooo_a( void* )
{
    if( g_oooTaskA )
        g_oooTaskA();
}

void races_run_ooo_b( void* )
{
    if( g_oooTaskB )
        g_oooTaskB();
}

void races_run_wdt_body( void* )
{
    if( g_wdtBody )
        g_wdtBody();
}

void races_run_wdt_close( void* )
{
    if( g_wdtTrace )
        g_wdtTrace->push_back( "affiliated-close" );

    if( g_activeModal )
    {
        LogLine( "[ASYNCIFY_RACES] ending active modal from affiliated task" );
        g_activeModal->EndModal( wxID_OK );
    }
    else
    {
        ++g_wdtQueueFailures;
    }

    if( !wxWasmExecutionReleaseOwner( g_wdtCloseOwner ) )
        ++g_wdtQueueFailures;

    g_wdtCloseOwner = {};
}

extern "C" {

// This raw ccall is transport only, like wxWasmEmbindSubmit. The stateful
// fiber body enters later through the execution-owner queue.
EMSCRIPTEN_KEEPALIVE void races_swap_once()
{
    wxWasmExecutionQueueOrdinary( &races_run_queued_swap, nullptr );
}

// These exports are transport only. The browser arrivals remain independent,
// but their suspendable native bodies enter through the execution-owner queue.
EMSCRIPTEN_KEEPALIVE void races_queue_ooo_a()
{
    if( !wxWasmExecutionQueueOrdinary( &races_run_ooo_a, nullptr ) )
        ++g_oooQueueFailures;
}

EMSCRIPTEN_KEEPALIVE void races_queue_ooo_b()
{
    if( !wxWasmExecutionQueueOrdinary( &races_run_ooo_b, nullptr ) )
        ++g_oooQueueFailures;
}

// Transport the B-side browser arrival into the ordinary owner queue.
EMSCRIPTEN_KEEPALIVE void races_wdt_park_b()
{
    if( g_wdtTrace )
        g_wdtTrace->push_back( "b-transport" );

    if( !wxWasmExecutionQueueOrdinary( &races_run_wdt_body, nullptr ) )
        ++g_wdtQueueFailures;
}

// Transport the close arrival into the exact retained modal child. It may
// pass the ordinary B-side job because only this affiliated tail can retire
// the active lease and make that ordinary job eligible.
EMSCRIPTEN_KEEPALIVE void races_end_active_modal()
{
    if( g_wdtTrace )
        g_wdtTrace->push_back( "close-transport" );

    if( !g_wdtCloseOwner
        || !wxWasmExecutionQueueAffiliated(
                g_wdtCloseOwner, &races_run_wdt_close, nullptr ) )
        ++g_wdtQueueFailures;
}

// Playwright calls this only after it has clicked the visible parent control.
// The transport itself owns no model state; the release runs through the exact
// retained L2 child owner on a scheduler context.
EMSCRIPTEN_KEEPALIVE void races_release_handback_child()
{
    if( !g_handbackCloseOwner
        || !wxWasmExecutionQueueAffiliated(
                g_handbackCloseOwner, &races_run_handback_release, nullptr ) )
    {
        ++g_handbackQueueFailures;
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
            wxDialog( aParent, wxID_ANY, aTag, wxDefaultPosition, wxSize( 260, 120 ) ),
            m_timer( this, ID_DIALOG_TIMER )
    {
        Bind( wxEVT_TIMER, &RacesDialog::OnTimer, this, ID_DIALOG_TIMER );
    }

    // A dialog-owned timer is ModalLifecycle work for this exact top-level
    // scope. The reducer therefore enters through the same scoped production
    // adapter as real modal UI work.
    void ArmOnce( int aDelayMs, std::function<void()> aOnTimer )
    {
        m_onTimer = std::move( aOnTimer );
        m_timer.StartOnce( aDelayMs );
    }

private:
    void OnTimer( wxTimerEvent& )
    {
        auto callback = std::move( m_onTimer );
        m_onTimer = nullptr;

        if( callback )
            callback();
    }

    wxTimer                 m_timer;
    std::function<void()>   m_onTimer;
};


class RacesFrame : public wxFrame
{
public:
    RacesFrame( const std::string& aOnly, bool aSleepParkMode ) :
            wxFrame( nullptr, wxID_ANY, "Asyncify Races Test", wxDefaultPosition,
                     wxSize( 900, 600 ) ),
            m_only( aOnly ),
            m_sleepParkMode( aSleepParkMode ),
            m_pollTimer( this, ID_POLL_TIMER )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );
        m_summary = new wxStaticText( panel, wxID_ANY, "Running asyncify race scenarios..." );
        sizer->Add( m_summary, 0, wxEXPAND | wxALL, 8 );
        panel->SetSizer( sizer );
        CreateStatusBar();

        Bind( wxEVT_TIMER, &RacesFrame::OnPollTimer, this, ID_POLL_TIMER );

        // CallAfter runs these scenarios after the detached main-loop context
        // starts on a scheduler task: the same lane as KiCad interactions.
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
        // modal_in_modal_in_modal and affiliated_close_unblocks_ordinary are ?only=
        // singles because their historical failures kill the chain. The
        // receipt-handback scenario is driven by real Playwright DOM input.
        return aName == "post_park_fiber_swap"
               || aName == "sleep_inside_fiber_inside_modal"
               || aName == "queued_suspensions_preserve_fifo"
               || aName == "long_parked_sleep_clobbered_by_swap"
               || aName == "modal_child_yield_skips_ineligible_pending"
               || aName == "retained_child_delays_modal_close";
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
            { "queued_suspensions_preserve_fifo",
              &RacesFrame::Scenario_QueuedSuspensionsPreserveFifo },
            { "long_parked_sleep_clobbered_by_swap", &RacesFrame::Scenario_LongParkedSleep },
            { "affiliated_close_unblocks_ordinary",
              &RacesFrame::Scenario_AffiliatedCloseUnblocksOrdinary },
            { "modal_child_yield_skips_ineligible_pending",
              &RacesFrame::Scenario_ModalChildYieldSkipsIneligiblePending },
            { "retained_child_delays_modal_close",
              &RacesFrame::Scenario_RetainedChildDelaysModalClose },
            { "nested_modal_receipt_handback",
              &RacesFrame::Scenario_NestedModalReceiptHandback },
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
    // Keep the historical scenario name for log continuity. OnInit completed
    // direct fiber cycles, then the detached scheduler-owned wx loop started.
    // This proves a later tool-style fiber can yield and finish after that
    // startup boundary without stale trampoline or Asyncify state.
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

        RacesDialog dlgA( this, "tripleA" );
        dlgA.ArmOnce( 40, [this]() { TripleLevelB(); } );
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
        RacesDialog dlgB( this, "tripleB" );
        dlgB.ArmOnce( 40, [this]() { TripleLevelC(); } );
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
        RacesDialog dlgC( this, "tripleC" );
        dlgC.ArmOnce( 40, [this]() {
            if( m_dlgC )
                m_dlgC->EndModal( 103 );
        } );
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

        RacesDialog dlg( this, "sifim" );
        dlg.ArmOnce( 40, [this]() { RunSleepInsideFiber(); } );
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

    // ----- scenario 4: queued_suspensions_preserve_fifo --------------------------
    // Two browser callbacks arrive while this owner is parked. Their native
    // bodies both suspend, but they must not enter concurrently: A and then B
    // run FIFO only after this owner's exact tail.
    void Scenario_QueuedSuspensionsPreserveFifo()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "queued_suspensions_preserve_fifo", 4000 );

        m_oooCtx = std::make_unique<CaseContext>();
        m_oooSeqStore.clear();
        g_oooRootTail = false;
        g_oooQueueFailures = 0;

        g_oooTaskA = [this]() {
            m_oooCtx->Expect( g_oooRootTail,
                              "queued body A entered before the parked owner tail" );
            m_oooSeqStore.push_back( "a-start" );
            m_oooCtx->Expect( races_sleep_ms( 120 ) == 1,
                              "queued body A sleep did not resume" );
            m_oooSeqStore.push_back( "a-end" );
        };

        g_oooTaskB = [this]() {
            m_oooCtx->Expect( g_oooRootTail,
                              "queued body B entered before the parked owner tail" );
            m_oooSeqStore.push_back( "b-start" );
            m_oooCtx->Expect( races_sleep_ms( 20 ) == 1,
                              "queued body B sleep did not resume" );
            m_oooSeqStore.push_back( "b-end" );
            m_oooCtx->Expect(
                    m_oooSeqStore == std::vector<std::string>{
                            "root-tail", "a-start", "a-end", "b-start", "b-end"},
                    "suspendable queued bodies did not execute FIFO" );
            m_oooCtx->Expect( g_oooQueueFailures == 0,
                              "a browser arrival was rejected by the owner queue" );
            CheckQuiescent( *m_oooCtx, "after queued FIFO suspensions" );
            Finalize( "queued_suspensions_preserve_fifo", std::move( *m_oooCtx ) );
            m_oooCtx.reset();
            g_oooTaskA = nullptr;
            g_oooTaskB = nullptr;
        };

        races_schedule_ccall( "races_queue_ooo_a", 50 );
        races_schedule_ccall( "races_queue_ooo_b", 100 );
        races_resolve_token_after( 1, 11, 350 );

        const int rootValue = races_await_token( 1 );
        m_oooCtx->Expect( rootValue == 11, "parked owner should resume with 11" );
        m_oooCtx->Expect( m_oooSeqStore.empty(),
                          "queued body entered before the parked owner resumed" );
        g_oooRootTail = true;
        m_oooSeqStore.push_back( "root-tail" );

        // Return without finalizing. This is the root owner's exact tail.
        // Body A becomes eligible after this handler returns; body B remains
        // queued until A's positive-duration sleep and owner release complete.
#else
        CaseContext ctx;
        Finalize( "queued_suspensions_preserve_fifo", std::move( ctx ) );
#endif
    }

    // ----- scenario 5: long_parked_sleep_clobbered_by_swap ------------------------
    // The old reducer ran fiber swaps directly from fresh ccall stacks while
    // this owner was parked. That bypassed the production gateway. The current
    // reducer keeps the browser timeouts concurrent, but submits each stateful
    // fiber body as Ordinary work. Both bodies must wait for this owner's exact
    // tail and then run once.
    void Scenario_LongParkedSleep()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "long_parked_sleep_clobbered_by_swap", 4000 );

        m_longCtx = std::make_unique<CaseContext>();
        g_longParkedOwnerLive = true;
        g_queuedSwapRuns = 0;
        g_queuedSwapOverlaps = 0;
        g_queuedSwapFailures = 0;

        races_schedule_ccall( "races_swap_once", 300 );
        races_schedule_ccall( "races_swap_once", 600 );
        races_resolve_token_after( 3, 33, 1200 );

        int v = races_await_token( 3 );   // parked for 1.2s while swap jobs queue
        g_longParkedOwnerLive = false;

        m_longCtx->Expect( v == 33, "long-parked sleep should resume with 33" );

        m_pollPredicate = []() { return g_queuedSwapRuns == 2; };
        m_pollBudgetMs = 2000;
        m_onPollDone = [this]( bool aOk ) {
            m_longCtx->Expect( aOk, "both queued swaps should run within budget" );
            m_longCtx->Expect( g_queuedSwapRuns == 2,
                               "queued swaps should run exactly twice" );
            m_longCtx->Expect( g_queuedSwapOverlaps == 0,
                               "a queued swap ran before the parked owner tail" );
            m_longCtx->Expect( g_queuedSwapFailures == 0,
                               "a queued swap did not complete its fiber cycle" );
            CheckQuiescent( *m_longCtx, "after serialized long-parked sleep" );
            Finalize( "long_parked_sleep_clobbered_by_swap", std::move( *m_longCtx ) );
            m_longCtx.reset();
        };
        m_pollTimer.Start( 50 );
#else
        CaseContext ctx;
        Finalize( "long_parked_sleep_clobbered_by_swap", std::move( ctx ) );
#endif
    }

    // ----- scenario 6 (?only=): affiliated_close_unblocks_ordinary ---------------
    // A close and an ordinary suspendable body arrive from independent browser
    // tasks while the modal owner is parked. The close carries the exact child
    // owner and can retire the lease. The ordinary body cannot enter until the
    // modal opener returns and releases its root owner.
    void Scenario_AffiliatedCloseUnblocksOrdinary()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "affiliated_close_unblocks_ordinary", 5000 );
#endif
        m_wdtCtx = std::make_unique<CaseContext>();
        g_wdtBodyStarted = false;
        g_wdtModalReturned = false;
        g_wdtQueueFailures = 0;
        g_wdtCloseOwner = {};
        m_wdtSeqStore.clear();
        g_wdtTrace = &m_wdtSeqStore;
        m_wdtParentOwner = wxWasmExecutionCurrentOwner();
        m_wdtCtx->Expect( static_cast<bool>( m_wdtParentOwner ),
                          "modal opener has no execution owner" );

        g_wdtBody = [this]() {
            g_wdtBodyStarted = true;
            m_wdtSeqStore.push_back( "b-start" );
            m_wdtCtx->Expect( g_wdtModalReturned,
                              "ordinary B-side body entered before the modal opener returned" );
            m_wdtCtx->Expect( races_sleep_ms( 100 ) == 1,
                              "ordinary B-side suspension did not resume" );
            m_wdtSeqStore.push_back( "b-end" );
            m_wdtCtx->Expect( g_wdtQueueFailures == 0,
                              "a transition transport or owner handoff failed" );
            m_wdtCtx->Expect(
                    m_wdtSeqStore == std::vector<std::string>{
                            "child-handler", "b-transport", "close-transport",
                            "affiliated-close", "modal-return", "b-start", "b-end"},
                    "affiliated close and ordinary body ran in the wrong order" );
            CheckQuiescent( *m_wdtCtx, "after serialized wakeup transition" );
            Finalize( "affiliated_close_unblocks_ordinary", std::move( *m_wdtCtx ) );
            m_wdtCtx.reset();
            g_wdtBody = nullptr;
            g_wdtTrace = nullptr;
        };

        RacesDialog dlg( this, "wdt" );
        dlg.ArmOnce( 40, [this]() { StageAffiliatedCloseRace(); } );
        g_activeModal = &dlg;
        int result = dlg.ShowModal();
        g_activeModal = nullptr;
        g_wdtModalReturned = true;
        m_wdtSeqStore.push_back( "modal-return" );

        m_wdtCtx->Expect( result == wxID_OK, "wdt modal should return wxID_OK" );
        m_wdtCtx->Expect( !g_wdtBodyStarted,
                          "ordinary B-side body overlapped the modal owner" );

        // Return without finalizing. This is the modal root owner's exact
        // tail; the queued B-side body becomes eligible after it returns.
    }

    void StageAffiliatedCloseRace()
    {
#ifdef __EMSCRIPTEN__
        m_wdtSeqStore.push_back( "child-handler" );
        g_wdtCloseOwner = wxWasmExecutionCurrentOwner();
        m_wdtCtx->Expect( static_cast<bool>( g_wdtCloseOwner ),
                          "modal timer has no child execution owner" );
        m_wdtCtx->Expect(
                g_wdtCloseOwner.parent == m_wdtParentOwner.id,
                "modal timer owner is not a child of the opener" );
        m_wdtCtx->Expect(
                wxWasmExecutionActiveLeaseScope()
                        == wxWasmExecutionScopeForWindow( g_activeModal ),
                "modal timer does not carry the dialog's exact lease scope" );

        if( g_wdtCloseOwner
            && !wxWasmExecutionRetainOwner( g_wdtCloseOwner ) )
        {
            ++g_wdtQueueFailures;
            g_wdtCloseOwner = {};
        }

        // The B-side transport arrives first but remains ordinary. The later
        // affiliated close may pass it because it is the exact progress tail.
        races_schedule_ccall( "races_wdt_park_b", 0 );
        races_schedule_ccall( "races_end_active_modal", 200 );
#endif
    }

    // The former nested_quasi_modal_pump_error scenario expected wx to wake a
    // saved C++ stack after a raw JS trap. That recovery contract is unsafe:
    // the trap makes Asyncify integrity unknown, so the production policy is
    // JS-only terminal fail-stop and no further Wasm call. Scheduler unit tests
    // pin that fail-stop policy; this C++ harness must not ask to resume poison.

    // ----- scenario 7: modal_child_yield_skips_ineligible_pending ---------------
    //
    // Pending() describes the physical wx queue. It does not say that the
    // current semantic owner may consume an item from it. Leave a CallAfter
    // owned by the modal opener in that queue, enter a modal timer child, and
    // call wxYield(). The child must skip the parent's event and return. The
    // former `while (Pending()) Dispatch()` loop repeatedly delayed and
    // re-added that ineligible handler, so this call never returned.
    void Scenario_ModalChildYieldSkipsIneligiblePending()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog(
                "modal_child_yield_skips_ineligible_pending", 5000 );
#endif
        m_yieldCtx = std::make_unique<CaseContext>();
        m_yieldParentOwner = wxWasmExecutionCurrentOwner();
        m_yieldDialog = nullptr;
        m_yieldParentEventRan = false;
        m_yieldChildReturned = false;
        m_yieldTimerRuns = 0;

        m_yieldCtx->Expect( static_cast<bool>( m_yieldParentOwner ),
                            "modal opener has no execution owner" );

        // This event belongs to the root which opens the modal. It must stay
        // physically pending while the child calls wxYield().
        CallAfter( [this]() { m_yieldParentEventRan = true; } );

        RacesDialog dialog( this, "child-yield-owner-filter" );
        m_yieldDialog = &dialog;
        dialog.ArmOnce( 20, [this]() { OnModalChildYieldTimer(); } );

        const int result = dialog.ShowModal();
        m_yieldDialog = nullptr;

        m_yieldCtx->Expect( result == 742,
                            "modal returned " + std::to_string( result )
                            + " instead of 742" );
        m_yieldCtx->Expect( m_yieldTimerRuns == 1,
                            "modal timer did not run exactly once" );
        m_yieldCtx->Expect( m_yieldChildReturned,
                            "wxYield did not return to the modal child" );
        m_yieldCtx->Expect( !m_yieldParentEventRan,
                            "modal child consumed its parent's pending event" );

        // After L1 closes, the original root is again the current branch.
        // Its pending CallAfter must still be live and consumable.
        const bool rootYieldReturned = wxYield();
        m_yieldCtx->Expect( rootYieldReturned,
                            "root wxYield was refused" );
        m_yieldCtx->Expect( m_yieldParentEventRan,
                            "parent event was lost instead of deferred" );

        CheckQuiescent( *m_yieldCtx,
                        "after owner-filtered modal child yield" );
        Finalize( "modal_child_yield_skips_ineligible_pending",
                  std::move( *m_yieldCtx ) );
        m_yieldCtx.reset();
    }

    void OnModalChildYieldTimer()
    {
        ++m_yieldTimerRuns;
        const wx_wasm_execution::OwnerToken childOwner =
                wxWasmExecutionCurrentOwner();

        m_yieldCtx->Expect(
                childOwner && childOwner.id != m_yieldParentOwner.id
                        && childOwner.parent == m_yieldParentOwner.id,
                "timer did not enter through the modal child owner" );

        const bool childYieldReturned = wxYield();
        m_yieldChildReturned = true;
        m_yieldCtx->Expect( childYieldReturned,
                            "modal child wxYield was refused" );
        m_yieldCtx->Expect( !m_yieldParentEventRan,
                            "modal child ran the opener's CallAfter" );

        if( m_yieldDialog )
            m_yieldDialog->EndModal( 742 );
    }

    // ----- scenario 8: retained_child_delays_modal_close -----------------------
    //
    // This is the production-adapter reducer for the close race. ShowModal()
    // opens the real wx execution lease. A real dialog-owned wxTimer enters as
    // its child. The handler retains that exact child, asks EndModal() to close
    // the lease, and transfers the retained reference to a fresh affiliated
    // task. The modal opener must remain parked until that task releases the
    // final child reference. An unrelated ordinary service job is queued while
    // the model is in this HALF state and must not run until the opener returns.
    void Scenario_RetainedChildDelaysModalClose()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "retained_child_delays_modal_close", 5000 );
#endif
        m_retainedCtx = std::make_unique<CaseContext>();
        m_retainedParentOwner = wxWasmExecutionCurrentOwner();
        m_retainedChildOwner = {};
        m_retainedDialog = nullptr;
        m_retainedTimerRuns = 0;
        m_retainedReleaseRuns = 0;
        m_retainedParentResumeRuns = 0;
        m_retainedServiceRuns = 0;
        m_retainedChildHandlerReturned = false;

        m_retainedCtx->Expect( static_cast<bool>( m_retainedParentOwner ),
                               "modal opener has no execution owner" );

        RacesDialog dialog( this, "retained-child-close" );
        m_retainedDialog = &dialog;
        dialog.ArmOnce( 20, [this]() { OnRetainedChildTimer(); } );

        const int result = dialog.ShowModal();
        m_retainedDialog = nullptr;
        ++m_retainedParentResumeRuns;

        m_retainedCtx->Expect( result == 731,
                               "modal returned " + std::to_string( result )
                               + " instead of its exact close result" );
        m_retainedCtx->Expect( m_retainedParentResumeRuns == 1,
                               "modal opener resumed more than once" );
        m_retainedCtx->Expect( m_retainedReleaseRuns == 1,
                               "modal opener resumed before the retained child tail" );
        m_retainedCtx->Expect( wxWasmExecutionCurrentOwner() == m_retainedParentOwner,
                               "modal opener resumed under a different owner" );

        // Do not finalize here. Returning retires the opener's root owner. The
        // ordinary service ingress queued in the child handler is then eligible
        // and performs the final assertions.
    }

    void OnRetainedChildTimer()
    {
        ++m_retainedTimerRuns;
        m_retainedChildOwner = wxWasmExecutionCurrentOwner();

        m_retainedCtx->Expect( static_cast<bool>( m_retainedChildOwner ),
                               "dialog timer has no execution owner" );
        m_retainedCtx->Expect(
                m_retainedChildOwner.id != m_retainedParentOwner.id
                && m_retainedChildOwner.parent == m_retainedParentOwner.id,
                "dialog timer did not enter through the modal's exact child owner" );
        m_retainedCtx->Expect(
                wxWasmExecutionActiveLeaseScope()
                        == wxWasmExecutionScopeForWindow( m_retainedDialog ),
                "dialog timer did not carry the modal's exact target scope" );

        const bool retained = wxWasmExecutionRetainOwner( m_retainedChildOwner );
        m_retainedCtx->Expect( retained,
                               "could not retain the modal's exact child owner" );

        // EndModal closes admission now, but it must not resolve ShowModal's
        // exact wait while the retained child reference is still live.
        m_retainedDialog->EndModal( 731 );
        m_retainedCtx->Expect( m_retainedParentResumeRuns == 0,
                               "EndModal resumed the opener synchronously" );

        const bool serviceQueued = wxWasmExecutionQueueOrdinary(
                &RacesFrame::RunDeferredRetainedService, this );
        m_retainedCtx->Expect( serviceQueued,
                               "ordinary service ingress was not queued" );

        bool releaseQueued = false;
        if( retained )
        {
            releaseQueued = wxWasmExecutionQueueAffiliated(
                    m_retainedChildOwner,
                    &RacesFrame::ReleaseRetainedModalChild, this );
            m_retainedCtx->Expect( releaseQueued,
                                   "retained child tail was not queued as affiliated work" );
        }

        // The affiliated task is required to cross a fresh scheduler-task
        // boundary. It detects an accidental inline call by reading this flag.
        m_retainedChildHandlerReturned = true;

        // Preserve liveness if an assertion above failed before the transfer.
        if( retained && !releaseQueued )
            wxWasmExecutionReleaseOwner( m_retainedChildOwner );
    }

    static void ReleaseRetainedModalChild( void* aArg )
    {
        RacesFrame* self = static_cast<RacesFrame*>( aArg );
        ++self->m_retainedReleaseRuns;

        self->m_retainedCtx->Expect( self->m_retainedChildHandlerReturned,
                                     "affiliated child tail ran inline" );
        self->m_retainedCtx->Expect( self->m_retainedParentResumeRuns == 0,
                                     "modal opener resumed before child release" );
        self->m_retainedCtx->Expect( self->m_retainedServiceRuns == 0,
                                     "ordinary service entered while the model was HALF" );
        self->m_retainedCtx->Expect(
                wxWasmExecutionCurrentOwner() == self->m_retainedChildOwner,
                "affiliated task lost the exact retained child owner" );
        self->m_retainedCtx->Expect(
                wxWasmExecutionReleaseOwner( self->m_retainedChildOwner ),
                "affiliated child tail could not release its owner" );
    }

    static void RunDeferredRetainedService( void* aArg )
    {
        RacesFrame* self = static_cast<RacesFrame*>( aArg );
        ++self->m_retainedServiceRuns;

        self->m_retainedCtx->Expect( self->m_retainedServiceRuns == 1,
                                     "ordinary service ingress ran more than once" );
        self->m_retainedCtx->Expect( self->m_retainedTimerRuns == 1,
                                     "modal timer child did not run exactly once" );
        self->m_retainedCtx->Expect( self->m_retainedReleaseRuns == 1,
                                     "retained child tail did not run exactly once" );
        self->m_retainedCtx->Expect( self->m_retainedParentResumeRuns == 1,
                                     "ordinary service ran before the modal opener returned" );

        self->CheckQuiescent( *self->m_retainedCtx,
                              "after retained-child modal close" );
        self->Finalize( "retained_child_delays_modal_close",
                        std::move( *self->m_retainedCtx ) );
        self->m_retainedCtx.reset();
    }

    // ----- scenario 9: nested_modal_receipt_handback ---------------------------
    // L2 begins closing while an explicitly retained L2 child keeps the exact
    // wait parked. Its DOM is hidden, so Playwright clicks the real L1 button
    // during this stable interval. The receipt must be stamped with L1, remain
    // queued behind L2, and run exactly once after L2 and L1's opener child
    // return. The external release export is transport only; it enters through
    // the retained affiliated owner.
    void Scenario_NestedModalReceiptHandback()
    {
#ifdef __EMSCRIPTEN__
        races_arm_watchdog( "nested_modal_receipt_handback", 10000 );
#endif
        m_handbackCtx = std::make_unique<CaseContext>();
        m_handbackParentOwner = wxWasmExecutionCurrentOwner();
        m_handbackParentDialog = nullptr;
        m_handbackChildDialog = nullptr;
        m_handbackChildOwner = {};
        m_handbackChildReturned = false;
        m_handbackChildHandlerReturned = false;
        m_handbackParentActionRuns = 0;
        m_handbackReleaseRuns = 0;
        g_handbackQueueFailures = 0;
        g_handbackCloseOwner = {};

        m_handbackCtx->Expect( static_cast<bool>( m_handbackParentOwner ),
                               "parent modal opener has no execution owner" );

        RacesDialog parent( this, "receipt-handback-parent" );
        wxBoxSizer* parentSizer = new wxBoxSizer( wxVERTICAL );
        wxButton* parentButton = new wxButton(
                &parent, ID_HANDBACK_PARENT, "Parent action" );
        parentSizer->Add( parentButton, 0, wxALL | wxALIGN_CENTER, 16 );
        parent.SetSizerAndFit( parentSizer );
        parentButton->Bind( wxEVT_BUTTON,
                            &RacesFrame::OnHandbackParentAction, this );

        m_handbackParentDialog = &parent;
        parent.ArmOnce( 20, [this]() { OpenHandbackChild(); } );
        const int result = parent.ShowModal();
        m_handbackParentDialog = nullptr;

        m_handbackCtx->Expect( result == 753,
                               "parent modal returned the wrong result" );
        m_handbackCtx->Expect( m_handbackChildReturned,
                               "parent action ran before L2 returned" );
        m_handbackCtx->Expect( m_handbackParentActionRuns == 1,
                               "parent action did not run exactly once" );
        m_handbackCtx->Expect( m_handbackReleaseRuns == 1,
                               "retained L2 child was not released exactly once" );
        m_handbackCtx->Expect( g_handbackQueueFailures == 0,
                               "affiliated release transport failed" );
        m_handbackCtx->Expect(
                wxWasmExecutionCurrentOwner() == m_handbackParentOwner,
                "parent modal resumed under a different owner" );

        g_handbackReleaseTask = nullptr;
        g_handbackCloseOwner = {};
        CheckQuiescent( *m_handbackCtx,
                        "after nested modal receipt handback" );
        Finalize( "nested_modal_receipt_handback",
                  std::move( *m_handbackCtx ) );
        m_handbackCtx.reset();
    }

    void OpenHandbackChild()
    {
        const wx_wasm_execution::OwnerToken openerOwner =
                wxWasmExecutionCurrentOwner();
        m_handbackCtx->Expect(
                openerOwner && openerOwner.id != m_handbackParentOwner.id
                        && openerOwner.parent == m_handbackParentOwner.id,
                "L2 opener did not enter through L1's child" );

        RacesDialog child( m_handbackParentDialog,
                           "receipt-handback-child" );
        wxBoxSizer* childSizer = new wxBoxSizer( wxVERTICAL );
        wxButton* childButton = new wxButton(
                &child, ID_HANDBACK_CHILD, "Close child" );
        childSizer->Add( childButton, 0, wxALL | wxALIGN_CENTER, 16 );
        child.SetSizerAndFit( childSizer );
        childButton->Bind( wxEVT_BUTTON,
                           &RacesFrame::OnHandbackChildClose, this );

        m_handbackChildDialog = &child;
        const int result = child.ShowModal();
        m_handbackChildDialog = nullptr;
        m_handbackChildReturned = true;

        m_handbackCtx->Expect( result == 752,
                               "L2 returned the wrong close result" );
        m_handbackCtx->Expect( m_handbackReleaseRuns == 1,
                               "L2 resumed before its retained child released" );
        m_handbackCtx->Expect( m_handbackParentActionRuns == 0,
                               "queued L1 input entered before L2 returned" );
    }

    void OnHandbackChildClose( wxCommandEvent& )
    {
        m_handbackChildOwner = wxWasmExecutionCurrentOwner();
        m_handbackCtx->Expect( static_cast<bool>( m_handbackChildOwner ),
                               "L2 close input has no execution owner" );
        const bool retained =
                wxWasmExecutionRetainOwner( m_handbackChildOwner );
        m_handbackCtx->Expect( retained,
                               "could not retain the exact L2 child" );

        if( retained )
        {
            g_handbackCloseOwner = m_handbackChildOwner;
            g_handbackReleaseTask = [this]() {
                ++m_handbackReleaseRuns;
                m_handbackCtx->Expect( m_handbackChildHandlerReturned,
                                       "L2 release ran inline" );
                m_handbackCtx->Expect( !m_handbackChildReturned,
                                       "L2 returned before affiliated release" );
                m_handbackCtx->Expect( m_handbackParentActionRuns == 0,
                                       "L1 input ran while L2 was active" );
                m_handbackCtx->Expect(
                        wxWasmExecutionCurrentOwner()
                                == m_handbackChildOwner,
                        "L2 release lost its retained owner" );
                m_handbackCtx->Expect(
                        wxWasmExecutionReleaseOwner( m_handbackChildOwner ),
                        "could not release retained L2 child" );
                g_handbackCloseOwner = {};
            };
        }

        m_handbackChildDialog->EndModal( 752 );
        m_handbackCtx->Expect( !m_handbackChildReturned,
                               "EndModal resumed L2 opener synchronously" );
        m_handbackChildHandlerReturned = true;
    }

    void OnHandbackParentAction( wxCommandEvent& )
    {
        ++m_handbackParentActionRuns;
        m_handbackCtx->Expect( m_handbackChildReturned,
                               "L1 input entered before L2 closed" );
        m_handbackCtx->Expect( m_handbackReleaseRuns == 1,
                               "L1 input entered before L2 child release" );
        m_handbackParentDialog->EndModal( 753 );
    }

    // ----- scenario 10 (mode=sleep-park): unwind_through_promise ------------------
    // OnInit performed an in-place sleep before the detached loop started. The
    // historic runtime could leak its internal unwind sentinel through that
    // Promise reaction. The spec asserts no sentinel reaches pageerror/console;
    // this C++ side also proves the detached loop and later fiber work are live.
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
    std::unique_ptr<CaseContext>     m_longCtx;
    std::unique_ptr<CaseContext>     m_wdtCtx;
    std::vector<std::string>         m_wdtSeqStore;
    wx_wasm_execution::OwnerToken    m_wdtParentOwner;
    std::unique_ptr<CaseContext>     m_yieldCtx;
    RacesDialog*                     m_yieldDialog = nullptr;
    wx_wasm_execution::OwnerToken    m_yieldParentOwner;
    bool                             m_yieldParentEventRan = false;
    bool                             m_yieldChildReturned = false;
    int                              m_yieldTimerRuns = 0;
    std::unique_ptr<CaseContext>     m_retainedCtx;
    RacesDialog*                     m_retainedDialog = nullptr;
    wx_wasm_execution::OwnerToken    m_retainedParentOwner;
    wx_wasm_execution::OwnerToken    m_retainedChildOwner;
    int                              m_retainedTimerRuns = 0;
    int                              m_retainedReleaseRuns = 0;
    int                              m_retainedParentResumeRuns = 0;
    int                              m_retainedServiceRuns = 0;
    bool                             m_retainedChildHandlerReturned = false;
    std::unique_ptr<CaseContext>     m_handbackCtx;
    RacesDialog*                     m_handbackParentDialog = nullptr;
    RacesDialog*                     m_handbackChildDialog = nullptr;
    wx_wasm_execution::OwnerToken    m_handbackParentOwner;
    wx_wasm_execution::OwnerToken    m_handbackChildOwner;
    bool                             m_handbackChildReturned = false;
    bool                             m_handbackChildHandlerReturned = false;
    int                              m_handbackParentActionRuns = 0;
    int                              m_handbackReleaseRuns = 0;

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
#endif

        // THE LOAD-BEARING TOPOLOGY: complete fiber swap cycles during OnInit.
        // Test every possible caller-owned stack offset. Before fiber_create()
        // normalized the adopted range, an unrelated code/data-layout change
        // could move new char[] from a lucky 16-byte address to an 8-byte one;
        // the first EM_ASM on that fiber then trapped in readEmAsmArgs. Running
        // the production libcontext adapter through all 16 input offsets makes
        // that former "optimized layout" cliff deterministic.
        {
            for( std::size_t skew = 0; skew < 16; ++skew )
            {
                TestCoroutine co(
                        []( TestCoroutine& self ) {
                            EM_ASM( { /* stack-alignment assertion runs in the generated glue */ } );
                            self.Yield( 1 );
                        },
                        256 * 1024, skew );

                const bool yielded = co.Call( static_cast<intptr_t>( skew + 1 ) );
                const intptr_t yieldedValue = co.LastReturnValue();
                const bool completed = !co.Resume( static_cast<intptr_t>( skew + 2 ) );

                if( !yielded || yieldedValue != 1 || co.LastReturnValue() != 0
                    || !completed )
                {
                    LogLine( "[ASYNCIFY_RACES] FAIL pre_main_alignment_canary :: skew="
                             + std::to_string( skew ) );
                    return false;
                }
            }

            LogLine( "[ASYNCIFY_RACES] PRE-PARK-SWAP done alignments=16" );
        }

#ifdef __EMSCRIPTEN__
        if( sleepPark )
        {
            // Retain the historical startup-Promise boundary. The internal
            // unwind must be consumed by handleSleep before OnInit continues;
            // the detached main loop starts only after this call returns.
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
