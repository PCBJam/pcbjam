/**
 * async_preload_test.cpp
 *
 * Standalone repro of KiCad-10's library-preload SHAPE (docs/features/wasm-exceptions/10 §7) —
 * NOT using real KiCad/pcbnew. Proves native wasm-EH makes the shape safe.
 *
 * The shape (mirrors kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp):
 *   - a std::async(std::launch::async, …) background worker (NOT the thread pool) that, per
 *     "library", PROXIES a fetch to the main thread (emscripten_proxy_sync_with_ctx) and then
 *     PARSES the bytes on the worker — the parse THROWS an IO_ERROR-like exception (the "mode-c"
 *     trigger: a throw caught ON a worker drives Asyncify under -fexceptions → crash; native
 *     wasm-EH decouples it → safe).
 *   - a LAZY join: main keeps the std::future alive and never blocks in normal operation, so it
 *     stays in its event loop to service the worker's proxied fetches.
 *   - independent worker→main proxy round-trips.  A proxy callback is only a request starter:
 *     it copies the request identity, starts a JavaScript Promise, and returns.  The Promise's
 *     short native finish later enters through the scheduler's native-completion gate.
 *
 * Modes 0–3 keep a synchronous mock fetch because they test worker exceptions, shutdown, and the
 * modal pump.  Mode 4 uses the complete asynchronous bridge shape.  It holds every provider
 * Promise until all requests have started, resolves them in reverse start order, and checks that
 * every blocked worker receives only its own reply.  There is deliberately no proxy mutex: network
 * requests must overlap; only their short native completions are serialized.
 *
 * URL ?m=0 simple | 1 throw (parse throws → caught on worker, no mode-c crash) |
 *         2 shutdown (main blocking-joins the future mid-load) | 3 modal (a modal opens while
 *         workers proxy) | 4 concurrent (held provider Promises resolve out of order)
 *
 * Console contract:
 *   [PRELOAD] START m=..      [PRELOAD] EH=native|js
 *   [PRELOAD] SUCCESS m=.. caught=.. loaded=..
 */

#include "wx/wx.h"

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <future>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#endif

// ---------------------------------------------------------------------------
static void plog( const char* fmt, ... )
{
    char buf[512];
    va_list ap;
    va_start( ap, fmt );
    vsnprintf( buf, sizeof( buf ), fmt, ap );
    va_end( ap );
#ifdef __EMSCRIPTEN__
    EM_ASM( { console.log( UTF8ToString( $0 ) ); }, buf );
#else
    printf( "%s\n", buf );
#endif
}

static int readMode()
{
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT( {
        var raw = location.search ? location.search.slice( 1 ) : location.hash.slice( 1 );
        var v = parseInt( new URLSearchParams( raw ).get( 'm' ), 10 );
        return isNaN( v ) ? 0 : v;
    } );
#else
    return 0;
#endif
}

static void mainSleep( int ms )
{
#ifdef __EMSCRIPTEN__
    emscripten_sleep( ms ); // Asyncify yield → main's event loop runs (services the proxy queue)
#else
    std::this_thread::sleep_for( std::chrono::milliseconds( ms ) );
#endif
}

// ---------------------------------------------------------------------------
// The simple proxied "fetch": worker → main round-trip used by modes 0–3.
// ---------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
extern "C" EMSCRIPTEN_KEEPALIVE void preload_finish( em_proxying_ctx* ctx )
{
    emscripten_proxy_finish( ctx );
}

static void proxy_fetch_on_main( em_proxying_ctx* ctx, void* )
{
    // Runs on the MAIN thread via the system proxying queue. Synchronous finish (see header note).
    preload_finish( ctx );
}
#endif

static std::string proxyFetchToMain( const std::string& lib )
{
#ifdef __EMSCRIPTEN__
    if( emscripten_is_main_runtime_thread() )
        return "(mock " + lib + ")"; // main path (not exercised here; the preload runs on a worker)

    em_proxying_queue* q = emscripten_proxy_get_system_queue();
    if( !emscripten_proxy_sync_with_ctx( q, emscripten_main_runtime_thread_id(),
                                         proxy_fetch_on_main, nullptr ) )
        return "";
#endif
    return "(mock " + lib + ")";
}

