/*
 * gl1_shaders — the FFP uber-program (ES 3.00) and uniform synchronization.
 *
 * One program, uniform-flag branches (all dynamically uniform — cheap), no
 * variant cache: mid-frame FFP toggles (two-side in DrawCulled, texture/alpha
 * flips inside display lists) become uniform stores instead of program
 * switches.
 *
 * Lighting is computed PER-VERTEX (Gouraud) on purpose: the native goldens
 * come from a fixed-function pipeline that evaluates lighting at vertices and
 * interpolates colors — per-fragment lighting would visibly mismatch specular
 * highlights on the suite's coarse meshes.
 *
 * The GL 1.5 conventions implemented here (they are load-bearing for parity):
 *   - light GL_POSITION is pre-transformed to EYE space at glLightfv time
 *   - halfway vector H = normalize(L + (0,0,1))  (GL_LIGHT_MODEL_LOCAL_VIEWER
 *     defaults to FALSE)
 *   - no attenuation (KiCad leaves kc=1, kl=kq=0), no spotlights
 *   - single-color model: specular folds into the one color before texturing
 *   - GL_COLOR_MATERIAL(AMBIENT_AND_DIFFUSE): the per-vertex color replaces
 *     material ambient+diffuse; alpha comes from the diffuse alpha
 *   - texture COMBINE args resolve against the tracked+default state (GL 1.5
 *     initial values for the SRC/OPERAND slots KiCad never sets); PREVIOUS is
 *     the primary color at texture unit 0
 */

#include "gl1_shim.h"

#include <glm/gtc/matrix_inverse.hpp>
#include <glm/gtc/type_ptr.hpp>

namespace gl1
{

static const char* VS_SOURCE = R"(#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aTexCoord;

uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
uniform float uPointSize;

uniform bool uLighting;
uniform bool uTwoSide;
uniform bool uColorMaterial;

struct FfpLight
{
    bool enabled;
    vec4 posEye;
    vec4 ambient;
    vec4 diffuse;
    vec4 specular;
};

uniform FfpLight uLights[3];
uniform vec4  uLightModelAmbient;
uniform vec4  uMatAmbient;
uniform vec4  uMatDiffuse;
uniform vec4  uMatSpecular;
uniform vec4  uMatEmission;
uniform float uShininess;

out vec4 vFrontColor;
out vec4 vBackColor;
out vec2 vTexCoord;

vec4 lit( vec3 N, vec3 eyePos, vec4 matAmb, vec4 matDiff )
{
    vec3 c = uMatEmission.rgb + matAmb.rgb * uLightModelAmbient.rgb;

    for( int i = 0; i < 3; ++i )
    {
        if( !uLights[i].enabled )
            continue;

        vec3 L = ( uLights[i].posEye.w == 0.0 )
                         ? normalize( uLights[i].posEye.xyz )
                         : normalize( uLights[i].posEye.xyz - eyePos );

        float ndotl = max( dot( N, L ), 0.0 );

        float spec = 0.0;

        if( ndotl > 0.0 )
        {
            vec3  H = normalize( L + vec3( 0.0, 0.0, 1.0 ) );
            float ndoth = max( dot( N, H ), 0.0 );
            spec = ( uShininess > 0.0 ) ? pow( ndoth, uShininess ) : 1.0;
        }

        c += matAmb.rgb * uLights[i].ambient.rgb
           + ndotl * matDiff.rgb * uLights[i].diffuse.rgb
           + spec * uMatSpecular.rgb * uLights[i].specular.rgb;
    }

    return vec4( clamp( c, 0.0, 1.0 ), clamp( matDiff.a, 0.0, 1.0 ) );
}

void main()
{
    vec4 eye = uModelView * vec4( aPosition, 1.0 );

    vTexCoord = aTexCoord;
    gl_PointSize = uPointSize;
    gl_Position = uProjection * eye;

    if( uLighting )
    {
        vec3 N = normalize( uNormalMatrix * aNormal );
        vec4 matAmb = uColorMaterial ? aColor : uMatAmbient;
        vec4 matDiff = uColorMaterial ? aColor : uMatDiffuse;

        vFrontColor = lit( N, eye.xyz, matAmb, matDiff );
        vBackColor = uTwoSide ? lit( -N, eye.xyz, matAmb, matDiff ) : vFrontColor;
    }
    else
    {
        vFrontColor = clamp( aColor, 0.0, 1.0 );
        vBackColor = vFrontColor;
    }
}
)";

static const char* FS_SOURCE = R"(#version 300 es
precision highp float;

