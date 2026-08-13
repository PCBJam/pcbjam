/*
 * sharedspice client stub — the editor side of the ngspice_service split
 * (docs/features/ngspice-split/; the SPICE analog of exporter_step_stub.cpp).
 *
 * eeschema's NGSPICE class normally dlopens libngspice and binds ~10 function
 * pointers; in WASM the simulator engine lives in a separate worker module
 * (wasm/ngspice-service/), and NGSPICE::init_dll()'s __EMSCRIPTEN__ branch
 * binds its pointers to the pcbjam_ngSpice_* functions here instead. Each
 * forwards over the `globalThis.ngspiceService` provider
 * (web/standalone/src/wasm/ngspice-service.ts) via EM_ASYNC_JS — the editor
 * suspends through Asyncify while the worker answers (the `__asyncjs__*`
 * import is auto-covered by scripts/common/asyncify-imports.txt).
 *
 * Callbacks: KiCad registers its cbSendChar/cbSendStat/cbControlledExit/
 * cbBGThreadRunning with pcbjam_ngSpice_Init; the worker streams `{ evt }`
 * frames which the provider hands to `globalThis.__ngspiceOnEvent` (installed
 * here). The exported pcbjam_ngspice_event is only an ingress adapter: it
 * copies the frame and queues an ordinary wx execution-owner job. A fresh
 * Wasm entry is not permission to inspect KiCad state while another owner is
 * parked, even when the eventual callbacks mostly take a mutex or queue a wx
 * event.
 *
 * ngSpice_running stays cheap: a client-side atomic mirror maintained from
 * command results and bg events — the simulator UI polls it on a refresh
 * timer and an RPC per poll would be pure overhead.
 *
 * Netlist file shipping: NETLIST_EXPORTER_SPICE emits `.include "<abs path>"`
 * lines (Sim.Library models, the IBIS cache) that ngspice opens from ITS
 * filesystem — pcbjam_ngSpice_Circ scans the deck, reads those files from the
 * editor MEMFS (recursively, bounded), and ships them with the circ request
 * so the service stages them at identical paths.
 */

#ifdef __EMSCRIPTEN__

#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten.h>

#include <nlohmann/json.hpp>

#include <ngspice/sharedspice.h>
#include <wx/wasm/private/execution_owner.h>

using nlohmann::json;

// -------------------------------------------------------------------------
// JS bridges
// -------------------------------------------------------------------------

// Generic request: JSON in, JSON out (malloc'd; caller frees). Vector data
// never travels this path — see js_ngspice_get_vec.
//
// Phase E shape (docs/features/async/22 §5, K6): token wait instead of an
// in-place Asyncify park; resolution ALWAYS deferred to at least a microtask
// (the early-resolve contract, doc 22 §10 Phase E retry entry).
// clang-format off
EM_JS( void, js_ngspice_request_start, ( int aToken, const char* aReqJson ), {
    const scheduler = globalThis.__wxScheduler;
    const finish = ( res ) => {
        if( !scheduler || typeof scheduler.runWaitCompletion !== 'function' )
            return;
        scheduler.runWaitCompletion( 'ngspice request completion', aToken, () => {
            const s = JSON.stringify( res ?? {} );
            const n = lengthBytesUTF8( s ) + 1;
            const p = _malloc( n );

            if( !p )
                return 0;

            stringToUTF8( s, p, n );
            return p;
        } );
    };
    let req;
    try {
        const svc = globalThis.ngspiceService;
        if( !svc )
            req = Promise.resolve( { error: 'ngspiceService provider not installed' } );
        else
            req = Promise.resolve( svc.request( JSON.parse( UTF8ToString( aReqJson ) ) ) );
    } catch( e ) {
        if( scheduler && typeof scheduler._terminalizeNativeTrap === 'function'
            && scheduler._terminalizeNativeTrap(
                'ngspice request setup trapped', e ) )
            throw e;
        req = Promise.resolve( { error: String( e ) } );
    }
    // If the first completion traps, its boundary closes the gate before the
    // catch attempts the error response. The second `finish` is then inert.
    req.then( finish ).catch( ( e ) => finish( { error: String( e ) } ) );
} );