// ---------------------------------------------------------------------------
// Concurrent asynchronous proxy reducer (mode 4).
//
// Each request remains on its worker's stack while emscripten_proxy_sync_with_ctx()
// blocks that worker.  The main-thread callback copies the scalar identity and
// result address into a JavaScript closure, starts a held provider Promise, and
// returns.  The Promise completion writes and finishes that exact request through
// the same native-entry gate used by the production library bridges.
// ---------------------------------------------------------------------------
static constexpr int CONCURRENT_REQUESTS = 4;
static constexpr int CONCURRENT_PENDING = -0x1234567;
static constexpr unsigned int CONCURRENT_GUARD_BEFORE = 0x51A7B001u;
static constexpr unsigned int CONCURRENT_GUARD_AFTER = 0x51A7B002u;

struct ConcurrentRequest
{
    unsigned int guardBefore = CONCURRENT_GUARD_BEFORE;
    int          id = -1;
    int          result = CONCURRENT_PENDING;
    unsigned int guardAfter = CONCURRENT_GUARD_AFTER;
};

static std::atomic<int> g_concurrentDone{ 0 };
static std::atomic<int> g_exactReplies{ 0 };
static std::atomic<int> g_replyMismatches{ 0 };
static std::atomic<int> g_nativeCompletions{ 0 };
static std::atomic<int> g_nativeCompletionActive{ 0 };
static std::atomic<int> g_nativeCollisions{ 0 };
static std::atomic<int> g_finishSeen[CONCURRENT_REQUESTS];

static int concurrentExpectedValue( int id )
{
    return 1000 + id * 37;
}

#ifdef __EMSCRIPTEN__
extern "C" EMSCRIPTEN_KEEPALIVE void preload_concurrent_finish( em_proxying_ctx* ctx,
                                                                 ConcurrentRequest* request,
                                                                 int id, int value )
{
    const int active = g_nativeCompletionActive.fetch_add( 1 ) + 1;

    if( active != 1 )
        g_nativeCollisions.fetch_add( 1 );

    bool valid = request && id >= 0 && id < CONCURRENT_REQUESTS
                 && request->guardBefore == CONCURRENT_GUARD_BEFORE
                 && request->guardAfter == CONCURRENT_GUARD_AFTER
                 && request->id == id && request->result == CONCURRENT_PENDING;

    if( valid && g_finishSeen[id].fetch_add( 1 ) == 0 )
        request->result = value;
    else
        g_replyMismatches.fetch_add( 1 );

    g_nativeCompletions.fetch_add( 1 );
    emscripten_proxy_finish( ctx );
    g_nativeCompletionActive.fetch_sub( 1 );
}