in vec4 vFrontColor;
in vec4 vBackColor;
in vec2 vTexCoord;

uniform bool      uTexEnabled;
uniform int       uTexEnvMode; // 0=MODULATE, 1=COMBINE
uniform sampler2D uTex0;
uniform vec4      uTexEnvColor;

// COMBINE argument selectors: src 0=TEXTURE 1=CONSTANT 2=PRIMARY 3=PREVIOUS;
// RGB op 0=SRC_COLOR 1=ONE_MINUS_SRC_COLOR 2=SRC_ALPHA 3=ONE_MINUS_SRC_ALPHA;
// alpha op 0=SRC_ALPHA 1=ONE_MINUS_SRC_ALPHA;
// func 0=MODULATE 1=INTERPOLATE 2=REPLACE.
uniform int   uCombineFuncRGB;
uniform int   uCombineFuncA;
uniform ivec3 uCombineSrcRGB;
uniform ivec3 uCombineOpRGB;
uniform ivec3 uCombineSrcA;
uniform ivec3 uCombineOpA;

uniform bool  uAlphaTest;
uniform int   uAlphaFunc; // GL func - GL_NEVER, i.e. 0..7
uniform float uAlphaRef;

out vec4 fragColor;

vec4 combineSource( int src, vec4 tex, vec4 primary )
{
    if( src == 0 )
        return tex;
    if( src == 1 )
        return uTexEnvColor;

    return primary; // PRIMARY, and PREVIOUS == primary at unit 0
}

vec3 combineArgRGB( int src, int op, vec4 tex, vec4 primary )
{
    vec4 s = combineSource( src, tex, primary );

    if( op == 0 )
        return s.rgb;
    if( op == 1 )
        return vec3( 1.0 ) - s.rgb;
    if( op == 2 )
        return vec3( s.a );

    return vec3( 1.0 - s.a );
}

float combineArgA( int src, int op, vec4 tex, vec4 primary )
{
    vec4 s = combineSource( src, tex, primary );

    return ( op == 0 ) ? s.a : 1.0 - s.a;
}

void main()
{
    vec4 c = gl_FrontFacing ? vFrontColor : vBackColor;

    if( uTexEnabled )
    {
        vec4 t = texture( uTex0, vTexCoord );

        if( uTexEnvMode == 0 )
        {
            c = c * t;
        }
        else
        {
            vec3 a0 = combineArgRGB( uCombineSrcRGB.x, uCombineOpRGB.x, t, c );
            vec3 a1 = combineArgRGB( uCombineSrcRGB.y, uCombineOpRGB.y, t, c );
            vec3 a2 = combineArgRGB( uCombineSrcRGB.z, uCombineOpRGB.z, t, c );

            vec3 rgb;

            if( uCombineFuncRGB == 0 )
                rgb = a0 * a1;
            else if( uCombineFuncRGB == 1 )
                rgb = a0 * a2 + a1 * ( vec3( 1.0 ) - a2 );
            else
                rgb = a0;

            float b0 = combineArgA( uCombineSrcA.x, uCombineOpA.x, t, c );
            float b1 = combineArgA( uCombineSrcA.y, uCombineOpA.y, t, c );
            float b2 = combineArgA( uCombineSrcA.z, uCombineOpA.z, t, c );

            float alpha;

            if( uCombineFuncA == 0 )
                alpha = b0 * b1;
            else if( uCombineFuncA == 1 )
                alpha = b0 * b2 + b1 * ( 1.0 - b2 );
            else
                alpha = b0;

            c = clamp( vec4( rgb, alpha ), 0.0, 1.0 );
        }
    }

    if( uAlphaTest )
    {
        bool pass;

        if( uAlphaFunc == 0 )      pass = false;            // NEVER
        else if( uAlphaFunc == 1 ) pass = c.a < uAlphaRef;  // LESS
        else if( uAlphaFunc == 2 ) pass = c.a == uAlphaRef; // EQUAL
        else if( uAlphaFunc == 3 ) pass = c.a <= uAlphaRef; // LEQUAL
        else if( uAlphaFunc == 4 ) pass = c.a > uAlphaRef;  // GREATER
        else if( uAlphaFunc == 5 ) pass = c.a != uAlphaRef; // NOTEQUAL
        else if( uAlphaFunc == 6 ) pass = c.a >= uAlphaRef; // GEQUAL
        else                       pass = true;             // ALWAYS

        if( !pass )
            discard;
    }

    fragColor = c;
}
)";


