/*
 * Shared plumbing for the per-editor collab binding TUs (eeschema_embind.cpp,
 * pcbnew_embind.cpp) — the frame-type-free half of the bridge: string/JSON
 * wire emitters to window.kicadCollab, the owner-queued COROUTINE fiber idiom,
 * and the frame-generic test hooks. Header-only (the collab_presence_style.h
 * pattern), so the build script needs no extra objects and the merged
 * kicad_editor image links it without ODR issues.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <deque>
#include <emscripten.h>
#include <exception>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <nlohmann/json.hpp>
#include <wx/event.h>
#include <wx/log.h>
#include <wx/string.h>
#include <wx/weakref.h>
#include <wx/wasm/private/execution_owner.h>
#include <eda_base_frame.h>
#include <tool/actions.h>
#include <tool/coroutine.h>
#include <tool/tool_manager.h>

namespace pcbjam_collab {

inline std::string toUtf8( const wxString& s ) { return std::string( s.utf8_str() ); }

/**
 * Run a body on the editor's main loop AND on a libcontext fiber stack — the
 * exact context native tool edits run in. Embind ccalls / bare CallAfter
 * stacks mis-dispatch asyncify-instrumented virtual calls (invoke_* through a
 * stale table type traps, or silently no-ops); commits, GAL overlay work and
 * the s-expr formatters must therefore run through this. The wx execution
 * queue admits an ordinary command on a fresh dispatch context;
 * COROUTINE::Call then moves the body to the libcontext fiber.
 *
 * MUTATION FIFO (drift-trio finding #10, standalone-hardening 0008 §10):
 * bodies run one-at-a-time. This serializes only the short C++ model-apply
 * phase. Fetches and WebSocket receives happen before this boundary and stay
 * concurrent; their completed payloads queue here in arrival order.
 *
 * Each body also retains the semantic wx execution owner under which it
 * starts. COROUTINE::Call can return while Asyncify still has the body parked,
 * so the ordinary wx scope which called us is not the body's lifetime. The
 * retained owner closes that gap. The body tail queues an AFFILIATED cleanup
 * for that exact token; unrelated ordinary work cannot enter just to reap the
 * coroutine, and cleanup cannot be mistaken for a new transaction.
 */
struct FiberJob
{
    FiberJob( wxEvtHandler* aTarget, std::function<void()> aBody,
              wx_wasm_execution::OwnerToken aOwner, bool aOwnerRetained ) :
            target( aTarget ), body( std::move( aBody ) ), owner( aOwner ),
            ownerRetained( aOwnerRetained )
    {
    }

    wxWeakRef<wxEvtHandler>       target;
    std::function<void()>         body;
    wx_wasm_execution::OwnerToken owner;
    bool                           ownerRetained = false;
};

// The JavaScript owner gateway already bounds serialized arguments by count
// and bytes. Keep the native secondary lane bounded as well, including legacy
// callers which do not arrive through that gateway.
inline constexpr std::size_t MAX_FIBER_JOBS = 4096;

/* The in-flight body. HEAP-allocated and pinned for the body's whole life:
 * when a body PARKS (asyncify suspension inside commit.Push), COROUTINE::Call
 * RETURNS EARLY — the later asyncify rewind re-enters the fiber through the
 * SAME callable at the SAME addresses (dynCall_vi → fcontext_entry →
 * callerStub → the wrapper). Stack-local cor/body (the original runOnFiber
 * AND the first serialized version) were destroyed on that early return, so
 * the rewind called through freed objects — "table index is out of bounds"
 * at rewind, memory corruption downstream (finding #10b's symbolized stack).
 * `done` is the ONLY completion signal; Call() returning is not. */
struct FiberSlot
{
    std::unique_ptr<COROUTINE<int, int>>   cor;
    std::unique_ptr<std::function<void()>> body;
    wxWeakRef<wxEvtHandler>                target;
    wx_wasm_execution::OwnerToken          owner;
    std::exception_ptr                     failure;
    bool                                   ownerRetained = false;
    bool                                   callReturned = false;
    bool                                   done = false;
};

