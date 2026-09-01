/*
 * WASM shadow of EXPORTER_STEP — the editor build compiles this INSTEAD of
 * exporters/step/exporter_step.cpp (no OCC in pcbnew.wasm; see
 * docs/features/occ-split/README.md). The class layout comes from the real
 * header; only the three symbols other TUs reference are defined here:
 * constructor, destructor, Export().
 *
 * Export() bridges to the occ_service worker: stage the live BOARD as sexpr
 * text in MEMFS, ship it + the official JOB_EXPORT_PCB_3D JSON through an
 * EM_ASYNC_JS suspend (globalThis.occService.request, installed by the web
 * app), and report the outcome. The exported file's bytes never enter this
 * module — the JS provider hands them straight to the browser download path.
 *
 * Callers stay untouched: PCBNEW_JOBS_HANDLER::JobExportStep and the browser
 * branch of DIALOG_EXPORT_STEP construct EXPORTER_STEP exactly as on desktop.
 */

#include <cstdlib>
#include <string>

#include <emscripten.h>

#include <wx/filename.h>
#include <wx/string.h>

#include <nlohmann/json.hpp>

#include <board.h>
#include <reporter.h>
#include <jobs/job_export_pcb_3d.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <exporters/step/exporter_step.h>

// Complete types for the unique_ptr members destroyed in ~EXPORTER_STEP (their
// headers still exist in the tree/sysroot; only the OCC *link* is gone).
#include <exporters/step/step_pcb_model.h>
#include <filename_resolver.h>

namespace
{
const char* const TMP_BOARD = "/tmp/pcbjam_occ_export_board.kicad_pcb";

// Optional side-channel: the dialog seam serializes the FULL job (including
// fields EXPORTER_STEP_PARAMS doesn't carry, e.g. the assembly variant) right
// before calling Export(). Consumed once. When unset (jobs-handler path), the
// job JSON is reconstructed from m_params.
std::string s_nextJobJson;
} // namespace

// One-shot job-JSON override for the next EXPORTER_STEP::Export() call.
extern "C" void Pcbjam_SetExportJobJson( const char* aJson )
{
    s_nextJobJson = aJson ? aJson : "";
}

// Phase E shape (docs/features/async/22 §5, K4): waits for the worker export
// via a token wait (context park when the frame stands on a scheduler context)
// instead of suspending the stack in place. The wait result is a malloc'd
// JSON string: { ok, report } — the download already happened in JS.
// Every resolution defers to at least a microtask (the early-resolve
// contract, doc 22 §10 Phase E retry entry).
EM_JS( void, js_occExportStart,
       ( int aToken, const char* aBoardPath, const char* aJobJson, const char* aFileName ),
{
    const boardPath = UTF8ToString( aBoardPath );
    const jobJson = UTF8ToString( aJobJson );
    const fileName = UTF8ToString( aFileName );

    // E-8: all native work (malloc + heap writes) runs inside the scheduler's
    // completion gate — a dead or trapped instance drops the completion
    // loudly instead of re-entering wasm, and a trap inside the prepare
    // latches the instance terminal without resolving the wait.
    const finish = ( res ) => {
        globalThis.__wxScheduler.runWaitCompletion( 'OCC export completion', aToken, () => {
            const s = JSON.stringify( res || { ok: false, report: 'occ_service: no response' } );
            const n = lengthBytesUTF8( s ) + 1;
            const p = _malloc( n );
            if( !p )
                return 0; // F-3: the native side already parses a null response as "{}" — never write through 0
            stringToUTF8( s, p, n );
            return p;
        } );
    };

    let req;

    try
    {
        const hook = globalThis.occService;

        if( !hook || typeof hook.request !== 'function' )
        {
            req = Promise.resolve( { ok: false, report: 'occ_service provider not installed' } );
        }
        else
        {
            const board = FS.readFile( boardPath ); // Uint8Array copy — transferable
            req = Promise.resolve( hook.request( { kind: 'export', board, jobJson, fileName } ) );
        }
    }
    catch( e )
    {
        console.error( '[pcbjam-occ] export request failed:', e );
        req = Promise.resolve( { ok: false, report: 'occ_service request failed: ' + e } );
    }

    req.then( finish ).catch( ( e ) => {
        console.error( '[pcbjam-occ] export request failed:', e );
        finish( { ok: false, report: 'occ_service request failed: ' + e } );
    } );
} )

// Token waits live in the wx wasm port (evtloop.cpp).
extern "C" int wxWasmBeginWait( const char* aKind );
extern "C" int wxWasmYieldUntil( int aToken );


EXPORTER_STEP::EXPORTER_STEP( BOARD* aBoard, const EXPORTER_STEP_PARAMS& aParams,
                              REPORTER* aReporter ) :
        m_params( aParams ),
        m_reporter( aReporter ),
        m_board( aBoard ),
        m_platingThickness( 0 )
{
}


EXPORTER_STEP::~EXPORTER_STEP()
{
}


bool EXPORTER_STEP::Export()
{
    if( !m_board )
        return false;

    // Stage the LIVE board (unsaved edits included) as sexpr text in MEMFS.
    try
    {
        PCB_IO_KICAD_SEXPR io;
        io.SaveBoard( wxString::FromUTF8( TMP_BOARD ), m_board );
    }
    catch( const std::exception& e )
    {
        if( m_reporter )
        {
            m_reporter->Report( wxString::Format( wxT( "Failed to stage board for export: %s" ),
                                                  e.what() ),
                                RPT_SEVERITY_ERROR );
        }

        return false;
    }

    // The official job JSON. Prefer the seam-provided full job; otherwise
    // rebuild one from the params we were constructed with.
    std::string jobJson;

    if( !s_nextJobJson.empty() )
    {
        jobJson = std::move( s_nextJobJson );
        s_nextJobJson.clear();
    }
    else
    {
        JOB_EXPORT_PCB_3D job;
        job.m_3dparams = m_params;
        job.SetStepFormat( m_params.m_Format );

        nlohmann::json j;
        job.ToJson( j );
        jobJson = j.dump();
    }

    const wxString downloadName = wxFileName( m_outputFile ).GetFullName();

    const int token = wxWasmBeginWait( "occ" );

    // Token 0 = the scheduler refused the wait (dead or terminal instance):
    // never start an RPC whose completion could not be admitted.
    if( token <= 0 )
    {
        if( m_reporter )
            m_reporter->Report( wxT( "occ_service: scheduler unavailable" ), RPT_SEVERITY_ERROR );

        wxRemoveFile( wxString::FromUTF8( TMP_BOARD ) );
        return false;
    }

    js_occExportStart( token, TMP_BOARD, jobJson.c_str(), downloadName.utf8_string().c_str() );

    // The malloc'd JSON pointer rides the wait as an int32.
    char* response = (char*) (uintptr_t) (uint32_t) wxWasmYieldUntil( token );

    bool ok = false;

    try
    {
        nlohmann::json res = nlohmann::json::parse( response ? response : "{}" );
        ok = res.value( "ok", false );

        const std::string report = res.value( "report", std::string() );

        if( m_reporter && !report.empty() )
        {
            m_reporter->Report( wxString::FromUTF8( report.c_str() ),
                                ok ? RPT_SEVERITY_INFO : RPT_SEVERITY_ERROR );
        }
    }
    catch( ... )
    {
        if( m_reporter )
            m_reporter->Report( wxT( "occ_service: malformed response" ), RPT_SEVERITY_ERROR );
    }

    std::free( response );
    wxRemoveFile( wxString::FromUTF8( TMP_BOARD ) );

    return ok;
}