struct LightLocs
{
    GLint enabled = -1;
    GLint posEye = -1;
    GLint ambient = -1;
    GLint diffuse = -1;
    GLint specular = -1;
};

struct ProgramLocs
{
    GLint modelView = -1;
    GLint projection = -1;
    GLint normalMatrix = -1;
    GLint pointSize = -1;

    GLint lighting = -1;
    GLint twoSide = -1;
    GLint colorMaterial = -1;
    LightLocs lights[3];
    GLint lightModelAmbient = -1;
    GLint matAmbient = -1;
    GLint matDiffuse = -1;
    GLint matSpecular = -1;
    GLint matEmission = -1;
    GLint shininess = -1;

    GLint texEnabled = -1;
    GLint texEnvMode = -1;
    GLint tex0 = -1;
    GLint texEnvColor = -1;
    GLint combineFuncRGB = -1;
    GLint combineFuncA = -1;
    GLint combineSrcRGB = -1;
    GLint combineOpRGB = -1;
    GLint combineSrcA = -1;
    GLint combineOpA = -1;

    GLint alphaTest = -1;
    GLint alphaFunc = -1;
    GLint alphaRef = -1;
};

static GLuint      s_program = 0;
static bool        s_buildFailed = false;
static ProgramLocs s_locs;


void shadersDropContextObjects()
{
    // The owning context is gone; the program name is invalid in the current
    // one. No glDeleteProgram — just forget it so programSync() rebuilds.
    // The fail latch resets too: a fresh context gets a fresh build attempt.
    s_program = 0;
    s_buildFailed = false;
    s_locs = ProgramLocs();
}


static GLuint compileShader( GLenum type, const char* source )
{
    GLuint shader = glCreateShader( type );
    glShaderSource( shader, 1, &source, nullptr );
    glCompileShader( shader );

    GLint ok = GL_FALSE;
    glGetShaderiv( shader, GL_COMPILE_STATUS, &ok );

    if( !ok )
    {
        char log[1024] = {};
        glGetShaderInfoLog( shader, sizeof( log ) - 1, nullptr, log );
        std::fprintf( stderr, "[gl1] %s shader compile failed:\n%s\n",
                      type == GL_VERTEX_SHADER ? "vertex" : "fragment", log );
        glDeleteShader( shader );
        return 0;
    }

    return shader;
}


static bool buildProgram()
{
    GLuint vs = compileShader( GL_VERTEX_SHADER, VS_SOURCE );
    GLuint fs = compileShader( GL_FRAGMENT_SHADER, FS_SOURCE );

    if( !vs || !fs )
        return false;

    GLuint prog = glCreateProgram();
    glAttachShader( prog, vs );
    glAttachShader( prog, fs );
    glLinkProgram( prog );
    glDeleteShader( vs );
    glDeleteShader( fs );

    GLint ok = GL_FALSE;
    glGetProgramiv( prog, GL_LINK_STATUS, &ok );

    if( !ok )
    {
        char log[1024] = {};
        glGetProgramInfoLog( prog, sizeof( log ) - 1, nullptr, log );
        std::fprintf( stderr, "[gl1] program link failed:\n%s\n", log );
        glDeleteProgram( prog );
        return false;
    }

    s_program = prog;

    ProgramLocs& l = s_locs;
    l.modelView = glGetUniformLocation( prog, "uModelView" );
    l.projection = glGetUniformLocation( prog, "uProjection" );
    l.normalMatrix = glGetUniformLocation( prog, "uNormalMatrix" );
    l.pointSize = glGetUniformLocation( prog, "uPointSize" );

    l.lighting = glGetUniformLocation( prog, "uLighting" );
    l.twoSide = glGetUniformLocation( prog, "uTwoSide" );
    l.colorMaterial = glGetUniformLocation( prog, "uColorMaterial" );

    for( int i = 0; i < 3; ++i )
    {
        char name[48];
        std::snprintf( name, sizeof( name ), "uLights[%d].enabled", i );
        l.lights[i].enabled = glGetUniformLocation( prog, name );
        std::snprintf( name, sizeof( name ), "uLights[%d].posEye", i );
        l.lights[i].posEye = glGetUniformLocation( prog, name );
        std::snprintf( name, sizeof( name ), "uLights[%d].ambient", i );
        l.lights[i].ambient = glGetUniformLocation( prog, name );
        std::snprintf( name, sizeof( name ), "uLights[%d].diffuse", i );
        l.lights[i].diffuse = glGetUniformLocation( prog, name );
        std::snprintf( name, sizeof( name ), "uLights[%d].specular", i );
        l.lights[i].specular = glGetUniformLocation( prog, name );
    }

    l.lightModelAmbient = glGetUniformLocation( prog, "uLightModelAmbient" );
    l.matAmbient = glGetUniformLocation( prog, "uMatAmbient" );
    l.matDiffuse = glGetUniformLocation( prog, "uMatDiffuse" );
    l.matSpecular = glGetUniformLocation( prog, "uMatSpecular" );
    l.matEmission = glGetUniformLocation( prog, "uMatEmission" );
    l.shininess = glGetUniformLocation( prog, "uShininess" );

    l.texEnabled = glGetUniformLocation( prog, "uTexEnabled" );
    l.texEnvMode = glGetUniformLocation( prog, "uTexEnvMode" );
    l.tex0 = glGetUniformLocation( prog, "uTex0" );
    l.texEnvColor = glGetUniformLocation( prog, "uTexEnvColor" );
    l.combineFuncRGB = glGetUniformLocation( prog, "uCombineFuncRGB" );
    l.combineFuncA = glGetUniformLocation( prog, "uCombineFuncA" );
    l.combineSrcRGB = glGetUniformLocation( prog, "uCombineSrcRGB" );
    l.combineOpRGB = glGetUniformLocation( prog, "uCombineOpRGB" );
    l.combineSrcA = glGetUniformLocation( prog, "uCombineSrcA" );
    l.combineOpA = glGetUniformLocation( prog, "uCombineOpA" );

    l.alphaTest = glGetUniformLocation( prog, "uAlphaTest" );
    l.alphaFunc = glGetUniformLocation( prog, "uAlphaFunc" );
    l.alphaRef = glGetUniformLocation( prog, "uAlphaRef" );

    // The FFP surface only ever uses texture unit 0 (asserted at
    // glClientActiveTexture); bind the sampler once. glUseProgram is not a
    // wrapped symbol (draw routing keys on client-array state instead), so
    // this is the real WebGL entry point.
    glUseProgram( prog );
    glUniform1i( l.tex0, 0 );

    return true;
}