// Vector fetch: fills editor-heap buffers directly (no JSON for MB arrays).
// aMeta: int[4] = { found, vtype, flags, length }; aReal/aComp receive
// malloc'd double buffers (comp interleaved re,im — the ngcomplex_t layout);
// aVName receives a malloc'd name string. The wait result is non-zero on
// transport error. All output writes happen in the resolve callback, BEFORE
// resolveWait — the parked caller reads them only after it resumes, the same
// ordering the in-place park had. Phase E shape, resolution always deferred.
EM_JS( void, js_ngspice_get_vec_start,
       ( int aToken, const char* aName, int* aMeta, double** aReal, double** aComp,
         char** aVName ), {
    const scheduler = globalThis.__wxScheduler;
    let req;
    try {
        const svc = globalThis.ngspiceService;
        req = svc ? Promise.resolve( svc.request( { kind: 'get_vec_info',
                                                    name: UTF8ToString( aName ) } ) )
                  : Promise.resolve( { error: 'ngspiceService provider not installed' } );
    } catch( e ) {
        if( scheduler && typeof scheduler._terminalizeNativeTrap === 'function'
            && scheduler._terminalizeNativeTrap(
                'ngspice vector request setup trapped', e ) )
            throw e;
        req = Promise.resolve( { error: String( e ) } );
    }
    req.catch( ( e ) => ( { error: String( e ) } ) ).then( ( res ) => {
        if( !scheduler || typeof scheduler.runWaitCompletion !== 'function' )
            return;
        scheduler.runWaitCompletion( 'ngspice vector completion', aToken, () => {
            HEAP32[aMeta >> 2] = 0;
            HEAPU32[aReal >> 2] = 0;
            HEAPU32[aComp >> 2] = 0;
            HEAPU32[aVName >> 2] = 0;
            if( !res || res.error )
                return 1;
            if( !res.found )
                return 0;

            // Allocate the complete result before copying or publishing any
            // part of it. Allocation failure is an ordinary request failure:
            // release private scratch, leave every output null, and return the
            // non-zero status expected by pcbjam_ngGet_Vec_Info.
            let real = 0;
            let comp = 0;
            let vname = 0;
            const release = () => {
                if( real )
                    _free( real );
                if( comp )
                    _free( comp );
                if( vname )
                    _free( vname );
            };

            if( res.real && res.real.length ) {
                real = _malloc( res.real.length * 8 );
                if( !real ) {
                    release();
                    return 1;
                }
            }
            if( res.comp && res.comp.length ) {
                comp = _malloc( res.comp.length * 8 );
                if( !comp ) {
                    release();
                    return 1;
                }
            }
            const s = res.vname || String();
            const n = lengthBytesUTF8( s ) + 1;
            vname = _malloc( n );
            if( !vname ) {
                release();
                return 1;
            }

            if( real )
                HEAPF64.set( res.real, real >> 3 );
            if( comp )
                HEAPF64.set( res.comp, comp >> 3 );
            stringToUTF8( s, vname, n );

            HEAP32[( aMeta >> 2 ) + 1] = res.vtype | 0;
            HEAP32[( aMeta >> 2 ) + 2] = res.flags | 0;
            HEAP32[( aMeta >> 2 ) + 3] = res.length | 0;
            HEAPU32[aReal >> 2] = real;
            HEAPU32[aComp >> 2] = comp;
            HEAPU32[aVName >> 2] = vname;
            HEAP32[aMeta >> 2] = 1;
            return 0;
        } );
    } );
} );

// Token waits live in the wx wasm port (evtloop.cpp).
extern "C" int wxWasmBeginWait( const char* aKind );
extern "C" int wxWasmYieldUntil( int aToken );

