#include "wx/wx.h"
#include "wx/textctrl.h"
#include "wx/timer.h"

#include "kicad_coroutine_harness.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <wx/wasm/private/sched_context.h>

// The production wx library normally supplies this export. Keep a weak,
// standalone leaf in the reducer too: the injected scheduler must have its
// readiness contract even when this small app is linked against a wx archive
// that does not pull in the production admission layer.
extern "C" int EMSCRIPTEN_KEEPALIVE __attribute__((weak)) wxWasmNativeEntryReady()
{
    return pcbjam_sched::current() == 0
                   && !pcbjam_sched::transition_in_flight() ? 1 : 0;
}
#endif

#include <array>
#include <functional>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>

using coroutine_test::TestCoroutine;

namespace
{

constexpr int ID_ASYNC_CASE_TIMER = wxID_HIGHEST + 450;

struct CaseContext
{
    bool                    passed = true;
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

} // namespace


class CoroutineTestFrame : public wxFrame
{
public:
    CoroutineTestFrame() :
            wxFrame( nullptr, wxID_ANY, "Coroutine Stress Test",
                     wxDefaultPosition, wxSize( 1000, 760 ) ),
            m_asyncCaseTimer( this, ID_ASYNC_CASE_TIMER )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

        wxStaticText* description = new wxStaticText(
                panel,
                wxID_ANY,
                "Stress-tests KiCad-style coroutine semantics on top of the real libcontext WASM port.\n"
                "The suite runs automatically on startup and reports PASS/FAIL per scenario."
        );
        sizer->Add( description, 0, wxEXPAND | wxALL, 8 );

        m_summary = new wxStaticText( panel, wxID_ANY, "Running coroutine stress suite..." );
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
        SetStatusText( "Coroutine test harness starting" );
        Bind( wxEVT_TIMER, &CoroutineTestFrame::OnAsyncCaseTimer, this, ID_ASYNC_CASE_TIMER );

        CallAfter( [this]() { RunSuite(); } );
    }

private:
    struct AsyncWaitLoopCaseState
    {
        struct Event
        {
            std::string name;
        };

        CaseContext                       ctx;
        std::vector<std::string>          sequence;
        bool                              pendingWait = false;
        bool                              shutdown = false;
        Event                             wakeupEvent;
        std::unique_ptr<TestCoroutine>    tool;
        int                               phase = 0;
    };

    struct AsyncNestedResumeCaseState
    {
        struct Event
        {
            std::string name;
        };

        CaseContext                       ctx;
        std::vector<std::string>          sequence;
        bool                              selectionPendingWait = false;
        bool                              selectionShutdown = false;
        Event                             selectionWakeupEvent;
        std::unique_ptr<TestCoroutine>    selection;
        std::unique_ptr<TestCoroutine>    control;
        int                               phase = 0;
    };

    void Log( const wxString& aMessage )
    {
        if( m_log )
        {
            m_log->AppendText( aMessage );
            m_log->AppendText( "\n" );
        }

        std::string utf8 = aMessage.ToStdString();

#ifdef __EMSCRIPTEN__
        EM_ASM( {
            console.log( UTF8ToString( $0 ) );
        }, utf8.c_str() );
#else
        printf( "%s\n", utf8.c_str() );
#endif
    }

    CaseResult RunCase( const std::string& aName, const std::function<void( CaseContext& )>& aFn )
    {
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", aName ) );

        CaseContext ctx;
        aFn( ctx );

        CaseResult result;
        result.name = aName;
        result.passed = ctx.passed;
        result.detail = JoinFailures( ctx.failures );

        if( result.passed )
        {
            Log( wxString::Format( "[COROUTINE_TEST] PASS %s", aName ) );
        }
        else
        {
            Log( wxString::Format( "[COROUTINE_TEST] FAIL %s :: %s", aName, result.detail ) );
        }

        return result;
    }

    void FinishCase( CaseResult aResult )
    {
        m_results.push_back( std::move( aResult ) );

        if( m_pendingAsyncCases == 0 )
            FinalizeSuite();
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

        FinishCase( std::move( result ) );
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
        wxString summary = wxString::Format( "Coroutine suite complete: %d passed, %d failed, %zu total",
                                             passed, failed, m_results.size() );
        m_summary->SetLabel( summary );
        SetStatusText( summary );
        Log( wxString::Format( "[COROUTINE_TEST] SUMMARY total=%zu passed=%d failed=%d",
                               m_results.size(), passed, failed ) );
    }