GLuint programId()
{
    return s_program;
}


static int encodeCombineSrc( GLenum src )
{
    switch( src )
    {
    case GL_TEXTURE:       return 0;
    case GL_CONSTANT:      return 1;
    case GL_PRIMARY_COLOR: return 2;
    case GL_PREVIOUS:      return 3;
    default:
        GL1_WARN_ONCE( "unsupported COMBINE source 0x%x", src );
        return 3;
    }
}


static int encodeCombineOpRGB( GLenum op )
{
    switch( op )
    {
    case GL_SRC_COLOR:           return 0;
    case GL_ONE_MINUS_SRC_COLOR: return 1;
    case GL_SRC_ALPHA:           return 2;
    case GL_ONE_MINUS_SRC_ALPHA: return 3;
    default:
        GL1_WARN_ONCE( "unsupported COMBINE RGB operand 0x%x", op );
        return 0;
    }
}


static int encodeCombineOpA( GLenum op )
{
    switch( op )
    {
    case GL_SRC_ALPHA:           return 0;
    case GL_ONE_MINUS_SRC_ALPHA: return 1;
    default:
        GL1_WARN_ONCE( "unsupported COMBINE alpha operand 0x%x", op );
        return 0;
    }
}


static int encodeCombineFunc( GLenum func )
{
    switch( func )
    {
    case GL_MODULATE:    return 0;
    case GL_INTERPOLATE: return 1;
    case GL_REPLACE:     return 2;
    default:
        GL1_WARN_ONCE( "unsupported COMBINE function 0x%x", func );
        return 0;
    }
}