// Event dispatcher: provider `{ evt }` frames -> KiCad's registered callbacks.
// One worker batch becomes one native owner job; a verbose simulation must not
// consume one bounded queue slot per output line. Installation is idempotent
// only for one exact editor Module lifetime. A replacement instance in the
// same realm replaces the handler instead of retaining an export closure into
// the old Wasm heap.
EM_JS( void, js_ngspice_install_events, (), {
    const installingModule = Module;
    const installed = globalThis.__ngspiceOnEvent;
    if( installed
        && installed.__pcbjamNgspiceOwnerModule === installingModule )
        return;

    const handler = ( evt ) => {
        const scheduler = globalThis.__wxScheduler;
        const currentModule = scheduler && scheduler.ownerModule;
        if( !scheduler || typeof scheduler.enqueueNativeCompletion !== 'function'
            || typeof scheduler.canTouchNative !== 'function'
            || !scheduler.canTouchNative()
            || currentModule !== installingModule
            || globalThis.__ngspiceOnEvent !== handler )
            return;

        const enqueue = ( site, bytes, run ) => {
            scheduler.enqueueNativeCompletion( site, bytes, () => {
                // The completion can wait behind an Asyncify transition. Do
                // not let an accepted old-instance closure enter after the
                // page has installed a replacement Module and scheduler.
                if( globalThis.__ngspiceOnEvent !== handler
                    || globalThis.__wxScheduler !== scheduler
                    || scheduler.ownerModule !== currentModule
                    || !scheduler.canTouchNative() )
                    return;
                run( currentModule );
            } );
        };
        if( evt.kind === 'char' || evt.kind === 'stat' ) {
            // Snapshot the worker-owned frame before retaining it. A verbose
            // provider batch occupies one bounded physical-entry job, not one
            // job per output line.
            const lines = Array.isArray( evt.lines ) ? evt.lines.map( String ) : [];
            if( lines.length ) {
                const payload = JSON.stringify( lines );
                const payloadBytes = lengthBytesUTF8( payload ) + 1;
                const kind = evt.kind === 'char' ? 0 : 1;
                enqueue( 'ngspice output event', payloadBytes, ( module ) => {
                    const n = lengthBytesUTF8( payload ) + 1;
                    const p = _malloc( n );

                    if( !p )
                    {
                        console.error( '[sharedspice_client] could not allocate output event batch' );
                        return;
                    }

                    stringToUTF8( payload, p, n );
                    module._pcbjam_ngspice_event_batch( kind, p );
                } );
            }
        } else if( evt.kind === 'bg' ) {
            const finished = evt.finished ? 1 : 0;
            enqueue( 'ngspice background-state event', 0, ( module ) => {
                module._pcbjam_ngspice_event( 2, 0, finished, 0 );
            } );
        } else if( evt.kind === 'exit' ) {
            const status = evt.status | 0;
            const flags = ( evt.immediate ? 1 : 0 ) | ( evt.quit ? 2 : 0 );
            enqueue( 'ngspice exit event', 0, ( module ) => {
                module._pcbjam_ngspice_event( 3, 0, status, flags );
            } );
        }
    };
    handler.__pcbjamNgspiceOwnerModule = installingModule;
    globalThis.__ngspiceOnEvent = handler;
} );
// clang-format on

// -------------------------------------------------------------------------
// Client state
// -------------------------------------------------------------------------