    void StartAsyncWaitLoopCase()
    {
        constexpr const char* caseName = "async_wait_loop_stays_suspended";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_pendingAsyncCases = 1;
        m_asyncCaseName = caseName;
        m_asyncState = std::make_unique<AsyncWaitLoopCaseState>();

        AsyncWaitLoopCaseState* state = m_asyncState.get();

        state->tool = std::make_unique<TestCoroutine>( [state]( TestCoroutine& self ) {
            while( true )
            {
                state->ctx.Expect( !state->pendingWait, "tool should not enter Wait twice in a row" );
                state->pendingWait = true;
                state->sequence.push_back( "wait-enter" );
                self.Yield( 700 );
                state->sequence.push_back( "wait-return" );

                if( state->shutdown )
                    break;

                state->ctx.Expect( !state->wakeupEvent.name.empty(),
                                   "wakeup event should be populated before resume" );
                state->sequence.push_back( "event:" + state->wakeupEvent.name );
            }

            state->sequence.push_back( "tool-end" );
        } );

        bool running = state->tool->Call( 1 );
        state->ctx.Expect( running, "tool wait loop should yield on initial call" );
        state->ctx.Expect( state->tool->LastReturnValue() == 700,
                           "initial wait yield should reach the root" );
        state->ctx.Expect( state->pendingWait, "tool should be pending wait after initial yield" );

        const std::vector<std::string> expectedBeforeDispatch = {
            "wait-enter"
        };
        state->ctx.Expect( state->sequence == expectedBeforeDispatch,
                           "unexpected async sequence before dispatch: "
                                   + JoinVector( state->sequence ) );

        state->phase = 1;
        m_asyncCaseTimer.StartOnce( 10 );
    }

    void CompleteAsyncWaitLoopCase()
    {
        if( !m_asyncState )
            return;

        RecordAsyncCase( m_asyncCaseName, std::move( m_asyncState->ctx ) );
        m_asyncState.reset();
        StartAsyncNestedResumeCase();
    }

    void RecordAsyncCase( const std::string& aName, CaseContext&& aCtx )
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

    void StartAsyncNestedResumeCase()
    {
        constexpr const char* caseName = "async_nested_resume_from_child_tool";
        Log( wxString::Format( "[COROUTINE_TEST] CASE %s", caseName ) );

        m_asyncCaseName = caseName;
        m_nestedAsyncState = std::make_unique<AsyncNestedResumeCaseState>();

        AsyncNestedResumeCaseState* state = m_nestedAsyncState.get();

        state->selection = std::make_unique<TestCoroutine>( [state]( TestCoroutine& self ) {
            while( true )
            {
                state->ctx.Expect( !state->selectionPendingWait,
                                   "selection should not enter Wait twice in a row" );
                state->selectionPendingWait = true;
                state->sequence.push_back( "selection:wait-enter" );
                self.Yield( 700 );
                state->sequence.push_back( "selection:wait-return" );

                if( state->selectionShutdown )
                    break;

                state->ctx.Expect( !state->selectionWakeupEvent.name.empty(),
                                   "selection wakeup event should be populated before nested resume" );
                state->sequence.push_back( "selection:event:" + state->selectionWakeupEvent.name );
            }

            state->sequence.push_back( "selection:tool-end" );
        } );

        state->control = std::make_unique<TestCoroutine>( [state]( TestCoroutine& self ) {
            (void) self;
            state->sequence.push_back( "control:start" );
            state->ctx.Expect( state->selectionPendingWait,
                               "selection should be pending when child tool resumes it" );
            state->selectionPendingWait = false;
            state->selectionWakeupEvent = { "metricUnits" };

            bool selectionRunning = state->selection->Resume( self, 2 );
            state->ctx.Expect( selectionRunning,
                               "selection should yield back to child tool after nested resume" );
            state->ctx.Expect( state->selection->LastReturnValue() == 700,
                               "nested selection yield should reach the child tool" );
            state->ctx.Expect( state->selectionPendingWait,
                               "selection should be waiting again after nested resume" );

            state->sequence.push_back( "control:after-selection" );
        } );

        bool selectionRunning = state->selection->Call( 1 );
        state->ctx.Expect( selectionRunning, "selection should yield on initial call" );
        state->ctx.Expect( state->selection->LastReturnValue() == 700,
                           "initial selection yield should reach the root" );
        state->ctx.Expect( state->selectionPendingWait,
                           "selection should be pending wait after initial yield" );

        const std::vector<std::string> expectedBeforeNestedResume = {
            "selection:wait-enter"
        };
        state->ctx.Expect( state->sequence == expectedBeforeNestedResume,
                           "unexpected nested sequence before child tool dispatch: "
                                   + JoinVector( state->sequence ) );

        state->phase = 1;
        m_asyncCaseTimer.StartOnce( 10 );
    }

    void CompleteAsyncNestedResumeCase()
    {
        if( !m_nestedAsyncState )
            return;

        m_pendingAsyncCases = 0;
        FinalizeCase( m_asyncCaseName, std::move( m_nestedAsyncState->ctx ) );
        m_nestedAsyncState.reset();
    }

