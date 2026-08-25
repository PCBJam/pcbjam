/*
 * gl1_draw — draw execution: streaming immediate-mode geometry and routed
 * client-array / user-VBO draws, all through the FFP uber-program.
 *
 * VAO policy: default VAO only, all four attributes respecified per draw. The
 * renderer binds its own VBO/IBO on the default VAO (3d_model.cpp), so a shim
 * VAO would hide the user's GL_ELEMENT_ARRAY_BUFFER binding. The shim never
 * binds GL_ELEMENT_ARRAY_BUFFER itself.
 *
 * GL_ARRAY_BUFFER discipline: GL1 code assumes the binding it last set — the
 * shim saves and restores it around its own streaming uploads so a later
 * gl*Pointer call captures the app's binding, not the shim's scratch VBO.
 */

#include "gl1_shim.h"

#include <cstring>

namespace gl1
{

static GLuint s_streamVBO = 0;  // immediate-mode interleaved stream
static GLuint s_scratchVBO = 0; // client-array upload staging


void drawDropContextObjects()
{
    // The owning context is gone; the buffer names are invalid in the current
    // one. No glDeleteBuffers — just forget them so the draws re-gen lazily.
    s_streamVBO = 0;
    s_scratchVBO = 0;
}

enum
{
    ATTR_POSITION = 0,
    ATTR_NORMAL = 1,
    ATTR_COLOR = 2,
    ATTR_TEXCOORD = 3,
};


// The shim's attribute setup assumes the DEFAULT VAO (see the VAO-policy note
// above) — but a routed draw can arrive with the CALLER's VAO bound (the
// raytracer blit and the 2D GAL both bind their own VAO right before drawing,
// and their attribute 0 collides with ATTR_POSITION). Scribbling attribute
// state into that VAO corrupts the caller PERMANENTLY — the engine-toggle
// blank-viewer amplifier. Every draw executor therefore isolates itself on
// VAO 0 and restores the caller's binding afterwards.
class ScopedDefaultVAO
{
public:
    ScopedDefaultVAO()
    {
        glGetIntegerv( GL_VERTEX_ARRAY_BINDING, &m_prev );
        if( m_prev != 0 )
            glBindVertexArray( 0 );
    }
    ~ScopedDefaultVAO()
    {
        if( m_prev != 0 )
            glBindVertexArray( (GLuint) m_prev );
    }

private:
    GLint m_prev = 0;
};


void drawImmVertices( GLenum mode, const ImmVertex* verts, GLsizei count )
{
    if( !programSync() )
        return;

    ScopedDefaultVAO vaoGuard;

    if( !s_streamVBO )
        glGenBuffers( 1, &s_streamVBO );

    GLint prevArrayBuffer = 0;
    glGetIntegerv( GL_ARRAY_BUFFER_BINDING, &prevArrayBuffer );

    glBindBuffer( GL_ARRAY_BUFFER, s_streamVBO );
    glBufferData( GL_ARRAY_BUFFER, (GLsizeiptr) ( count * sizeof( ImmVertex ) ), verts,
                  GL_STREAM_DRAW );

    const GLsizei stride = (GLsizei) sizeof( ImmVertex );

    glEnableVertexAttribArray( ATTR_POSITION );
    glVertexAttribPointer( ATTR_POSITION, 3, GL_FLOAT, GL_FALSE, stride, (const void*) 0 );

    glEnableVertexAttribArray( ATTR_NORMAL );
    glVertexAttribPointer( ATTR_NORMAL, 3, GL_FLOAT, GL_FALSE, stride,
                           (const void*) ( 3 * sizeof( float ) ) );

    glEnableVertexAttribArray( ATTR_COLOR );
    glVertexAttribPointer( ATTR_COLOR, 4, GL_FLOAT, GL_FALSE, stride,
                           (const void*) ( 6 * sizeof( float ) ) );

    glDisableVertexAttribArray( ATTR_TEXCOORD );
    glVertexAttrib2f( ATTR_TEXCOORD, 0.0f, 0.0f );

    __real_glDrawArrays( mode, 0, count );

    glBindBuffer( GL_ARRAY_BUFFER, (GLuint) prevArrayBuffer );
}


// Constant (current-state) value for a disabled attribute array.
static void setConstantAttrib( int attr )
{
    const State& s = S();

    glDisableVertexAttribArray( attr );

    switch( attr )
    {
    case ATTR_NORMAL:
        glVertexAttrib3f( ATTR_NORMAL, s.currentNormal.x, s.currentNormal.y, s.currentNormal.z );
        break;

    case ATTR_COLOR:
        glVertexAttrib4f( ATTR_COLOR, s.currentColor.r, s.currentColor.g, s.currentColor.b,
                          s.currentColor.a );
        break;

    case ATTR_TEXCOORD:
        glVertexAttrib2f( ATTR_TEXCOORD, 0.0f, 0.0f );
        break;

    default:
        break;
    }
}


// Binds all four attributes from the given sources: client-memory sources are
// packed into one scratch-VBO upload; VBO-backed sources bind the user's
// buffer with the given byte offset. Restores GL_ARRAY_BUFFER when done.
static bool setupAttribSources( const AttribSource aSrc[CA_COUNT], GLsizei count )
{
    if( !aSrc[CA_VERTEX].enabled )
    {
        GL1_WARN_ONCE( "array draw without an enabled GL_VERTEX_ARRAY — dropped" );
        return false;
    }

    static std::vector<uint8_t> staging;
    staging.clear();

    GLintptr cpuOffsets[CA_COUNT] = {};
    bool     anyCpu = false;

    for( int i = 0; i < CA_COUNT; ++i )
    {
        const AttribSource& src = aSrc[i];

        if( !src.enabled || !src.cpuData )
            continue;

        anyCpu = true;

        // Whole strided block; the last vertex only needs its tight size.
        const GLsizei tight = attribEffectiveStride( src.size, src.type, 0 );
        const size_t  bytes = (size_t) ( count - 1 ) * src.stride + tight;

        // 4-byte-align each sub-range inside the scratch VBO.
        const size_t aligned = ( staging.size() + 3u ) & ~size_t( 3 );
        staging.resize( aligned + bytes );
        std::memcpy( staging.data() + aligned, src.cpuData, bytes );
        cpuOffsets[i] = (GLintptr) aligned;
    }

    if( anyCpu )
    {
        if( !s_scratchVBO )
            glGenBuffers( 1, &s_scratchVBO );

        glBindBuffer( GL_ARRAY_BUFFER, s_scratchVBO );
        glBufferData( GL_ARRAY_BUFFER, (GLsizeiptr) staging.size(), staging.data(),
                      GL_STREAM_DRAW );
    }

    static const GLint attrOf[CA_COUNT] = { ATTR_POSITION, ATTR_NORMAL, ATTR_COLOR,
                                            ATTR_TEXCOORD };

    for( int i = 0; i < CA_COUNT; ++i )
    {
        const AttribSource& src = aSrc[i];
        const GLint         attr = attrOf[i];

        if( !src.enabled )
        {
            setConstantAttrib( attr );
            continue;
        }

        if( src.cpuData )
            glBindBuffer( GL_ARRAY_BUFFER, s_scratchVBO );
        else
            glBindBuffer( GL_ARRAY_BUFFER, src.buffer );

        glEnableVertexAttribArray( attr );
        glVertexAttribPointer( attr, src.size, src.type,
                               src.normalized ? GL_TRUE : GL_FALSE, src.stride,
                               (const void*) ( src.cpuData ? cpuOffsets[i] : src.offset ) );
    }

    return true;
}


void drawArraysWithSources( GLenum mode, GLsizei count, const AttribSource aSrc[CA_COUNT] )
{
    if( count <= 0 || !programSync() )
        return;

    switch( mode )
    {
    case GL_POINTS:
    case GL_LINES:
    case GL_LINE_STRIP:
    case GL_TRIANGLES:
    case GL_TRIANGLE_STRIP:
    case GL_TRIANGLE_FAN:
        break;

    default:
        // The renderer only issues array draws with WebGL2-legal primitives
        // (GL_TRIANGLES everywhere, GL_LINES for model bboxes).
        GL1_WARN_ONCE( "array draw with unsupported primitive 0x%x — dropped", mode );
        return;
    }

    ScopedDefaultVAO vaoGuard;

    GLint prevArrayBuffer = 0;
    glGetIntegerv( GL_ARRAY_BUFFER_BINDING, &prevArrayBuffer );

    if( setupAttribSources( aSrc, count ) )
        __real_glDrawArrays( mode, 0, count );

    glBindBuffer( GL_ARRAY_BUFFER, (GLuint) prevArrayBuffer );
}


// Builds the per-attribute sources from the live client-array state,
// rebasing so that vertex 0 of the draw is `first`.
static void buildLiveSources( AttribSource aOut[CA_COUNT], GLint first )
{
    const State& s = S();

    for( int i = 0; i < CA_COUNT; ++i )
    {
        const ClientArray& ca = s.clientArrays[i];
        AttribSource&      src = aOut[i];

        src.enabled = ca.enabled;

        if( !ca.enabled )
            continue;

        src.size = ca.size;
        src.type = ca.type;
        src.normalized = attribNormalized( i, ca.type );
        src.stride = attribEffectiveStride( ca.size, ca.type, ca.stride );

        if( ca.boundBuffer == 0 )
        {
            src.cpuData = (const uint8_t*) ca.pointer + (size_t) first * src.stride;
        }
        else
        {
            src.cpuData = nullptr;
            src.buffer = ca.boundBuffer;
            src.offset = (GLintptr) ca.pointer + (GLintptr) first * src.stride;
        }
    }
}


void drawClientArrays( GLenum mode, GLint first, GLsizei count )
{
    AttribSource src[CA_COUNT];
    buildLiveSources( src, first );
    drawArraysWithSources( mode, count, src );
}


void drawClientElements( GLenum mode, GLsizei count, GLenum type, const GLvoid* indices )
{
    if( count <= 0 || !programSync() )
        return;

    // The renderer's indexed draws (3d_model.cpp) are always fully VBO-backed:
    // vertex attribs offset into a bound GL_ARRAY_BUFFER, indices offset into
    // a bound GL_ELEMENT_ARRAY_BUFFER. WebGL2 requires the index buffer.
    GLint ibo = 0;
    glGetIntegerv( GL_ELEMENT_ARRAY_BUFFER_BINDING, &ibo );

    if( ibo == 0 )
    {
        GL1_WARN_ONCE( "glDrawElements without a bound index buffer — dropped "
                       "(client-memory indices are not supported)" );
        return;
    }

    AttribSource src[CA_COUNT];
    buildLiveSources( src, 0 );

    for( int i = 0; i < CA_COUNT; ++i )
    {
        if( src[i].enabled && src[i].cpuData )
        {
            GL1_WARN_ONCE( "glDrawElements over client-memory vertex arrays is not supported "
                           "— dropped" );
            return;
        }
    }

    GLint prevArrayBuffer = 0;
    glGetIntegerv( GL_ARRAY_BUFFER_BINDING, &prevArrayBuffer );

    if( setupAttribSources( src, count ) )
        __real_glDrawElements( mode, count, type, indices );

    glBindBuffer( GL_ARRAY_BUFFER, (GLuint) prevArrayBuffer );
}

} // namespace gl1