static void concurrent_proxy_on_main( em_proxying_ctx* ctx, void* arg )
{
    ConcurrentRequest* request = static_cast<ConcurrentRequest*>( arg );

    EM_ASM( {
        const ctx = $0;
        const requestPtr = $1;
        const id = $2;
        const expected = $3;
        const count = $4;

        // The state is initialized by runConcurrentProxyScenario() before any
        // worker starts.  Creating the Promise here models kicadLibs.request:
        // its executor records that network work has started, but its resolver
        // remains held until every independent request is in flight.
        const provider = () => new Promise( ( resolve ) => {
            const state = globalThis.__preloadConcurrent;
            if( !state || state.expected !== count )
                throw new Error( '[PRELOAD] concurrent provider state missing' );

            state.started += 1;
            state.startOrder.push( id );
            state.pending.push( { id, expected, resolve } );
            console.log( '[PRELOAD] concurrent provider-start id=' + id
                         + ' started=' + state.started + ' resolved=' + state.resolved );

            if( state.started !== state.expected )
                return;

            state.allStartedBeforeResolve = state.resolved === 0;
            console.log( '[PRELOAD] concurrent ALL_STARTED started=' + state.started
                         + ' resolved=' + state.resolved );

            // Resolve in the exact reverse of provider start order.  All
            // Promise reactions then enqueue their independent native finishes;
            // no request has to wait for a preceding fetch to settle.
            setTimeout( () => {
                state.pending.slice().reverse().forEach( ( item ) => {
                    if( state.firstResolveStarted < 0 )
                        state.firstResolveStarted = state.started;
                    state.resolved += 1;
                    state.resolveOrder.push( item.id );
                    console.log( '[PRELOAD] concurrent provider-resolve id=' + item.id
                                 + ' resolved=' + state.resolved );
                    item.resolve( item.expected );
                } );
            }, 0 );
        } );

        Promise.resolve()
            .then( provider )
            .then( ( value ) => {
                const deliver = () =>
                    _preload_concurrent_finish( ctx, requestPtr, id, value );
                const scheduler = globalThis.__wxScheduler;

                if( scheduler && typeof scheduler.enqueueNativeCompletion === 'function' )
                {
                    const accepted = scheduler.enqueueNativeCompletion(
                        'async preload provider completion', 8, deliver );
                    if( !accepted )
                        console.error( '[PRELOAD] concurrent native completion rejected id=' + id );
                    return;
                }

                // The standalone reducer normally has the wx scheduler.  Keep
                // the converter-style fallback equivalent to production.
                if( !globalThis.__wxNativeIntegrityUnknown )
                    deliver();
            } )
            .catch( ( error ) => {
                console.error( '[PRELOAD] concurrent provider failed id=' + id, error );
            } );
    }, ctx, request, request->id, concurrentExpectedValue( request->id ), CONCURRENT_REQUESTS );
}
#endif

static void concurrentWorker( int id )
{
    ConcurrentRequest request;
    request.id = id;

#ifdef __EMSCRIPTEN__
    em_proxying_queue* queue = emscripten_proxy_get_system_queue();
    const bool proxied = emscripten_proxy_sync_with_ctx(
            queue, emscripten_main_runtime_thread_id(), concurrent_proxy_on_main, &request );
#else
    const bool proxied = true;
    request.result = concurrentExpectedValue( id );
#endif

    const bool exact = proxied && request.guardBefore == CONCURRENT_GUARD_BEFORE
                       && request.guardAfter == CONCURRENT_GUARD_AFTER && request.id == id
                       && request.result == concurrentExpectedValue( id );

    if( exact )
        g_exactReplies.fetch_add( 1 );
    else
        g_replyMismatches.fetch_add( 1 );

    g_concurrentDone.fetch_add( 1 );
}

static void runConcurrentProxyScenario()
{
    g_concurrentDone.store( 0 );
    g_exactReplies.store( 0 );
    g_replyMismatches.store( 0 );
    g_nativeCompletions.store( 0 );
    g_nativeCompletionActive.store( 0 );
    g_nativeCollisions.store( 0 );

    for( auto& seen : g_finishSeen )
        seen.store( 0 );

#ifdef __EMSCRIPTEN__
    EM_ASM( {
        // Assign fields separately: top-level commas in an EM_ASM body are
        // interpreted as C preprocessor argument separators.
        const state = {};
        state.expected = $0;
        state.started = 0;
        state.resolved = 0;
        state.firstResolveStarted = -1;
        state.allStartedBeforeResolve = false;
        state.startOrder = [];
        state.resolveOrder = [];
        state.pending = [];
        globalThis.__preloadConcurrent = state;
    }, CONCURRENT_REQUESTS );
#endif

    std::vector<std::thread> workers;
    workers.reserve( CONCURRENT_REQUESTS );

    for( int id = 0; id < CONCURRENT_REQUESTS; ++id )
        workers.emplace_back( concurrentWorker, id );

    // The main runtime thread must remain yielded so it can start all provider
    // Promises and later admit their exact native completions.
    for( int i = 0; i < 3000 && g_concurrentDone.load() != CONCURRENT_REQUESTS; ++i )
        mainSleep( 10 );

    for( auto& worker : workers )
        worker.join();

    int started = CONCURRENT_REQUESTS;
    int resolved = CONCURRENT_REQUESTS;
    int firstResolveStarted = CONCURRENT_REQUESTS;
    int allStartedBeforeResolve = 1;
    int outOfOrder = 1;

#ifdef __EMSCRIPTEN__
    started = EM_ASM_INT( { return globalThis.__preloadConcurrent.started | 0; } );
    resolved = EM_ASM_INT( { return globalThis.__preloadConcurrent.resolved | 0; } );
    firstResolveStarted = EM_ASM_INT( {
        return globalThis.__preloadConcurrent.firstResolveStarted | 0;
    } );
    allStartedBeforeResolve = EM_ASM_INT( {
        return globalThis.__preloadConcurrent.allStartedBeforeResolve ? 1 : 0;
    } );
    outOfOrder = EM_ASM_INT( {
        const state = globalThis.__preloadConcurrent;
        if( state.startOrder.length !== state.resolveOrder.length )
            return 0;
        return state.startOrder.some( ( id, index ) => id !== state.resolveOrder[index] ) ? 1 : 0;
    } );
#endif

    plog( "[PRELOAD] CONCURRENCY_RESULT started=%d resolved=%d firstResolveStarted=%d "
          "allStartedBeforeResolve=%d outOfOrder=%d exact=%d mismatches=%d "
          "nativeCompletions=%d nativeCollisions=%d",
          started, resolved, firstResolveStarted, allStartedBeforeResolve, outOfOrder,
          g_exactReplies.load(), g_replyMismatches.load(), g_nativeCompletions.load(),
          g_nativeCollisions.load() );
    plog( "[PRELOAD] SUCCESS m=4 caught=0 loaded=0" );
}

