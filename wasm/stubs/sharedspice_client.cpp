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
 * suspends (JSPI) while the worker answers.
 *
 * Callbacks: KiCad registers its cbSendChar/cbSendStat/cbControlledExit/
 * cbBGThreadRunning with pcbjam_ngSpice_Init; the worker streams `{ evt }`
 * frames which the provider hands to `globalThis.__ngspiceOnEvent` (installed
 * here). The dispatcher calls the exported pcbjam_ngspice_event — a fresh
 * WASM entry from JS, safe while the main C++ stack is suspended (the wx-dom
 * DOM-event mechanism, wxwidgets/src/wasm/domevents.cpp); KiCad's callbacks
 * only take a mutex and wxQueueEvent, so nothing on this path can suspend.
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
#include <set>
#include <string>
#include <vector>

#include <emscripten.h>

#include <nlohmann/json.hpp>

#include <ngspice/sharedspice.h>

using nlohmann::json;

// -------------------------------------------------------------------------
// JS bridges
// -------------------------------------------------------------------------

// Generic request: JSON in, JSON out (malloc'd; caller frees). Vector data
// never travels this path — see js_ngspice_get_vec.
//
// Phase E shape (docs/features/async/22 §5, K6): token wait instead of
// suspending the stack in place; resolution ALWAYS deferred to at least a
// microtask (the early-resolve contract, doc 22 §10 Phase E retry entry).
// clang-format off
EM_JS( void, js_ngspice_request_start, ( int aToken, const char* aReqJson ), {
    // E-8: the malloc + heap writes run inside the scheduler's completion
    // gate — a dead or trapped instance drops the completion loudly instead
    // of re-entering wasm.
    const finish = ( res ) => {
        globalThis.__wxScheduler.runWaitCompletion( 'ngspice request completion', aToken, () => {
            const s = JSON.stringify( res ?? {} );
            const n = lengthBytesUTF8( s ) + 1;
            const p = _malloc( n );
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
        req = Promise.resolve( { error: String( e ) } );
    }
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
    let req;
    try {
        const svc = globalThis.ngspiceService;
        req = svc ? Promise.resolve( svc.request( { kind: 'get_vec_info',
                                                    name: UTF8ToString( aName ) } ) )
                  : Promise.resolve( { error: 'ngspiceService provider not installed' } );
    } catch( e ) {
        req = Promise.resolve( { error: String( e ) } );
    }
    // E-8: every output-pointer write happens inside the scheduler's
    // completion gate, so a dead or trapped instance is never written to.
    // A plain JS failure inside the prepare resolves the inertResult (1 =
    // transport error) so the parked caller fails instead of stranding.
    req.catch( ( e ) => ( { error: String( e ) } ) ).then( ( res ) => {
        globalThis.__wxScheduler.runWaitCompletion( 'ngspice vector completion', aToken, () => {
            HEAP32[aMeta >> 2] = 0;
            HEAPU32[aReal >> 2] = 0;
            HEAPU32[aComp >> 2] = 0;
            HEAPU32[aVName >> 2] = 0;
            if( !res || res.error )
                return 1;
            if( !res.found )
                return 0;
            HEAP32[( aMeta >> 2 ) + 1] = res.vtype | 0;
            HEAP32[( aMeta >> 2 ) + 2] = res.flags | 0;
            HEAP32[( aMeta >> 2 ) + 3] = res.length | 0;
            if( res.real && res.real.length ) {
                const p = _malloc( res.real.length * 8 );
                HEAPF64.set( res.real, p >> 3 );
                HEAPU32[aReal >> 2] = p;
            }
            if( res.comp && res.comp.length ) {
                const p = _malloc( res.comp.length * 8 );
                HEAPF64.set( res.comp, p >> 3 );
                HEAPU32[aComp >> 2] = p;
            }
            const s = res.vname || '';
            const n = lengthBytesUTF8( s ) + 1;
            const vp = _malloc( n );
            stringToUTF8( s, vp, n );
            HEAPU32[aVName >> 2] = vp;
            HEAP32[aMeta >> 2] = 1;
            return 0;
        }, /* inertResult = */ 1 );
    } );
} );

// Token waits live in the wx wasm port (evtloop.cpp).
extern "C" int wxWasmBeginWait( const char* aKind );
extern "C" int wxWasmYieldUntil( int aToken );

// Event dispatcher: provider `{ evt }` frames -> KiCad's registered callbacks
// via the exported pcbjam_ngspice_event (fresh wasm entries; see header
// comment).
//
// E-5: the handler is bound to the EXACT installing module, not to whatever
// `Module` lexically means when an event later arrives. Presence is not
// identity: the old install-once guard let a replacement module (trap
// recovery is module replacement — cross-ref G-8) keep the retired module's
// handler, whose closure drove the dead instance's heap. Re-installation is
// idempotent only for the same module; a different module replaces the
// handler, and a superseded handler disarms itself.
EM_JS( void, js_ngspice_install_events, (), {
    const installingModule = Module;
    const installed = globalThis.__ngspiceOnEvent;
    if( installed && installed.__pcbjamNgspiceOwnerModule === installingModule )
        return;
    const handler = ( evt ) => {
        if( globalThis.__ngspiceOnEvent !== handler )
            return; // superseded install — never drive a retired module
        const sched = globalThis.__wxScheduler;
        if( !sched || !sched.canTouchNative || !sched.canTouchNative() ) {
            // E-8/M-2: a dead or terminal instance takes no native entry; the
            // drop is loud, never silent.
            console.warn( '[sharedspice_client] dropping ngspice event for a '
                          + 'dead/terminal module' );
            return;
        }
        const call = ( kind, text, a, b ) => {
            let p = 0;
            if( text != null ) {
                const n = lengthBytesUTF8( text ) + 1;
                // Bare closure exports: this EM_JS body is compiled into the
                // installing module's glue closure, so _malloc/stringToUTF8
                // ARE that exact module's (Module._malloc is not populated in
                // this build). The identity guarantee is the handler capture
                // plus the __ngspiceOnEvent self-disarm above.
                p = _malloc( n );
                stringToUTF8( text, p, n );
            }
            installingModule._pcbjam_ngspice_event( kind, p, a | 0, b | 0 );
        };
        try {
            if( evt.kind === 'char' || evt.kind === 'stat' ) {
                for( const line of evt.lines || [] )
                    call( evt.kind === 'char' ? 0 : 1, line, 0, 0 );
            } else if( evt.kind === 'bg' ) {
                call( 2, null, evt.finished ? 1 : 0, 0 );
            } else if( evt.kind === 'exit' ) {
                call( 3, null, evt.status | 0,
                      ( evt.immediate ? 1 : 0 ) | ( evt.quit ? 2 : 0 ) );
            }
        } catch( e ) {
            // A trap on this fresh entry poisons the instance: latch the
            // terminal gate so no later completion re-enters it.
            if( !sched._terminalizeNativeTrap
                    || !sched._terminalizeNativeTrap( 'ngspice event entry', e ) )
                throw e;
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

    // Token 0 = the scheduler refused the wait (dead or terminal instance):
    // never start an RPC whose completion could not be admitted.
    if( token <= 0 )
        return json{ { "error", "wx scheduler unavailable" } };

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
// Event entry from JS (fresh wasm entry; must never suspend)
// -------------------------------------------------------------------------

extern "C" EMSCRIPTEN_KEEPALIVE void pcbjam_ngspice_event( int aKind, char* aText, int aA, int aB )
{
    switch( aKind )
    {
    case 0: // char
        if( s_sendChar )
            s_sendChar( aText ? aText : const_cast<char*>( "" ), 0, s_user );
        break;

    case 1: // stat
        if( s_sendStat )
            s_sendStat( aText ? aText : const_cast<char*>( "" ), 0, s_user );
        break;

    case 2: // bg: aA = finished
        s_bgRunning.store( aA == 0 );

        if( s_bgThreadRunning )
            s_bgThreadRunning( aA != 0, 0, s_user );
        break;

    case 3: // exit: aA = status, aB = immediate|quit<<1
        s_bgRunning.store( false );

        if( s_controlledExit )
            s_controlledExit( aA, ( aB & 1 ) != 0, ( aB & 2 ) != 0, 0, s_user );
        break;
    }

    std::free( aText );
}

// E-9: a destroyed NGSPICE must unregister its callbacks — a late worker
// event otherwise reaches s_sendChar( text, 0, s_user ) with s_user pointing
// at the destroyed object (use-after-free after simulator close; the E-7
// run-generation gate sits downstream in the wx event queue and cannot cover
// this entry). Identity-checked so a stale destructor never clears a
// successor instance's registration.
extern "C" EMSCRIPTEN_KEEPALIVE void pcbjam_ngspice_reset_callbacks( void* aUser )
{
    if( s_user != aUser )
        return;

    s_sendChar = nullptr;
    s_sendStat = nullptr;
    s_controlledExit = nullptr;
    s_bgThreadRunning = nullptr;
    s_user = nullptr;
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

    // Token 0 = the scheduler refused the wait (dead or terminal instance).
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