    void OnAsyncCaseTimer( wxTimerEvent& aEvent )
    {
        if( aEvent.GetId() != ID_ASYNC_CASE_TIMER )
            return;

        if( m_asyncState )
        {
            AsyncWaitLoopCaseState* state = m_asyncState.get();

            if( state->phase == 1 )
            {
                state->ctx.Expect( state->pendingWait,
                                   "tool should still be pending when the browser callback resumes it" );
                state->pendingWait = false;
                state->wakeupEvent = { "metricUnits" };

                bool running = state->tool->Resume( 2 );
                state->ctx.Expect( running, "tool should yield again after the first callback resume" );
                state->ctx.Expect( state->tool->LastReturnValue() == 700,
                                   "second wait yield should reach the root" );
                state->ctx.Expect( state->pendingWait,
                                   "tool should be pending wait again after second yield" );
                state->ctx.Expect( state->tool->Running(),
                                   "tool should still be suspended after second yield" );

                const std::vector<std::string> expectedAfterFirstResume = {
                    "wait-enter",
                    "wait-return",
                    "event:metricUnits",
                    "wait-enter"
                };
                state->ctx.Expect( state->sequence == expectedAfterFirstResume,
                                   "unexpected wait-loop sequence after first callback resume: "
                                           + JoinVector( state->sequence ) );

                state->phase = 2;
                m_asyncCaseTimer.StartOnce( 10 );
                return;
            }

            if( state->phase == 2 )
            {
                const std::vector<std::string> expectedStillSuspended = {
                    "wait-enter",
                    "wait-return",
                    "event:metricUnits",
                    "wait-enter"
                };
                state->ctx.Expect( state->sequence == expectedStillSuspended,
                                   "tool should remain suspended until the next explicit dispatch: "
                                           + JoinVector( state->sequence ) );
                state->ctx.Expect( state->pendingWait,
                                   "tool should still be pending wait before the next dispatch" );
                state->ctx.Expect( state->tool->Running(),
                                   "tool should still be running before the next dispatch" );

                state->phase = 3;
                m_asyncCaseTimer.StartOnce( 10 );
                return;
            }

            if( state->phase == 3 )
            {
                state->ctx.Expect( state->pendingWait,
                                   "tool should still be pending before the shutdown dispatch" );
                state->pendingWait = false;
                state->shutdown = true;
                state->wakeupEvent = { "shutdown" };

                bool running = state->tool->Resume( 3 );
                state->ctx.Expect( !running, "tool should finish after the explicit shutdown dispatch" );

                const std::vector<std::string> expectedAfterFinalResume = {
                    "wait-enter",
                    "wait-return",
                    "event:metricUnits",
                    "wait-enter",
                    "wait-return",
                    "tool-end"
                };
                state->ctx.Expect( state->sequence == expectedAfterFinalResume,
                                   "unexpected wait-loop sequence after shutdown dispatch: "
                                           + JoinVector( state->sequence ) );

                CompleteAsyncWaitLoopCase();
                return;
            }
        }

        if( !m_nestedAsyncState )
            return;

        AsyncNestedResumeCaseState* state = m_nestedAsyncState.get();

        if( state->phase == 1 )
        {
            bool controlRunning = state->control->Call( 11 );
            state->ctx.Expect( !controlRunning,
                               "child tool should finish after resuming selection once" );

            const std::vector<std::string> expectedAfterNestedResume = {
                "selection:wait-enter",
                "control:start",
                "selection:wait-return",
                "selection:event:metricUnits",
                "selection:wait-enter",
                "control:after-selection"
            };
            state->ctx.Expect( state->sequence == expectedAfterNestedResume,
                               "unexpected nested sequence after child tool resume: "
                                       + JoinVector( state->sequence ) );
            state->ctx.Expect( state->selectionPendingWait,
                               "selection should be waiting again after the child tool finishes" );
            state->ctx.Expect( state->selection->Running(),
                               "selection should still be suspended after nested resume" );

            state->phase = 2;
            m_asyncCaseTimer.StartOnce( 10 );
            return;
        }

        if( state->phase == 2 )
        {
            const std::vector<std::string> expectedStillSuspended = {
                "selection:wait-enter",
                "control:start",
                "selection:wait-return",
                "selection:event:metricUnits",
                "selection:wait-enter",
                "control:after-selection"
            };
            state->ctx.Expect( state->sequence == expectedStillSuspended,
                               "selection should remain suspended after the child tool returns: "
                                       + JoinVector( state->sequence ) );
            state->ctx.Expect( state->selectionPendingWait,
                               "selection should still be pending before the shutdown dispatch" );
            state->ctx.Expect( state->selection->Running(),
                               "selection should still be running before the shutdown dispatch" );

            state->selectionPendingWait = false;
            state->selectionShutdown = true;
            state->selectionWakeupEvent = { "shutdown" };

            bool selectionRunning = state->selection->Resume( 3 );
            state->ctx.Expect( !selectionRunning,
                               "selection should finish after the explicit shutdown dispatch" );

            const std::vector<std::string> expectedAfterFinalResume = {
                "selection:wait-enter",
                "control:start",
                "selection:wait-return",
                "selection:event:metricUnits",
                "selection:wait-enter",
                "control:after-selection",
                "selection:wait-return",
                "selection:tool-end"
            };
            state->ctx.Expect( state->sequence == expectedAfterFinalResume,
                               "unexpected nested sequence after final selection shutdown: "
                                       + JoinVector( state->sequence ) );

            CompleteAsyncNestedResumeCase();
        }
    }

