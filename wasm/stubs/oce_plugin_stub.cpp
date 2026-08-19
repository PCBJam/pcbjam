/*
 * WASM shadow of the oce 3D plugin's flat-C surface (oce3d_*) — the editor
 * build links this INSTEAD of s3d_plugin_oce (no OCC in pcbnew.wasm; see
 * docs/features/occ-split/README.md). The static plugin registry
 * (kicad/3d-viewer/3d_cache/pcbjam_static_3d_plugins.cpp) consumes exactly
 * this surface, so the plugin manager, S3D_CACHE, and the scene build compile
 * untouched — .step/.iges footprint models keep loading, their parse just runs
 * in the occ_service worker.
 *
 * oce3d_Load: the model file is already in MEMFS (materialized by
 * PCBJAM_3D::EnsureModelFile before the plugin dispatch). Ship its bytes to
 * the worker (EM_ASYNC_JS suspend — legal here: EnsureModelFile already
 * suspends on this same S3D_CACHE::load path), get back the SCENEGRAPH
 * serialized in KiCad's own binary cache format, and rebuild it with
 * S3D::ReadCache.
 *
 * Metadata (extensions/filters/versions) mirrors plugins/3d/oce/oce.cpp and
 * include/plugins/3d/3d_plugin.h so the manager's handshake and extension map
 * are identical to the real plugin's.
 */

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten.h>

#include <wx/string.h>
#include <wx/filefn.h>

#include <plugins/3dapi/ifsg_api.h>

class SCENEGRAPH;

namespace
{

// Non-Windows extension/filter lists from plugins/3d/oce/oce.cpp (FILE_DATA).
const std::vector<std::string> k_extensions = {
    "stp", "STP", "stpZ", "stpz", "STPZ", "step", "STEP", "stp.gz", "STP.GZ", "step.gz",
    "STEP.GZ", "igs", "IGS", "iges", "IGES"
};

const std::vector<std::string> k_filters = {
    "STEP (*.stp;*.STP;*.stpZ;*.stpz;*.STPZ;*.step;*.STEP;*.stp.gz;*.STP.GZ;*.step.gz;"
    "*.STEP.GZ)|*.stp;*.STP;*.stpZ;*.stpz;*.STPZ;*.step;*.STEP;*.stp.gz;*.STP.GZ;"
    "*.step.gz;*.STEP.GZ",
    "IGES (*.igs;*.IGS;*.iges;*.IGES)|*.igs;*.IGS;*.iges;*.IGES"
};

bool acceptAnyCacheTag( const char*, void* )
{
    // The cache blob just crossed the worker boundary from our own writer —
    // there is no plugin-version drift to guard against.
    return true;
}

} // namespace

// Phase E shape (docs/features/async/22 §5, K5): waits for the worker
// parse+tessellate via a token wait instead of suspending in place. The
// wait result is a malloc'd path string: the scenegraph-cache file written
// into this module's MEMFS ("" on failure). Every resolution defers to at
// least a microtask (the early-resolve contract, doc 22 §10 Phase E retry).
EM_JS( void, js_occLoadModelStart, ( int aToken, const char* aModelPath ),
{
    const modelPath = UTF8ToString( aModelPath );

    // E-8: all native work (the MEMFS cache write + the malloc'd path) runs
    // inside the scheduler's completion gate — a dead or trapped instance
    // drops the completion loudly instead of re-entering wasm, and a trap
    // inside the prepare latches the instance terminal without resolving.
    const finish = ( writeCache ) => {
        globalThis.__wxScheduler.runWaitCompletion( 'OCC model completion', aToken, () => {
            const cachePath = writeCache();
            const n = lengthBytesUTF8( cachePath ) + 1;
            const p = _malloc( n );
            stringToUTF8( cachePath, p, n );
            return p;
        } );
    };

    let req;

    try
    {
        const hook = globalThis.occService;

        if( !hook || typeof hook.request !== 'function' )
        {
            console.error( '[pcbjam-occ] loadModel: occ_service provider not installed' );
            req = Promise.resolve( null );
        }
        else
        {
            const bytes = FS.readFile( modelPath ); // Uint8Array copy — transferable
            const dot = modelPath.lastIndexOf( '.' );
            const ext = dot >= 0 ? modelPath.slice( dot + 1 ) : 'step';
            req = Promise.resolve( hook.request( { kind: 'loadModel', bytes, ext } ) );
        }
    }
    catch( e )
    {
        console.error( '[pcbjam-occ] loadModel request failed:', e );
        req = Promise.resolve( null );
    }

    req.then( ( res ) => {
        finish( () => {
            let cachePath = '';

            if( res && res.ok && res.bytes && res.bytes.length )
            {
                cachePath = '/tmp/pcbjam_occ_model_cache.3dc';
                FS.writeFile( cachePath, res.bytes );
            }
            else if( res && res.report )
            {
                console.error( '[pcbjam-occ] loadModel failed:', res.report );
            }

            return cachePath;
        } );
    } ).catch( ( e ) => {
        // The gate makes this fallback inert after a trap or shutdown — it
        // cannot repeat native work in a damaged instance.
        console.error( '[pcbjam-occ] loadModel request failed:', e );
        finish( () => '' );
    } );
} )

