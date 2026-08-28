/*
 * Shared plumbing for the per-editor collab binding TUs (eeschema_embind.cpp,
 * pcbnew_embind.cpp) — the frame-type-free half of the bridge: string/JSON
 * wire emitters to window.kicadCollab, the CallAfter+COROUTINE apply queue,
 * and the frame-generic test hooks. Header-only (the collab_presence_style.h
 * pattern), so the build script needs no extra objects and the merged
 * kicad_editor image links it without ODR issues.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <deque>
#include <emscripten.h>
#include <functional>
#include <string>
#include <nlohmann/json.hpp>
#include <wx/event.h>
#include <wx/string.h>
#include <eda_base_frame.h>
#include <tool/actions.h>
#include <tool/coroutine.h>
#include <tool/tool_manager.h>

namespace pcbjam_collab {

inline std::string toUtf8( const wxString& s ) { return std::string( s.utf8_str() ); }

/**
 * Run a body on the editor's main loop AND inside a COROUTINE — the exact
 * context native tool edits run in. CallAfter queues onto the app's
 * pending-event list (drained every frame by the wasm main loop,
 * src/wasm/evtloop.cpp); COROUTINE::Call moves the body onto its own
 * coroutine stack. Commits, GAL overlay work and the s-expr formatters run
 * through this.
 *
 * SERIALIZED (drift-trio finding #10, standalone-hardening 0008 §10): bodies
 * run strictly one-at-a-time through a FIFO. A body that SUSPENDS (a JSPI
 * suspension inside commit.Push — connectivity/GAL work) returns early from
 * COROUTINE::Call while its coroutine is still in flight. Without the queue
 * the main loop kept draining pending events and started the NEXT body — a
 * local commit and a remote apply then ran interleaved on shared
 * commit/listener state (s_applyingRemote is a single global), silently
 * losing applies on the actively-editing receiver and, in the worst case,
 * corrupting memory (fuzz S10: wasm OOB on an observer). The busy flag is
 * suspension-safe: while a suspended body is in flight every other drain
 * invocation no-ops on the flag, and the body's own coroutine tail
 * re-schedules the drain when it completes.
 */
inline std::deque<std::function<void()>>& applyQueue()
{
    static std::deque<std::function<void()>> q;
    return q;
}

inline bool& applyBusy()
{
    static bool busy = false;
    return busy;
}

/* The in-flight body. HEAP-allocated and pinned for the body's whole life:
 * when a body SUSPENDS (a JSPI suspension inside commit.Push), COROUTINE::Call
 * RETURNS EARLY — the later resume re-enters the coroutine through the SAME
 * callable at the SAME addresses. Stack-local cor/body (the original
 * runOnCoroutine AND the first serialized version) were destroyed on that
 * early return, so the resume ran through freed objects — memory corruption
 * downstream (finding #10b's symbolized stack). `done` is the ONLY completion
 * signal; Call() returning is not. */
struct ApplySlot
{
    COROUTINE<int, int>*   cor = nullptr;
    std::function<void()>* body = nullptr;
    bool                   done = false;
};

inline ApplySlot& activeApplySlot()
{
    static ApplySlot s;
    return s;
}

inline wxEvtHandler*& applyHandler()
{
    static wxEvtHandler* h = nullptr;
    return h;
}

inline void drainApplies();

inline void reapApply()
{
    ApplySlot& slot = activeApplySlot();
    delete slot.cor;
    delete slot.body;
    slot.cor = nullptr;
    slot.body = nullptr;
    slot.done = false;
    applyBusy() = false;
}

inline void drainApplies()
{
    ApplySlot& slot = activeApplySlot();

    if( applyBusy() )
    {
        if( !slot.done )
        {
            if( slot.cor && slot.cor->CanResume() )
                return;     // suspended body still in flight — its tail re-drains

            // P-1: the body's activation died without finishing (its promising entry
            // REJECTED — a JS exception out of a wire callback, or a trap — and libcontext
            // flagged the record dead). Its tail never runs, so nothing else would ever
            // reap it: release the slot here and keep draining.
            EM_ASM( { console.error( '[pcbjam collab] apply body died mid-flight — slot released' ); } );
        }

        reapApply();        // completed (or died) since the last drain
    }

    auto& q = applyQueue();

    while( !q.empty() )
    {
        applyBusy() = true;
        slot.done = false;
        slot.body = new std::function<void()>( std::move( q.front() ) );
        q.pop_front();

        slot.cor = new COROUTINE<int, int>( []( int ) -> int
        {
            ApplySlot& sl = activeApplySlot();

            // P-1 hardening (findings group P): `done` is the ONLY completion signal, so a
            // body that unwinds on a C++ exception would leave applyBusy() true for the
            // page's life and silently queue every later job behind it: fit/pan from JS,
            // remote applies AND the local-edit flushDiff (local edits stop syncing).
            // Always mark the slot done. NOTE: a JS exception thrown out of an EM_ASM wire
            // callback does NOT surface here — under JSPI it rejects the promising entry
            // and this frame is simply abandoned; that case is covered by the wire
            // emitters' own try/catch plus the dead-body reap in drainApplies().
            try
            {
                ( *sl.body )();
            }
            catch( ... )
            {
                EM_ASM( { console.error( '[pcbjam collab] apply body threw — slot released' ); } );
            }

            sl.done = true;

            // If we suspended, no drain is pending by the time the body
            // completes — schedule the reap + next body from the coroutine
            // tail (CallAfter only queues; safe here).
            if( wxEvtHandler* h = applyHandler() )
                h->CallAfter( []() { drainApplies(); } );

            return 0;
        } );

        slot.cor->Call( 0 );

        if( !slot.done )
        {
            if( slot.cor->CanResume() )
                return;     // suspended — cor/body stay pinned for the resume

            EM_ASM( { console.error( '[pcbjam collab] apply body died at entry — slot released' ); } );
        }

        reapApply();
    }
}

