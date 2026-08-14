#include "wx/wx.h"
#include "wx/textctrl.h"
#include "wx/timer.h"
#include "wx/dialog.h"

#include "kicad_coroutine_harness.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
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
            m_externalClose( false )
    {
        Bind( wxEVT_SHOW, &AutoClosingDialog::OnShow, this );
        Bind( wxEVT_TIMER, &AutoClosingDialog::OnTimer, this, ID_MODAL_CLOSE_TIMER );
    }

    // If set, the dialog will not self-close; an external caller must call EndModalExternal.
    void UseExternalClose() { m_externalClose = true; }

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

            if( !m_externalClose )
                m_timer.StartOnce( m_delayMs );
        }

        aEvent.Skip();
    }

    void OnTimer( wxTimerEvent& aEvent )
    {
        (void) aEvent;
        LogLine( "[COROUTINE_TEST] MODAL-END-AUTO " + m_tag );
        EndModal( wxID_OK );
    }

    std::string m_tag;
    int         m_delayMs;
    wxTimer     m_timer;
    bool        m_externalClose;
};


class NestedTestFrame : public wxFrame
{
public:
    NestedTestFrame() :
            wxFrame( nullptr, wxID_ANY, "Nested Coroutine+Modal Test",
                     wxDefaultPosition, wxSize( 1000, 760 ) ),
            m_scenarioTimer( this, ID_SCENARIO_TIMER )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

        wxStaticText* description = new wxStaticText(
                panel,
                wxID_ANY,
                "Tests the interaction between wxDialog::ShowModal (EM_ASYNC_JS / startModal) and\n"
                "libcontext coroutines (JSPI). Historically reproduced nested asyncify crashes.\n"
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

        Bind( wxEVT_TIMER, &NestedTestFrame::OnScenarioTimer, this, ID_SCENARIO_TIMER );

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

        {
            AutoClosingDialog dlg( this, "baselineA", 50 );
            int result = dlg.ShowModal();
            ctx.Expect( result == wxID_OK, "modal should return wxID_OK" );
        }

        FinalizeCase( caseName, std::move( ctx ) );
    }

    // --- Case 2: baseline_fiber_alone ---
    // Proves that TestCoroutine works without any modal involvement.
    void RunCase_BaselineFiberAlone()
    {
        const std::string caseName = "baseline_fiber_alone";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        CaseContext ctx;

        TestCoroutine coroutine( []( TestCoroutine& self ) {
            self.Yield( 42 );
        } );

        bool running = coroutine.Call( 1 );
        ctx.Expect( running, "fiber should yield on first call" );
        ctx.Expect( coroutine.LastReturnValue() == 42, "yield value should be 42" );

        running = coroutine.Resume( 2 );
        ctx.Expect( !running, "fiber should finish on resume" );

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

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S3", 0 );
        dlg->UseExternalClose();

        // Arm a scenario timer that will fire INSIDE the modal's event loop
        m_pendingScenario = [this]() { RunScenario3FiberWork(); };
        m_scenarioTimer.StartOnce( 30 );

        // Show the modal (this blocks under EM_ASYNC_JS)
        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        m_currentCtx->Expect( result == wxID_OK,
                              "modal should return wxID_OK (actual: " + std::to_string( result ) + ")" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        // Chain to next scenario
        CallAfter( [this]() { StartCase_FiberMultiSwapInsideModal(); } );
    }

    void RunScenario3FiberWork()
    {

        {
            TestCoroutine co( []( TestCoroutine& self ) {
                self.Yield( 100 );
            } );

            bool running = co.Call( 1 );
            m_currentCtx->Expect( running, "S3: fiber should yield on first call" );
            m_currentCtx->Expect( co.LastReturnValue() == 100, "S3: yield value should be 100" );


            running = co.Resume( 2 );
            m_currentCtx->Expect( !running, "S3: fiber should finish on resume" );

        }
        // Fiber destroyed here


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

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S4", 0 );
        dlg->UseExternalClose();

        m_pendingScenario = [this]() { RunScenario4MultiSwap(); };
        m_scenarioTimer.StartOnce( 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        m_currentCtx->Expect( result == wxID_OK, "S4: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_FiberYieldAcrossModalClose(); } );
    }

    void RunScenario4MultiSwap()
    {

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

        m_s5Fiber = std::make_unique<TestCoroutine>( []( TestCoroutine& self ) {
            self.Yield( 501 );
            self.Yield( 502 );
        } );

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S5", 0 );
        dlg->UseExternalClose();

        m_pendingScenario = [this]() { RunScenario5Yield(); };
        m_scenarioTimer.StartOnce( 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;


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

        bool running = m_s5Fiber->Call( 1 );
        m_currentCtx->Expect( running, "S5: fiber should yield in modal" );
        m_currentCtx->Expect( m_s5Fiber->LastReturnValue() == 501, "S5: yield 501" );


        // Do NOT resume; leave the fiber suspended across the modal close.

        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Case 6: fiber_deep_yield_loop_inside_modal ---
    // Deep recursive stack with many yields inside a modal. Stresses the stack-capture
    // machinery under deep frames.
    void StartCase_FiberDeepYieldLoop()
    {
        const std::string caseName = "fiber_deep_yield_loop_inside_modal";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_currentCaseName = caseName;
        m_currentCtx = std::make_unique<CaseContext>();

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S6", 0 );
        dlg->UseExternalClose();

        m_pendingScenario = [this]() { RunScenario6DeepYield(); };
        m_scenarioTimer.StartOnce( 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        m_currentCtx->Expect( result == wxID_OK, "S6: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        CallAfter( [this]() { StartCase_ModalFiberModalSequence(); } );
    }

    void RunScenario6DeepYield()
    {

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

        // Modal A (auto-close)
        {
            AutoClosingDialog dlgA( this, "S7A", 50 );
            int resultA = dlgA.ShowModal();
            ctx.Expect( resultA == wxID_OK, "S7: modal A should return wxID_OK" );
        }


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


        // Modal B (auto-close)
        {
            AutoClosingDialog dlgB( this, "S7B", 50 );
            int resultB = dlgB.ShowModal();
            ctx.Expect( resultB == wxID_OK, "S7: modal B should return wxID_OK" );
        }


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

        auto dlg = std::make_unique<AutoClosingDialog>( this, "S8", 0 );
        dlg->UseExternalClose();

        m_pendingScenario = [this]() { RunScenario8NestedFibers(); };
        m_scenarioTimer.StartOnce( 30 );

        m_activeDialog = dlg.get();
        int result = dlg->ShowModal();
        m_activeDialog = nullptr;

        m_currentCtx->Expect( result == wxID_OK, "S8: modal should return wxID_OK" );

        FinalizeCase( caseName, std::move( *m_currentCtx ) );
        m_currentCtx.reset();

        // Done with all cases
        CallAfter( [this]() { FinalizeSuite(); } );
    }

    void RunScenario8NestedFibers()
    {

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


        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    // --- Scenario timer handler (runs inside modal event loops) ---
    void OnScenarioTimer( wxTimerEvent& aEvent )
    {
        if( aEvent.GetId() != ID_SCENARIO_TIMER )
            return;

        if( m_pendingScenario )
        {
            auto scenario = std::move( m_pendingScenario );
            m_pendingScenario = nullptr;
            scenario();
        }
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
    wxTimer                             m_scenarioTimer;
    std::function<void()>               m_pendingScenario;
    std::string                         m_currentCaseName;
    std::unique_ptr<CaseContext>        m_currentCtx;
    AutoClosingDialog*                  m_activeDialog = nullptr;
    std::unique_ptr<TestCoroutine>      m_s5Fiber;
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