// The weak target can cancel a job only before it starts. Once a body parks,
// its callable and coroutine must stay alive until rewind reaches the real
// tail; generic cancellation would free live captured state. Callers whose
// target can die during such a wait must therefore use their own weak handle
// or generation check inside the body.

/**
 * One physical libcontext lane for one exact semantic owner.
 *
 * A modal parent remains a live owner while its libcontext body is parked in
 * ShowModal(). The modal pump may then admit one child owner. That child is
 * allowed to run a short collab/model body before it closes the modal. A
 * process-global FiberSlot cannot represent both bodies: the child queues
 * behind the parked parent, but the parent cannot resume until the child
 * releases its owner. Keeping the slot and FIFO on the exact OwnerToken breaks
 * that cycle without allowing unrelated roots to overlap.
 *
 * The object address is stable while a native dispatch callback refers to it:
 * fiberLanes() owns every lane through a unique_ptr, and an idle lane is erased
 * only by the callback which has just consumed its last drain/cleanup edge.
 */
struct FiberLane
{
    explicit FiberLane( wx_wasm_execution::OwnerToken aOwner ) : owner( aOwner ) {}

    wx_wasm_execution::OwnerToken owner;
    std::deque<FiberJob>          jobs;
    FiberSlot                     slot;
    bool                          drainQueued = false;
};

inline std::deque<std::unique_ptr<FiberLane>>& fiberLanes()
{
    static std::deque<std::unique_ptr<FiberLane>> lanes;
    return lanes;
}

// This is the global payload bound. Moving a job from its lane FIFO into its
// active slot does not change the count; terminal reap/cancellation does.
inline std::size_t& retainedFiberJobCount()
{
    static std::size_t count = 0;
    return count;
}

inline FiberLane* findFiberLane( const wx_wasm_execution::OwnerToken& aOwner )
{
    if( !aOwner )
        return nullptr;

    for( const std::unique_ptr<FiberLane>& lane : fiberLanes() )
    {
        if( lane->owner == aOwner )
            return lane.get();
    }

    return nullptr;
}

inline FiberLane* createFiberLane( const wx_wasm_execution::OwnerToken& aOwner )
{
    std::unique_ptr<FiberLane> lane = std::make_unique<FiberLane>( aOwner );
    FiberLane*                 result = lane.get();
    fiberLanes().push_back( std::move( lane ) );
    return result;
}

inline FiberLane* findOrCreateFiberLane(
        const wx_wasm_execution::OwnerToken& aOwner )
{
    FiberLane* lane = findFiberLane( aOwner );

    if( lane )
        return lane;

    return createFiberLane( aOwner );
}

inline bool fiberLaneIdle( const FiberLane& aLane )
{
    return !aLane.drainQueued && !aLane.slot.cor && aLane.jobs.empty();
}

inline bool fiberLaneIsRegistered( const FiberLane* aLane )
{
    if( !aLane )
        return false;

    for( const std::unique_ptr<FiberLane>& lane : fiberLanes() )
    {
        if( lane.get() == aLane )
            return true;
    }

    return false;
}

inline void eraseIdleFiberLane( FiberLane* aLane )
{
    if( !aLane || !fiberLaneIdle( *aLane ) )
        return;

    auto& lanes = fiberLanes();

    for( auto it = lanes.begin(); it != lanes.end(); ++it )
    {
        if( it->get() == aLane )
        {
            lanes.erase( it );
            return;
        }
    }

    wxWasmExecutionFailStop( "runOnFiber lost an idle owner lane" );
}

inline bool fiberBusy()
{
    for( const std::unique_ptr<FiberLane>& lane : fiberLanes() )
    {
        if( lane->slot.cor )
            return true;
    }

    return false;
}

inline bool fiberWorkPending()
{
    return retainedFiberJobCount() != 0;
}