// ---------------------------------------------------------------------------
class IO_ERROR : public std::runtime_error
{
public:
    explicit IO_ERROR( const std::string& m ) : std::runtime_error( m ) {}
};

static std::size_t parseLib( const std::string& data, bool shouldThrow )
{
    if( shouldThrow )
        throw IO_ERROR( "simulated S-expr parse failure" ); // the mode-c trigger
    return data.find( "mock" ) != std::string::npos ? 1u : 0u;
}

// ---------------------------------------------------------------------------
static std::atomic<bool> g_caught{ false };
static std::atomic<int>  g_loaded{ 0 };
static std::atomic<bool> g_done{ false };
static std::atomic<bool> g_abort{ false };
static std::future<void> g_future; // kept alive => LAZY join (dtor blocks only at teardown)

static void preloadRun( bool throwOnParse )
{
    try
    {
        std::this_thread::sleep_for( std::chrono::milliseconds( 20 ) ); // worker-side watchdog
        for( const char* lib : { "lib_a", "lib_b", "lib_c" } )
        {
            if( g_abort.load() )
                break; // the CancelPreload mitigation: bail before the next proxy
            std::string data = proxyFetchToMain( lib );   // proxy the fetch to main
            g_loaded.fetch_add( (int) parseLib( data, throwOnParse ) ); // parse ON the worker (throws)
        }
    }
    catch( const std::exception& e )
    {
        g_caught.store( true );
        plog( "[PRELOAD] worker caught: %s", e.what() );
    }
    g_done.store( true );
}

// ---------------------------------------------------------------------------
// minimal auto-closing modal (timer armed before ShowModal; closes itself)
// ---------------------------------------------------------------------------
static constexpr int ID_MODAL_CLOSE = wxID_HIGHEST + 700;

class AutoCloseDialog : public wxDialog
{
public:
    AutoCloseDialog( wxWindow* parent, int delayMs ) :
            wxDialog( parent, wxID_ANY, "preload-modal", wxDefaultPosition, wxSize( 280, 120 ) ),
            m_timer( this, ID_MODAL_CLOSE )
    {
        Bind( wxEVT_SHOW, &AutoCloseDialog::OnShow, this );
        Bind( wxEVT_TIMER, [this] ( wxTimerEvent& ) { plog( "[PRELOAD] modal: close-timer fired" ); EndModal( wxID_OK ); }, ID_MODAL_CLOSE );
        m_delayMs = delayMs;
    }

private:
    void OnShow( wxShowEvent& e )
    {
        if( e.IsShown() )
        {
            plog( "[PRELOAD] modal: shown, arming %dms auto-close", m_delayMs );
            m_timer.StartOnce( m_delayMs );
        }
        e.Skip();
    }
    wxTimer m_timer;
    int     m_delayMs = 300;
};

