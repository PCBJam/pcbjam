// Deterministic reducer for bounded, owner-aware wx pending events on Wasm.

#include "wx/wx.h"
#include "wx/dialog.h"
#include "wx/timer.h"
#include "wx/wasm/private/execution_owner.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#include <functional>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace
{

constexpr int ID_MODAL_TIMER = wxID_HIGHEST + 860;
constexpr int ID_DELEGATED_STEP_ONE = wxID_HIGHEST + 861;
constexpr int ID_DELEGATED_STEP_TWO = wxID_HIGHEST + 862;
constexpr int ID_UNSCOPED_MANAGER = wxID_HIGHEST + 863;
constexpr int ID_STALE_DELEGATE = wxID_HIGHEST + 864;
constexpr int PENDING_BURST = 512;

struct CheckContext
{
    void Expect( bool aCondition, const std::string& aFailure )
    {
        if( !aCondition )
            failures.push_back( aFailure );
    }

    std::vector<std::string> failures;
};

void LogLine( const std::string& aLine )
{
#ifdef __EMSCRIPTEN__
    EM_ASM( { console.log( UTF8ToString( $0 ) ); }, aLine.c_str() );
#else
    std::printf( "%s\n", aLine.c_str() );
#endif
}

std::function<void()> g_freshTransport;

#ifdef __EMSCRIPTEN__
EM_JS( void, pending_owner_schedule_transport, (), {
    setTimeout( function() {
        try {
            Module.ccall( 'pending_owner_fresh_transport', null, [], [] );
        } catch( error ) {
            console.error( '[PENDING_OWNER] transport failed: ' + error );
        }
    }, 0 );
} );

EM_JS( void, pending_owner_arm_watchdog, (), {
    setTimeout( function() {
        if( !Module.__pendingOwnerDone )
            console.log( '[PENDING_OWNER] FAIL watchdog :: modal completion did not make progress' );
    }, 7000 );
} );

EM_JS( void, pending_owner_mark_done, (), {
    Module.__pendingOwnerDone = true;
} );
#endif

} // namespace

wxDECLARE_EVENT( PENDING_OWNER_MANAGER_EVENT, wxCommandEvent );
wxDEFINE_EVENT( PENDING_OWNER_MANAGER_EVENT, wxCommandEvent );
wxDECLARE_EVENT( PENDING_OWNER_FINAL_EVENT, wxCommandEvent );
wxDEFINE_EVENT( PENDING_OWNER_FINAL_EVENT, wxCommandEvent );

extern "C" EMSCRIPTEN_KEEPALIVE void pending_owner_fresh_transport()
{
    if( g_freshTransport )
        g_freshTransport();
}

class PendingOwnerDialog : public wxDialog
{
public:
    explicit PendingOwnerDialog( wxWindow* aParent ) :
            wxDialog( aParent, wxID_ANY, "Pending-event owner reducer",
                      wxDefaultPosition, wxSize( 320, 140 ) ),
            m_timer( this, ID_MODAL_TIMER )
    {
        Bind( wxEVT_TIMER, &PendingOwnerDialog::OnTimer, this,
              ID_MODAL_TIMER );
        Bind( wxEVT_PAINT, &PendingOwnerDialog::OnPaint, this );
    }

    void Arm( std::function<void()> aCallback )
    {
        m_callback = std::move( aCallback );
        m_timer.StartOnce( 20 );
    }

    int PaintRuns() const { return m_paintRuns; }

private:
    void OnTimer( wxTimerEvent& )
    {
        std::function<void()> callback = std::move( m_callback );
        m_callback = nullptr;

        if( callback )
            callback();
    }

    void OnPaint( wxPaintEvent& aEvent )
    {
        ++m_paintRuns;
        aEvent.Skip();
    }

    wxTimer m_timer;
    std::function<void()> m_callback;
    int m_paintRuns = 0;
};

class PendingOwnerSidecar : public wxEvtHandler
{
public:
    bool Associate( wxWindow* aWindow )
    {
        return wxWasmExecutionAssociatePendingEventHandler( this, aWindow );
    }

    ~PendingOwnerSidecar() override
    {
        wxWasmExecutionForgetPendingEventHandler( this );
    }
};