inline std::size_t fiberLaneCount()
{
    return fiberLanes().size();
}

inline void drainFibers( FiberLane& aLane );
inline void queueFiberDrain( FiberLane& aLane );

inline void scheduledFiberDrain( void* aArg )
{
    FiberLane* lane = static_cast<FiberLane*>( aArg );

    if( !fiberLaneIsRegistered( lane ) || !lane->drainQueued )
    {
        wxWasmExecutionFailStop( "runOnFiber drain lost its owner lane" );
        return;
    }

    lane->drainQueued = false;
    drainFibers( *lane );
    eraseIdleFiberLane( lane );
}

inline void queueFiberDrain( FiberLane& aLane )
{
    FiberSlot& slot = aLane.slot;
    auto&      q = aLane.jobs;

    if( aLane.drainQueued || slot.cor || q.empty() )
        return;

    aLane.drainQueued = true;

    if( q.front().ownerRetained )
    {
        if( !aLane.owner || aLane.owner != q.front().owner )
        {
            aLane.drainQueued = false;
            wxWasmExecutionFailStop( "runOnFiber queued job changed owner lanes" );
            return;
        }

        // The job retained this exact owner at its Embind/input entry. Transfer
        // that reference through an affiliated fresh-stack callback. An active
        // child lane can therefore run while an ancestor lane is parked, but an
        // unrelated root still cannot enter.
        if( wxWasmExecutionQueueAffiliated(
                    q.front().owner, scheduledFiberDrain, &aLane ) )
        {
            return;
        }

        aLane.drainQueued = false;
        wxWasmExecutionRecordOwnerFailure(
                q.front().owner, "runOnFiber could not queue its retained execution owner" );
        wxWasmExecutionFailStop( "runOnFiber could not queue its retained execution owner" );
        return;
    }

    // A direct caller without a current owner gets its own one-job lane.
    // Ordinary admission creates the owner on a fresh dispatch context; the
    // lane binds to that owner before starting its body.
    if( wxWasmExecutionQueueOrdinary( scheduledFiberDrain, &aLane ) )
        return;

    aLane.drainQueued = false;
    wxWasmExecutionFailStop( "runOnFiber could not queue ordinary execution" );
}

inline std::string fiberFailureMessage( const std::exception_ptr& aFailure )
{
    if( !aFailure )
        return {};

    try
    {
        std::rethrow_exception( aFailure );
    }
    catch( const std::exception& e )
    {
        return std::string( "runOnFiber body failed: " ) + e.what();
    }
    catch( ... )
    {
        return "runOnFiber body failed with a non-standard exception";
    }
}

inline std::exception_ptr reapFiber( FiberLane& aLane )
{
    FiberSlot& slot = aLane.slot;

    // Delete the returned coroutine and its captures while the semantic owner
    // is still held. This function is never called from the coroutine itself.
    slot.cor.reset();
    slot.body.reset();
    slot.target.Release();

    const wx_wasm_execution::OwnerToken owner = slot.owner;
    const bool ownerRetained = slot.ownerRetained;
    std::exception_ptr failure = slot.failure;
    slot.failure = nullptr;
    slot.owner = {};
    slot.ownerRetained = false;
    slot.callReturned = false;
    slot.done = false;

    if( retainedFiberJobCount() == 0 )
    {
        wxWasmExecutionFailStop( "runOnFiber terminal reap underflowed its global bound" );
    }
    else
    {
        --retainedFiberJobCount();
    }

    // Associate the native failure with the JavaScript ticket before the last
    // reference can retire that ticket. Non-Embind owners legitimately have
    // no ticket, so a false return here is not itself an invariant failure.
    if( failure && ownerRetained )
    {
        const std::string reason = fiberFailureMessage( failure );
        wxWasmExecutionRecordOwnerFailure( owner, reason.c_str() );
    }

    if( ownerRetained && !wxWasmExecutionReleaseOwner( owner ) )
    {
        wxLogError( "runOnFiber: the retained execution owner refused terminal release" );
        wxWasmExecutionFailStop( "runOnFiber retained owner refused terminal release" );
    }

    return failure;
}