namespace
{

SendChar*        s_sendChar = nullptr;
SendStat*        s_sendStat = nullptr;
ControlledExit*  s_controlledExit = nullptr;
BGThreadRunning* s_bgThreadRunning = nullptr;
void*            s_user = nullptr;

// Mirror of the service's bg-run state (see header comment).
std::atomic<bool> s_bgRunning{ false };

json rpc( const json& aReq )
{
    const int token = wxWasmBeginWait( "ngspice" );

    if( token <= 0 )
        return json{ { "error", "scheduler refused an exact ngspice wait" } };

    js_ngspice_request_start( token, aReq.dump().c_str() );

    // The malloc'd JSON pointer rides the wait as an int32.
    char* raw = (char*) (uintptr_t) (uint32_t) wxWasmYieldUntil( token );
    json  res = json::parse( raw ? raw : "{}", nullptr, /* allow_exceptions */ false );
    std::free( raw );

    if( res.is_discarded() )
        res = json::object();

    if( res.contains( "error" ) )
    {
        fprintf( stderr, "[sharedspice_client] %s: %s\n",
                 aReq.value( "kind", "?" ).c_str(),
                 res["error"].dump().c_str() );
    }

    return res;
}

struct NgspiceEventJob
{
    int                      kind = 0;
    std::vector<std::string> lines;
    int                      a = 0;
    int                      b = 0;
};

std::size_t retainedNgspiceEventBytes( const NgspiceEventJob& aJob,
                                      std::size_t aTransportBytes )
{
    // This is a conservative native footprint, not allocator telemetry. The
    // vector objects and each string capacity can expand a compact JSON batch;
    // the transport size remains the floor so the byte lease genuinely moves
    // from the JS completion queue into this native semantic queue.
    constexpr std::size_t overflow =
            wx_wasm_execution::MaxQueuedRetainedBytes + 1;
    std::size_t bytes = sizeof( NgspiceEventJob );

    const auto add = [&bytes]( std::size_t aAmount ) {
        if( aAmount > wx_wasm_execution::MaxQueuedRetainedBytes - bytes )
        {
            bytes = wx_wasm_execution::MaxQueuedRetainedBytes + 1;
            return false;
        }

        bytes += aAmount;
        return true;
    };

    if( aJob.lines.capacity()
        > ( wx_wasm_execution::MaxQueuedRetainedBytes - bytes )
                  / sizeof( std::string ) )
    {
        return overflow;
    }

    if( !add( aJob.lines.capacity() * sizeof( std::string ) ) )
        return overflow;

    for( const std::string& line : aJob.lines )
    {
        if( line.capacity() >= wx_wasm_execution::MaxQueuedRetainedBytes
            || !add( line.capacity() + 1 ) )
        {
            return overflow;
        }
    }

    return bytes > aTransportBytes ? bytes : aTransportBytes;
}

void deliverNgspiceEvent( void* aArg )
{
    std::unique_ptr<NgspiceEventJob> job( static_cast<NgspiceEventJob*>( aArg ) );

    switch( job->kind )
    {
    case 0: // char
        if( s_sendChar )
        {
            for( std::string& line : job->lines )
                s_sendChar( line.empty() ? const_cast<char*>( "" ) : line.data(), 0, s_user );
        }
        break;

    case 1: // stat
        if( s_sendStat )
        {
            for( std::string& line : job->lines )
                s_sendStat( line.empty() ? const_cast<char*>( "" ) : line.data(), 0, s_user );
        }
        break;

    case 2: // bg: a = finished
        s_bgRunning.store( job->a == 0 );

        if( s_bgThreadRunning )
            s_bgThreadRunning( job->a != 0, 0, s_user );
        break;

    case 3: // exit: a = status, b = immediate|quit<<1
        s_bgRunning.store( false );

        if( s_controlledExit )
            s_controlledExit( job->a, ( job->b & 1 ) != 0,
                              ( job->b & 2 ) != 0, 0, s_user );
        break;
    }
}

void discardNgspiceEvent( void* aArg )
{
    delete static_cast<NgspiceEventJob*>( aArg );
}

// Read an editor-MEMFS file; returns false if it doesn't exist.
bool readFile( const std::string& aPath, std::string* aOut )
{
    FILE* fp = fopen( aPath.c_str(), "rb" );

    if( !fp )
        return false;

    fseek( fp, 0, SEEK_END );
    long size = ftell( fp );
    fseek( fp, 0, SEEK_SET );

    aOut->resize( size > 0 ? (size_t) size : 0 );

    if( size > 0 && fread( aOut->data(), 1, (size_t) size, fp ) != (size_t) size )
    {
        fclose( fp );
        return false;
    }

    fclose( fp );
    return true;
}

// Extract the file path from a `.include "<path>"` / `.inc` / `.lib "<path>"
// [section]` deck line; empty if the line is not an include directive.
std::string includePathFromLine( const std::string& aLine )
{
    size_t i = 0;

    while( i < aLine.size() && isspace( (unsigned char) aLine[i] ) )
        i++;

    if( i >= aLine.size() || aLine[i] != '.' )
        return std::string();

    size_t wordEnd = i;

    while( wordEnd < aLine.size() && !isspace( (unsigned char) aLine[wordEnd] ) )
        wordEnd++;

    std::string word = aLine.substr( i, wordEnd - i );

    for( char& c : word )
        c = (char) tolower( (unsigned char) c );

    if( word != ".include" && word != ".inc" && word != ".lib" )
        return std::string();

    size_t p = wordEnd;

    while( p < aLine.size() && isspace( (unsigned char) aLine[p] ) )
        p++;

    if( p >= aLine.size() )
        return std::string();

    if( aLine[p] == '"' || aLine[p] == '\'' )
    {
        char   quote = aLine[p++];
        size_t end = aLine.find( quote, p );
        return end == std::string::npos ? std::string() : aLine.substr( p, end - p );
    }

    size_t end = p;

    while( end < aLine.size() && !isspace( (unsigned char) aLine[end] ) )
        end++;

    return aLine.substr( p, end - p );
}

// Collect the deck's referenced model files (recursively — a shipped library
// may itself .include others), bounded against cycles and runaway depth.
void collectIncludeFiles( const std::vector<std::string>& aLines, json* aFiles,
                          std::set<std::string>* aSeen, int aDepth )
{
    if( aDepth > 4 )
        return;

    for( const std::string& line : aLines )
    {
        std::string path = includePathFromLine( line );

        if( path.empty() || aSeen->count( path ) )
            continue;

        aSeen->insert( path );

        std::string text;

        if( !readFile( path, &text ) )
            continue; // ngspice will report the miss with its native error

        aFiles->push_back( { { "path", path }, { "text", text } } );

        std::vector<std::string> nested;
        size_t                   start = 0;

        while( start <= text.size() )
        {
            size_t nl = text.find( '\n', start );

            if( nl == std::string::npos )
            {
                nested.push_back( text.substr( start ) );
                break;
            }

            nested.push_back( text.substr( start, nl - start ) );
            start = nl + 1;
        }

        collectIncludeFiles( nested, aFiles, aSeen, aDepth + 1 );
    }
}

} // namespace

