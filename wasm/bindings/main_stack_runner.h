/*
 * Main-stack runner: the KiCad half of wx's nested-loop bounce
 * (pcbjam docs/features/async/19, 20 D3).
 *
 * A quasi-modal's nested event loop parks its whole stack for the dialog's
 * lifetime. When that stack is a TOOL coroutine's, the park suspends the
 * fiber's body where the fiber layer cannot see it: the stale-fiber guard
 * quarantines the fiber, then REFUSES its own resume, and the dialog stops
 * responding to clicks (only the titlebar x still works, because that path is
 * ungated). That is the Symbol Properties hang.
 *
 * wx detects "this nested loop is about to park on a non-main stack" — it can,
 * cheaply and exactly, by comparing a frame address against
 * emscripten_stack_get_base()/end() — but it must not know what a coroutine
 * is. So it calls this runner, and KiCad's TOOL_MANAGER moves the loop onto
 * the main stack via its own RunMainStack mechanism, which suspends the
 * coroutine the legitimate way: a fiber swap the layer records
 * (swap_suspended = true), so no quarantine, no refused resume.
 *
 * This lives in pcbjam's binding layer rather than in KiCad or wx precisely
 * because it is the only place that may know about both.
 */
#pragma once

#include <wx/app.h>

#include <eda_base_frame.h>
#include <tool/tool_manager.h>

#include <wx/wasm/private/mainstack.h>

namespace pcbjam_main_stack
{

/**
 * Run aFunc on the main stack if a tool coroutine is currently active.
 *
 * Returns 1 when the body has been run (bounced, or run inline because there
 * was no coroutine to bounce off), 0 when there was nothing to run it with —
 * no frame or no tool manager — in which case wx parks in place exactly as it
 * did before this hook existed.
 */
inline int run_on_main_stack( void ( *aFunc )( void* ), void* aArg )
{
    if( !wxTheApp )
        return 0;

    auto* frame = dynamic_cast<EDA_BASE_FRAME*>( wxTheApp->GetTopWindow() );

    if( !frame )
        return 0;

    TOOL_MANAGER* toolMgr = frame->GetToolManager();

    if( !toolMgr )
        return 0;

    // RunOnMainStackIfActiveTool runs the body inline when no coroutine is
    // running. Either way the body HAS run, so report it as handled — letting
    // wx fall through would run the nested loop a second time.
    bool ran = false;

    toolMgr->RunOnMainStackIfActiveTool(
            [aFunc, aArg, &ran]()
            {
                ran = true;
                aFunc( aArg );
            } );

    return ran ? 1 : 0;
}

/**
 * Installs at static-init time. Only stores a function pointer, so it is safe
 * before wx exists; every lookup above happens lazily per call, since frames
 * come and go. Included by more than one binding TU — setting the same pointer
 * twice is idempotent.
 */
struct INSTALLER
{
    INSTALLER() { wxWasmSetMainStackRunner( &run_on_main_stack ); }
};

inline INSTALLER g_installer;

} // namespace pcbjam_main_stack
