/*
 * occ_service — the OpenCASCADE 3D service for the browser build.
 *
 * A standalone WebAssembly module (own emscripten instance + memory) meant to
 * run in a dedicated Web Worker, so the editor can drop its OCC link entirely
 * (docs/features/occ-split/README.md). pcbnew reaches it through a postMessage
 * RPC; this module never suspends, so it builds without JSPI.
 *
 * Two embind entry points, both batch/synchronous:
 *   occExport(boardSexpr, paramsJson, models) -> { ok, report, fileName, bytes }
 *       Parse the board text (KICAD_SEXP), map the official JOB_EXPORT_PCB_3D
 *       JSON onto EXPORTER_STEP_PARAMS (the pcbnew_jobs_handler mapping) and
 *       run EXPORTER_STEP — STEP/STEPZ/BREP/XAO/GLB/PLY/STL out. `models` is
 *       an array of { path, bytes } lib model bodies the host prefetched for
 *       this board (R2/IDB via the editor's models-bridge); they are staged
 *       under the shared MEMFS model root so the exporter's staged-model
 *       probe (pcbjam_model_fetch.h FindStagedModel) resolves them, and
 *       removed again after the export.
 *   occLoadModel(bytes, ext) -> { ok, report, bytes }
 *       Feed a STEP/IGES model to the (statically linked) oce plugin loader
 *       and return the resulting SCENEGRAPH serialized with S3D::WriteCache —
 *       pcbnew's import shadow rebuilds it with S3D::ReadCache.
 *
 * main() runs once at module boot (default INVOKE_RUN; -sEXIT_RUNTIME=0 keeps
 * the runtime alive afterwards) and brings up wxBase + a minimal PGM the
 * kicad-cli way (SetPgm + InitPgm(headless)) — EXPORTER_STEP's
 * FILENAME_RESOLVER calls Pgm() unconditionally (exporter_step.cpp:154).
 * Settings land in the in-memory wxConfig store from occ_service_pre.js.
 */

#include <cstdio>
#include <string>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <wx/init.h>
#include <wx/string.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/image.h>

#include <pgm_base.h>
#include <settings/settings_manager.h>
#include <kiplatform/environment.h>
#include <reporter.h>
#include <thread_pool.h>
#include <nlohmann/json.hpp>
#include <jobs/job_export_pcb_3d.h>

#include <board.h>
#include <pcb_io/pcb_io_mgr.h>
#include <exporters/step/exporter_step.h>

#include <3d_cache/pcbjam_model_fetch.h> // PCBJAM_3D::MODELS_MEMFS_ROOT
#include <plugins/3dapi/ifsg_api.h>

class SCENEGRAPH;

// The statically linked oce plugin's loader (plugins/3d/oce/oce.cpp, renamed
// per-TU to oce3d_* by its EMSCRIPTEN CMake block; the registry in
// 3d-viewer/3d_cache/pcbjam_static_3d_plugins.cpp declares the same surface).
extern "C" SCENEGRAPH* oce3d_Load( char const* aFileName );

// The export dialog's browser seam (dialog_export_step.cpp, compiled into the
// kiface objects this module links) feeds the full job JSON to the EDITOR-side
// EXPORTER_STEP shadow through this hook. No dialog ever runs in the worker —
// the service's EXPORTER_STEP is the real one — so it's a no-op here; the
// symbol just has to resolve.
extern "C" void Pcbjam_SetExportJobJson( const char* ) {}