inline void reportFiberFailure( const std::exception_ptr& aFailure )
{
    if( !aFailure )
        return;

    try
    {
        std::rethrow_exception( aFailure );
    }
    catch( const std::exception& e )
    {
        wxLogError( "runOnFiber body failed: %s", e.what() );
    }
    catch( ... )
    {
        wxLogError( "runOnFiber body failed with a non-standard exception" );
    }
}

inline void affiliatedFiberCleanup( void* aArg )
{
    FiberLane* lane = static_cast<FiberLane*>( aArg );

    if( !fiberLaneIsRegistered( lane ) )
    {
        wxWasmExecutionFailStop( "runOnFiber cleanup lost its owner lane" );
        return;
    }

    FiberSlot& slot = lane->slot;

    if( !slot.cor || !slot.done || lane->owner != slot.owner
            || wxWasmExecutionCurrentOwner() != slot.owner )
    {
        wxWasmExecutionFailStop( "runOnFiber cleanup ran outside its retained owner" );
        return;
    }

    std::exception_ptr failure = reapFiber( *lane );
    reportFiberFailure( failure );
    queueFiberDrain( *lane );
    eraseIdleFiberLane( lane );
}

inline void queueAffiliatedFiberCleanup( FiberLane& aLane )
{
    FiberSlot& aSlot = aLane.slot;

    if( wxWasmExecutionQueueAffiliated(
                aSlot.owner, affiliatedFiberCleanup, &aLane ) )
        return;

    // A returned coroutine cannot delete itself. There is no safe ordinary
    // fallback: it would erase the exact owner relationship and could admit an
    // unrelated transaction. Stop the module and keep the pinned envelope.
    wxWasmExecutionRecordOwnerFailure(
            aSlot.owner, "runOnFiber could not queue affiliated terminal cleanup" );
    wxWasmExecutionFailStop( "runOnFiber could not queue affiliated terminal cleanup" );
}

inline int fiberBodyEntry( FiberLane* aLane, int )
{
    if( !aLane )
    {
        wxWasmExecutionFailStop( "runOnFiber body lost its owner lane" );
        return 0;
    }

    FiberSlot& slot = aLane->slot;

    try
    {
        ( *slot.body )();
    }
    catch( ... )
    {
        // Never unwind an exception across libcontext's stack switch.
        // Report it from the dispatch stack after terminal cleanup.
        slot.failure = std::current_exception();
    }

    slot.done = true;

    // If Call() already returned, this is an Asyncify rewind tail. It cannot
    // delete its own coroutine. Transfer the retained owner to an explicit
    // affiliated cleanup on another dispatch stack.
    if( slot.callReturned )
        queueAffiliatedFiberCleanup( *aLane );

    return 0;
}

inline void finishCancelledFiberJob( FiberLane& aLane, const char* aReason )
{
    auto& q = aLane.jobs;

    FiberJob job = std::move( q.front() );
    q.pop_front();

    // Destroy captures before the semantic command is allowed to complete.
    job.body = {};
    job.target.Release();

    if( retainedFiberJobCount() == 0 )
    {
        wxWasmExecutionFailStop( "runOnFiber cancellation underflowed its global bound" );
    }
    else
    {
        --retainedFiberJobCount();
    }

    if( job.ownerRetained )
    {
        wxWasmExecutionRecordOwnerFailure( job.owner, aReason );

        if( !wxWasmExecutionReleaseOwner( job.owner ) )
            wxWasmExecutionFailStop( "runOnFiber cancelled owner refused terminal release" );
    }
}

