#include "wx/wx.h"
#include "wx/textctrl.h"
#include "wx/timer.h"
#include "wx/dialog.h"

#include "kicad_coroutine_harness.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <wx/wasm/private/execution_owner.h>
#include <wx/wasm/private/sched_context.h>
#endif

#include <array>
#include <functional>
#include <memory>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>

using coroutine_test::TestCoroutine;

namespace
{

constexpr int ID_SCENARIO_TIMER = wxID_HIGHEST + 550;
constexpr int ID_MODAL_CLOSE_TIMER = wxID_HIGHEST + 551;

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


struct CaseResult
{
    std::string name;
    bool        passed = true;
    std::string detail;
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


template <typename T>
std::string JoinVector( const std::vector<T>& aValues )
{
    std::ostringstream oss;

    for( std::size_t i = 0; i < aValues.size(); ++i )
    {
        if( i > 0 )
            oss << ",";

        oss << aValues[i];
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


void LogAsyncifyState( const char* aTag )
{
#ifdef __EMSCRIPTEN__
    EM_ASM( {
        try {
            var tag = UTF8ToString( $0 );
            var state = ( typeof Asyncify !== 'undefined' ) ? Asyncify.state : 'N/A';
            var stackLen = ( typeof Asyncify !== 'undefined' && Asyncify.exportCallStack )
                               ? Asyncify.exportCallStack.length : 'N/A';
            var currData = ( typeof Asyncify !== 'undefined' && Asyncify.currData )
                               ? Asyncify.currData : 'null';
            var tableLen = ( typeof wasmTable !== 'undefined' && wasmTable )
                               ? wasmTable.length : 'N/A';
            console.log( '[COROUTINE_TEST] ASYNCIFY ' + tag +
                         ' state=' + state +
                         ' stackLen=' + stackLen +
                         ' currData=' + currData +
                         ' tableLen=' + tableLen );
        } catch (e) {
            console.log( '[COROUTINE_TEST] ASYNCIFY ' + UTF8ToString( $0 ) + ' error=' + e );
        }
    }, aTag );
#else
    (void) aTag;
#endif
}

} // namespace


/**
 * AutoClosingDialog - a wxDialog that closes itself after a delay.
 * Used to simulate user interaction in automated tests.
 */
class AutoClosingDialog : public wxDialog
{
public:
    AutoClosingDialog( wxWindow* aParent, const wxString& aTag, int aDelayMs ) :
            wxDialog( aParent, wxID_ANY, aTag, wxDefaultPosition, wxSize( 300, 150 ) ),
            m_tag( aTag.ToStdString() ),
            m_delayMs( aDelayMs ),
            m_timer( this, ID_MODAL_CLOSE_TIMER ),
            m_scenarioTimer( this, ID_SCENARIO_TIMER ),
            m_externalClose( false )
    {
        Bind( wxEVT_SHOW, &AutoClosingDialog::OnShow, this );
        Bind( wxEVT_TIMER, &AutoClosingDialog::OnTimer, this, ID_MODAL_CLOSE_TIMER );
        Bind( wxEVT_TIMER, &AutoClosingDialog::OnScenarioTimer,
              this, ID_SCENARIO_TIMER );
    }

    // If set, the dialog will not self-close; an external caller must call EndModalExternal.
    void UseExternalClose() { m_externalClose = true; }

    void RunScenarioAfterShow( std::function<void()> aScenario, int aDelayMs )
    {
        m_scenario = std::move( aScenario );
        m_scenarioDelayMs = aDelayMs;
    }

    void EndModalExternal( int aCode )
    {
        LogLine( "[COROUTINE_TEST] MODAL-END-EXT " + m_tag );
        EndModal( aCode );
    }

private:
    void OnShow( wxShowEvent& aEvent )
    {
        if( aEvent.IsShown() )
        {
            LogLine( "[COROUTINE_TEST] MODAL-SHOW " + m_tag );
            LogAsyncifyState( ( "modal-shown-" + m_tag ).c_str() );

            if( !m_externalClose )
                m_timer.StartOnce( m_delayMs );

            // ShowModal() opens the execution lease before Show(true). Starting
            // here gives this dialog-owned timer both the exact target scope and
            // the exact active lease generation.
            if( m_scenario )
                m_scenarioTimer.StartOnce( m_scenarioDelayMs );
        }

        aEvent.Skip();
    }

    void OnTimer( wxTimerEvent& aEvent )
    {
        (void) aEvent;
        LogLine( "[COROUTINE_TEST] MODAL-END-AUTO " + m_tag );
        EndModal( wxID_OK );
    }

    void OnScenarioTimer( wxTimerEvent& )
    {
        if( m_scenario )
        {
            auto scenario = std::move( m_scenario );
            m_scenario = nullptr;
            scenario();
        }
    }

    std::string m_tag;
    int         m_delayMs;
    wxTimer     m_timer;
    wxTimer     m_scenarioTimer;
    std::function<void()> m_scenario;
    int         m_scenarioDelayMs = 0;
    bool        m_externalClose;
};


class NestedTestFrame : public wxFrame
{
public:
    NestedTestFrame() :
            wxFrame( nullptr, wxID_ANY, "Nested Coroutine+Modal Test",
                     wxDefaultPosition, wxSize( 1000, 760 ) )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

        wxStaticText* description = new wxStaticText(
                panel,
                wxID_ANY,
                "Tests the interaction between wxDialog::ShowModal (EM_ASYNC_JS / startModal) and\n"
                "libcontext fibers (emscripten_fiber_swap). Reproduces nested Asyncify crashes.\n"
                "The suite runs automatically on startup and reports PASS/FAIL per scenario."
        );
        sizer->Add( description, 0, wxEXPAND | wxALL, 8 );

        m_summary = new wxStaticText( panel, wxID_ANY, "Running nested coroutine+modal suite..." );
        sizer->Add( m_summary, 0, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 8 );

        m_log = new wxTextCtrl(
                panel,
                wxID_ANY,
                "",
                wxDefaultPosition,
                wxDefaultSize,
                wxTE_MULTILINE | wxTE_READONLY
        );
        m_log->SetFont( wxFontInfo( 10 ).Family( wxFONTFAMILY_TELETYPE ) );
        sizer->Add( m_log, 1, wxEXPAND | wxALL, 8 );

        panel->SetSizer( sizer );
        CreateStatusBar();
        SetStatusText( "Nested coroutine+modal test harness starting" );

        CallAfter( [this]() { RunSuite(); } );
    }

private:
    void Log( const wxString& aMessage )
    {
        if( m_log )
        {
            m_log->AppendText( aMessage );
            m_log->AppendText( "\n" );
        }

        LogLine( aMessage.ToStdString() );
    }

    void FinalizeCase( const std::string& aName, CaseContext&& aCtx )
    {
        CaseResult result;
        result.name = aName;
        result.passed = aCtx.passed;
        result.detail = JoinFailures( aCtx.failures );

        if( result.passed )
            Log( wxString::Format( "[COROUTINE_TEST] PASS %s", aName ) );
        else
            Log( wxString::Format( "[COROUTINE_TEST] FAIL %s :: %s", aName, result.detail ) );

        m_results.push_back( std::move( result ) );
    }

    void FinalizeSuite()
    {
        int passed = 0;

        for( const CaseResult& result : m_results )
        {
            if( result.passed )
                ++passed;
        }

        int failed = static_cast<int>( m_results.size() ) - passed;
        wxString summary = wxString::Format( "Nested suite complete: %d passed, %d failed, %zu total",
                                             passed, failed, m_results.size() );
        m_summary->SetLabel( summary );
        SetStatusText( summary );
        Log( wxString::Format( "[COROUTINE_TEST] SUMMARY total=%zu passed=%d failed=%d",
                               m_results.size(), passed, failed ) );
    }

    // --- Case 1: baseline_modal_alone ---
    // Proves that the modal mechanism works in isolation (EM_ASYNC_JS/startModal).
    // If this fails, the test infrastructure is broken.
    void RunCase_BaselineModalAlone()
    {
        const std::string caseName = "baseline_modal_alone";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        CaseContext ctx;
        LogAsyncifyState( "A-pre-modal" );

        {
            AutoClosingDialog dlg( this, "baselineA", 50 );
            int result = dlg.ShowModal();
            ctx.Expect( result == wxID_OK, "modal should return wxID_OK" );
        }

        LogAsyncifyState( "A-post-modal" );
        FinalizeCase( caseName, std::move( ctx ) );
    }

    // --- Case 2: baseline_fiber_alone ---
    // Proves that TestCoroutine works without any modal involvement.
    void RunCase_BaselineFiberAlone()
    {
        const std::string caseName = "baseline_fiber_alone";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        CaseContext ctx;
        LogAsyncifyState( "B-pre-fiber" );

        TestCoroutine coroutine( []( TestCoroutine& self ) {
            self.Yield( 42 );
        } );

        bool running = coroutine.Call( 1 );
        ctx.Expect( running, "fiber should yield on first call" );
        ctx.Expect( coroutine.LastReturnValue() == 42, "yield value should be 42" );

        running = coroutine.Resume( 2 );
        ctx.Expect( !running, "fiber should finish on resume" );

        LogAsyncifyState( "B-post-fiber" );
        FinalizeCase( caseName, std::move( ctx ) );
    }

    // --- Case 3: fiber_create_run_destroy_inside_modal (THE TARGET REPRODUCER) ---
    // A fiber is created, run to completion, and destroyed during a modal's event loop.
    // In the broken state, the modal's rewind after EndModal crashes with index out of bounds.
    void StartCase_FiberInsideModal()
    {
        const std::string caseName = "fiber_create_run_destroy_inside_modal";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        LogAsyncifyState( "S3-pre-modal" );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S3", 0 );
        dlg->UseExternalClose();

        // Modal work must carry the modal's exact target scope and lease. A
        // frame-owned timer is deliberately not allowed to borrow a dialog
        // lease merely because it expires while that dialog is open.
        dlg->RunScenarioAfterShow(
                [this]() { RunScenario3FiberWork(); }, 30 );

        // Show the modal (this blocks under EM_ASYNC_JS)
        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        LogAsyncifyState( "S3-post-modal" );
        m_currentCtx->Expect( result == wxID_OK,
                              "modal should return wxID_OK (actual: " + std::to_string( result ) + ")" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        // Chain to next scenario
        CallAfter( [this]() { StartCase_FiberMultiSwapInsideModal(); } );
    }

    void RunScenario3FiberWork()
    {
        LogAsyncifyState( "S3-timer-enter" );

        {
            TestCoroutine co( []( TestCoroutine& self ) {
                self.Yield( 100 );
            } );

            bool running = co.Call( 1 );
            m_currentCtx->Expect( running, "S3: fiber should yield on first call" );
            m_currentCtx->Expect( co.LastReturnValue() == 100, "S3: yield value should be 100" );

            LogAsyncifyState( "S3-after-call" );

            running = co.Resume( 2 );
            m_currentCtx->Expect( !running, "S3: fiber should finish on resume" );

            LogAsyncifyState( "S3-after-resume" );
        }
        // Fiber destroyed here

        LogAsyncifyState( "S3-after-destroy" );

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 4: fiber_multi_swap_inside_modal ---
    // Multiple fiber yield/resume cycles inside a modal. Tests if the bug needs >=2 swaps.
    void StartCase_FiberMultiSwapInsideModal()
    {
        const std::string caseName = "fiber_multi_swap_inside_modal";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        LogAsyncifyState( "S4-pre-modal" );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S4", 0 );
        dlg->UseExternalClose();

        dlg->RunScenarioAfterShow(
                [this]() { RunScenario4MultiSwap(); }, 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        LogAsyncifyState( "S4-post-modal" );
        m_currentCtx->Expect( result == wxID_OK, "S4: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_FiberYieldAcrossModalClose(); } );
    }

    void RunScenario4MultiSwap()
    {
        LogAsyncifyState( "S4-timer-enter" );

        {
            TestCoroutine co( []( TestCoroutine& self ) {
                self.Yield( 1 );
                self.Yield( 2 );
                self.Yield( 3 );
            } );

            bool running = co.Call( 10 );
            m_currentCtx->Expect( running, "S4: first yield" );
            m_currentCtx->Expect( co.LastReturnValue() == 1, "S4: yield value 1" );

            running = co.Resume( 20 );
            m_currentCtx->Expect( running, "S4: second yield" );
            m_currentCtx->Expect( co.LastReturnValue() == 2, "S4: yield value 2" );

            running = co.Resume( 30 );
            m_currentCtx->Expect( running, "S4: third yield" );
            m_currentCtx->Expect( co.LastReturnValue() == 3, "S4: yield value 3" );

            running = co.Resume( 40 );
            m_currentCtx->Expect( !running, "S4: fiber should finish" );
        }

        LogAsyncifyState( "S4-after-fiber" );

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 5: fiber_yield_across_modal_close ---
    // Fiber is Call()'d and yields, then modal closes WITHOUT resuming the fiber.
    // After modal, we resume the still-suspended fiber. Tests dormant fiber buffer impact.
    void StartCase_FiberYieldAcrossModalClose()
    {
        const std::string caseName = "fiber_yield_across_modal_close";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        LogAsyncifyState( "S5-pre-modal" );

        m_s5Fiber = std::make_unique<TestCoroutine>( []( TestCoroutine& self ) {
            self.Yield( 501 );
            self.Yield( 502 );
        } );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S5", 0 );
        dlg->UseExternalClose();

        dlg->RunScenarioAfterShow(
                [this]() { RunScenario5Yield(); }, 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        LogAsyncifyState( "S5-post-modal" );

        // After modal, resume the fiber
        if( m_s5Fiber && m_s5Fiber->Running() )
        {
            bool running = m_s5Fiber->Resume( 99 );
            m_currentCtx->Expect( running, "S5: fiber should yield again after modal close" );

            running = m_s5Fiber->Resume( 100 );
            m_currentCtx->Expect( !running, "S5: fiber should finish after second resume" );
        }

        m_s5Fiber.reset();
        m_currentCtx->Expect( result == wxID_OK, "S5: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_FiberDeepYieldLoop(); } );
    }

    void RunScenario5Yield()
    {
        LogAsyncifyState( "S5-timer-enter" );

        bool running = m_s5Fiber->Call( 1 );
        m_currentCtx->Expect( running, "S5: fiber should yield in modal" );
        m_currentCtx->Expect( m_s5Fiber->LastReturnValue() == 501, "S5: yield 501" );

        LogAsyncifyState( "S5-fiber-yielded" );

        // Do NOT resume; leave the fiber suspended across the modal close.

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 6: fiber_deep_yield_loop_inside_modal ---
    // Deep recursive stack with many yields inside a modal. Stresses asyncify buffers.
    void StartCase_FiberDeepYieldLoop()
    {
        const std::string caseName = "fiber_deep_yield_loop_inside_modal";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        LogAsyncifyState( "S6-pre-modal" );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S6", 0 );
        dlg->UseExternalClose();

        dlg->RunScenarioAfterShow(
                [this]() { RunScenario6DeepYield(); }, 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        LogAsyncifyState( "S6-post-modal" );
        m_currentCtx->Expect( result == wxID_OK, "S6: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_ModalFiberModalSequence(); } );
    }

    void RunScenario6DeepYield()
    {
        LogAsyncifyState( "S6-timer-enter" );

        {
            TestCoroutine co( [ctx = m_currentCtx.get()]( TestCoroutine& self ) {
                std::function<void( int )> dive = [&]( int depth ) {
                    std::array<int, 8> locals {};

                    for( std::size_t i = 0; i < locals.size(); ++i )
                        locals[i] = depth * 10 + static_cast<int>( i );

                    int expected = std::accumulate( locals.begin(), locals.end(), 0 );

                    if( depth == 0 )
                    {
                        self.Yield( 600 );
                        ctx->Expect( std::accumulate( locals.begin(), locals.end(), 0 ) == expected,
                                     "S6: deepest frame locals survive resume" );
                        return;
                    }

                    dive( depth - 1 );
                    ctx->Expect( std::accumulate( locals.begin(), locals.end(), 0 ) == expected,
                                 "S6: frame locals survive at depth " + std::to_string( depth ) );
                };

                dive( 4 );
            } );

            bool running = co.Call( 1 );
            m_currentCtx->Expect( running, "S6: deep fiber should yield" );
            m_currentCtx->Expect( co.LastReturnValue() == 600, "S6: deep yield value" );

            running = co.Resume( 2 );
            m_currentCtx->Expect( !running, "S6: deep fiber should finish" );
        }

        LogAsyncifyState( "S6-after-fiber" );

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 7: modal_fiber_modal_sequence ---
    // Modal A -> fiber work between -> Modal B. Tests state leak across modal boundaries.
    void StartCase_ModalFiberModalSequence()
    {
        const std::string caseName = "modal_fiber_modal_sequence";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        CaseContext ctx;
        LogAsyncifyState( "S7-pre-modal-A" );

        // Modal A (auto-close)
        {
            AutoClosingDialog dlgA( this, "S7A", 50 );
            int resultA = dlgA.ShowModal();
            ctx.Expect( resultA == wxID_OK, "S7: modal A should return wxID_OK" );
        }

        LogAsyncifyState( "S7-post-modal-A" );

        // Fiber work between modals
        {
            TestCoroutine co( []( TestCoroutine& self ) {
                self.Yield( 700 );
            } );

            bool running = co.Call( 1 );
            ctx.Expect( running, "S7: inter-modal fiber should yield" );

            running = co.Resume( 2 );
            ctx.Expect( !running, "S7: inter-modal fiber should finish" );
        }

        LogAsyncifyState( "S7-mid" );

        // Modal B (auto-close)
        {
            AutoClosingDialog dlgB( this, "S7B", 50 );
            int resultB = dlgB.ShowModal();
            ctx.Expect( resultB == wxID_OK, "S7: modal B should return wxID_OK" );
        }

        LogAsyncifyState( "S7-post-modal-B" );

        FinalizeCase( "modal_fiber_modal_sequence", std::move( ctx ) );

        CallAfter( [this]() { StartCase_NestedFibersInsideModal(); } );
    }

    // --- Case 8: nested_fibers_inside_modal ---
    // Parent fiber calls child fiber (FROM_ROUTINE) inside modal.
    void StartCase_NestedFibersInsideModal()
    {
        const std::string caseName = "nested_fibers_inside_modal";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        LogAsyncifyState( "S8-pre-modal" );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S8", 0 );
        dlg->UseExternalClose();

        dlg->RunScenarioAfterShow(
                [this]() { RunScenario8NestedFibers(); }, 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        LogAsyncifyState( "S8-post-modal" );
        m_currentCtx->Expect( result == wxID_OK, "S8: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_NestedDispatchRoots(); } );
    }

    void RunScenario8NestedFibers()
    {
        LogAsyncifyState( "S8-timer-enter" );

        {
            auto ctx = m_currentCtx.get();
            std::vector<std::string> sequence;

            TestCoroutine child( [&sequence]( TestCoroutine& self ) {
                sequence.push_back( "child-start" );
                self.Yield( 801 );
                sequence.push_back( "child-end" );
            } );

            TestCoroutine parent( [&]( TestCoroutine& self ) {
                sequence.push_back( "parent-start" );
                bool childRunning = child.Call( self, 100 );
                ctx->Expect( childRunning, "S8: child should yield to parent" );
                ctx->Expect( child.LastReturnValue() == 801, "S8: child yield value" );
                sequence.push_back( "parent-after-child-yield" );

                childRunning = child.Resume( self, 200 );
                ctx->Expect( !childRunning, "S8: child should finish on resume" );
                sequence.push_back( "parent-end" );
            } );

            bool running = parent.Call( 1 );
            ctx->Expect( !running, "S8: parent should complete" );

            const std::vector<std::string> expected = {
                "parent-start", "child-start", "parent-after-child-yield", "child-end", "parent-end"
            };
            ctx->Expect( sequence == expected,
                         "S8: unexpected sequence: " + JoinVector( sequence ) );
        }

        LogAsyncifyState( "S8-after-fiber" );

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 9: nested_dispatch_roots_preserve_fiber_identity ---
    //
    // Exact production topology, and deliberately stronger than the older
    // stale-source reducer:
    //
    //   dispatch root A -> tool fiber F1 -> modal exact wait
    //   modal child dispatch root B -> tool fiber F2 -> yield -> finish
    //   modal close -> exact wake of F1 -> terminal handoff to root A
    //
    // The stale-source reducer proves only that B cannot overwrite a parked
    // F1 capture.  This case also proves that B is not needlessly blocked: it
    // receives its own immutable libcontext root identity and can run F2 while
    // A/F1 remain parked.  A later task verifies that both semantic owners and
    // both tool-fiber contexts retired rather than surviving as ghost state.
    void StartCase_NestedDispatchRoots()
    {
        const std::string caseName =
                "nested_dispatch_roots_preserve_fiber_identity";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();
        m_nestedSequence.clear();

#ifdef __EMSCRIPTEN__
        m_nestedRootA = pcbjam_sched::current();
        m_nestedOwnerA = wxWasmExecutionCurrentOwner();
        m_nestedFiberReleasedBefore =
                pcbjam_sched::reg().fiber_released;
        m_currentCtx->Expect( m_nestedRootA != 0,
                              "S9: root A must be a scheduler context" );
        m_currentCtx->Expect( static_cast<bool>( m_nestedOwnerA ),
                              "S9: root A must carry a semantic owner" );
#endif
        m_nestedSequence.push_back( "A-call" );

        m_nestedF1 = std::make_unique<TestCoroutine>(
                [this]( TestCoroutine& ) {
                    m_nestedSequence.push_back( "F1-open" );
#ifdef __EMSCRIPTEN__
                    m_nestedF1Id = pcbjam_sched::current();
                    m_currentCtx->Expect( m_nestedF1Id != 0
                                                  && m_nestedF1Id
                                                             != m_nestedRootA,
                                          "S9: F1 must have its own physical context" );
                    m_currentCtx->Expect(
                            wxWasmExecutionCurrentOwner() == m_nestedOwnerA,
                            "S9: F1 must retain root A's semantic owner" );
#endif

                    AutoClosingDialog dialog( this, "S9", 0 );
                    dialog.UseExternalClose();
                    dialog.RunScenarioAfterShow(
                            [this]() { RunScenario9ChildRoot(); }, 30 );

                    m_activeDialog = &dialog;
                    const int result = dialog.ShowModal();
                    m_activeDialog = nullptr;

                    m_nestedSequence.push_back( "F1-resume" );
#ifdef __EMSCRIPTEN__
                    m_nestedF1ResumeId = pcbjam_sched::current();
                    m_currentCtx->Expect(
                            m_nestedF1ResumeId == m_nestedF1Id,
                            "S9: modal close must resume the exact F1 context" );
                    m_currentCtx->Expect(
                            wxWasmExecutionCurrentOwner() == m_nestedOwnerA,
                            "S9: resumed F1 must recover root A's semantic owner" );
                    m_nestedF2ReturnAfterF1Wake =
                            libcontext::wasm_return_context_id_for_test(
                                    m_nestedF2
                                            ? m_nestedF2->ContextHandleForTest()
                                            : nullptr );
                    m_currentCtx->Expect(
                            m_nestedF2ReturnAfterF1Wake == m_nestedRootBProtocol,
                            "S9: F1 wake must not rewrite F2's saved root-B return handle" );
#endif
                    m_currentCtx->Expect( result == wxID_OK,
                                          "S9: modal must return wxID_OK" );
                } );

        const bool f1Running = m_nestedF1->Call( 1 );
        m_nestedSequence.push_back( "A-return" );
        m_currentCtx->Expect( !f1Running,
                              "S9: F1 must finish after its exact modal wake" );

#ifdef __EMSCRIPTEN__
        m_nestedRootAResume = pcbjam_sched::current();
        m_currentCtx->Expect( m_nestedRootAResume == m_nestedRootA,
                              "S9: F1 must hand off to its original root A" );
#endif

        m_nestedF1.reset();
        m_nestedF2.reset();

#ifdef __EMSCRIPTEN__
        m_currentCtx->Expect( pcbjam_sched::find( m_nestedF1Id ) == nullptr,
                              "S9: F1 physical context must retire" );
        m_currentCtx->Expect( pcbjam_sched::find( m_nestedF2Id ) == nullptr,
                              "S9: F2 physical context must retire" );
        m_nestedFiberReleasedAfter =
                pcbjam_sched::reg().fiber_released;
        m_currentCtx->Expect(
                m_nestedFiberReleasedAfter
                                == m_nestedFiberReleasedBefore + 2,
                "S9: exactly F1 and F2 must retire during the reducer" );
#endif

        const std::vector<std::string> expected = {
            "A-call", "F1-open", "B-enter", "F2-enter", "B-yield",
            "F2-resume", "B-finish", "B-close", "F1-resume", "A-return"
        };
        m_currentCtx->Expect(
                m_nestedSequence == expected,
                "S9: unexpected nested-root sequence: "
                        + JoinVector( m_nestedSequence ) );

        // QueueOrdinary guarantees a fresh task and a fresh root admission
        // after the current root-A handler returns.  A CallAfter posted here
        // is intentionally affiliated with A and would therefore be the wrong
        // observation point for A's retirement.
#ifdef __EMSCRIPTEN__
        if( !wxWasmExecutionQueueOrdinary(
                    &NestedTestFrame::FinishNestedDispatchRootsThunk, this ) )
        {
            m_currentCtx->Expect(
                    false, "S9: retirement oracle could not be queued" );
            FinishCase_NestedDispatchRoots();
        }
#else
        CallAfter( [this]() { FinishCase_NestedDispatchRoots(); } );
#endif
    }

    void RunScenario9ChildRoot()
    {
        m_nestedSequence.push_back( "B-enter" );

#ifdef __EMSCRIPTEN__
        m_nestedRootB = pcbjam_sched::current();
        m_nestedOwnerB = wxWasmExecutionCurrentOwner();
        m_currentCtx->Expect( m_nestedRootB != 0
                                      && m_nestedRootB != m_nestedRootA,
                              "S9: modal child must use a distinct dispatch root B" );
        m_currentCtx->Expect( static_cast<bool>( m_nestedOwnerB )
                                      && m_nestedOwnerB != m_nestedOwnerA,
                              "S9: modal child must carry a distinct child owner" );
        m_currentCtx->Expect(
                pcbjam_sched::status_of( m_nestedRootA )
                                == pcbjam_sched::Status::Parked,
                "S9: root A must remain transfer-parked while B runs" );
        m_currentCtx->Expect(
                pcbjam_sched::status_of( m_nestedF1Id )
                                == pcbjam_sched::Status::Parked,
                "S9: F1 must remain exact-wait parked while B runs" );
#endif

        {
#ifdef __EMSCRIPTEN__
            m_nestedRootBProtocol =
                    libcontext::wasm_current_context_id_for_test();
#endif
            m_nestedF2 = std::make_unique<TestCoroutine>(
                    [this]( TestCoroutine& self ) {
                m_nestedSequence.push_back( "F2-enter" );
#ifdef __EMSCRIPTEN__
                m_nestedF2Id = pcbjam_sched::current();
                m_currentCtx->Expect(
                        m_nestedF2Id != 0 && m_nestedF2Id != m_nestedF1Id
                                && m_nestedF2Id != m_nestedRootA
                                && m_nestedF2Id != m_nestedRootB,
                        "S9: F2 must have a distinct physical context" );
                m_currentCtx->Expect(
                        wxWasmExecutionCurrentOwner() == m_nestedOwnerB,
                        "S9: F2 must retain root B's modal-child owner" );
#endif
                self.Yield( 902 );
                m_nestedSequence.push_back( "F2-resume" );
#ifdef __EMSCRIPTEN__
                m_nestedF2ResumeId = pcbjam_sched::current();
                m_currentCtx->Expect(
                        m_nestedF2ResumeId == m_nestedF2Id,
                        "S9: F2 must resume on its exact physical context" );
                m_currentCtx->Expect(
                        wxWasmExecutionCurrentOwner() == m_nestedOwnerB,
                        "S9: resumed F2 must keep root B's child owner" );
#endif
            } );

            bool running = m_nestedF2->Call( 1 );
            m_nestedSequence.push_back( "B-yield" );
            m_currentCtx->Expect( running,
                                  "S9: F2 must yield once to root B" );
            m_currentCtx->Expect( m_nestedF2->LastReturnValue() == 902,
                                  "S9: F2 yield value must reach root B" );
#ifdef __EMSCRIPTEN__
            m_nestedF2ReturnBeforeClose =
                    libcontext::wasm_return_context_id_for_test(
                            m_nestedF2->ContextHandleForTest() );
            m_currentCtx->Expect(
                    m_nestedF2ReturnBeforeClose == m_nestedRootBProtocol,
                    "S9: F2's saved return handle must name root B" );
            m_currentCtx->Expect( pcbjam_sched::current() == m_nestedRootB,
                                  "S9: F2 yield must return to root B" );
#endif

            running = m_nestedF2->Resume( 2 );
            m_nestedSequence.push_back( "B-finish" );
            m_currentCtx->Expect( !running,
                                  "S9: F2 must finish on its one resume" );
#ifdef __EMSCRIPTEN__
            m_currentCtx->Expect( pcbjam_sched::current() == m_nestedRootB,
                                  "S9: F2 finish must return to root B" );
#endif
        }

        m_nestedSequence.push_back( "B-close" );
        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    void FinishCase_NestedDispatchRoots()
    {
#ifdef __EMSCRIPTEN__
        bool ownerAStillLive = wxWasmExecutionRetainOwner( m_nestedOwnerA );
        bool ownerBStillLive = wxWasmExecutionRetainOwner( m_nestedOwnerB );
        const libcontext::wasm_root_proxy_stats rootStats =
                libcontext::wasm_root_proxy_stats_for_test();

        m_currentCtx->Expect( !ownerAStillLive,
                              "S9: semantic root owner A must retire once its handler returns" );
        m_currentCtx->Expect( !ownerBStillLive,
                              "S9: semantic child owner B must retire once its handler returns" );

        // Keep a failed assertion from perturbing later cases with the probe's
        // extra reference.
        if( ownerAStillLive )
            wxWasmExecutionReleaseOwner( m_nestedOwnerA );
        if( ownerBStillLive )
            wxWasmExecutionReleaseOwner( m_nestedOwnerB );

        m_currentCtx->Expect( rootStats.live <= rootStats.capacity,
                              "S9: root proxies stay within the dispatch-root bound" );
        m_currentCtx->Expect( rootStats.peak <= rootStats.capacity,
                              "S9: root proxy high-water stays bounded" );
        m_currentCtx->Expect( rootStats.capacity == 16,
                              "S9: root proxy capacity matches dispatch depth" );
        m_currentCtx->Expect(
                libcontext::wasm_root_proxy_capacity_accepts_for_test( 15 ),
                "S9: the 16th live root proxy is accepted" );
        m_currentCtx->Expect(
                !libcontext::wasm_root_proxy_capacity_accepts_for_test( 16 ),
                "S9: a 17th live root proxy is rejected" );
        m_currentCtx->Expect( rootStats.scheduler_release_attempts == 0,
                              "S9: a root proxy never releases a scheduler-owned stack" );
        m_currentCtx->Expect( rootStats.unsafe_sweeps == 0,
                              "S9: a live physical root proxy is never swept" );

        Log( wxString::Format(
                "[COROUTINE_TEST] NESTED-ROOTS rootA=%u rootB=%u "
                "f1=%u f1Resume=%u f2=%u f2Resume=%u rootAResume=%u "
                "f2ReturnBefore=%u f2ReturnAfter=%u rootBProtocol=%u "
                "fiberReleasedDelta=%u rootProxyLive=%zu rootProxyPeak=%zu "
                "rootProxyCapacity=%zu rootProxyCreated=%u rootProxyReleased=%u "
                "rootProxySchedulerReleases=%u rootProxyUnsafeSweeps=%u sequence=%s",
                m_nestedRootA, m_nestedRootB, m_nestedF1Id,
                m_nestedF1ResumeId, m_nestedF2Id, m_nestedF2ResumeId,
                m_nestedRootAResume, m_nestedF2ReturnBeforeClose,
                m_nestedF2ReturnAfterF1Wake, m_nestedRootBProtocol,
                m_nestedFiberReleasedAfter - m_nestedFiberReleasedBefore,
                rootStats.live, rootStats.peak, rootStats.capacity,
                rootStats.created, rootStats.released,
                rootStats.scheduler_release_attempts, rootStats.unsafe_sweeps,
                JoinVector( m_nestedSequence ) ) );
#endif

        FinalizeCase( m_currentCaseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();
        CallAfter( [this]() { FinalizeSuite(); } );
    }

    static void FinishNestedDispatchRootsThunk( void* aArg )
    {
        static_cast<NestedTestFrame*>( aArg )
                ->FinishCase_NestedDispatchRoots();
    }

    // --- RunSuite: kicks off the synchronous cases, then chains async ones ---
    void RunSuite()
    {
        m_results.clear();

        // Synchronous baselines first
        RunCase_BaselineModalAlone();
        RunCase_BaselineFiberAlone();

        // Chain async modal+fiber scenarios 3..8
        CallAfter( [this]() { StartCase_FiberInsideModal(); } );
    }

private:
    std::vector<CaseResult>             m_results;
    std::string                         m_currentCaseName;
    std::unique_ptr<CaseContext>        m_currentCtx;
    AutoClosingDialog*                  m_activeDialog = nullptr;
    std::unique_ptr<TestCoroutine>      m_s5Fiber;
    std::unique_ptr<TestCoroutine>      m_nestedF1;
    std::unique_ptr<TestCoroutine>      m_nestedF2;
    std::vector<std::string>            m_nestedSequence;
#ifdef __EMSCRIPTEN__
    pcbjam_sched::ContextId             m_nestedRootA = 0;
    pcbjam_sched::ContextId             m_nestedRootB = 0;
    pcbjam_sched::ContextId             m_nestedF1Id = 0;
    pcbjam_sched::ContextId             m_nestedF1ResumeId = 0;
    pcbjam_sched::ContextId             m_nestedF2Id = 0;
    pcbjam_sched::ContextId             m_nestedF2ResumeId = 0;
    pcbjam_sched::ContextId             m_nestedRootAResume = 0;
    uint32_t                            m_nestedRootBProtocol = 0;
    uint32_t                            m_nestedF2ReturnBeforeClose = 0;
    uint32_t                            m_nestedF2ReturnAfterF1Wake = 0;
    wx_wasm_execution::OwnerToken       m_nestedOwnerA;
    wx_wasm_execution::OwnerToken       m_nestedOwnerB;
    unsigned                            m_nestedFiberReleasedBefore = 0;
    unsigned                            m_nestedFiberReleasedAfter = 0;
#endif
    wxStaticText*                       m_summary = nullptr;
    wxTextCtrl*                         m_log = nullptr;
};


class NestedTestApp : public wxApp
{
public:
    bool OnInit() override
    {
        NestedTestFrame* frame = new NestedTestFrame();
        frame->Show();
        return true;
    }
};


wxIMPLEMENT_APP( NestedTestApp );