// -------------------------------------------------------------------------
// Event entry from JS. Copy only; stateful delivery requires owner admission.
// -------------------------------------------------------------------------

extern "C" EMSCRIPTEN_KEEPALIVE void pcbjam_ngspice_event( int aKind, char* aText, int aA, int aB )
{
    std::unique_ptr<NgspiceEventJob> job;
    const std::size_t transportBytes = aText ? std::strlen( aText ) + 1 : 0;

    try
    {
        job = std::make_unique<NgspiceEventJob>();
        job->kind = aKind;
        if( aText )
            job->lines.emplace_back( aText );
        job->a = aA;
        job->b = aB;
    }
    catch( ... )
    {
        std::free( aText );
        wxWasmExecutionFailStop( "could not copy ngspice service event" );
        return;
    }

    std::free( aText );

    const std::size_t retainedBytes =
            retainedNgspiceEventBytes( *job, transportBytes );

    if( !wxWasmExecutionQueueOrdinaryRetained(
            deliverNgspiceEvent, job.get(), retainedBytes,
            discardNgspiceEvent ) )
    {
        wxWasmExecutionFailStop( "could not queue ngspice service event" );
        return;
    }

    job.release();
}

extern "C" EMSCRIPTEN_KEEPALIVE void pcbjam_ngspice_event_batch( int aKind, char* aLinesJson )
{
    std::unique_ptr<char, decltype( &std::free )> payload( aLinesJson, &std::free );
    std::unique_ptr<NgspiceEventJob>              job;
    const std::size_t transportBytes =
            payload ? std::strlen( payload.get() ) + 1 : 0;

    try
    {
        json lines = json::parse( payload ? payload.get() : "[]" );

        if( !lines.is_array() )
            throw std::runtime_error( "ngspice event batch is not an array" );

        job = std::make_unique<NgspiceEventJob>();
        job->kind = aKind;
        job->lines = lines.get<std::vector<std::string>>();
    }
    catch( ... )
    {
        wxWasmExecutionFailStop( "could not copy ngspice service event batch" );
        return;
    }

    const std::size_t retainedBytes =
            retainedNgspiceEventBytes( *job, transportBytes );

    if( !wxWasmExecutionQueueOrdinaryRetained(
            deliverNgspiceEvent, job.get(), retainedBytes,
            discardNgspiceEvent ) )
    {
        wxWasmExecutionFailStop( "could not queue ngspice service event batch" );
        return;
    }

    job.release();
}

// -------------------------------------------------------------------------
// The sharedspice API surface NGSPICE::init_dll binds to
// -------------------------------------------------------------------------

void pcbjam_ngSpice_Init( SendChar* aSendChar, SendStat* aSendStat, ControlledExit* aExit,
                          SendData*, SendInitData*, BGThreadRunning* aBgRunning, void* aUser )
{
    s_sendChar = aSendChar;
    s_sendStat = aSendStat;
    s_controlledExit = aExit;
    s_bgThreadRunning = aBgRunning;
    s_user = aUser;

    js_ngspice_install_events();

    // Boots the worker lazily; a failure surfaces on the first command too
    // (KiCad ignores ngSpice_Init's status, matching its native call).
    rpc( { { "kind", "init" } } );
}