// ---------------------------------------------------------------------------
static constexpr int ID_SCENARIO_TIMER = wxID_HIGHEST + 701;

class PreloadFrame : public wxFrame
{
public:
    PreloadFrame() : wxFrame( nullptr, wxID_ANY, "Async Preload Test",
                              wxDefaultPosition, wxSize( 420, 140 ) ),
                     m_scenarioTimer( this, ID_SCENARIO_TIMER )
    {
        wxPanel* p = new wxPanel( this );
        wxBoxSizer* s = new wxBoxSizer( wxVERTICAL );
        s->Add( new wxStaticText( p, wxID_ANY, "std::async library-preload repro — see console." ),
                0, wxALL, 16 );
        p->SetSizer( s );
        Bind( wxEVT_TIMER, &PreloadFrame::OnScenario, this, ID_SCENARIO_TIMER );
    }

    void armModalScenario() { m_scenarioTimer.StartOnce( 50 ); }

private:
    // Runs INSIDE the main event loop (the modal pump needs that — ShowModal straight from OnInit,
    // before the loop starts, hangs). Several workers each do a bounded series of worker->main proxy
    // round-trips with a small gap so the modal pump can dispatch its auto-close timer.  The system
    // proxy queue delivers the leaf callbacks; no category-wide request mutex is involved.
    void OnScenario( wxTimerEvent& )
    {
        std::atomic<int>         rounds{ 0 };
        std::vector<std::thread> workers;
        for( int i = 0; i < 3; ++i )
            workers.emplace_back( [&rounds]
            {
                for( int k = 0; k < 12; ++k )
                {
                    proxyFetchToMain( "spam" );
                    rounds.fetch_add( 1 );
                    std::this_thread::sleep_for( std::chrono::milliseconds( 10 ) );
                }
            } );

        plog( "[PRELOAD] modal: workers spawned, showing modal" );
        AutoCloseDialog dlg( this, 300 );
        dlg.ShowModal();
        plog( "[PRELOAD] modal: ShowModal returned (rounds=%d)", rounds.load() );

        for( auto& t : workers )
            t.join();
        plog( "[PRELOAD] SUCCESS m=3 caught=0 loaded=0 proxyRounds=%d", rounds.load() );
    }

    wxTimer m_scenarioTimer;
};

class PreloadApp : public wxApp
{
public:
    bool OnInit() override
    {
        const int mode = readMode();
        plog( "[PRELOAD] START m=%d", mode );
#ifdef __WASM_EXCEPTIONS__
        plog( "[PRELOAD] EH=native" );
#else
        plog( "[PRELOAD] EH=js" );
#endif
        g_caught.store( false );
        g_loaded.store( 0 );
        g_done.store( false );
        g_abort.store( false );

        PreloadFrame* frame = new PreloadFrame();
        frame->Show();

        if( mode == 3 )
        {
            frame->armModalScenario(); // runs in the main loop; logs its own [PRELOAD] SUCCESS m=3
            return true;
        }

        if( mode == 4 )
        {
            runConcurrentProxyScenario();
            return true;
        }

        const bool throwOnParse = ( mode == 1 );
        g_future = std::async( std::launch::async, [throwOnParse] { preloadRun( throwOnParse ); } );

        if( mode == 2 ) // shutdown: blocking-join the future mid-load (synchronous proxies complete
                        // during the futex busy-wait's queue processing)
        {
            mainSleep( 30 );
            g_abort.store( true );
            g_future.wait();
            plog( "[PRELOAD] shutdown joined" );
        }
        else // simple / throw: LAZY join — poll via emscripten_sleep, main stays live
        {
            for( int i = 0; i < 200 && !g_done.load(); ++i )
                mainSleep( 20 );
        }

        plog( "[PRELOAD] SUCCESS m=%d caught=%d loaded=%d",
              mode, g_caught.load() ? 1 : 0, g_loaded.load() );
        return true;
    }
};

wxIMPLEMENT_APP( PreloadApp );