namespace
{

// Minimal headless PGM: MacOpenFile is PGM_BASE's only pure virtual.
class PGM_OCC_SERVICE : public PGM_BASE
{
public:
    void MacOpenFile( const wxString& ) override {}
};

PGM_OCC_SERVICE s_program;

const char* const TMP_BOARD = "/tmp/occ_service_board.kicad_pcb";
const char* const TMP_CACHE = "/tmp/occ_service_model.3dc";


bool writeFile( const wxString& aPath, const void* aData, size_t aLen )
{
    wxFFile f( aPath, wxT( "wb" ) );
    return f.IsOpened() && f.Write( aData, aLen ) == aLen;
}


bool readFile( const wxString& aPath, std::vector<char>* aOut )
{
    wxFFile f( aPath, wxT( "rb" ) );

    if( !f.IsOpened() )
        return false;

    wxFileOffset len = f.Length();
    aOut->resize( (size_t) len );
    return len >= 0 && f.Read( aOut->data(), (size_t) len ) == (size_t) len;
}


// Copy a std::vector's bytes into a fresh JS-owned Uint8Array (the
// typed_memory_view itself only aliases this module's heap; the Uint8Array
// constructor makes the copy that survives postMessage/transfer).
emscripten::val toUint8Array( const std::vector<char>& aBytes )
{
    emscripten::val view = emscripten::val( emscripten::typed_memory_view(
            aBytes.size(), reinterpret_cast<const uint8_t*>( aBytes.data() ) ) );
    return emscripten::val::global( "Uint8Array" ).new_( view );
}


// Headless board load from sexpr text — the pcbnew_scripting_helpers::LoadBoard
// pattern (that file is KICAD_SCRIPTING-gated and the wasm stub returns null,
// so the few needed lines are replicated here): default project from the PGM's
// settings manager, PCB_IO_MGR parse, project attach.
BOARD* loadBoardFromSexpr( const std::string& aSexpr, wxString* aErr )
{
    if( !writeFile( wxString::FromUTF8( TMP_BOARD ), aSexpr.data(), aSexpr.size() ) )
    {
        *aErr = wxT( "occ_service: cannot stage board file in MEMFS" );
        return nullptr;
    }

    SETTINGS_MANAGER& mgr = Pgm().GetSettingsManager();
    PROJECT*          project = mgr.GetProject( wxEmptyString );

    if( !project )
    {
        mgr.LoadProject( wxEmptyString );
        project = mgr.GetProject( wxEmptyString );
    }

    BOARD* brd = nullptr;

    try
    {
        brd = PCB_IO_MGR::Load( PCB_IO_MGR::KICAD_SEXP, wxString::FromUTF8( TMP_BOARD ) );
    }
    catch( const std::exception& e )
    {
        *aErr = wxString::Format( wxT( "board parse failed: %s" ), e.what() );
    }
    catch( ... )
    {
        *aErr = wxT( "board parse failed" );
    }

    if( brd && project )
        brd->SetProject( project );

    return brd;
}


// Stage the host-prefetched lib model bodies under the shared MEMFS model
// root (PCBJAM_3D::MODELS_MEMFS_ROOT) where EXPORTER_STEP's staged-model
// probe looks. Paths arrive as lib-relative refs ("<lib>.3dshapes/<n>.<ext>");
// anything absolute or traversing is skipped defensively. Returns the staged
// absolute paths so the caller can remove them after the export.
std::vector<wxString> stageModelFiles( const emscripten::val& aModels )
{
    std::vector<wxString> staged;

    if( aModels.isNull() || aModels.isUndefined() || !aModels["length"].as<bool>() )
        return staged;

    const size_t count = aModels["length"].as<size_t>();

    for( size_t i = 0; i < count; ++i )
    {
        emscripten::val entry = aModels[i];

        if( entry.isNull() || entry.isUndefined() )
            continue;

        const std::string rel = entry["path"].as<std::string>();
        emscripten::val   bytes = entry["bytes"];

        if( rel.empty() || rel.front() == '/' || rel.find( ".." ) != std::string::npos
            || bytes.isNull() || bytes.isUndefined() )
        {
            std::fprintf( stderr, "[occ_service] models: skipping bad entry '%s'\n",
                          rel.c_str() );
            continue;
        }

        const size_t         len = bytes["byteLength"].as<size_t>();
        std::vector<uint8_t> buf( len );

        emscripten::val view =
                emscripten::val( emscripten::typed_memory_view( len, buf.data() ) );
        view.call<void>( "set", bytes );

        const wxString path = wxString::FromUTF8(
                std::string( PCBJAM_3D::MODELS_MEMFS_ROOT ) + "/" + rel );

        if( !wxFileName( path ).Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        {
            std::fprintf( stderr, "[occ_service] models: mkdir failed for '%s'\n",
                          rel.c_str() );
            continue;
        }

        if( writeFile( path, buf.data(), buf.size() ) )
            staged.push_back( path );
        else
            std::fprintf( stderr, "[occ_service] models: write failed for '%s'\n",
                          rel.c_str() );
    }

    std::fprintf( stderr, "[occ_service] models: staged %zu/%zu\n", staged.size(),
                  count );
    return staged;
}


emscripten::val occExport( std::string aBoardSexpr, std::string aParamsJson,
                           emscripten::val aModels )
{
    emscripten::val ret = emscripten::val::object();
    ret.set( "ok", false );

    // The official job JSON: JOB_EXPORT_PCB_3D registers every dialog/CLI field
    // as a JOB_PARAM (common/jobs/job_export_pcb_3d.cpp), so FromJson fills
    // m_3dparams + m_format directly.
    JOB_EXPORT_PCB_3D job;

    try
    {
        job.FromJson( nlohmann::json::parse( aParamsJson ) );
    }
    catch( const std::exception& e )
    {
        ret.set( "report", std::string( "occ_service: bad paramsJson: " ) + e.what() );
        return ret;
    }

    EXPORTER_STEP_PARAMS params = job.m_3dparams;

    // Same format mapping as PCBNEW_JOBS_HANDLER::JobExportStep.
    switch( job.m_format )
    {
    case JOB_EXPORT_PCB_3D::FORMAT::STEP:  params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::STEP;  break;
    case JOB_EXPORT_PCB_3D::FORMAT::STEPZ: params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::STEPZ; break;
    case JOB_EXPORT_PCB_3D::FORMAT::BREP:  params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::BREP;  break;
    case JOB_EXPORT_PCB_3D::FORMAT::XAO:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::XAO;   break;
    case JOB_EXPORT_PCB_3D::FORMAT::GLB:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::GLB;   break;
    case JOB_EXPORT_PCB_3D::FORMAT::PLY:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::PLY;   break;
    case JOB_EXPORT_PCB_3D::FORMAT::STL:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::STL;   break;
    case JOB_EXPORT_PCB_3D::FORMAT::U3D:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::U3D;   break;
    case JOB_EXPORT_PCB_3D::FORMAT::PDF:   params.m_Format = EXPORTER_STEP_PARAMS::FORMAT::PDF;   break;
    default:
        // VRML exports run in-editor (EXPORTER_VRML, no OCC); anything else is a caller bug.
        ret.set( "report", std::string( "occ_service: unsupported format" ) );
        return ret;
    }

    // Phase breadcrumbs (stderr → worker console): the only field-visible
    // signal of where a hang/trap sits inside this synchronous call.
    std::fprintf( stderr, "[occ_service] export: parsing board (%zu bytes)\n",
                  aBoardSexpr.size() );

    wxString err;
    BOARD*   brd = loadBoardFromSexpr( aBoardSexpr, &err );

    if( !brd )
    {
        ret.set( "report", std::string( err.utf8_string() ) );
        return ret;
    }

    // Host-prefetched lib model bodies → the shared MEMFS model root, where
    // the exporter's staged-model probe resolves resolver-miss refs.
    const std::vector<wxString> stagedModels = stageModelFiles( aModels );

    std::fprintf( stderr, "[occ_service] export: board parsed, running EXPORTER_STEP (%s)\n",
                  params.GetFormatName().utf8_string().c_str() );

    WX_STRING_REPORTER reporter;
    EXPORTER_STEP      exporter( brd, params, &reporter );

    wxFileName outFn( wxT( "/tmp" ), wxT( "occ_service_out" ),
                      params.GetDefaultExportExtension() );
    exporter.m_outputFile = outFn.GetFullPath();

    bool              ok = false;
    std::vector<char> outBytes;

    try
    {
        ok = exporter.Export();
    }
    catch( const std::exception& e )
    {
        reporter.Report( wxString::Format( wxT( "export exception: %s" ), e.what() ),
                         RPT_SEVERITY_ERROR );
    }
    catch( ... )
    {
        // OCCT throws Standard_Failure on malformed geometry internals.
        reporter.Report( wxT( "export exception (OCCT)" ), RPT_SEVERITY_ERROR );
    }

    if( ok )
        ok = readFile( exporter.m_outputFile, &outBytes );

    ret.set( "ok", ok );
    ret.set( "report", std::string( reporter.GetMessages().utf8_string() ) );
    ret.set( "fileName", std::string( outFn.GetFullName().utf8_string() ) );

    if( ok )
        ret.set( "bytes", toUint8Array( outBytes ) );

    wxRemoveFile( exporter.m_outputFile );
    wxRemoveFile( wxString::FromUTF8( TMP_BOARD ) );

    // Staged bodies are per-request (the host re-ships from its IDB/MEMFS
    // cache); don't let them accumulate in the worker across exports.
    for( const wxString& staged : stagedModels )
        wxRemoveFile( staged );

    delete brd;

    std::fprintf( stderr, "[occ_service] export %s (%zu bytes)\n",
                  ok ? "ok" : "FAILED", outBytes.size() );
    return ret;
}


emscripten::val occLoadModel( emscripten::val aBytes, std::string aExt )
{
    emscripten::val ret = emscripten::val::object();
    ret.set( "ok", false );

    // Sanitize the extension — it picks the parser (STEP vs IGES) inside the
    // oce loader via the temp file name.
    std::string ext;

    for( char c : aExt )
    {
        if( isalnum( (unsigned char) c ) )
            ext += (char) tolower( (unsigned char) c );
    }

    if( ext.empty() )
    {
        ret.set( "report", std::string( "occ_service: empty model extension" ) );
        return ret;
    }

    const size_t         len = aBytes["byteLength"].as<size_t>();
    std::vector<uint8_t> buf( len );

    // memcpy from the JS Uint8Array into this module's heap via a view .set().
    emscripten::val view =
            emscripten::val( emscripten::typed_memory_view( len, buf.data() ) );
    view.call<void>( "set", aBytes );

    const wxString modelPath =
            wxString::FromUTF8( ( std::string( "/tmp/occ_service_model." ) + ext ).c_str() );

    if( !writeFile( modelPath, buf.data(), buf.size() ) )
    {
        ret.set( "report", std::string( "occ_service: cannot stage model file" ) );
        return ret;
    }

    SCENEGRAPH* sg = nullptr;

    try
    {
        sg = oce3d_Load( modelPath.utf8_string().c_str() );
    }
    catch( ... )
    {
        // Standard_Failure on malformed STEP internals — treat as parse failure,
        // mirroring the per-model skip behavior in pcbjam_static_3d_plugins.cpp.
        sg = nullptr;
    }

    wxRemoveFile( modelPath );

    if( !sg )
    {
        ret.set( "report", std::string( "occ_service: model parse failed (." ) + ext + ")" );
        return ret;
    }

    // SCENEGRAPH's first and only base is SGNODE (sg/scenegraph.h); the full
    // definition lives in 3d-viewer-internal headers, so cast at ABI level.
    SGNODE* node = reinterpret_cast<SGNODE*>( sg );

    bool              ok = S3D::WriteCache( TMP_CACHE, true, node, "pcbjam-occ_service:1" );
    std::vector<char> cacheBytes;

    if( ok )
        ok = readFile( wxString::FromUTF8( TMP_CACHE ), &cacheBytes );

    S3D::DestroyNode( node );
    wxRemoveFile( wxString::FromUTF8( TMP_CACHE ) );

    ret.set( "ok", ok );

    if( ok )
        ret.set( "bytes", toUint8Array( cacheBytes ) );
    else
        ret.set( "report", std::string( "occ_service: scenegraph cache write failed" ) );

    std::fprintf( stderr, "[occ_service] loadModel .%s %s (%zu -> %zu bytes)\n", ext.c_str(),
                  ok ? "ok" : "FAILED", len, cacheBytes.size() );
    return ret;
}

} // namespace


EMSCRIPTEN_BINDINGS( occ_service )
{
    emscripten::function( "occExport", &occExport );
    emscripten::function( "occLoadModel", &occLoadModel );
}


int main( int argc, char** argv )
{
    // Bring up wxBase (no GUI): wxString/wxFileName/wxFFile need the library
    // initialized. Function-static so it lives for the module's lifetime
    // (-sEXIT_RUNTIME=0 keeps the runtime alive after main returns).
    static wxInitializer initializer( argc, argv );

    if( !initializer.IsOk() )
    {
        std::fprintf( stderr, "[occ_service] wxWidgets initialisation failed\n" );
        return 1;
    }

    KIPLATFORM::ENV::Init();
    SetPgm( &s_program );

    // Headless, no python — the kicad-cli bootstrap (kicad_cli.cpp): creates the
    // settings manager + locale so Pgm()-dependent code (FILENAME_RESOLVER,
    // ADVANCED_CFG) works. Settings I/O lands in the pre-js in-memory store.
    if( !s_program.InitPgm( true, true ) )
    {
        std::fprintf( stderr, "[occ_service] InitPgm failed\n" );
        return 2;
    }

    // Boards may embed bitmap images in various formats.
    wxInitAllImageHandlers();

    // Warm the KiCad thread pool NOW, while this thread's event loop is still
    // live. The exporter's first use (step_pcb_model.cpp CreatePCB) happens
    // inside the synchronous occExport call — and in a browser a blocked
    // thread cannot finish spawning Workers, which deadlocks the pool ctor in
    // Chromium (the same class as the raytracer pre-warm fix, root commit
    // 7630c7e). Constructing it here lets every std::thread start cleanly.
    GetKiCadThreadPool();

    std::fprintf( stderr, "[occ_service] ready\n" );
    return 0;
}
