// Reproduction probe #4: activate the coroutine from inside the rAF-driven tick —
// the SINGLE JS->wasm boundary KiCad actually uses. Asyncify-era shape: rAF ->
// callUserCallback -> iterFunc -> dynCall_v -> wasm refresh -> tool coroutine, via
// emscripten_set_main_loop. JSPI (2026-08-13): a plain main-loop callback cannot
// suspend ("SuspendError: trying to suspend without WebAssembly.promising"), and the
// shipped app doesn't use emscripten_set_main_loop anymore — wx drives rAF ticks
// through PROMISING exports (wxWasmTopLevelTick et al). This probe mirrors that: a JS
// rAF driver calls the exported repro_tick(), which is on the target's JSPI_EXPORTS
// list, so the coroutine suspends mid-tick exactly like a tool coroutine mid-refresh.
//
// No-wx + pthreads. Both engines should reach "[REPRO] DONE".

#include "kicad_coroutine_harness.h"

#include <emscripten.h>
#include <emscripten/em_js.h>

#include <cstdio>

using coroutine_test::TestCoroutine;

static int g_frame = 0;
static bool g_done = false;

static void run_coroutine()
{
    TestCoroutine co( []( TestCoroutine& self ) {
        std::printf( "[REPRO] coroutine body running, about to yield\n" );
        std::fflush( stdout );
        self.Yield( 42 );
    } );

    bool running = co.Call( 1 );  // suspends the tick's promising activation; yields back
    std::printf( "[REPRO] after Call: running=%d lastValue=%ld\n",
                 (int) running, (long) co.LastReturnValue() );
    std::fflush( stdout );

    running = co.Resume( 2 );
    std::printf( "[REPRO] after Resume: running=%d\n", (int) running );
    std::fflush( stdout );
}

extern "C" EMSCRIPTEN_KEEPALIVE void repro_tick()
{
    if( g_done )
        return;

    ++g_frame;
    std::printf( "[REPRO] main-loop frame %d\n", g_frame );
    std::fflush( stdout );

    if( g_frame >= 2 )
    {
        std::printf( "[REPRO] activating coroutine inside main-loop refresh\n" );
        std::fflush( stdout );
        run_coroutine();
        std::printf( "[REPRO] DONE\n" );
        std::fflush( stdout );
        g_done = true;
    }
}

// rAF driver calling the PROMISING tick export (the glue wraps every
// JSPI_EXPORTS entry with WebAssembly.promising, so each tick may suspend).
EM_JS( void, install_raf_driver, (), {
    const tick = () => {
        Promise.resolve( _repro_tick() ).then( () => {
            if( !Module.__reproDone )
                requestAnimationFrame( tick );
        } );
    };
    requestAnimationFrame( tick );
} );

int main()
{
    std::printf( "[REPRO] start; installing rAF driver over the promising tick export\n" );
    std::fflush( stdout );
    install_raf_driver();
    emscripten_exit_with_live_runtime();  // main returns; rAF drives repro_tick
    return 0;
}