class PendingEventOwnerFrame : public wxFrame
{
public:
    PendingEventOwnerFrame() :
            wxFrame( nullptr, wxID_ANY, "Pending Event Owner Test",
                     wxDefaultPosition, wxSize( 760, 360 ) )
    {
        wxPanel* panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );
        m_summary = new wxStaticText( panel, wxID_ANY,
                                      "Running pending-event owner reducer..." );
        sizer->Add( m_summary, 0, wxEXPAND | wxALL, 12 );
        panel->SetSizer( sizer );

        m_operationManager.Bind(
                PENDING_OWNER_MANAGER_EVENT,
                &PendingEventOwnerFrame::OnOperationManagerEvent, this );
        wxTheApp->Bind( PENDING_OWNER_FINAL_EVENT,
                        &PendingEventOwnerFrame::OnOperationFinalEvent, this );
        Bind( wxEVT_PAINT, &PendingEventOwnerFrame::OnPaint, this );

        CallAfter( [this]() { Run(); } );
    }

    ~PendingEventOwnerFrame() override
    {
        m_operationManager.Unbind(
                PENDING_OWNER_MANAGER_EVENT,
                &PendingEventOwnerFrame::OnOperationManagerEvent, this );
        wxTheApp->Unbind( PENDING_OWNER_FINAL_EVENT,
                          &PendingEventOwnerFrame::OnOperationFinalEvent, this );
    }