bool programSync()
{
    // Every shim draw funnels through here, so this is the single choke point
    // where a recreated WebGL context (3D viewer close/reopen) gets detected
    // before any cached GL name is used.
    contextSync();

    if( s_buildFailed )
        return false;

    if( !s_program )
    {
        if( !buildProgram() )
        {
            s_buildFailed = true;
            GL1_WARN_ONCE( "FFP program build failed — shim draws disabled" );
            return false;
        }

        // First build: force a full upload.
        State& s0 = S();
        s0.matricesDirty = true;
        s0.lightingDirty = true;
        s0.texEnvDirty = true;
        s0.miscDirty = true;
    }

    State&             s = S();
    const ProgramLocs& l = s_locs;

    glUseProgram( s_program );

    if( s.matricesDirty )
    {
        s.matricesDirty = false;

        const glm::mat4& mv = s.mv.back();
        glUniformMatrix4fv( l.modelView, 1, GL_FALSE, glm::value_ptr( mv ) );
        glUniformMatrix4fv( l.projection, 1, GL_FALSE, glm::value_ptr( s.proj.back() ) );

        const glm::mat3 nm = glm::inverseTranspose( glm::mat3( mv ) );
        glUniformMatrix3fv( l.normalMatrix, 1, GL_FALSE, glm::value_ptr( nm ) );
    }

    if( s.lightingDirty )
    {
        s.lightingDirty = false;

        glUniform1i( l.lighting, s.lighting ? 1 : 0 );
        glUniform1i( l.twoSide, s.twoSide ? 1 : 0 );
        glUniform1i( l.colorMaterial, s.colorMaterial ? 1 : 0 );

        for( int i = 0; i < 3; ++i )
        {
            const Light& lt = s.lights[i];
            glUniform1i( l.lights[i].enabled, s.lightEnabled[i] ? 1 : 0 );
            glUniform4fv( l.lights[i].posEye, 1, glm::value_ptr( lt.posEye ) );
            glUniform4fv( l.lights[i].ambient, 1, glm::value_ptr( lt.ambient ) );
            glUniform4fv( l.lights[i].diffuse, 1, glm::value_ptr( lt.diffuse ) );
            glUniform4fv( l.lights[i].specular, 1, glm::value_ptr( lt.specular ) );
        }

        for( int i = 3; i < 8; ++i )
        {
            if( s.lightEnabled[i] )
                GL1_WARN_ONCE( "GL_LIGHT%d enabled but the shim models only lights 0-2", i );
        }

        glUniform4fv( l.lightModelAmbient, 1, glm::value_ptr( s.lightModelAmbient ) );
        glUniform4fv( l.matAmbient, 1, glm::value_ptr( s.material.ambient ) );
        glUniform4fv( l.matDiffuse, 1, glm::value_ptr( s.material.diffuse ) );
        glUniform4fv( l.matSpecular, 1, glm::value_ptr( s.material.specular ) );
        glUniform4fv( l.matEmission, 1, glm::value_ptr( s.material.emission ) );
        glUniform1f( l.shininess, s.material.shininess );
    }

    if( s.texEnvDirty )
    {
        s.texEnvDirty = false;

        int mode = 0;

        if( s.texEnvMode == GL_MODULATE )
            mode = 0;
        else if( s.texEnvMode == GL_COMBINE )
            mode = 1;
        else
            GL1_WARN_ONCE( "unsupported GL_TEXTURE_ENV_MODE 0x%x (treated as MODULATE)",
                           s.texEnvMode );

        glUniform1i( l.texEnvMode, mode );
        glUniform4fv( l.texEnvColor, 1, glm::value_ptr( s.texEnvColor ) );

        glUniform1i( l.combineFuncRGB, encodeCombineFunc( s.combineRGB ) );
        glUniform1i( l.combineFuncA, encodeCombineFunc( s.combineAlpha ) );
        glUniform3i( l.combineSrcRGB, encodeCombineSrc( s.srcRGB[0] ),
                     encodeCombineSrc( s.srcRGB[1] ), encodeCombineSrc( s.srcRGB[2] ) );
        glUniform3i( l.combineOpRGB, encodeCombineOpRGB( s.operandRGB[0] ),
                     encodeCombineOpRGB( s.operandRGB[1] ), encodeCombineOpRGB( s.operandRGB[2] ) );
        glUniform3i( l.combineSrcA, encodeCombineSrc( s.srcAlpha[0] ),
                     encodeCombineSrc( s.srcAlpha[1] ), encodeCombineSrc( s.srcAlpha[2] ) );
        glUniform3i( l.combineOpA, encodeCombineOpA( s.operandAlpha[0] ),
                     encodeCombineOpA( s.operandAlpha[1] ), encodeCombineOpA( s.operandAlpha[2] ) );
    }

    if( s.miscDirty )
    {
        s.miscDirty = false;

        glUniform1i( l.texEnabled, s.texture2D ? 1 : 0 );
        glUniform1i( l.alphaTest, s.alphaTest ? 1 : 0 );
        glUniform1i( l.alphaFunc, (int) ( s.alphaFunc - GL_NEVER ) );
        glUniform1f( l.alphaRef, s.alphaRef );
        glUniform1f( l.pointSize, s.pointSize );
    }

    return true;
}

} // namespace gl1