inline void drainFibers( FiberLane& aLane )
{
    FiberSlot& slot = aLane.slot;
    auto&      q = aLane.jobs;

    if( slot.cor )
    {
        // Only affiliatedFiberCleanup may reap a body whose Call() returned
        // before its Asyncify rewind reached the real tail.
        wxWasmExecutionFailStop( "runOnFiber drain entered while a fiber was active" );
        return;
    }

    if( q.empty() )
        return;

    // A queued body may capture the target as a raw pointer. Do not invoke it
    // after wx has destroyed that target; reject its owner ticket instead.
    if( !q.front().target )
    {
        finishCancelledFiberJob(
                aLane, "runOnFiber target was destroyed before the body started" );
        queueFiberDrain( aLane );
        return;
    }

    const wx_wasm_execution::OwnerToken current = wxWasmExecutionCurrentOwner();

    if( !current )
    {
        wxWasmExecutionFailStop( "runOnFiber drain has no execution owner" );
        return;
    }

    if( q.front().ownerRetained && q.front().owner != current )
    {
        wxWasmExecutionFailStop( "runOnFiber drain entered under the wrong execution owner" );
        return;
    }

    if( aLane.owner && aLane.owner != current )
    {
        wxWasmExecutionFailStop( "runOnFiber lane entered under the wrong execution owner" );
        return;
    }

    std::unique_ptr<std::function<void()>> body;
    std::unique_ptr<COROUTINE<int, int>>    cor;

    try
    {
        // Leave the queued original intact until both allocations succeed.
        body = std::make_unique<std::function<void()>>( q.front().body );
        cor = std::make_unique<COROUTINE<int, int>>(
                [lane = &aLane]( int aArg ) { return fiberBodyEntry( lane, aArg ); } );
    }
    catch( ... )
    {
        const std::exception_ptr failure = std::current_exception();
        const std::string reason = fiberFailureMessage( failure );

        if( q.front().ownerRetained )
            finishCancelledFiberJob( aLane, reason.c_str() );
        else
        {
            // The ordinary admission still owns this callback. Record before
            // its scope releases, then discard the unstarted job.
            wxWasmExecutionRecordOwnerFailure( current, reason.c_str() );
            finishCancelledFiberJob( aLane, reason.c_str() );
        }

        reportFiberFailure( failure );
        queueFiberDrain( aLane );
        return;
    }

    if( !q.front().ownerRetained )
    {
        if( !wxWasmExecutionRetainOwner( current ) )
        {
            wxWasmExecutionFailStop( "runOnFiber could not retain its admitted execution owner" );
            return;
        }

        q.front().owner = current;
        q.front().ownerRetained = true;
        aLane.owner = current;
    }

    slot.owner = q.front().owner;
    slot.ownerRetained = true;       // transfer the queued reference
    slot.target = q.front().target;
    slot.done = false;
    slot.callReturned = false;
    slot.failure = nullptr;
    slot.body = std::move( body );
    slot.cor = std::move( cor );
    q.pop_front();

    try
    {
        slot.cor->Call( 0 );
    }
    catch( ... )
    {
        // COROUTINE allocates/switches its stack in Call(). Preserve the owner
        // balance if setup fails before fiberBodyEntry can capture the error.
        slot.failure = std::current_exception();
        slot.done = true;
    }

    slot.callReturned = true;

    if( !slot.done )
        return;                         // cor/body/owner stay pinned for rewind

    std::exception_ptr failure = reapFiber( aLane );
    reportFiberFailure( failure );
    queueFiberDrain( aLane );
}