// Token waits live in the wx wasm port (evtloop.cpp).
extern "C" int wxWasmBeginWait( const char* aKind );
extern "C" int wxWasmYieldUntil( int aToken );


extern "C"
{

// --- class handshake (include/plugins/3d/3d_plugin.h semantics) -------------

char const* oce3d_GetKicadPluginClass( void )
{
    return "PLUGIN_3D";
}


void oce3d_GetClassVersion( unsigned char* Major, unsigned char* Minor, unsigned char* Patch,
                            unsigned char* Revision )
{
    if( Major )
        *Major = 1;

    if( Minor )
        *Minor = 0;

    if( Patch )
        *Patch = 0;

    if( Revision )
        *Revision = 0;
}


bool oce3d_CheckClassVersion( unsigned char Major, unsigned char, unsigned char, unsigned char )
{
    return Major == 1;
}


// --- plugin identity (plugins/3d/oce/oce.cpp values) -------------------------

const char* oce3d_GetKicadPluginName( void )
{
    return "PLUGIN_3D_OCE";
}


void oce3d_GetPluginVersion( unsigned char* Major, unsigned char* Minor, unsigned char* Patch,
                             unsigned char* Revision )
{
    if( Major )
        *Major = 1;

    if( Minor )
        *Minor = 4;

    if( Patch )
        *Patch = 2;

    if( Revision )
        *Revision = 0;
}


int oce3d_GetNExtensions( void )
{
    return (int) k_extensions.size();
}


char const* oce3d_GetModelExtension( int aIndex )
{
    if( aIndex < 0 || aIndex >= (int) k_extensions.size() )
        return nullptr;

    return k_extensions[aIndex].c_str();
}


int oce3d_GetNFilters( void )
{
    return (int) k_filters.size();
}


char const* oce3d_GetFileFilter( int aIndex )
{
    if( aIndex < 0 || aIndex >= (int) k_filters.size() )
        return nullptr;

    return k_filters[aIndex].c_str();
}


bool oce3d_CanRender( void )
{
    return true;
}


SCENEGRAPH* oce3d_Load( char const* aFileName )
{
    if( !aFileName )
        return nullptr;

    const int token = wxWasmBeginWait( "occ" );

    // Token 0 = the scheduler refused the wait (dead or terminal instance).
    if( token <= 0 )
        return nullptr;

    js_occLoadModelStart( token, aFileName );

    // The malloc'd path pointer rides the wait as an int32.
    char* cachePath = (char*) (uintptr_t) (uint32_t) wxWasmYieldUntil( token );

    if( !cachePath || !*cachePath )
    {
        std::free( cachePath );
        return nullptr;
    }

    // ReadCache returns the top-level SCENEGRAPH as its SGNODE base.
    SGNODE* node = S3D::ReadCache( cachePath, nullptr, &acceptAnyCacheTag );

    wxRemoveFile( wxString::FromUTF8( cachePath ) );
    std::free( cachePath );

    return reinterpret_cast<SCENEGRAPH*>( node );
}

} // extern "C"
