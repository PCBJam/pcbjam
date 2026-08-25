/*
 * gl1_shim — GL 1.x fixed-function pipeline emulated on WebGL2.
 *
 * Internal header shared by the wasm/gl1/src modules. The public surface
 * is the set of C entry points in gl1_entry_ffp.cpp (FFP-only names absent from
 * WebGL2, previously no-op'd by wasm/stubs/gl_ffp_stub.c) plus the __wrap_*
 * interceptors in gl1_entry_wrapped.cpp (Emscripten-owned names the emulator
 * must observe; see wrapped_symbols.txt and the -Wl,--wrap flags both link
 * sites derive from it).
 *
 * Everything here is main-thread-only (both consumers render on the main
 * browser thread) — no TLS, no atomics, no exceptions.
 */

#ifndef GL1_SHIM_H
#define GL1_SHIM_H

#define GL_GLEXT_PROTOTYPES
#include <GL/gl.h>
#include <GL/glu.h> // wasm/stubs/GL/glu.h via -I wasm/stubs

#include <glm/glm.hpp>

#include <cstdint>
#include <cstdio>
#include <vector>

// One-time diagnostics: the suite requires a clean console, but unsupported
// paths must not fail silently. Each call site warns exactly once.
#define GL1_WARN_ONCE( fmt, ... )                                          \
    do                                                                     \
    {                                                                      \
        static bool _gl1_warned = false;                                   \
        if( !_gl1_warned )                                                 \
        {                                                                  \
            _gl1_warned = true;                                            \
            std::fprintf( stderr, "[gl1] " fmt "\n", ##__VA_ARGS__ );      \
        }                                                                  \
    } while( 0 )

// The __real_* counterparts of every wrapped symbol (resolved by wasm-ld back
// to the Emscripten WebGL JS-library import). Shim-internal code that needs
// the true WebGL behavior calls these directly — never the public names.
extern "C"
{
    void      __real_glEnable( GLenum cap );
    void      __real_glDisable( GLenum cap );
    GLboolean __real_glIsEnabled( GLenum cap );
    void      __real_glDrawArrays( GLenum mode, GLint first, GLsizei count );
    void      __real_glDrawElements( GLenum mode, GLsizei count, GLenum type, const GLvoid* indices );
    void      __real_glGetFloatv( GLenum pname, GLfloat* params );
    void      __real_glBindTexture( GLenum target, GLuint texture );
    void      __real_glBlendFunc( GLenum sfactor, GLenum dfactor );
    void      __real_glLineWidth( GLfloat width );
    void      __real_glHint( GLenum target, GLenum mode );
}

namespace gl1
{

// ---------------------------------------------------------------------------
// State mirror — the GL 1.x state the emulator owns. WebGL-native state
// (blend, depth, stencil, cull, viewport, textures, buffers...) is NOT
// mirrored; those calls pass through untouched.
// ---------------------------------------------------------------------------

struct Light
{
    // GL 1.5 defaults: LIGHT0 gets white diffuse/specular, others black
    // (applied in State::State).
    glm::vec4 ambient{ 0.0f, 0.0f, 0.0f, 1.0f };
    glm::vec4 diffuse{ 0.0f, 0.0f, 0.0f, 1.0f };
    glm::vec4 specular{ 0.0f, 0.0f, 0.0f, 1.0f };
    // GL_POSITION is transformed by the modelview CURRENT AT THE glLightfv CALL
    // and stored in eye space — this is what eye-anchors KiCad's directional
    // lights (init_lights() runs under an identity modelview).
    glm::vec4 posEye{ 0.0f, 0.0f, 1.0f, 0.0f };
};

struct Material
{
    glm::vec4 ambient{ 0.2f, 0.2f, 0.2f, 1.0f };
    glm::vec4 diffuse{ 0.8f, 0.8f, 0.8f, 1.0f };
    glm::vec4 specular{ 0.0f, 0.0f, 0.0f, 1.0f };
    glm::vec4 emission{ 0.0f, 0.0f, 0.0f, 1.0f };
    float     shininess = 0.0f;
};

struct ClientArray
{
    bool          enabled = false;
    GLint         size = 4;
    GLenum        type = GL_FLOAT;
    GLsizei       stride = 0;
    const GLvoid* pointer = nullptr;
    // GL1 semantics: gl*Pointer captures the GL_ARRAY_BUFFER binding current at
    // the call; 0 = client memory, nonzero = offset into that VBO.
    GLuint        boundBuffer = 0;
};

// Interleaved immediate-mode vertex (glBegin/glEnd stream and display-list
// geometry bake share this layout). Matches the attribute setup in gl1_draw.
struct ImmVertex
{
    float px, py, pz;
    float nx, ny, nz;
    float r, g, b, a;
    float u, v;
};

static_assert( sizeof( ImmVertex ) == 12 * sizeof( float ), "ImmVertex must stay tightly packed" );

enum ClientArrayIndex
{
    CA_VERTEX = 0,
    CA_NORMAL,
    CA_COLOR,
    CA_TEXCOORD,
    CA_COUNT
};

struct State
{
    // --- matrix stacks ---
    GLenum                 matrixMode = GL_MODELVIEW;
    std::vector<glm::mat4> mv;   // modelview stack, top = back()
    std::vector<glm::mat4> proj; // projection stack, top = back()

    // --- immediate-mode current attributes (persist across Begin/End) ---
    glm::vec4 currentColor{ 1.0f, 1.0f, 1.0f, 1.0f };
    glm::vec3 currentNormal{ 0.0f, 0.0f, 1.0f };

    // --- FFP capabilities (tracked; never forwarded to WebGL) ---
    bool lighting = false;
    bool lightEnabled[8] = {};
    bool colorMaterial = false;
    bool texture2D = false;
    bool normalizeNormals = false;
    bool alphaTest = false;
    // Tracked only so glIsEnabled stays consistent; no rendering effect here
    // (forwarding them would raise INVALID_ENUM in WebGL2).
    bool lineSmooth = false;
    bool pointSmooth = false;
    bool multisample = false;

    // --- lighting rig / materials ---
    Light     lights[8];
    glm::vec4 lightModelAmbient{ 0.2f, 0.2f, 0.2f, 1.0f };
    bool      twoSide = false;
    Material  material; // GL_FRONT_AND_BACK only (asserted at the entry point)
    GLenum    colorMaterialMode = GL_AMBIENT_AND_DIFFUSE;

    // --- texture environment, unit 0 (GL 1.5 initial values) ---
    GLenum    texEnvMode = GL_MODULATE;
    glm::vec4 texEnvColor{ 0.0f, 0.0f, 0.0f, 0.0f };
    GLenum    combineRGB = GL_MODULATE;
    GLenum    combineAlpha = GL_MODULATE;
    GLenum    srcRGB[3] = { GL_TEXTURE, GL_PREVIOUS, GL_CONSTANT };
    GLenum    operandRGB[3] = { GL_SRC_COLOR, GL_SRC_COLOR, GL_SRC_ALPHA };
    GLenum    srcAlpha[3] = { GL_TEXTURE, GL_PREVIOUS, GL_CONSTANT };
    GLenum    operandAlpha[3] = { GL_SRC_ALPHA, GL_SRC_ALPHA, GL_SRC_ALPHA };

    // --- alpha test ---
    GLenum alphaFunc = GL_ALWAYS;
    float  alphaRef = 0.0f;

    // --- misc ---
    GLenum shadeModel = GL_SMOOTH;
    float  pointSize = 1.0f;
    float  lineWidth = 1.0f;
    GLuint boundTexture2D = 0; // mirror of the unit-0 GL_TEXTURE_2D binding

    // --- client arrays ---
    ClientArray clientArrays[CA_COUNT];

    // Nonzero while a non-shim GLSL program is bound (raytracer blit, 2D GAL):
    // routed draws pass through untouched.
    GLuint externalProgram = 0;

    // --- dirty flags (uniform re-upload gates) ---
    bool matricesDirty = true;
    bool lightingDirty = true;
    bool texEnvDirty = true;
    bool miscDirty = true;

    State()
    {
        mv.reserve( 64 );
        proj.reserve( 8 );
        mv.push_back( glm::mat4( 1.0f ) );
        proj.push_back( glm::mat4( 1.0f ) );

        lights[0].diffuse = glm::vec4( 1.0f, 1.0f, 1.0f, 1.0f );
        lights[0].specular = glm::vec4( 1.0f, 1.0f, 1.0f, 1.0f );
    }

    glm::mat4&       mvTop() { return mv.back(); }
    glm::mat4&       projTop() { return proj.back(); }
    glm::mat4&       currentTop() { return matrixMode == GL_PROJECTION ? proj.back() : mv.back(); }
    std::vector<glm::mat4>& currentStack() { return matrixMode == GL_PROJECTION ? proj : mv; }
};

State& S();

// Returns the tracked-flag slot for FFP-only glEnable/glDisable caps, or
// nullptr for caps WebGL owns natively (forward those).
bool* ffpCapSlot( GLenum cap );

// Marks the state blocks a cap flip invalidates.
void onCapChanged( GLenum cap );

// Immediate-execution state mutators shared by the __wrap_* interceptors and
// display-list replay (identical semantics, minus the recording check).
void stateEnable( GLenum cap, bool enable );
void stateBindTexture( GLenum target, GLuint texture );
void stateBlendFunc( GLenum sfactor, GLenum dfactor );
void stateLineWidth( GLfloat width );
void stateAlphaFunc( GLenum func, GLclampf ref );

// --- context-generation guard (gl1_state.cpp) ---
// GL object names live and die with the WebGL context, and the 3D viewer's
// close/reopen destroys and recreates it (~wxGLCanvas destroys the context
// with the canvas; the next open mints new ones). Called from programSync()
// ONLY: that is the single choke point every shim draw crosses, it always
// runs under the 3D context, and — critically — it is a path the 2D GAL never
// reaches, so alternating 2D/3D paints cannot ping-pong the owner (a check in
// the glBindTexture wrap did exactly that: every caller crosses a wrap).
// On a context change it drops every cached name so the shim rebuilds lazily
// in the new context. Deliberately never touches display-list or
// immediate-mode state: the change can be detected mid-scene-rebuild, and
// those modules are context-agnostic CPU state.
void contextSync();
// True when the CURRENT WebGL context is the shim's owner context (or no owner
// exists yet). The __wrap_* draw interceptors gate FFP routing on this: only
// the owner context's draws can be fixed-function traffic — a draw under any
// other context (the 2D GAL, a recreated canvas) always passes through, no
// matter what the global client-array mirror says. (gl1_state.cpp)
bool contextIsOwner();
// Per-TU cache drops invoked by contextSync() on a context change.
void shadersDropContextObjects(); // FFP program + uniform locations + fail latch
void drawDropContextObjects();    // stream/scratch VBOs

// GL1 normalized-attribute rule: integer colors and normals are normalized,
// floats are not (positions/texcoords are float-only in this codebase).
bool attribNormalized( int arrayIndex, GLenum type );

// Effective byte stride of a client array (GL stride 0 = tightly packed).
GLsizei attribEffectiveStride( GLint size, GLenum type, GLsizei stride );

// One vertex attribute's data source for an array draw: either client memory
// to be uploaded (cpuData) or a byte offset into a user VBO (buffer/offset).
struct AttribSource
{
    bool        enabled = false;
    GLint       size = 4;
    GLenum      type = GL_FLOAT;
    bool        normalized = false;
    GLsizei     stride = 0; // effective byte stride, never 0
    const void* cpuData = nullptr;
    GLuint      buffer = 0;
    GLintptr    offset = 0;
};

// --- matrix module (gl1_matrix.cpp) ---
void matrixLoadIdentity();
void matrixLoadf( const GLfloat* m );
void matrixPush();
void matrixPop();
void matrixTranslate( float x, float y, float z );
void matrixRotate( float angleDeg, float x, float y, float z );
void matrixScale( float x, float y, float z );
void matrixPerspective( double fovyDeg, double aspect, double zNear, double zFar );

// --- immediate-mode module (gl1_immediate.cpp) ---
// Also the emission path for GLU quadrics and display-list replay, so all
// geometry funnels through one primitive-conversion + draw pipeline.
void immBegin( GLenum mode );
void immVertex( float x, float y, float z );
void immEnd();
bool immActive();

// --- draw module (gl1_draw.cpp) ---
// Uploads `count` interleaved ImmVertex records to the streaming VBO and draws
// them with the FFP program. `mode` must already be a WebGL2-legal primitive.
void drawImmVertices( GLenum mode, const ImmVertex* verts, GLsizei count );
// Non-indexed draw over explicit per-attribute sources (client arrays,
// display-list snapshots). Sources are pre-rebased: vertex 0 = first vertex.
void drawArraysWithSources( GLenum mode, GLsizei count, const AttribSource aSrc[CA_COUNT] );
// Routed glDrawArrays/glDrawElements over FFP client-array state.
void drawClientArrays( GLenum mode, GLint first, GLsizei count );
void drawClientElements( GLenum mode, GLsizei count, GLenum type, const GLvoid* indices );

// --- shader module (gl1_shaders.cpp) ---
// Binds the FFP program and re-uploads whatever state is dirty. Returns false
// (once, with a console warning) if the program failed to build.
bool programSync();
GLuint programId();

// --- display-list module (gl1_dlist.cpp) ---
bool     dlistRecording();
GLuint   dlistGenLists( GLsizei range );
GLboolean dlistIsList( GLuint list );
void     dlistNewList( GLuint list, GLenum mode );
void     dlistEndList();
void     dlistCallList( GLuint list );
void     dlistDeleteLists( GLuint list, GLsizei range );
// Recording hooks (called from entry points / wrappers while recording).
void dlistRecordEnable( GLenum cap, bool enable );
void dlistRecordBindTexture( GLenum target, GLuint texture );
void dlistRecordBlendFunc( GLenum sfactor, GLenum dfactor );
void dlistRecordLineWidth( GLfloat width );
void dlistRecordAlphaFunc( GLenum func, GLclampf ref );
void dlistRecordNormal( float nx, float ny, float nz );
void dlistRecordColor( float r, float g, float b, float a );
void dlistRecordBegin( GLenum mode );
void dlistRecordVertex( float x, float y, float z );
void dlistRecordEnd();
void dlistRecordDrawArrays( GLenum mode, GLint first, GLsizei count );

} // namespace gl1

#endif // GL1_SHIM_H
