/*
 * gl1_state — the shim's GL 1.x state singleton and capability routing.
 */

#include "gl1_shim.h"

#include <emscripten.h>

namespace gl1
{

State& S()
{
    static State s;
    return s;
}


// Identity of the current WebGL context, stable for the context's lifetime and
// never reused. The EMSCRIPTEN_WEBGL_CONTEXT_HANDLE is NOT that: Emscripten
// recycles freed handle slots, so the context created after a destroy can get
// the very same numeric handle. Stamp a monotonic id on Emscripten's
// per-context record (a fresh JS object per createContext) instead.
static int currentContextId()
{
    return EM_ASM_INT( {
        var ctx = ( typeof GL !== 'undefined' ) ? GL.currentContext : null;
        if( !ctx )
            return 0;
        if( !ctx.gl1ContextId )
        {
            GL.gl1NextContextId = ( GL.gl1NextContextId | 0 ) + 1;
            ctx.gl1ContextId = GL.gl1NextContextId;
        }
        return ctx.gl1ContextId;
    } );
}


// The context generation the shim's cached GL objects belong to. 0 until the
// first contextSync() under a live context.
static int s_ownerContext = 0;

void contextSync()
{
    int cur = currentContextId();

    if( cur == s_ownerContext || cur == 0 )
        return;

    if( s_ownerContext != 0 )
    {
        // The context that owned the cached names is gone (3D viewer closed and
        // reopened). No glDelete*: the names are invalid in the current context
        // — forget them and let each module rebuild lazily.
        std::printf( "[gl1] WebGL context changed — dropping cached GL objects\n" );

        shadersDropContextObjects();
        drawDropContextObjects();

        State& s = S();
        s.boundTexture2D = 0;

        for( int i = 0; i < CA_COUNT; ++i )
            s.clientArrays[i].boundBuffer = 0;

        // The new program starts with default-initialized uniforms; force a
        // full re-upload on its first sync.
        s.matricesDirty = true;
        s.lightingDirty = true;
        s.texEnvDirty = true;
        s.miscDirty = true;
    }

    s_ownerContext = cur;
}


bool* ffpCapSlot( GLenum cap )
{
    State& s = S();

    switch( cap )
    {
    case GL_LIGHTING:       return &s.lighting;
    case GL_COLOR_MATERIAL: return &s.colorMaterial;
    case GL_TEXTURE_2D:     return &s.texture2D;
    case GL_NORMALIZE:      return &s.normalizeNormals;
    case GL_ALPHA_TEST:     return &s.alphaTest;
    // Tracked-but-inert: WebGL2 has no equivalent caps and would raise
    // INVALID_ENUM; the suite's goldens are single-sample/aliased anyway.
    case GL_LINE_SMOOTH:    return &s.lineSmooth;
    case GL_POINT_SMOOTH:   return &s.pointSmooth;
    case GL_MULTISAMPLE:    return &s.multisample;
    default:
        if( cap >= GL_LIGHT0 && cap <= GL_LIGHT7 )
            return &s.lightEnabled[cap - GL_LIGHT0];

        return nullptr; // WebGL-native cap: forward
    }
}


void onCapChanged( GLenum cap )
{
    State& s = S();

    switch( cap )
    {
    case GL_LIGHTING:
    case GL_COLOR_MATERIAL:
        s.lightingDirty = true;
        s.miscDirty = true;
        break;

    case GL_TEXTURE_2D:
    case GL_ALPHA_TEST:
        s.miscDirty = true;
        break;

    default:
        if( cap >= GL_LIGHT0 && cap <= GL_LIGHT7 )
            s.lightingDirty = true;
        break;
    }
}


void stateEnable( GLenum cap, bool enable )
{
    if( bool* slot = ffpCapSlot( cap ) )
    {
        if( *slot != enable )
        {
            *slot = enable;
            onCapChanged( cap );
        }

        return;
    }

    if( enable )
        __real_glEnable( cap );
    else
        __real_glDisable( cap );
}


void stateBindTexture( GLenum target, GLuint texture )
{
    if( target == GL_TEXTURE_2D )
        S().boundTexture2D = texture;

    __real_glBindTexture( target, texture );
}


void stateBlendFunc( GLenum sfactor, GLenum dfactor )
{
    __real_glBlendFunc( sfactor, dfactor );
}


void stateLineWidth( GLfloat width )
{
    if( width > 1.0f )
        GL1_WARN_ONCE( "glLineWidth(%g): browsers clamp line width to 1 — lines render thinner "
                       "than native (known WebGL2 limitation)", (double) width );

    S().lineWidth = width;
    __real_glLineWidth( width );
}


void stateAlphaFunc( GLenum func, GLclampf ref )
{
    State& s = S();
    s.alphaFunc = func;
    s.alphaRef = ref;
    s.miscDirty = true;
}


bool attribNormalized( int arrayIndex, GLenum type )
{
    // GL1 fixed-function semantics: integer color components map to [0,1] and
    // integer normals to [-1,1]; float data is used as-is.
    if( type == GL_FLOAT )
        return false;

    return arrayIndex == CA_COLOR || arrayIndex == CA_NORMAL;
}


static GLsizei componentSize( GLenum type )
{
    switch( type )
    {
    case GL_BYTE:
    case GL_UNSIGNED_BYTE:  return 1;
    case GL_SHORT:
    case GL_UNSIGNED_SHORT: return 2;
    case GL_FLOAT:
    default:                return 4;
    }
}


GLsizei attribEffectiveStride( GLint size, GLenum type, GLsizei stride )
{
    return stride != 0 ? stride : size * componentSize( type );
}

} // namespace gl1
