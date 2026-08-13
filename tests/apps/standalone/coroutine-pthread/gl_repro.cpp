// Reproduction probe #5: WebGL 2.0 + coroutine, the last untested KiCad factor.
//
// KiCad's GAL renders via WebGL 2.0 in the rAF refresh, and tool coroutines activate
// during the same refresh — so the Asyncify unwind/rewind happens MID-RENDER-FRAME with
// the GL context current. This probe creates a real WebGL-2.0 context and activates the
// coroutine between GL draw calls inside the rAF-driven frame, then the coroutine
// yields back and the frame's promising activation suspends/resumes. (JSPI 2026-08-13:
// emscripten_set_main_loop callbacks are plain calls and cannot suspend — the frame is
// driven like the shipped app drives ticks, a JS rAF loop over a promising export.)
//
// No-wx (single-threaded first; GL+pthreads needs OFFSCREEN proxying — add later if this
// passes). Firefox should reach "[REPRO] DONE"; if system Chrome crashes before DONE, the
// WebGL x coroutine-rewind interaction is the missing factor.

#include "kicad_coroutine_harness.h"

#include <emscripten.h>
#include <emscripten/em_js.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>

#include <cstdio>

using coroutine_test::TestCoroutine;

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_ctx = 0;
static int g_frame = 0;

static void run_coroutine()
{
    TestCoroutine co( []( TestCoroutine& self ) {
        std::printf( "[REPRO] coroutine body running (mid-GL-frame), about to yield\n" );
        std::fflush( stdout );
        self.Yield( 42 );
    } );

    bool running = co.Call( 1 );  // unwinds the render frame back to dynCall_v; yields back
    std::printf( "[REPRO] after Call: running=%d lastValue=%ld\n",
                 (int) running, (long) co.LastReturnValue() );
    std::fflush( stdout );

    running = co.Resume( 2 );
    std::printf( "[REPRO] after Resume: running=%d\n", (int) running );
    std::fflush( stdout );
}

static bool g_done = false;

extern "C" EMSCRIPTEN_KEEPALIVE void repro_tick()
{
    if( g_done )
        return;

    ++g_frame;
    glClearColor( 0.1f, 0.2f, 0.3f, 1.0f );
    glClear( GL_COLOR_BUFFER_BIT );  // a real WebGL2 draw call before the coroutine

    if( g_frame >= 2 )
    {
        std::printf( "[REPRO] frame %d: activating coroutine mid-GL-frame\n", g_frame );
        std::fflush( stdout );

        run_coroutine();  // coroutine yields -> the frame activation suspends + resumes

        glClearColor( 0.3f, 0.2f, 0.1f, 1.0f );
        glClear( GL_COLOR_BUFFER_BIT );  // another GL call after the coroutine resumes
        std::printf( "[REPRO] DONE\n" );
        std::fflush( stdout );
        g_done = true;
    }
}

// rAF driver over the promising tick export (each tick may suspend mid-frame).
EM_JS( void, install_raf_driver, (), {
    const tick = () => {
        Promise.resolve( _repro_tick() ).then( () => requestAnimationFrame( tick ) );
    };
    requestAnimationFrame( tick );
} );

int main()
{
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes( &attrs );
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    g_ctx = emscripten_webgl_create_context( "#canvas", &attrs );
    emscripten_webgl_make_context_current( g_ctx );
    std::printf( "[REPRO] start; WebGL2 context=%d\n", (int) g_ctx );
    std::fflush( stdout );

    install_raf_driver();
    emscripten_exit_with_live_runtime();  // main returns; rAF drives repro_tick
    return 0;
}