    void RunSuite()
    {
        m_results.clear();

        m_results.push_back( RunCase( "first_entry_runs_once", [this]( CaseContext& ctx ) {
            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                ctx.Expect( self.EntryCount() == 1, "entry count should be 1 on first entry" );
                self.Yield( 11 );
                ctx.Expect( self.EntryCount() == 1, "entry count should still be 1 after resume" );
            } );

            bool running = coroutine.Call( 1 );
            ctx.Expect( running, "coroutine should yield on first call" );
            ctx.Expect( coroutine.EntryCount() == 1, "entry count should be 1 after call" );
            ctx.Expect( coroutine.LastReturnValue() == 11, "yield value should be 11" );

            running = coroutine.Resume( 2 );
            ctx.Expect( !running, "coroutine should finish after resume" );
            ctx.Expect( coroutine.EntryCount() == 1, "entry count should remain 1" );
        } ) );

        m_results.push_back( RunCase( "yield_resume_preserves_state", [this]( CaseContext& ctx ) {
            int entryRuns = 0;
            int afterResume = 0;
            intptr_t resumedValue = -1;
            bool localPreserved = false;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                ++entryRuns;
                int localGuard = 41;
                self.Yield( 111 );
                ++afterResume;
                resumedValue = self.CurrentValue();
                localPreserved = ( localGuard == 41 );
            } );

            bool running = coroutine.Call( 7 );
            ctx.Expect( running, "coroutine should yield on initial call" );
            ctx.Expect( entryRuns == 1, "entry should run once" );
            ctx.Expect( coroutine.LastReturnValue() == 111, "yield should reach caller" );

            running = coroutine.Resume( 222 );
            ctx.Expect( !running, "coroutine should finish after resume" );
            ctx.Expect( afterResume == 1, "post-resume code should run once" );
            ctx.Expect( resumedValue == 222, "resume value should reach coroutine" );
            ctx.Expect( localPreserved, "stack-local state should survive yield/resume" );
        } ) );

        m_results.push_back( RunCase( "deep_stack_preserved_across_yield", [this]( CaseContext& ctx ) {
            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                std::function<void( int )> dive = [&]( int depth ) {
                    std::array<int, 16> locals {};

                    for( std::size_t i = 0; i < locals.size(); ++i )
                        locals[i] = depth * 100 + static_cast<int>( i );

                    int expected = std::accumulate( locals.begin(), locals.end(), 0 );

                    if( depth == 0 )
                    {
                        self.Yield( 500 );
                        ctx.Expect( std::accumulate( locals.begin(), locals.end(), 0 ) == expected,
                                    "deepest frame locals should survive resume" );
                        return;
                    }

                    dive( depth - 1 );
                    ctx.Expect( std::accumulate( locals.begin(), locals.end(), 0 ) == expected,
                                "frame locals should survive unwind/rewind at depth " + std::to_string( depth ) );
                };

                dive( 6 );
            } );

            bool running = coroutine.Call( 3 );
            ctx.Expect( running, "deep stack coroutine should yield" );
            ctx.Expect( coroutine.LastReturnValue() == 500, "deep stack yield value should propagate" );

            running = coroutine.Resume( 4 );
            ctx.Expect( !running, "deep stack coroutine should finish after resume" );
        } ) );

        m_results.push_back( RunCase( "nested_coroutine_call_and_resume", [this]( CaseContext& ctx ) {
            std::vector<std::string> sequence;
            intptr_t childResumeValue = 0;

            TestCoroutine child( [&]( TestCoroutine& self ) {
                sequence.push_back( "child-start" );
                self.Yield( 33 );
                childResumeValue = self.CurrentValue();
                sequence.push_back( "child-end" );
            } );

            TestCoroutine parent( [&]( TestCoroutine& self ) {
                sequence.push_back( "parent-start" );

                bool childRunning = child.Call( self, 10 );
                ctx.Expect( childRunning, "child should yield to parent" );
                ctx.Expect( child.LastReturnValue() == 33, "child yield value should reach parent" );
                sequence.push_back( "after-child-yield" );

                childRunning = child.Resume( self, 44 );
                ctx.Expect( !childRunning, "child should finish after resume" );
                ctx.Expect( childResumeValue == 44, "resume value should reach child" );
                sequence.push_back( "after-child-finish" );

                self.Yield( 55 );
                sequence.push_back( "parent-end" );
            } );

            bool running = parent.Call( 1 );
            ctx.Expect( running, "parent should yield to root" );
            ctx.Expect( parent.LastReturnValue() == 55, "parent yield should reach root" );

            const std::vector<std::string> expectedBeforeResume = {
                "parent-start",
                "child-start",
                "after-child-yield",
                "child-end",
                "after-child-finish"
            };
            ctx.Expect( sequence == expectedBeforeResume,
                        "unexpected nested sequence before parent resume: " + JoinVector( sequence ) );

            running = parent.Resume( 2 );
            ctx.Expect( !running, "parent should finish after resume" );

            const std::vector<std::string> expectedAfterResume = {
                "parent-start",
                "child-start",
                "after-child-yield",
                "child-end",
                "after-child-finish",
                "parent-end"
            };
            ctx.Expect( sequence == expectedAfterResume,
                        "unexpected nested sequence after parent resume: " + JoinVector( sequence ) );
        } ) );

        m_results.push_back( RunCase( "nested_parent_yield_preserves_suspend", [this]( CaseContext& ctx ) {
            std::vector<std::string> sequence;
            intptr_t childResumeValue = 0;
            intptr_t childFinalValue = 0;

            TestCoroutine child( [&]( TestCoroutine& self ) {
                sequence.push_back( "child-start" );
                self.Yield( 301 );
                childResumeValue = self.CurrentValue();
                sequence.push_back( "child-after-parent-resume" );
                self.Yield( 302 );
                childFinalValue = self.CurrentValue();
                sequence.push_back( "child-end" );
            } );

            TestCoroutine parent( [&]( TestCoroutine& self ) {
                sequence.push_back( "parent-start" );

                bool childRunning = child.Call( self, 111 );
                ctx.Expect( childRunning, "child should yield to parent before parent yields to root" );
                ctx.Expect( child.LastReturnValue() == 301, "child first yield should reach parent" );
                sequence.push_back( "parent-after-child-yield" );

                self.Yield( 401 );

                sequence.push_back( "parent-after-root-resume" );
                ctx.Expect( child.Running(), "child should still be suspended when parent resumes from root" );

                childRunning = child.Resume( self, 222 );
                ctx.Expect( childRunning, "child should yield a second time after parent resumes" );
                ctx.Expect( child.LastReturnValue() == 302, "child second yield should reach parent" );
                sequence.push_back( "parent-after-child-second-yield" );

                self.Yield( 402 );

                sequence.push_back( "parent-final-resume" );
                childRunning = child.Resume( self, 333 );
                ctx.Expect( !childRunning, "child should finish on final resume" );
                sequence.push_back( "parent-end" );
            } );

            bool running = parent.Call( 1 );
            ctx.Expect( running, "parent should yield to root after child yields to parent" );
            ctx.Expect( parent.LastReturnValue() == 401, "parent first yield should reach root" );
            ctx.Expect( child.Running(), "child should remain suspended after parent yields to root" );

            const std::vector<std::string> expectedBeforeResume = {
                "parent-start",
                "child-start",
                "parent-after-child-yield"
            };
            ctx.Expect( sequence == expectedBeforeResume,
                        "parent should remain suspended after yielding to root: " + JoinVector( sequence ) );

            running = parent.Resume( 2 );
            ctx.Expect( running, "parent should yield a second time after explicit root resume" );
            ctx.Expect( parent.LastReturnValue() == 402, "parent second yield should reach root" );
            ctx.Expect( childResumeValue == 222, "child should observe the value from the parent resume" );

            const std::vector<std::string> expectedAfterFirstResume = {
                "parent-start",
                "child-start",
                "parent-after-child-yield",
                "parent-after-root-resume",
                "child-after-parent-resume",
                "parent-after-child-second-yield"
            };
            ctx.Expect( sequence == expectedAfterFirstResume,
                        "unexpected sequence after first explicit parent resume: " + JoinVector( sequence ) );

            running = parent.Resume( 3 );
            ctx.Expect( !running, "parent should finish after the final explicit root resume" );
            ctx.Expect( childFinalValue == 333, "child should observe the final resume value" );

            const std::vector<std::string> expectedAfterFinalResume = {
                "parent-start",
                "child-start",
                "parent-after-child-yield",
                "parent-after-root-resume",
                "child-after-parent-resume",
                "parent-after-child-second-yield",
                "parent-final-resume",
                "child-end",
                "parent-end"
            };
            ctx.Expect( sequence == expectedAfterFinalResume,
                        "unexpected sequence after final parent resume: " + JoinVector( sequence ) );
        } ) );

        m_results.push_back( RunCase( "nested_root_resume_releases_caller_once",
                                      [this]( CaseContext& ctx ) {
            std::vector<std::string> sequence;
            std::vector<intptr_t> observedValues;

            TestCoroutine target( [&]( TestCoroutine& self ) {
                sequence.push_back( "target:start" );
                self.Yield( 101 );
                observedValues.push_back( self.CurrentValue() );
                sequence.push_back( "target:after-first-resume" );
                self.Yield( 102 );
                observedValues.push_back( self.CurrentValue() );
                sequence.push_back( "target:after-second-resume" );
                self.Yield( 103 );
                observedValues.push_back( self.CurrentValue() );
                sequence.push_back( "target:end" );
            } );

            ctx.Expect( target.Call( 1 ), "target should suspend before nested dispatch" );
            ctx.Expect( target.LastReturnValue() == 101,
                        "target's initial yield should reach the root" );

            TestCoroutine driver( [&]( TestCoroutine& self ) {
                (void) self;
                sequence.push_back( "driver:start" );

                // TOOL_MANAGER has call sites with this shape: a method uses
                // the no-argument (root-style) Resume() overload even though
                // another coroutine is physically running.  Each local
                // CallContext must retain and then release that physical
                // caller exactly once.
                bool targetRunning = target.Resume( 11 );
                ctx.Expect( targetRunning,
                            "target should suspend after the first nested root-style resume" );
                ctx.Expect( target.LastReturnValue() == 102,
                            "first nested yield should return to the driver" );
                sequence.push_back( "driver:after-first-resume" );

                targetRunning = target.Resume( 22 );
                ctx.Expect( targetRunning,
                            "target should suspend after the second nested root-style resume" );
                ctx.Expect( target.LastReturnValue() == 103,
                            "second nested yield should return to the driver" );
                sequence.push_back( "driver:after-second-resume" );
            } );

            ctx.Expect( !driver.Call( 2 ), "driver should finish after both nested resumes" );
            ctx.Expect( target.Running(), "target should remain suspended after the driver finishes" );

            ctx.Expect( !target.Resume( 33 ), "target should finish from the real root" );

            const std::vector<std::string> expectedSequence = {
                "target:start",
                "driver:start",
                "target:after-first-resume",
                "driver:after-first-resume",
                "target:after-second-resume",
                "driver:after-second-resume",
                "target:end"
            };
            const std::vector<intptr_t> expectedValues = { 11, 22, 33 };

            ctx.Expect( sequence == expectedSequence,
                        "unexpected nested root-style resume sequence: " + JoinVector( sequence ) );
            ctx.Expect( observedValues == expectedValues,
                        "nested root-style resume values were not preserved: "
                                + JoinVector( observedValues ) );
        } ) );

        m_results.push_back( RunCase( "root_bounce_continue_after_root", [this]( CaseContext& ctx ) {
            std::vector<std::string> events;
            int rootRuns = 0;
            intptr_t afterRootValue = 0;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                events.push_back( "before-root" );
                self.RunMainStack( [&]() {
                    ++rootRuns;
                    events.push_back( "on-root" );
                }, 77 );
                afterRootValue = self.CurrentValue();
                events.push_back( "after-root" );
            } );

            bool running = coroutine.Call( 5 );
            ctx.Expect( !running, "root bounce case should finish in one root call" );
            ctx.Expect( rootRuns == 1, "root callback should run exactly once" );
            ctx.Expect( afterRootValue == 77, "resume from root bounce should keep value" );

            const std::vector<std::string> expected = { "before-root", "on-root", "after-root" };
            ctx.Expect( events == expected, "unexpected root bounce order: " + JoinVector( events ) );
        } ) );

        m_results.push_back( RunCase( "completion_returns_control_without_exit", [this]( CaseContext& ctx ) {
            int entryRuns = 0;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                ++entryRuns;
                (void) self;
            } );

            bool running = coroutine.Call( 9 );
            ctx.Expect( !running, "completed coroutine should return false from Call" );
            ctx.Expect( entryRuns == 1, "completion case should run exactly once" );
        } ) );

        m_results.push_back( RunCase( "resume_after_finish_does_not_reenter", [this]( CaseContext& ctx ) {
            int entryRuns = 0;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                ++entryRuns;
                (void) self;
            } );

            bool running = coroutine.Call( 0 );
            ctx.Expect( !running, "coroutine should finish immediately" );

            running = coroutine.Resume( 123 );
            ctx.Expect( !running, "resume on finished coroutine should stay false" );
            ctx.Expect( entryRuns == 1, "finished coroutine must not re-enter" );
        } ) );

        m_results.push_back( RunCase( "finished_release_retires_handle", [this]( CaseContext& ctx ) {
            libcontext::fcontext_t stale = nullptr;

            {
                auto completed = std::make_unique<TestCoroutine>( []( TestCoroutine& self ) {
                    (void) self;
                } );

                ctx.Expect( !completed->Call(), "lifetime probe should finish immediately" );
                stale = completed->ContextHandleForTest();
                ctx.Expect( stale != nullptr, "finished coroutine should expose a live token before release" );
            }

            TestCoroutine replacement( []( TestCoroutine& self ) { (void) self; } );
            ctx.Expect( !replacement.Call(), "replacement lifetime probe should finish immediately" );
            ctx.Expect( replacement.ContextHandleForTest() != stale,
                        "a retired token must never be reused for a replacement context" );

            libcontext::fcontext_t savedCaller = nullptr;
            const intptr_t result = libcontext::jump_fcontext( &savedCaller, stale, 0 );
            ctx.Expect( result == 0, "a stale finished token must be refused" );
            ctx.Expect( savedCaller == nullptr,
                        "refusing a stale finished token must not capture the caller" );
        } ) );

        m_results.push_back( RunCase( "suspended_cancel_retires_handle", [this]( CaseContext& ctx ) {
            libcontext::fcontext_t stale = nullptr;
            int entryRuns = 0;
            int afterYieldRuns = 0;

            {
                auto cancelled = std::make_unique<TestCoroutine>( [&]( TestCoroutine& self ) {
                    ++entryRuns;
                    self.Yield( 91 );
                    ++afterYieldRuns;
                } );

                ctx.Expect( cancelled->Call(), "cancellation probe should suspend" );
                stale = cancelled->ContextHandleForTest();
                ctx.Expect( stale != nullptr, "suspended coroutine should expose a live token before release" );
            }

            TestCoroutine replacement( []( TestCoroutine& self ) { (void) self; } );
            ctx.Expect( !replacement.Call(), "replacement cancellation probe should finish immediately" );
            ctx.Expect( replacement.ContextHandleForTest() != stale,
                        "a cancelled token must never be reused for a replacement context" );

            libcontext::fcontext_t savedCaller = nullptr;
            const intptr_t result = libcontext::jump_fcontext( &savedCaller, stale, 0 );
            ctx.Expect( result == 0, "a stale cancelled token must be refused" );
            ctx.Expect( savedCaller == nullptr,
                        "refusing a stale cancelled token must not capture the caller" );
            ctx.Expect( entryRuns == 1 && afterYieldRuns == 0,
                        "cancelling a suspended context must not re-enter its body" );
        } ) );