private:
    void Run()
    {
        LogLine( "[PENDING_OWNER] CASE modal_pending_flood_affiliated_liveness" );
#ifdef __EMSCRIPTEN__
        pending_owner_arm_watchdog();
#endif

        m_parentOwner = wxWasmExecutionCurrentOwner();
        m_baseline = wxWasmExecutionPendingEventQueueStats();
        m_checks.Expect( static_cast<bool>( m_parentOwner ),
                         "modal opener has no execution owner" );
        m_checks.Expect(
                m_baseline.failure
                        == wx_wasm_execution::PendingEventFailure::None,
                "pending-event queue was already terminal" );

        // A missing delegated payload is rejected before QueueEvent's assert
        // path and must not manufacture provenance or queue ownership.
        wxWasmExecutionQueueDelegatedPendingEvent(
                &m_operationManager, nullptr, {} );
        const wx_wasm_execution::PendingEventQueueStats afterNullDelegate =
                wxWasmExecutionPendingEventQueueStats();
        m_checks.Expect(
                afterNullDelegate.retained == m_baseline.retained
                        && afterNullDelegate.accepted == m_baseline.accepted
                        && afterNullDelegate.rejected == m_baseline.rejected,
                "null delegated event changed pending-event ownership" );

        g_freshTransport = [this]() { PostBurstFromFreshEntry(); };

        std::optional<PendingOwnerDialog> dialog;
        dialog.emplace( this );
        PendingOwnerDialog* const firstDialog = &*dialog;
        m_dialog = firstDialog;
        m_checks.Expect( m_scopedSidecar.Associate( firstDialog ),
                         "could not associate the modal sidecar scope" );

        // This sidecar has the same owner and scope as the dialog, but it is not
        // a real window target. Scope equality alone must not give it authority
        // to enter the modal child.
        m_scopedSidecar.CallAfter(
                [this]() { ++m_preModalAssociatedSidecarRuns; } );

        // This exact event targets the real dialog before ShowModal() creates
        // the child lease. The parent owner and dialog generation are already
        // known. Lease creation may transfer this event, but no other event
        // which merely shares its owner and scope.
        firstDialog->CallAfter(
                [this, firstDialog]()
                {
                    ++m_preModalCallAfterRuns;
                    const wx_wasm_execution::OwnerToken owner =
                            wxWasmExecutionCurrentOwner();
                    m_checks.Expect(
                            owner && owner.parent == m_parentOwner.id,
                            "pre-modal CallAfter did not run on the child owner" );
                    m_checks.Expect(
                            wxWasmExecutionActiveLeaseScope()
                                    == wxWasmExecutionScopeForWindow(
                                            firstDialog ),
                            "pre-modal CallAfter ran outside its exact lease" );
                } );

        // OpenModalLease() precedes Show(true) and InitDialog(). A nested yield
        // in this short interval must not run transferred child work on the
        // still-unparked parent stack.
        firstDialog->Bind(
                wxEVT_INIT_DIALOG,
                [this, firstDialog]( wxInitDialogEvent& aEvent )
                {
                    m_checks.Expect(
                            wxWasmExecutionActiveLeaseScope()
                                    == wxWasmExecutionScopeForWindow(
                                            firstDialog ),
                            "InitDialog did not observe the exact modal lease" );
                    const bool yielded = wxYield();
                    m_checks.Expect( yielded,
                                     "InitDialog pre-park wxYield was refused" );
                    m_checks.Expect(
                            m_preModalCallAfterRuns == 0,
                            "dialog callback ran before the parent parked" );
                    m_checks.Expect(
                            m_preModalAssociatedSidecarRuns == 0,
                            "scope-only sidecar ran during the pre-park yield" );
                    aEvent.Skip();
                } );

        firstDialog->Arm( [this]() { OnModalTimer(); } );
        const int result = firstDialog->ShowModal();
        m_dialog = nullptr;
        g_freshTransport = nullptr;
        ++m_parentResumeRuns;

        m_checks.Expect( result == 752,
                         "modal did not receive its exact close result" );
        m_checks.Expect( m_transportRuns == 1,
                         "fresh unowned transport did not run exactly once" );
        m_checks.Expect( m_affiliatedRuns == 1,
                         "exact affiliated completion did not run exactly once" );
        m_checks.Expect( m_preModalCallAfterRuns == 1,
                         "pre-modal CallAfter did not run exactly once" );
        m_checks.Expect( m_preModalAssociatedSidecarRuns == 0,
                         "scope-only sidecar entered the first modal" );
        m_checks.Expect( m_afterClosePendingRuns == 0,
                         "closing-lease work ran before the root drain" );
        m_checks.Expect( m_parentResumeRuns == 1,
                         "modal parent did not resume exactly once" );
        m_checks.Expect( m_pendingRuns == 0,
                         "modal child consumed unscoped pending work" );
        m_checks.Expect( m_scopedSidecarRuns == 1,
                         "modal child did not consume its associated sidecar work" );
        m_checks.Expect( m_unscopedSidecarRuns == 0,
                         "modal child consumed an unassociated sidecar event" );
        m_checks.Expect( m_delegatedStepOneRuns == 1
                                 && m_delegatedStepTwoRuns == 1
                                 && m_delegatedFinalRuns == 1,
                         "delegated manager-to-app operation did not finish in the modal" );
        m_checks.Expect( m_unscopedManagerRuns == 0,
                         "modal child consumed unscoped work from the same manager" );
        m_checks.Expect( m_childScopedPaintFrameRuns >= 0,
                         "modal child did not run the scoped-paint reducer" );
        m_checks.Expect( m_framePaintRuns == m_childScopedPaintFrameRuns,
                         "parent frame painted before the modal opener resumed" );
        m_checks.Expect( !wxWasmExecutionActiveLeaseScope(),
                         "first modal lease remained active after ShowModal returned" );

        const int rootPaintBefore = m_framePaintRuns;
        wxTheApp->PaintCurrentExecutionScope();
        const int rootPaintDelta = m_framePaintRuns - rootPaintBefore;
        m_checks.Expect( rootPaintDelta > 0,
                         "root scoped paint did not drain the parent invalidation" );
        m_checks.Expect( !NeedsPaint(),
                         "root scoped paint left the parent invalidation pending" );

        std::ostringstream paint;
        paint << "[PENDING_OWNER] PAINT childParentDelta="
              << m_childScopedPaintFrameDelta
              << " childDialogDelta=" << m_childScopedPaintDialogDelta
              << " rootParentDelta=" << rootPaintDelta;
        LogLine( paint.str() );

        dialog.reset();

        wxWasmExecutionQueueDelegatedPendingEvent(
                &m_operationManager,
                new wxCommandEvent( PENDING_OWNER_MANAGER_EVENT,
                                    ID_STALE_DELEGATE ),
                m_operationDelegate );

        dialog.emplace( this );
        PendingOwnerDialog* const replacement = &*dialog;
        m_checks.Expect( replacement == firstDialog,
                         "replacement modal did not reuse the first object address" );
        replacement->Arm(
                [this, replacement]()
                {
                    const wx_wasm_execution::PendingEventDelegate fresh =
                            wxWasmExecutionCapturePendingEventDelegate(
                                    replacement );
                    m_checks.Expect( static_cast<bool>( fresh ),
                                     "replacement modal could not capture its delegate" );
                    m_checks.Expect( fresh.lease != m_operationDelegate.lease,
                                     "replacement modal reused the first lease generation" );
                    wxYield();
                    m_checks.Expect( m_staleDelegateRuns == 0,
                                     "stale delegation entered a replacement modal" );
                    m_checks.Expect( m_unscopedManagerRuns == 0,
                                     "replacement modal borrowed unscoped manager work" );
                    replacement->EndModal( 753 );
                } );
        const int replacementResult = replacement->ShowModal();
        dialog.reset();
        m_checks.Expect( replacementResult == 753,
                         "replacement modal did not receive its exact close result" );

        const wx_wasm_execution::PendingEventQueueStats beforeRootDrain =
                wxWasmExecutionPendingEventQueueStats();
        m_checks.Expect(
                beforeRootDrain.retained
                        == m_baseline.retained + PENDING_BURST + 5,
                "blocked pending work was lost before the root drain" );
        m_checks.Expect(
                beforeRootDrain.highWater
                        <= wx_wasm_execution::MaxPendingEvents,
                "pending-event retention exceeded its hard bound" );

        const bool rootYieldReturned = wxYield();
        const wx_wasm_execution::PendingEventQueueStats afterRootDrain =
                wxWasmExecutionPendingEventQueueStats();

        m_checks.Expect( rootYieldReturned, "root wxYield was refused" );
        m_checks.Expect( m_pendingRuns == PENDING_BURST,
                         "root did not drain every pending event exactly once" );
        m_checks.Expect( m_unscopedSidecarRuns == 1,
                         "root did not preserve and drain the unassociated sidecar event" );
        m_checks.Expect(
                m_preModalAssociatedSidecarRuns == 1,
                "root did not preserve and drain the scope-only sidecar event" );
        m_checks.Expect( m_afterClosePendingRuns == 1,
                         "root did not drain work retained across modal close" );
        m_checks.Expect( m_unscopedManagerRuns == 1,
                         "root did not drain unscoped work from the operation manager" );
        m_checks.Expect( m_staleDelegateRuns == 1,
                         "root did not drain the stale delegated event" );
        m_checks.Expect( afterRootDrain.retained == m_baseline.retained,
                         "root drain retained pending-event provenance" );
        m_checks.Expect(
                afterRootDrain.forgotten - m_baseline.forgotten
                        == afterRootDrain.accepted - m_baseline.accepted,
                "the operation did not retire every accepted pending event" );
        m_checks.Expect(
                afterRootDrain.failure
                        == wx_wasm_execution::PendingEventFailure::None,
                "pending burst tripped terminal admission" );

        std::ostringstream stats;
        stats << "[PENDING_OWNER] STATS retained=" << afterRootDrain.retained
              << " highWater=" << afterRootDrain.highWater
              << " accepted=" << afterRootDrain.accepted
              << " forgotten=" << afterRootDrain.forgotten
              << " avoidedScans=" << afterRootDrain.avoidedPhysicalScans
              << " dispatchChecks=" << afterRootDrain.dispatchChecks;
        LogLine( stats.str() );

        Finish();
    }

    void OnModalTimer()
    {
        m_childOwner = wxWasmExecutionCurrentOwner();
        m_checks.Expect(
                m_childOwner && m_childOwner.id != m_parentOwner.id
                        && m_childOwner.parent == m_parentOwner.id,
                "timer did not enter through the exact modal child" );

        if( !m_childOwner || !wxWasmExecutionRetainOwner( m_childOwner ) )
        {
            m_checks.Expect( false, "could not retain the exact modal child" );
            if( m_dialog )
                m_dialog->EndModal( wxID_CANCEL );
            return;
        }

        m_scopedSidecar.CallAfter( [this]() { ++m_scopedSidecarRuns; } );
        m_unscopedSidecar.CallAfter( [this]() { ++m_unscopedSidecarRuns; } );
        m_operationDelegate =
                wxWasmExecutionCapturePendingEventDelegate( m_dialog );
        m_checks.Expect( static_cast<bool>( m_operationDelegate ),
                         "modal child could not capture an operation delegate" );

        const bool sidecarYieldReturned = wxYield();
        m_checks.Expect( sidecarYieldReturned,
                         "modal child could not drain associated sidecar work" );
        m_checks.Expect( m_scopedSidecarRuns == 1,
                         "associated sidecar event did not run in the modal child" );
        m_checks.Expect( m_unscopedSidecarRuns == 0,
                         "unassociated sidecar event borrowed the active lease" );

        m_checks.Expect(
                wxWasmExecutionActiveLeaseScope()
                        == wxWasmExecutionScopeForWindow( m_dialog ),
                "modal child does not own the active paint scope" );

        const int framePaintBefore = m_framePaintRuns;
        const int dialogPaintBefore = m_dialog ? m_dialog->PaintRuns() : 0;
        Refresh();
        if( m_dialog )
            m_dialog->Refresh();
        wxTheApp->PaintCurrentExecutionScope();

        m_childScopedPaintFrameRuns = m_framePaintRuns;
        m_childScopedPaintFrameDelta =
                m_framePaintRuns - framePaintBefore;
        m_childScopedPaintDialogDelta = m_dialog
                ? m_dialog->PaintRuns() - dialogPaintBefore : 0;
        m_checks.Expect( m_childScopedPaintFrameDelta == 0,
                         "modal child painted the parked parent frame" );
        m_checks.Expect( m_childScopedPaintDialogDelta > 0,
                         "modal child did not paint its exact dialog scope" );
        m_checks.Expect( NeedsPaint(),
                         "modal child cleared the parked parent's invalidation" );

#ifdef __EMSCRIPTEN__
        pending_owner_schedule_transport();
#else
        PostBurstFromFreshEntry();
#endif
    }

    void PostBurstFromFreshEntry()
    {
        ++m_transportRuns;
        m_checks.Expect(
                !wxWasmExecutionCapturePendingEventDelegate( m_dialog ),
                "fresh callback borrowed the ambient active modal lease" );
        const wx_wasm_execution::PendingEventQueueStats before =
                wxWasmExecutionPendingEventQueueStats();

        for( int i = 0; i < PENDING_BURST; ++i )
            CallAfter( [this]() { ++m_pendingRuns; } );

        const wx_wasm_execution::PendingEventQueueStats after =
                wxWasmExecutionPendingEventQueueStats();
        m_checks.Expect( after.accepted - before.accepted == PENDING_BURST,
                         "unowned producer did not retain the complete burst" );
        m_checks.Expect( after.retained - before.retained == PENDING_BURST,
                         "retention accounting differs from the physical burst" );
        m_checks.Expect(
                after.highWater <= wx_wasm_execution::MaxPendingEvents,
                "pending-event high-water exceeded the hard bound" );

        m_operationManager.QueueEvent(
                new wxCommandEvent( PENDING_OWNER_MANAGER_EVENT,
                                    ID_UNSCOPED_MANAGER ) );
        wxWasmExecutionQueueDelegatedPendingEvent(
                &m_operationManager,
                new wxCommandEvent( PENDING_OWNER_MANAGER_EVENT,
                                    ID_DELEGATED_STEP_ONE ),
                m_operationDelegate );

        const bool queued = wxWasmExecutionQueueAffiliated(
                m_childOwner,
                &PendingEventOwnerFrame::RunAffiliatedCompletion, this );
        m_checks.Expect( queued,
                         "exact affiliated completion was not queued" );

        if( !queued )
            wxWasmExecutionReleaseOwner( m_childOwner );
    }

    static void RunAffiliatedCompletion( void* aArg )
    {
        PendingEventOwnerFrame* self =
                static_cast<PendingEventOwnerFrame*>( aArg );
        ++self->m_affiliatedRuns;
        self->m_checks.Expect(
                wxWasmExecutionCurrentOwner() == self->m_childOwner,
                "affiliated completion lost the retained modal child" );

        const wx_wasm_execution::PendingEventQueueStats beforeYield =
                wxWasmExecutionPendingEventQueueStats();
        const bool childYieldReturned = wxYield();
        const wx_wasm_execution::PendingEventQueueStats afterYield =
                wxWasmExecutionPendingEventQueueStats();

        self->m_checks.Expect( childYieldReturned,
                               "modal child wxYield was refused" );
        self->m_checks.Expect( self->m_pendingRuns == 0,
                               "modal child admitted unscoped pending work" );
        // The pass consumes step one, step two, and the final event.  Steps
        // one and two each queue their successor, so the physical retained
        // count falls by one while accepted rises by two and forgotten rises
        // by three. The eligibility scan checks both blocked sidecars once,
        // every flood event once, the manager 2 + 2 + 1 times, and the final
        // application event once.
        self->m_checks.Expect(
                afterYield.retained + 1 == beforeYield.retained,
                "delegated pass retired the wrong number of retained events" );
        self->m_checks.Expect(
                afterYield.accepted == beforeYield.accepted + 2,
                "delegated pass queued the wrong number of successor events" );
        self->m_checks.Expect(
                afterYield.forgotten == beforeYield.forgotten + 3,
                "delegated pass did not retire its three exact events" );
        self->m_checks.Expect(
                afterYield.dispatchChecks
                        == beforeYield.dispatchChecks + PENDING_BURST + 8,
                "delegated pass performed an unexpected eligibility scan" );
        self->m_checks.Expect(
                self->m_delegatedStepOneRuns == 1
                        && self->m_delegatedStepTwoRuns == 1
                        && self->m_delegatedFinalRuns == 1,
                "modal child did not drain the complete delegated event chain" );

        const wx_wasm_execution::PendingEventQueueStats beforeBlockedYield =
                wxWasmExecutionPendingEventQueueStats();
        const bool blockedYieldReturned = wxYield();
        const wx_wasm_execution::PendingEventQueueStats afterBlockedYield =
                wxWasmExecutionPendingEventQueueStats();

        self->m_checks.Expect( blockedYieldReturned,
                               "modal child blocked-only wxYield was refused" );
        self->m_checks.Expect(
                afterBlockedYield.retained == beforeBlockedYield.retained,
                "blocked-only yield consumed retained parent work" );
        self->m_checks.Expect(
                afterBlockedYield.dispatchChecks
                        == beforeBlockedYield.dispatchChecks,
                "blocked-only yield traversed the ineligible physical list" );
        self->m_checks.Expect(
                afterBlockedYield.avoidedPhysicalScans
                        == beforeBlockedYield.avoidedPhysicalScans + 1,
                "blocked-only yield did not use exactly one indexed no-scan path" );
        self->m_checks.Expect(
                self->m_pendingRuns == 0 && self->m_unscopedSidecarRuns == 0
                        && self->m_unscopedManagerRuns == 0,
                "blocked-only yield admitted unscoped work" );

        // Accept this exact child callback while the lease is open. EndModal()
        // then revokes admission before the nested yield. The callback must
        // stay retained until the parent resumes as the stable root.
        self->m_scopedSidecar.CallAfter(
                [self]() { ++self->m_afterClosePendingRuns; } );
        self->MaybeFinishFirstModal();

        const wx_wasm_execution::PendingEventQueueStats beforeCloseYield =
                wxWasmExecutionPendingEventQueueStats();
        const bool closeYieldReturned = wxYield();
        const wx_wasm_execution::PendingEventQueueStats afterCloseYield =
                wxWasmExecutionPendingEventQueueStats();

        self->m_checks.Expect( closeYieldReturned,
                               "closing modal wxYield was refused" );
        self->m_checks.Expect(
                self->m_afterClosePendingRuns == 0,
                "pending work entered after BeginClose revoked the lease" );
        self->m_checks.Expect(
                afterCloseYield.retained == beforeCloseYield.retained,
                "closing modal consumed retained pending work" );
        self->m_checks.Expect(
                afterCloseYield.dispatchChecks
                        == beforeCloseYield.dispatchChecks,
                "closing modal traversed the ineligible physical list" );
        self->m_checks.Expect(
                afterCloseYield.avoidedPhysicalScans
                        == beforeCloseYield.avoidedPhysicalScans + 1,
                "closing modal did not use the indexed no-scan path" );

        self->m_checks.Expect(
                wxWasmExecutionReleaseOwner( self->m_childOwner ),
                "affiliated completion could not release its exact child" );
        self->m_childOwner = {};
    }

    void OnOperationManagerEvent( wxCommandEvent& aEvent )
    {
        switch( aEvent.GetId() )
        {
        case ID_DELEGATED_STEP_ONE:
            ++m_delegatedStepOneRuns;
            wxWasmExecutionQueueDelegatedPendingEvent(
                    &m_operationManager,
                    new wxCommandEvent( PENDING_OWNER_MANAGER_EVENT,
                                        ID_DELEGATED_STEP_TWO ),
                    m_operationDelegate );
            break;

        case ID_DELEGATED_STEP_TWO:
            ++m_delegatedStepTwoRuns;
            wxWasmExecutionQueueDelegatedPendingEvent(
                    wxTheApp,
                    new wxCommandEvent( PENDING_OWNER_FINAL_EVENT, wxID_ANY ),
                    m_operationDelegate );
            break;

        case ID_UNSCOPED_MANAGER:
            ++m_unscopedManagerRuns;
            break;

        case ID_STALE_DELEGATE:
            ++m_staleDelegateRuns;
            break;
        }
    }

    void OnOperationFinalEvent( wxCommandEvent& )
    {
        ++m_delegatedFinalRuns;
    }

    void OnPaint( wxPaintEvent& aEvent )
    {
        ++m_framePaintRuns;
        aEvent.Skip();
    }

    void MaybeFinishFirstModal()
    {
        if( m_dialog && m_affiliatedRuns == 1 && m_delegatedFinalRuns == 1 )
            m_dialog->EndModal( 752 );
    }

    void Finish()
    {
        if( m_checks.failures.empty() )
        {
            LogLine( "[PENDING_OWNER] PASS modal_pending_flood_affiliated_liveness" );
            LogLine( "[PENDING_OWNER] SUMMARY total=1 passed=1 failed=0" );
            m_summary->SetLabel( "Pending-event owner reducer passed" );
        }
        else
        {
            std::ostringstream failures;
            for( size_t i = 0; i < m_checks.failures.size(); ++i )
            {
                if( i )
                    failures << " | ";
                failures << m_checks.failures[i];
            }
            LogLine( "[PENDING_OWNER] FAIL modal_pending_flood_affiliated_liveness :: "
                     + failures.str() );
            LogLine( "[PENDING_OWNER] SUMMARY total=1 passed=0 failed=1" );
            m_summary->SetLabel( "Pending-event owner reducer failed" );
        }

#ifdef __EMSCRIPTEN__
        pending_owner_mark_done();
#endif
    }

    CheckContext m_checks;
    PendingOwnerDialog* m_dialog = nullptr;
    wxStaticText* m_summary = nullptr;
    wx_wasm_execution::OwnerToken m_parentOwner;
    wx_wasm_execution::OwnerToken m_childOwner;
    wx_wasm_execution::PendingEventQueueStats m_baseline;
    int m_pendingRuns = 0;
    int m_transportRuns = 0;
    int m_affiliatedRuns = 0;
    PendingOwnerSidecar m_scopedSidecar;
    PendingOwnerSidecar m_unscopedSidecar;
    wxEvtHandler m_operationManager;
    wx_wasm_execution::PendingEventDelegate m_operationDelegate;
    int m_scopedSidecarRuns = 0;
    int m_unscopedSidecarRuns = 0;
    int m_delegatedStepOneRuns = 0;
    int m_delegatedStepTwoRuns = 0;
    int m_delegatedFinalRuns = 0;
    int m_unscopedManagerRuns = 0;
    int m_staleDelegateRuns = 0;
    int m_preModalCallAfterRuns = 0;
    int m_preModalAssociatedSidecarRuns = 0;
    int m_afterClosePendingRuns = 0;
    int m_parentResumeRuns = 0;
    int m_framePaintRuns = 0;
    int m_childScopedPaintFrameRuns = -1;
    int m_childScopedPaintFrameDelta = 0;
    int m_childScopedPaintDialogDelta = 0;
};

class PendingEventOwnerApp : public wxApp
{
public:
    bool OnInit() override
    {
        PendingEventOwnerFrame* frame = new PendingEventOwnerFrame();
        frame->Show();
        return true;
    }
};

wxIMPLEMENT_APP( PendingEventOwnerApp );