inline void runOnFiber( wxEvtHandler* aHandler, std::function<void()> aBody )
{
    if( !aHandler )
        return;

    if( retainedFiberJobCount() >= MAX_FIBER_JOBS )
    {
        wxWasmExecutionFailStop( "runOnFiber queue exceeded capacity" );
        return;
    }

    const wx_wasm_execution::OwnerToken owner = wxWasmExecutionCurrentOwner();
    bool ownerRetained = false;

    // The Embind delivery scope's reference ends as soon as the JS-callable
    // body returns. Retain it here, before queuing or switching fibers, so the
    // JavaScript Promise covers the real mutation tail (including a park).
    if( owner )
    {
        if( !wxWasmExecutionRetainOwner( owner ) )
        {
            wxWasmExecutionFailStop( "runOnFiber could not retain its calling execution owner" );
            return;
        }

        ownerRetained = true;
    }

    FiberLane* lane = nullptr;

    try
    {
        lane = findOrCreateFiberLane( owner );

        lane->jobs.emplace_back(
                aHandler, std::move( aBody ), owner, ownerRetained );
        ++retainedFiberJobCount();
    }
    catch( ... )
    {
        const std::exception_ptr failure = std::current_exception();
        const std::string reason = fiberFailureMessage( failure );

        if( ownerRetained )
        {
            wxWasmExecutionRecordOwnerFailure( owner, reason.c_str() );

            if( !wxWasmExecutionReleaseOwner( owner ) )
                wxWasmExecutionFailStop( "runOnFiber enqueue owner refused terminal release" );
        }

        reportFiberFailure( failure );

        // Lane creation can succeed before its first deque allocation fails.
        eraseIdleFiberLane( lane );
        return;
    }

    // Always return through the raw Embind export before starting the body.
    // The delivery path is Wasm -> JS deliverMutator() -> Wasm wrapper. If the
    // wrapper starts a body inline and that body parks, Asyncify must unwind
    // through the still-live outer Wasm/JS/Wasm chain. Queueing the affiliated
    // drain gives the body a fresh owner callback instead. The retained owner
    // keeps the semantic command alive across this shallow-return boundary.
    queueFiberDrain( *lane );
}

// ── C++ → JS wire emitters (no-ops without a JS listener) ───────────────────

/** Legacy scalar delta wire: window.kicadCollab.onDelta. */
inline void emitDelta( const nlohmann::json& aDelta )
{
    std::string s = aDelta.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onDelta )
            window.kicadCollab.onDelta( UTF8ToString( $0 ) );
    }, s.c_str() );
}

/** v2 per-item s-expr blob wire (ysync 0008): window.kicadCollab.onItems. */
inline void emitItemsWire( const nlohmann::json& aWire )
{
    std::string s = aWire.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onItems )
            window.kicadCollab.onItems( UTF8ToString( $0 ) );
    }, s.c_str() );
}

/** Local cursor position (presence): window.kicadCollab.onCursor. */
inline void emitCursor( double aX, double aY, bool aActive )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onCursor )
            window.kicadCollab.onCursor( $0, $1, $2 );
    }, aX, aY, aActive ? 1 : 0 );
}

/** Local selection payload (presence): window.kicadCollab.onSelection. */
inline void emitSelection( const std::string& aJson )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSelection )
            window.kicadCollab.onSelection( UTF8ToString( $0 ) );
    }, aJson.c_str() );
}

/** Viewport transform for the DOM layers (0005): window.kicadCollab.onViewport. */
inline void emitViewport( double aCx, double aCy, double aPxPerIu, int aW, int aH )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onViewport )
            window.kicadCollab.onViewport( $0, $1, $2, $3, $4 );
    }, aCx, aCy, aPxPerIu, aW, aH );
}

// ── frame-generic test hooks (ysync miss 09) ────────────────────────────────

/** Run Edit>Undo exactly like the UI would (main-loop + fiber stack) —
 *  exercises the local-ops-only undo policy and the stale-picker UUID guard. */
inline bool testUndo( EDA_BASE_FRAME* aFrame )
{
    if( !aFrame )
        return false;

    runOnFiber( aFrame, [aFrame]() { aFrame->GetToolManager()->RunAction( ACTIONS::undo ); } );
    return true;
}

/** Local undo stack depth — remote applies must not grow it (miss 09). */
inline int testUndoDepth( EDA_BASE_FRAME* aFrame )
{
    return aFrame ? aFrame->GetUndoCommandCount() : -1;
}

} // namespace pcbjam_collab

#endif // __EMSCRIPTEN__
