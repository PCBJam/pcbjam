/*
 * gl1_entry_wrapped — interceptors for the Emscripten-owned GL names the
 * emulator must observe. The ONLY mechanism-aware TU: both link sites pass
 * -Wl,--wrap=<sym> for every name in ../wrapped_symbols.txt, so references
 * land on __wrap_* here and __real_* resolves back to the WebGL JS library.
 * (Fallback if --wrap ever breaks: macro-remap in gal/opengl/kiglew.h — only
 * this file would change.)
 *
 * Draw routing: a glDrawArrays/glDrawElements call belongs to the FFP
 * pipeline iff GL_VERTEX_ARRAY client state is enabled — only GL1 code uses
 * glEnableClientState, while the raytracer blit and the 2D WebGL GAL drive
 * their own GLSL programs with glVertexAttribPointer and never touch client
 * state. Their draws pass through untouched.
 */

#include "gl1_shim.h"

#include <glm/gtc/type_ptr.hpp>

#include <cstring>

using namespace gl1;

extern "C"
{

void __wrap_glEnable( GLenum cap )
{
    if( dlistRecording() )
    {
        dlistRecordEnable( cap, true );
        return;
    }

    stateEnable( cap, true );
}


void __wrap_glDisable( GLenum cap )
{
    if( dlistRecording() )
    {
        dlistRecordEnable( cap, false );
        return;
    }

    stateEnable( cap, false );
}


GLboolean __wrap_glIsEnabled( GLenum cap )
{
    // glGet-class queries execute even during display-list recording.
    if( bool* slot = ffpCapSlot( cap ) )
        return *slot ? GL_TRUE : GL_FALSE;

    return __real_glIsEnabled( cap );
}


void __wrap_glGetFloatv( GLenum pname, GLfloat* params )
{
    if( pname == GL_MODELVIEW_MATRIX )
    {
        std::memcpy( params, glm::value_ptr( S().mv.back() ), 16 * sizeof( GLfloat ) );
        return;
    }

    if( pname == GL_PROJECTION_MATRIX )
    {
        std::memcpy( params, glm::value_ptr( S().proj.back() ), 16 * sizeof( GLfloat ) );
        return;
    }

    __real_glGetFloatv( pname, params );
}


void __wrap_glDrawArrays( GLenum mode, GLint first, GLsizei count )
{
    // Only the shim's owner context can carry FFP traffic. A draw under any
    // other context (the 2D GAL, the raytracer blit after a canvas swap) is a
    // modern-GL consumer by definition — pass it through even if the global
    // client-array mirror was left enabled by an interrupted FFP window, and
    // even while a display list is recording (a foreign draw must never be
    // swallowed into the owner's open list).
    if( !contextIsOwner() )
    {
        __real_glDrawArrays( mode, first, count );
        return;
    }

    if( dlistRecording() )
    {
        dlistRecordDrawArrays( mode, first, count );
        return;
    }

    if( !S().clientArrays[CA_VERTEX].enabled )
    {
        // Modern-GL consumer (raytracer blit, 2D GAL, the shim itself never
        // reaches here) — pass through untouched.
        __real_glDrawArrays( mode, first, count );
        return;
    }

    drawClientArrays( mode, first, count );
}


void __wrap_glDrawElements( GLenum mode, GLsizei count, GLenum type, const GLvoid* indices )
{
    // Same owner-context gate as __wrap_glDrawArrays.
    if( !contextIsOwner() )
    {
        __real_glDrawElements( mode, count, type, indices );
        return;
    }

    if( dlistRecording() )
    {
        GL1_WARN_ONCE( "glDrawElements inside glNewList is not supported — dropped" );
        return;
    }

    if( !S().clientArrays[CA_VERTEX].enabled )
    {
        __real_glDrawElements( mode, count, type, indices );
        return;
    }

    drawClientElements( mode, count, type, indices );
}


void __wrap_glBindTexture( GLenum target, GLuint texture )
{
    // NO contextSync() here: this wrap intercepts EVERY caller, including the
    // 2D GAL binding its own textures under its own context — a check here
    // ping-pongs the owner on 2D<->3D paint alternation and thrash-rebuilds
    // the FFP program each flip (observed: 23 resets in one e2e run). The
    // boundTexture2D mirror this site feeds is write-only bookkeeping, so a
    // reset zeroing it after a new-context bind loses nothing.

    if( dlistRecording() )
    {
        dlistRecordBindTexture( target, texture );
        return;
    }

    stateBindTexture( target, texture );
}


void __wrap_glBlendFunc( GLenum sfactor, GLenum dfactor )
{
    if( dlistRecording() )
    {
        dlistRecordBlendFunc( sfactor, dfactor );
        return;
    }

    stateBlendFunc( sfactor, dfactor );
}


void __wrap_glLineWidth( GLfloat width )
{
    if( dlistRecording() )
    {
        dlistRecordLineWidth( width );
        return;
    }

    stateLineWidth( width );
}


void __wrap_glHint( GLenum target, GLenum mode )
{
    // Only the two WebGL2-legal hints pass through; the FFP hints
    // (LINE_SMOOTH_HINT, PERSPECTIVE_CORRECTION_HINT...) would raise
    // INVALID_ENUM and are swallowed.
    if( target == GL_GENERATE_MIPMAP_HINT || target == GL_FRAGMENT_SHADER_DERIVATIVE_HINT )
        __real_glHint( target, mode );
}

} // extern "C"