#ifdef __EMSCRIPTEN__
        m_results.push_back( RunCase( "registry_refusal_ghost_returns_without_swap",
                                      [this]( CaseContext& ctx ) {
            int entryRuns = 0;
            int afterYieldRuns = 0;
            const pcbjam_sched::ContextId firstNewId =
                    pcbjam_sched::detail::reg().next_id;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                ++entryRuns;
                self.Yield( 101 );
                ++afterYieldRuns;
            } );

            ctx.Expect( coroutine.Call(), "reducer coroutine should establish a suspension" );

            pcbjam_sched::ContextId target = 0;
            pcbjam_sched::Status targetStatus = pcbjam_sched::Status::Finished;

            for( const auto& [id, physical] : pcbjam_sched::detail::reg().contexts )
            {
                if( id >= firstNewId && physical->symmetric
                    && pcbjam_sched::fiber_enterable( id ) )
                {
                    target = id;
                    targetStatus = physical->status;
                    break;
                }
            }

            ctx.Expect( target != 0, "could not identify the coroutine's physical context" );

            if( !target )
                return;

            // libcontext still records a valid symmetric suspension, but the
            // authoritative registry now says an in-place wake owns the body.
            // Resume must ghost-return before saving the caller or swapping.
            pcbjam_sched::note_inplace_park( target, +1 );
            const bool runningAfterRefusal = coroutine.Resume( 202 );
            const bool targetStayedUnchanged =
                    pcbjam_sched::status_of( target ) == targetStatus;
            pcbjam_sched::note_inplace_park( target, -1 );

            ctx.Expect( runningAfterRefusal,
                        "a refused resume must leave the coroutine live" );
            ctx.Expect( entryRuns == 1 && afterYieldRuns == 0,
                        "registry/protocol disagreement physically entered the target" );
            ctx.Expect( targetStayedUnchanged,
                        "refusal changed the target's physical suspension" );

            // The ghost return is non-destructive. Removing the exact registry
            // refusal makes the same saved suspension legal again.
            const bool runningAfterLegalResume = coroutine.Resume( 303 );
            ctx.Expect( !runningAfterLegalResume,
                        "legal resume should finish the reducer coroutine" );
            ctx.Expect( entryRuns == 1 && afterYieldRuns == 1,
                        "legal resume did not continue the preserved body once" );
        } ) );