/** Test/diagnostic probe (P-1): is the apply slot busy and how many bodies wait behind it.
 *  A `busy` that never clears while `queued` grows is the wedge signature. */
inline std::string applyQueueStateJson()
{
    return "{\"busy\":" + std::string( applyBusy() ? "true" : "false" )
           + ",\"queued\":" + std::to_string( applyQueue().size() ) + "}";
}

inline void runOnCoroutine( wxEvtHandler* aHandler, std::function<void()> aBody )
{
    applyHandler() = aHandler;
    applyQueue().push_back( std::move( aBody ) );
    aHandler->CallAfter( []() { drainApplies(); } );
}

// ── C++ → JS wire emitters (no-ops without a JS listener) ───────────────────

/** Legacy scalar delta wire: window.kicadCollab.onDelta. */
inline void emitDelta( const nlohmann::json& aDelta )
{
    std::string s = aDelta.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onDelta )
        {
            // A throwing listener must never unwind the wasm frame that called it: under
            // JSPI that rejects the running coroutine's entry (findings P-1).
            try { window.kicadCollab.onDelta( UTF8ToString( $0 ) ); }
            catch( e ) { console.error( '[pcbjam collab] onDelta listener threw', e ); }
        }
    }, s.c_str() );
}

/** v2 per-item s-expr blob wire (ysync 0008): window.kicadCollab.onItems. */
inline void emitItemsWire( const nlohmann::json& aWire )
{
    std::string s = aWire.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onItems )
        {
            // A throwing listener must never unwind the wasm frame that called it: under
            // JSPI that rejects the running coroutine's entry (findings P-1).
            try { window.kicadCollab.onItems( UTF8ToString( $0 ) ); }
            catch( e ) { console.error( '[pcbjam collab] onItems listener threw', e ); }
        }
    }, s.c_str() );
}

/** Local cursor position (presence): window.kicadCollab.onCursor. */
inline void emitCursor( double aX, double aY, bool aActive )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onCursor )
        {
            // A throwing listener must never unwind the wasm frame that called it: under
            // JSPI that rejects the running coroutine's entry (findings P-1).
            try { window.kicadCollab.onCursor( $0, $1, $2 ); }
            catch( e ) { console.error( '[pcbjam collab] onCursor listener threw', e ); }
        }
    }, aX, aY, aActive ? 1 : 0 );
}

/** Local selection payload (presence): window.kicadCollab.onSelection. */
inline void emitSelection( const std::string& aJson )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSelection )
        {
            // A throwing listener must never unwind the wasm frame that called it: under
            // JSPI that rejects the running coroutine's entry (findings P-1).
            try { window.kicadCollab.onSelection( UTF8ToString( $0 ) ); }
            catch( e ) { console.error( '[pcbjam collab] onSelection listener threw', e ); }
        }
    }, aJson.c_str() );
}

/** Viewport transform for the DOM layers (0005): window.kicadCollab.onViewport. */
inline void emitViewport( double aCx, double aCy, double aPxPerIu, int aW, int aH )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onViewport )
        {
            // A throwing listener must never unwind the wasm frame that called it: under
            // JSPI that rejects the running coroutine's entry (findings P-1).
            try { window.kicadCollab.onViewport( $0, $1, $2, $3, $4 ); }
            catch( e ) { console.error( '[pcbjam collab] onViewport listener threw', e ); }
        }
    }, aCx, aCy, aPxPerIu, aW, aH );
}

// ── frame-generic test hooks (ysync miss 09) ────────────────────────────────

/** Run Edit>Undo exactly like the UI would (main loop + apply coroutine) —
 *  exercises the local-ops-only undo policy and the stale-picker UUID guard. */
inline bool testUndo( EDA_BASE_FRAME* aFrame )
{
    if( !aFrame )
        return false;

    runOnCoroutine( aFrame, [aFrame]() { aFrame->GetToolManager()->RunAction( ACTIONS::undo ); } );
    return true;
}

/** Local undo stack depth — remote applies must not grow it (miss 09). */
inline int testUndoDepth( EDA_BASE_FRAME* aFrame )
{
    return aFrame ? aFrame->GetUndoCommandCount() : -1;
}

} // namespace pcbjam_collab

#endif // __EMSCRIPTEN__
