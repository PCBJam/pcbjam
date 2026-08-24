/**
 * 3D-renderer WebGL test harness (WASM) — runs the shared scenarios
 * (tests/3d-regression/scenarios/) in the browser. The legacy GL surface is
 * implemented by the wasm/gl1 GL1->WebGL2 emulation layer; the parity level
 * (npm run 3d:check:parity) compares these renders against the native goldens.
 *
 * Unlike the GAL harness this needs no wx window: the renderer draws into
 * whatever context is current, so a direct emscripten WebGL2 context on
 * #canvas is enough — created with the attributes the suite requires
 * (stencil for DrawCulled, no MSAA to match the native single-sample FBO,
 * preserveDrawingBuffer for Playwright canvas screenshots).
 */

#include <emscripten.h>
#include <emscripten/html5.h>

#include "scene3d_test_ctx.h"
#include "scene3d_test_scenarios.h"

#include <cstdio>

static const int CAPTURE_WIDTH = 800;  // must match manifest.json + native FBO
static const int CAPTURE_HEIGHT = 600;

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_context = 0;
static SCENE3D_CTX*                    g_ctx = nullptr;

// One context-creation recipe for the initial context (main) and recreateContext():
// the recreated context must carry the exact attributes the suite requires, or a
// close/reopen render would differ from the goldens for attribute reasons alone.
static bool createContext()
{
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes( &attrs );

    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = true;
    attrs.stencil = true;                // DrawCulled hole subtraction
    attrs.antialias = false;             // native goldens are single-sample
    attrs.preserveDrawingBuffer = true;  // Playwright canvas.screenshot()

    emscripten_set_canvas_element_size( "#canvas", CAPTURE_WIDTH, CAPTURE_HEIGHT );

    g_context = emscripten_webgl_create_context( "#canvas", &attrs );

    if( g_context <= 0 )
        return false;

    emscripten_webgl_make_context_current( g_context );
    return true;
}

extern "C"
{

EMSCRIPTEN_KEEPALIVE
int getTotalScenarios()
{
    return Scene3DTest::GetScenarioCount();
}

EMSCRIPTEN_KEEPALIVE
const char* getScenarioName( int aIndex )
{
    return Scene3DTest::GetScenarioName( aIndex );
}

EMSCRIPTEN_KEEPALIVE
int getCanvasWidth()
{
    return CAPTURE_WIDTH;
}

EMSCRIPTEN_KEEPALIVE
int getCanvasHeight()
{
    return CAPTURE_HEIGHT;
}

EMSCRIPTEN_KEEPALIVE
int runScenario( int aIndex )
{
    if( aIndex < 0 || aIndex >= Scene3DTest::GetScenarioCount() )
        return -1;

    if( emscripten_webgl_make_context_current( g_context ) != EMSCRIPTEN_RESULT_SUCCESS )
        return -2;

    if( !g_ctx )
    {
        g_ctx = new SCENE3D_CTX( CAPTURE_WIDTH, CAPTURE_HEIGHT );
        g_ctx->InitOnce();
    }

    std::printf( "[3d-webgl] scenario %d: %s\n", aIndex, Scene3DTest::GetScenarioName( aIndex ) );

    // Start from a cleared frame; scenarios call BeginFrame themselves.
    glViewport( 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT );
    glClearColor( 0.0f, 0.0f, 0.0f, 1.0f );
    glClearDepth( 1.0f );
    glClearStencil( 0 );
    glClear( GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT );

    Scene3DTest::RenderScenario( *g_ctx, aIndex );

    glFinish();
    return 0;
}

// Destroy the current WebGL context and mint a fresh one on a fresh canvas
// element — the harness model of the app's 3D-viewer close/reopen (~wxGLCanvas
// destroys its context AND its DOM canvas; a new frame creates new ones).
// The element swap is essential: a browser canvas keeps its WebGL context for
// life, so recreating on the SAME element would hand back the same live context
// and old GL object names would still work — hiding the very bug this models.
// Deliberately NO shim call here: the gl1 layer itself must detect the context
// change on its next draw and rebuild its cached GL objects, exactly as
// production code paths require.
EMSCRIPTEN_KEEPALIVE
int recreateContext()
{
    // The scene ctx is rebuilt per context, like the app's per-canvas renderer.
    // Delete it while the old context is still alive (mirrors releaseOpenGL()).
    delete g_ctx;
    g_ctx = nullptr;

    if( g_context > 0 )
        emscripten_webgl_destroy_context( g_context );

    g_context = 0;

    EM_ASM( {
        var old = Module['canvas'];
        var fresh = old.cloneNode( false );  // same id/width/height, no context yet
        old.parentNode.replaceChild( fresh, old );
        Module['canvas'] = fresh;
        // '#canvas' resolves through specialHTMLTargets before querySelector.
        if( typeof specialHTMLTargets !== 'undefined' )
            specialHTMLTargets['#canvas'] = fresh;
    } );

    if( !createContext() )
    {
        std::fprintf( stderr, "[3d-webgl] recreateContext: failed to create WebGL2 context\n" );
        return -1;
    }

    std::printf( "[3d-webgl] context recreated\n" );
    return 0;
}

} // extern "C"


int main()
{
    if( !createContext() )
    {
        std::fprintf( stderr, "[3d-webgl] failed to create WebGL2 context (%ld)\n",
                      (long) g_context );
        return 1;
    }

    std::printf( "[3d-webgl] ready: %d scenarios, %dx%d\n", Scene3DTest::GetScenarioCount(),
                 CAPTURE_WIDTH, CAPTURE_HEIGHT );

    EM_ASM( { if( window._threeDTestReady ) window._threeDTestReady(); } );

    return 0;
}
