/*
 * gl1_entry_ffp — the 52 public FFP entry points the shim owns.
 *
 * These are the GL 1.x names absent from Emscripten's WebGL2 library (the
 * exact surface wasm/stubs/gl_ffp_stub.c used to no-op). Signatures match
 * Emscripten's <GL/gl.h> / the project's <GL/glu.h> (GLU lives in gl1_glu.cpp).
 *
 * Per the GL_COMPILE contract, listable calls funnel into the display-list
 * recorder while recording instead of executing; client-array state calls,
 * glGenLists/glIsList/glDeleteLists and glGet* always execute immediately.
 * Listable calls the renderer never records (matrix, lighting, texenv...)
 * warn once and drop while recording rather than silently corrupting state.
 */

#include "gl1_shim.h"

#include <glm/gtc/type_ptr.hpp>

using namespace gl1;

// Guard for listable entry points that the recorder intentionally does not
// support because the renderer never records them.
#define GL1_UNRECORDED( name )                                                        \
    if( dlistRecording() )                                                            \
    {                                                                                 \
        GL1_WARN_ONCE( name " inside glNewList is not supported — call dropped" );    \
        return;                                                                       \
    }

extern "C"
{

// ---- Immediate mode ----------------------------------------------------

void glBegin( GLenum mode )
{
    if( dlistRecording() )
    {
        dlistRecordBegin( mode );
        return;
    }

    immBegin( mode );
}


void glEnd( void )
{
    if( dlistRecording() )
    {
        dlistRecordEnd();
        return;
    }

    immEnd();
}


void glVertex2f( GLfloat x, GLfloat y )
{
    if( dlistRecording() )
    {
        dlistRecordVertex( x, y, 0.0f );
        return;
    }

    immVertex( x, y, 0.0f );
}


void glVertex3f( GLfloat x, GLfloat y, GLfloat z )
{
    if( dlistRecording() )
    {
        dlistRecordVertex( x, y, z );
        return;
    }

    immVertex( x, y, z );
}


void glVertex3d( GLdouble x, GLdouble y, GLdouble z )
{
    glVertex3f( (GLfloat) x, (GLfloat) y, (GLfloat) z );
}


void glNormal3f( GLfloat nx, GLfloat ny, GLfloat nz )
{
    if( dlistRecording() )
    {
        dlistRecordNormal( nx, ny, nz );
        return;
    }

    S().currentNormal = glm::vec3( nx, ny, nz );
}


void glColor3f( GLfloat r, GLfloat g, GLfloat b )
{
    if( dlistRecording() )
    {
        dlistRecordColor( r, g, b, 1.0f );
        return;
    }

    S().currentColor = glm::vec4( r, g, b, 1.0f );
}


void glColor4f( GLfloat r, GLfloat g, GLfloat b, GLfloat a )
{
    if( dlistRecording() )
    {
        dlistRecordColor( r, g, b, a );
        return;
    }

    S().currentColor = glm::vec4( r, g, b, a );
}


// ---- Display lists ------------------------------------------------------

GLuint glGenLists( GLsizei range )
{
    return dlistGenLists( range );
}


void glNewList( GLuint list, GLenum mode )
{
    dlistNewList( list, mode );
}


void glEndList( void )
{
    dlistEndList();
}


void glCallList( GLuint list )
{
    if( dlistRecording() )
    {
        GL1_WARN_ONCE( "nested glCallList inside glNewList is not supported — dropped" );
        return;
    }

    dlistCallList( list );
}


void glDeleteLists( GLuint list, GLsizei range )
{
    dlistDeleteLists( list, range );
}


GLboolean glIsList( GLuint list )
{
    return dlistIsList( list );
}


// ---- Matrix stack --------------------------------------------------------

void glMatrixMode( GLenum mode )
{
    GL1_UNRECORDED( "glMatrixMode" );

    if( mode != GL_MODELVIEW && mode != GL_PROJECTION )
    {
        GL1_WARN_ONCE( "glMatrixMode: unsupported mode 0x%x (only MODELVIEW/PROJECTION)", mode );
        return;
    }

    S().matrixMode = mode;
}


void glLoadIdentity( void )
{
    GL1_UNRECORDED( "glLoadIdentity" );
    matrixLoadIdentity();
}


void glLoadMatrixf( const GLfloat* m )
{
    GL1_UNRECORDED( "glLoadMatrixf" );
    matrixLoadf( m );
}


void glPushMatrix( void )
{
    GL1_UNRECORDED( "glPushMatrix" );
    matrixPush();
}


void glPopMatrix( void )
{
    GL1_UNRECORDED( "glPopMatrix" );
    matrixPop();
}


void glTranslatef( GLfloat x, GLfloat y, GLfloat z )
{
    GL1_UNRECORDED( "glTranslatef" );
    matrixTranslate( x, y, z );
}


void glRotatef( GLfloat angle, GLfloat x, GLfloat y, GLfloat z )
{
    GL1_UNRECORDED( "glRotatef" );
    matrixRotate( angle, x, y, z );
}


void glScalef( GLfloat x, GLfloat y, GLfloat z )
{
    GL1_UNRECORDED( "glScalef" );
    matrixScale( x, y, z );
}


void glScaled( GLdouble x, GLdouble y, GLdouble z )
{
    GL1_UNRECORDED( "glScaled" );
    matrixScale( (float) x, (float) y, (float) z );
}


// ---- Fixed-function lighting / material ----------------------------------

void glShadeModel( GLenum mode )
{
    GL1_UNRECORDED( "glShadeModel" );

    if( mode != GL_SMOOTH )
        GL1_WARN_ONCE( "glShadeModel: only GL_SMOOTH is supported (got 0x%x)", mode );

    S().shadeModel = mode;
}


void glLightfv( GLenum light, GLenum pname, const GLfloat* params )
{
    GL1_UNRECORDED( "glLightfv" );

    if( light < GL_LIGHT0 || light > GL_LIGHT7 )
        return;

    State& s = S();
    Light& l = s.lights[light - GL_LIGHT0];

    switch( pname )
    {
    case GL_AMBIENT:
        l.ambient = glm::make_vec4( params );
        break;

    case GL_DIFFUSE:
        l.diffuse = glm::make_vec4( params );
        break;

    case GL_SPECULAR:
        l.specular = glm::make_vec4( params );
        break;

    case GL_POSITION:
        // GL 1.x: the position is transformed by the modelview matrix current
        // AT THIS CALL and stored in eye coordinates. init_lights() runs under
        // an identity modelview (directional lights anchored in eye space);
        // the per-frame headlight is set under the camera view matrix.
        l.posEye = s.mv.back() * glm::make_vec4( params );
        break;

    default:
        GL1_WARN_ONCE( "glLightfv: unsupported pname 0x%x", pname );
        return;
    }

    s.lightingDirty = true;
}


void glLightModeli( GLenum pname, GLint param )
{
    GL1_UNRECORDED( "glLightModeli" );

    if( pname == GL_LIGHT_MODEL_TWO_SIDE )
    {
        S().twoSide = ( param != 0 );
        S().lightingDirty = true;
    }
    else
    {
        GL1_WARN_ONCE( "glLightModeli: unsupported pname 0x%x", pname );
    }
}


void glLightModelfv( GLenum pname, const GLfloat* params )
{
    GL1_UNRECORDED( "glLightModelfv" );

    if( pname == GL_LIGHT_MODEL_AMBIENT )
    {
        S().lightModelAmbient = glm::make_vec4( params );
        S().lightingDirty = true;
    }
    else
    {
        GL1_WARN_ONCE( "glLightModelfv: unsupported pname 0x%x", pname );
    }
}


void glMaterialf( GLenum face, GLenum pname, GLfloat param )
{
    GL1_UNRECORDED( "glMaterialf" );

    if( face != GL_FRONT_AND_BACK )
        GL1_WARN_ONCE( "glMaterialf: only GL_FRONT_AND_BACK is supported (got 0x%x)", face );

    if( pname == GL_SHININESS )
    {
        S().material.shininess = param;
        S().lightingDirty = true;
    }
    else
    {
        GL1_WARN_ONCE( "glMaterialf: unsupported pname 0x%x", pname );
    }
}


void glMaterialfv( GLenum face, GLenum pname, const GLfloat* params )
{
    GL1_UNRECORDED( "glMaterialfv" );

    if( face != GL_FRONT_AND_BACK )
        GL1_WARN_ONCE( "glMaterialfv: only GL_FRONT_AND_BACK is supported (got 0x%x)", face );

    State& s = S();

    switch( pname )
    {
    case GL_AMBIENT:
        s.material.ambient = glm::make_vec4( params );
        break;

    case GL_DIFFUSE:
        s.material.diffuse = glm::make_vec4( params );
        break;

    case GL_AMBIENT_AND_DIFFUSE:
        s.material.ambient = glm::make_vec4( params );
        s.material.diffuse = glm::make_vec4( params );
        break;

    case GL_SPECULAR:
        s.material.specular = glm::make_vec4( params );
        break;

    case GL_EMISSION:
        s.material.emission = glm::make_vec4( params );
        break;

    case GL_SHININESS:
        s.material.shininess = params[0];
        break;

    default:
        GL1_WARN_ONCE( "glMaterialfv: unsupported pname 0x%x", pname );
        return;
    }

    s.lightingDirty = true;
}


void glColorMaterial( GLenum face, GLenum mode )
{
    GL1_UNRECORDED( "glColorMaterial" );

    if( face != GL_FRONT_AND_BACK || mode != GL_AMBIENT_AND_DIFFUSE )
    {
        GL1_WARN_ONCE( "glColorMaterial: only (GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE) is "
                       "supported (got 0x%x, 0x%x)", face, mode );
    }

    S().colorMaterialMode = mode;
    S().lightingDirty = true;
}


// ---- Client-state vertex arrays (always execute, even while recording) ----

static ClientArray* clientArraySlot( GLenum cap )
{
    // FFP client-state mutation is the earliest signal that fixed-function
    // code is working in the CURRENT context — adopt/refresh ownership here,
    // BEFORE the mutation lands in the mirror. This is what moves ownership
    // to a recreated 3D context (its scene rebuild calls gl*Pointer /
    // glEnableClientState long before its first draw), and what guarantees a
    // context change wipes stale client-array state before new state is
    // recorded. Only FFP callers reach these names; the 2D GAL never does.
    contextSync();

    State& s = S();

    switch( cap )
    {
    case GL_VERTEX_ARRAY:        return &s.clientArrays[CA_VERTEX];
    case GL_NORMAL_ARRAY:        return &s.clientArrays[CA_NORMAL];
    case GL_COLOR_ARRAY:         return &s.clientArrays[CA_COLOR];
    case GL_TEXTURE_COORD_ARRAY: return &s.clientArrays[CA_TEXCOORD];
    default:
        GL1_WARN_ONCE( "unsupported client-state cap 0x%x", cap );
        return nullptr;
    }
}


void glEnableClientState( GLenum cap )
{
    if( ClientArray* a = clientArraySlot( cap ) )
        a->enabled = true;
}


void glDisableClientState( GLenum cap )
{
    if( ClientArray* a = clientArraySlot( cap ) )
        a->enabled = false;
}


void glClientActiveTexture( GLenum texture )
{
    if( texture != GL_TEXTURE0 )
        GL1_WARN_ONCE( "glClientActiveTexture: only GL_TEXTURE0 is supported (got 0x%x)",
                       texture );
}


// GL1 semantics: gl*Pointer captures the GL_ARRAY_BUFFER binding current at
// the call (0 = client memory, nonzero = byte offset into that VBO).
static GLuint currentArrayBufferBinding()
{
    GLint binding = 0;
    glGetIntegerv( GL_ARRAY_BUFFER_BINDING, &binding );
    return (GLuint) binding;
}


void glVertexPointer( GLint size, GLenum type, GLsizei stride, const GLvoid* ptr )
{
    contextSync(); // see clientArraySlot()
    ClientArray& a = S().clientArrays[CA_VERTEX];
    a.size = size;
    a.type = type;
    a.stride = stride;
    a.pointer = ptr;
    a.boundBuffer = currentArrayBufferBinding();
}


void glNormalPointer( GLenum type, GLsizei stride, const GLvoid* ptr )
{
    ClientArray& a = S().clientArrays[CA_NORMAL];
    a.size = 3;
    a.type = type;
    a.stride = stride;
    a.pointer = ptr;
    a.boundBuffer = currentArrayBufferBinding();
}


void glColorPointer( GLint size, GLenum type, GLsizei stride, const GLvoid* ptr )
{
    ClientArray& a = S().clientArrays[CA_COLOR];
    a.size = size;
    a.type = type;
    a.stride = stride;
    a.pointer = ptr;
    a.boundBuffer = currentArrayBufferBinding();
}


void glTexCoordPointer( GLint size, GLenum type, GLsizei stride, const GLvoid* ptr )
{
    ClientArray& a = S().clientArrays[CA_TEXCOORD];
    a.size = size;
    a.type = type;
    a.stride = stride;
    a.pointer = ptr;
    a.boundBuffer = currentArrayBufferBinding();
}


// ---- Fixed-function texture environment -----------------------------------

static void texEnvSet( GLenum pname, GLenum param )
{
    State& s = S();

    switch( pname )
    {
    case GL_TEXTURE_ENV_MODE: s.texEnvMode = param; break;
    case GL_COMBINE_RGB:      s.combineRGB = param; break;
    case GL_COMBINE_ALPHA:    s.combineAlpha = param; break;
    case GL_SRC0_RGB:         s.srcRGB[0] = param; break;
    case GL_SRC1_RGB:         s.srcRGB[1] = param; break;
    case GL_SRC2_RGB:         s.srcRGB[2] = param; break;
    case GL_OPERAND0_RGB:     s.operandRGB[0] = param; break;
    case GL_OPERAND1_RGB:     s.operandRGB[1] = param; break;
    case GL_OPERAND2_RGB:     s.operandRGB[2] = param; break;
    case GL_SRC0_ALPHA:       s.srcAlpha[0] = param; break;
    case GL_SRC1_ALPHA:       s.srcAlpha[1] = param; break;
    case GL_SRC2_ALPHA:       s.srcAlpha[2] = param; break;
    case GL_OPERAND0_ALPHA:   s.operandAlpha[0] = param; break;
    case GL_OPERAND1_ALPHA:   s.operandAlpha[1] = param; break;
    case GL_OPERAND2_ALPHA:   s.operandAlpha[2] = param; break;
    default:
        GL1_WARN_ONCE( "glTexEnv: unsupported pname 0x%x", pname );
        return;
    }

    s.texEnvDirty = true;
}


void glTexEnvi( GLenum target, GLenum pname, GLint param )
{
    GL1_UNRECORDED( "glTexEnvi" );

    if( target != GL_TEXTURE_ENV )
    {
        GL1_WARN_ONCE( "glTexEnvi: unsupported target 0x%x", target );
        return;
    }

    texEnvSet( pname, (GLenum) param );
}


void glTexEnvf( GLenum target, GLenum pname, GLfloat param )
{
    GL1_UNRECORDED( "glTexEnvf" );

    if( target != GL_TEXTURE_ENV )
    {
        GL1_WARN_ONCE( "glTexEnvf: unsupported target 0x%x", target );
        return;
    }

    texEnvSet( pname, (GLenum) param );
}


void glTexEnvfv( GLenum target, GLenum pname, const GLfloat* params )
{
    GL1_UNRECORDED( "glTexEnvfv" );

    if( target != GL_TEXTURE_ENV )
    {
        GL1_WARN_ONCE( "glTexEnvfv: unsupported target 0x%x", target );
        return;
    }

    if( pname == GL_TEXTURE_ENV_COLOR )
    {
        S().texEnvColor = glm::make_vec4( params );
        S().texEnvDirty = true;
    }
    else
    {
        texEnvSet( pname, (GLenum) params[0] );
    }
}


// ---- Misc fixed-function state absent from GLES3 ---------------------------

void glAlphaFunc( GLenum func, GLclampf ref )
{
    if( dlistRecording() )
    {
        dlistRecordAlphaFunc( func, ref );
        return;
    }

    stateAlphaFunc( func, ref );
}


void glPolygonMode( GLenum face, GLenum mode )
{
    GL1_UNRECORDED( "glPolygonMode" );
    (void) face;

    if( mode != GL_FILL )
        GL1_WARN_ONCE( "glPolygonMode: only GL_FILL is supported (got 0x%x)", mode );
}


void glClearDepth( GLclampd depth )
{
    GL1_UNRECORDED( "glClearDepth" );
    glClearDepthf( (GLclampf) depth );
}


void glPointSize( GLfloat size )
{
    GL1_UNRECORDED( "glPointSize" );
    S().pointSize = size;
    S().miscDirty = true;
}

} // extern "C"