int pcbjam_ngSpice_Circ( char** aCircArray )
{
    std::vector<std::string> lines;

    for( int i = 0; aCircArray && aCircArray[i]; i++ )
        lines.emplace_back( aCircArray[i] );

    json files = json::array();
    std::set<std::string> seen;
    collectIncludeFiles( lines, &files, &seen, 0 );

    json req = { { "kind", "circ" }, { "lines", lines }, { "files", std::move( files ) } };

    return rpc( req ).value( "ret", 1 );
}

int pcbjam_ngSpice_Command( char* aCommand )
{
    std::string cmd = aCommand ? aCommand : "";
    int ret = rpc( { { "kind", "command" }, { "cmd", cmd } } ).value( "ret", 1 );

    // The bg 'started' event arrives asynchronously; flip the mirror at the
    // acceptance edge so an immediate IsRunning() poll already sees it.
    if( ret == 0 && cmd.rfind( "bg_run", 0 ) == 0 )
        s_bgRunning.store( true );

    return ret;
}

pvector_info pcbjam_ngGet_Vec_Info( char* aVecName )
{
    // Per-call arena: valid until the next call, matching every NGSPICE
    // consumer (they copy within the same call).
    static vector_info s_vi;
    static char*       s_name = nullptr;
    static double*     s_real = nullptr;
    static double*     s_comp = nullptr;

    std::free( s_name );
    std::free( s_real );
    std::free( s_comp );
    s_name = nullptr;
    s_real = nullptr;
    s_comp = nullptr;

    int     meta[4] = { 0, 0, 0, 0 };
    double* real = nullptr;
    double* comp = nullptr;
    char*   vname = nullptr;

    const int token = wxWasmBeginWait( "ngspice" );

    if( token <= 0 )
        return nullptr;

    js_ngspice_get_vec_start( token, aVecName ? aVecName : "", meta, &real, &comp, &vname );

    if( wxWasmYieldUntil( token ) != 0 )
        return nullptr;

    if( !meta[0] )
        return nullptr;

    s_name = vname;
    s_real = real;
    s_comp = comp;

    s_vi.v_name = s_name;
    s_vi.v_type = meta[1];
    s_vi.v_flags = (short) meta[2];
    s_vi.v_length = meta[3];
    s_vi.v_realdata = s_real;
    // Interleaved re,im doubles ARE the ngcomplex_t array layout.
    s_vi.v_compdata = reinterpret_cast<ngcomplex_t*>( s_comp );

    return &s_vi;
}

char* pcbjam_ngSpice_CurPlot( void )
{
    static std::string s_plot;
    s_plot = rpc( { { "kind", "cur_plot" } } ).value( "name", "" );
    return s_plot.data();
}

namespace
{

// Shared marshalling for the two NULL-terminated string-array calls.
char** stringArrayResult( const json& aRes )
{
    static std::vector<std::string> s_store;
    static std::vector<char*>       s_ptrs;

    s_store.clear();
    s_ptrs.clear();

    if( aRes.contains( "names" ) && aRes["names"].is_array() )
    {
        for( const auto& n : aRes["names"] )
            s_store.push_back( n.get<std::string>() );
    }

    for( std::string& s : s_store )
        s_ptrs.push_back( s.data() );

    s_ptrs.push_back( nullptr );
    return s_ptrs.data();
}

} // namespace

char** pcbjam_ngSpice_AllPlots( void )
{
    return stringArrayResult( rpc( { { "kind", "all_plots" } } ) );
}

char** pcbjam_ngSpice_AllVecs( char* aPlotName )
{
    return stringArrayResult(
            rpc( { { "kind", "all_vecs" }, { "plot", aPlotName ? aPlotName : "" } } ) );
}

bool pcbjam_ngSpice_Running( void )
{
    return s_bgRunning.load();
}

char* pcbjam_ngCM_Input_Path( const char* aPath )
{
    static std::string s_path;
    s_path = aPath ? aPath : "";
    rpc( { { "kind", "cm_input_path" }, { "path", s_path } } );
    return s_path.data();
}

#endif // __EMSCRIPTEN__