#endif

        m_results.push_back( RunCase( "interleaving_multiple_coroutines", [this]( CaseContext& ctx ) {
            std::vector<std::string> sequence;

            TestCoroutine a( [&]( TestCoroutine& self ) {
                sequence.push_back( "a1" );
                self.Yield( 1 );
                sequence.push_back( "a2" );
                self.Yield( 2 );
                sequence.push_back( "a3" );
            } );

            TestCoroutine b( [&]( TestCoroutine& self ) {
                sequence.push_back( "b1" );
                self.Yield( 10 );
                sequence.push_back( "b2" );
            } );

            bool runningA = a.Call( 1 );
            bool runningB = b.Call( 2 );
            ctx.Expect( runningA, "coroutine A should yield on first call" );
            ctx.Expect( runningB, "coroutine B should yield on first call" );
            ctx.Expect( a.LastReturnValue() == 1, "A first yield should be 1" );
            ctx.Expect( b.LastReturnValue() == 10, "B first yield should be 10" );

            runningA = a.Resume( 3 );
            runningB = b.Resume( 4 );
            ctx.Expect( runningA, "coroutine A should yield on second resume" );
            ctx.Expect( !runningB, "coroutine B should finish on resume" );
            ctx.Expect( a.LastReturnValue() == 2, "A second yield should be 2" );

            runningA = a.Resume( 5 );
            ctx.Expect( !runningA, "coroutine A should finish on final resume" );

            const std::vector<std::string> expected = { "a1", "b1", "a2", "b2", "a3" };
            ctx.Expect( sequence == expected, "unexpected interleave order: " + JoinVector( sequence ) );
        } ) );

        m_results.push_back( RunCase( "stress_many_round_trips", [this]( CaseContext& ctx ) {
            constexpr int rounds = 96;
            int total = 0;
            int iterations = 0;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                for( int i = 0; i < rounds; ++i )
                {
                    total += static_cast<int>( self.CurrentValue() );
                    ++iterations;

                    if( i + 1 < rounds )
                        self.Yield( i + 1 );
                }
            } );

            bool running = coroutine.Call( 1 );
            ctx.Expect( running, "stress coroutine should yield on first iteration" );
            ctx.Expect( coroutine.LastReturnValue() == 1, "first stress yield should be 1" );

            for( int value = 2; value <= rounds; ++value )
            {
                running = coroutine.Resume( value );

                if( value < rounds )
                {
                    ctx.Expect( running, "stress coroutine should still be running at value " + std::to_string( value ) );
                    ctx.Expect( coroutine.LastReturnValue() == value,
                                "stress yield mismatch at value " + std::to_string( value ) );
                }
                else
                {
                    ctx.Expect( !running, "stress coroutine should finish on final resume" );
                }
            }

            int expectedTotal = rounds * ( rounds + 1 ) / 2;
            ctx.Expect( iterations == rounds, "stress coroutine should run all iterations" );
            ctx.Expect( total == expectedTotal,
                        "stress accumulated total mismatch, got " + std::to_string( total ) +
                        " expected " + std::to_string( expectedTotal ) );
        } ) );

        m_results.push_back( RunCase( "transfer_values_round_trip", [this]( CaseContext& ctx ) {
            std::vector<intptr_t> observed;

            TestCoroutine coroutine( [&]( TestCoroutine& self ) {
                observed.push_back( self.CurrentValue() );
                self.Yield( 31 );
                observed.push_back( self.CurrentValue() );
                self.Yield( 63 );
                observed.push_back( self.CurrentValue() );
            } );

            bool running = coroutine.Call( 17 );
            ctx.Expect( running, "transfer test should yield on first call" );
            ctx.Expect( coroutine.LastReturnValue() == 31, "first transfer yield should be 31" );

            running = coroutine.Resume( 47 );
            ctx.Expect( running, "transfer test should yield on second step" );
            ctx.Expect( coroutine.LastReturnValue() == 63, "second transfer yield should be 63" );

            running = coroutine.Resume( 79 );
            ctx.Expect( !running, "transfer test should finish on final resume" );

            const std::vector<intptr_t> expected = { 17, 47, 79 };
            ctx.Expect( observed == expected, "unexpected transfer sequence: " + JoinVector( observed ) );
        } ) );

        m_pendingAsyncCases = 1;
        StartAsyncWaitLoopCase();
    }

private:
    std::vector<CaseResult>           m_results;
    wxTimer                           m_asyncCaseTimer;
    std::unique_ptr<AsyncWaitLoopCaseState> m_asyncState;
    std::unique_ptr<AsyncNestedResumeCaseState> m_nestedAsyncState;
    std::string                       m_asyncCaseName;
    int                               m_pendingAsyncCases = 0;
    wxStaticText*  m_summary = nullptr;
    wxTextCtrl*    m_log = nullptr;
};


class CoroutineTestApp : public wxApp
{
public:
    bool OnInit() override
    {
        CoroutineTestFrame* frame = new CoroutineTestFrame();
        frame->Show();
        return true;
    }
};


wxIMPLEMENT_APP( CoroutineTestApp );
