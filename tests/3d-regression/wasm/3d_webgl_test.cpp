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

// ---------------------------------------------------------------------------
// Engine-toggle regression scaffolding: model a "modern-GL consumer" (the
// raytracer blit / the 2D GAL) sharing the process with the FFP shim.
// ---------------------------------------------------------------------------

// A minimal GLSL quad drawer with a PERSISTENT VAO (the victim). Mirrors the
// raytracer blit: attribute location 0 (colliding with the shim's
// ATTR_POSITION), own VBO, own program.
static GLuint g_appVAO = 0, g_appVBO = 0, g_appProg = 0;

static GLuint compileMini( GLenum type, const char* src )
{
    GLuint s = glCreateShader( type );
    glShaderSource( s, 1, &src, nullptr );
    glCompileShader( s );
    return s;
}

extern "C"
{

// (Re)build the persistent app quad in the CURRENT context. Green full-screen
// quad on attribute 0. Returns 0 on success.
EMSCRIPTEN_KEEPALIVE
int appQuadInit()
{
    static const char* VS = "#version 300 es\nlayout(location=0) in vec2 p;"
                            "void main(){ gl_Position = vec4(p,0.,1.); }";
    static const char* FS = "#version 300 es\nprecision mediump float;"
                            "out vec4 c; void main(){ c = vec4(0.,1.,0.,1.); }";

    GLuint vs = compileMini( GL_VERTEX_SHADER, VS );
    GLuint fs = compileMini( GL_FRAGMENT_SHADER, FS );
    GLuint prog = glCreateProgram();
    glAttachShader( prog, vs );
    glAttachShader( prog, fs );
    glLinkProgram( prog );
    glDeleteShader( vs );
    glDeleteShader( fs );

    GLint linked = GL_FALSE;
    glGetProgramiv( prog, GL_LINK_STATUS, &linked );
    if( !linked )
        return -1;

    static const float quad[] = { -1.f, -1.f, 1.f, -1.f, -1.f, 1.f,
                                  -1.f, 1.f,  1.f, -1.f, 1.f, 1.f };
    g_appProg = prog;
    glGenVertexArrays( 1, &g_appVAO );
    glBindVertexArray( g_appVAO );
    glGenBuffers( 1, &g_appVBO );
    glBindBuffer( GL_ARRAY_BUFFER, g_appVBO );
    glBufferData( GL_ARRAY_BUFFER, sizeof( quad ), quad, GL_STATIC_DRAW );
    glEnableVertexAttribArray( 0 );
    glVertexAttribPointer( 0, 2, GL_FLOAT, GL_FALSE, 0, nullptr );
    glBindVertexArray( 0 );
    glBindBuffer( GL_ARRAY_BUFFER, 0 );
    return (int) glGetError();
}

// Draw the persistent app quad exactly like the blit does: bind ITS VAO, its
// program, glDrawArrays. aClearFirst=1 clears to black before drawing so the
// framebuffer afterwards shows only this draw's output. Returns glGetError.
EMSCRIPTEN_KEEPALIVE
int appQuadDraw( int aClearFirst )
{
    while( glGetError() != GL_NO_ERROR ) {}
    if( aClearFirst )
    {
        glViewport( 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT );
        glClearColor( 0.f, 0.f, 0.f, 1.f );
        glClear( GL_COLOR_BUFFER_BIT );
    }
    glUseProgram( g_appProg );
    glBindVertexArray( g_appVAO );
    glDrawArrays( GL_TRIANGLES, 0, 6 );
    glBindVertexArray( 0 );
    glUseProgram( 0 );
    glFinish();
    return (int) glGetError();
}

// Leave the FFP mirror in the poisoned shape the engine switch can produce:
// GL_VERTEX_ARRAY enabled with a (small) VBO captured by glVertexPointer —
// the MODEL_3D::BeginDrawMulti window state.
EMSCRIPTEN_KEEPALIVE
void ffpMakeStale()
{
    static GLuint tinyVBO = 0;
    static const float tri[] = { 0.f, 0.f, 0.f, 1.f, 0.f, 0.f, 0.f, 1.f, 0.f };
    if( !tinyVBO )
    {
        glGenBuffers( 1, &tinyVBO );
        glBindBuffer( GL_ARRAY_BUFFER, tinyVBO );
        glBufferData( GL_ARRAY_BUFFER, sizeof( tri ), tri, GL_STATIC_DRAW );
    }
    else
        glBindBuffer( GL_ARRAY_BUFFER, tinyVBO );
    glVertexPointer( 3, GL_FLOAT, 0, nullptr ); // captures tinyVBO in the mirror
    glEnableClientState( GL_VERTEX_ARRAY );
    glBindBuffer( GL_ARRAY_BUFFER, 0 );
}

EMSCRIPTEN_KEEPALIVE
void ffpClearStale()
{
    glDisableClientState( GL_VERTEX_ARRAY );
}

// A second live WebGL context on its own canvas — the harness model of the 2D
// editor's GAL context coexisting with the 3D viewer's.
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_context2 = 0;

EMSCRIPTEN_KEEPALIVE
int createSecondContext()
{
    EM_ASM( {
        if( !document.getElementById( "canvas2" ) )
        {
            var c = document.createElement( "canvas" );
            c.id = "canvas2";
            c.width = 320; c.height = 240;
            document.body.appendChild( c );
            if( typeof specialHTMLTargets !== 'undefined' )
                specialHTMLTargets['#canvas2'] = c;
        }
    } );

    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes( &attrs );
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.preserveDrawingBuffer = true;
    g_context2 = emscripten_webgl_create_context( "#canvas2", &attrs );
    return g_context2 > 0 ? 0 : -1;
}

// Switch the current context: 1 = the main harness context, 2 = the second.
EMSCRIPTEN_KEEPALIVE
int useContext( int aWhich )
{
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE h = ( aWhich == 2 ) ? g_context2 : g_context;
    if( h <= 0 )
        return -1;
    return emscripten_webgl_make_context_current( h ) == EMSCRIPTEN_RESULT_SUCCESS ? 0 : -2;
}

// Build + draw + delete a fresh GLSL quad entirely in the CURRENT context (no
// persistent state — safe under any context). Returns glGetError after draw.
EMSCRIPTEN_KEEPALIVE
int quadDrawFresh()
{
    GLuint savedVAO = g_appVAO, savedVBO = g_appVBO, savedProg = g_appProg;
    g_appVAO = g_appVBO = g_appProg = 0;
    int rc = appQuadInit();
    if( rc == 0 )
        rc = appQuadDraw( 1 );
    glDeleteVertexArrays( 1, &g_appVAO );
    glDeleteBuffers( 1, &g_appVBO );
    glDeleteProgram( g_appProg );
    g_appVAO = savedVAO; g_appVBO = savedVBO; g_appProg = savedProg;
    return rc;
}

} // extern "C"

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
