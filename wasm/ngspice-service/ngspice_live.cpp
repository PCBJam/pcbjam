/*
 * ngspice_live - the live-simulation engine, a second set of entry points in
 * the ngspice_service module (design: docs/features/simulation/).
 *
 * One module, two kinds of session, each in a Worker of its own:
 *   - eeschema's simulator window uses the sharedspice RPC of
 *     ngspice_service_main.cpp (init, circ, command, ...)
 *   - a live session uses the functions of this file (liveInit, liveCirc, ...)
 * A Worker is one or the other: a live Worker never calls init(), the
 * simulator's Worker never calls liveInit(). Until liveInit() runs, nothing
 * in this file does anything (see the four __wrap_ functions).
 *
 * It links the same libngspice.a and code-model archives, unchanged, and adds
 * what a live session needs:
 *
 *   pacing     the transient is held to the wall clock inside ngspice's own
 *              step loop (ngSpice_Init_Sync), with pause and a speed factor
 *   inputs     EXTERNAL sources read their value from a table the page
 *              writes; a change becomes a 1 ms ramp
 *   values     every accepted time point updates a "latest" and a
 *              time-averaged table. Nothing is stored in ngspice (save none);
 *              the page reads one snapshot per picture frame
 *   code parts ngspice's d_cosim loads its co-simulator with dlopen/dlsym.
 *              Those four libc calls are redirected at link time (-Wl,--wrap)
 *              to a registry of WebAssembly modules. Each part is
 *              instantiated in the simulation thread, in its own memory, and
 *              reached through three flat functions. No ngspice source
 *              changes.
 *
 * RPC surface (embind, called by web/standalone/src/wasm/ngspice-live-worker.js):
 *   liveInit()                 -> int   ngSpice_Init with the live callbacks
 *   liveCirc(lines, files)     -> int   stage the model files, drop the last
 *                                       circuit, load this one. -1 = a run is
 *                                       still going. 0 does NOT mean ngspice
 *                                       took the circuit: it says 0 for a
 *                                       circuit it cannot run, too
 *   liveStart()                -> int   start the transient in the background.
 *                                       The circuit runs once livePoints() is
 *                                       above 0; a circuit ngspice cannot run
 *                                       ends before that (liveRunState() 0)
 *   liveStop()                 -> int   halt it. -1 = its thread has not
 *                                       come up yet, ask again
 *   liveRunState()             -> int   0 = nothing runs, 1 = started, the
 *                                       thread is not up yet, 2 = running
 *   livePoints()               -> number    time points solved in this run
 *   liveProblem()              -> string    as "problem" in the snapshot
 *   liveSetInput(name, value)           name = the source as ngspice calls it
 *                                       ("v.xsw1.vctl")
 *   liveSetSpeed(x)                     simulated seconds per second; 0 = as
 *                                       fast as it goes
 *   liveSetPaused(bool)
 *   liveNames()                -> string[]  the vectors of the running circuit
 *   liveSnapshot()             -> {t, points, load, achieved, lagging,
 *                                  running, gen, problem, latest, avg}
 *                                  problem: why a code part of this run could
 *                                  not be loaded ("" = none). ngspice goes on
 *                                  without the part; the caller stops the run
 *   liveRegisterPart(name, bytes)       the WebAssembly module of a code part
 *   livePartAt(name)           -> number    for tests: where its bytes are
 *
 * Threads: a function here runs either on the module's main thread (the
 * Worker; embind calls) or on ngspice's background thread (callbacks, part
 * calls). Shared state is plain memory, guarded as noted.
 */

#include <atomic>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include <emscripten.h>
#include <emscripten/bind.h>

#include "ngspice/sharedspice.h"

// ngspice's co-simulation contract (its own header, taken from the ngspice
// source tree by CMakeLists.txt) and the XSPICE digital types it refers to.
extern "C" {
typedef enum { ZERO, ONE, UNKNOWN } Digital_State_t;
typedef enum { STRONG, RESISTIVE, HI_IMPEDANCE, UNDETERMINED } Digital_Strength_t;
typedef struct
{
    Digital_State_t    state;
    Digital_Strength_t strength;
} Digital_t;
#include "ngspice/cosim.h"
}

using namespace emscripten;

// The JavaScript of pj_part_load turns text into a C string for pj_host_log.
EM_JS_DEPS( ngspice_live, "$stringToNewUTF8" );

namespace
{

std::atomic<bool> s_inited{ false }; // liveInit() ran: this Worker is a live session

// Whether a run is going, kept here and not asked from ngspice. ngspice counts a background
// run as running only once its thread has come up, and halting it before that leaves a
// thread that can no longer be halted. A thread from the pool can take a while to come up.
enum RunState
{
    RUN_NONE = 0,     // nothing runs
    RUN_STARTING = 1, // bg_run was given, the thread has not reported in
    RUN_GOING = 2,    // the thread runs
};

std::atomic<int> s_run{ RUN_NONE };

// ---------------------------------------------------------------------------
// Console events (the shape of ngspice_service_main.cpp, plus one kind)
// ---------------------------------------------------------------------------

enum EvtKind
{
    EVT_CHAR = 0,
    EVT_STAT = 1,
    EVT_BG = 2,
    EVT_EXIT = 3,
    EVT_PART = 4, // text from a code part or about one. a: 0 = info, 1 = new code loaded, 2 = a problem
};

// Safe from any thread. The string is strdup'd and freed by the proxied JS.
void emitEvt( int aKind, const char* aText, int aA, int aB )
{
    char* copy = aText ? strdup( aText ) : nullptr;

    MAIN_THREAD_ASYNC_EM_ASM(
        {
            var s = $1 ? UTF8ToString( $1 ) : null;
            if( $1 )
                _free( $1 );
            if( Module.ngspiceEmit )
                Module.ngspiceEmit( $0, s, $2, $3 );
        },
        aKind, copy, aA, aB );
}

int cbSendChar( char* aWhat, int, void* )
{
    emitEvt( EVT_CHAR, aWhat, 0, 0 );
    return 0;
}

int cbSendStat( char* aWhat, int, void* )
{
    emitEvt( EVT_STAT, aWhat, 0, 0 );
    return 0;
}

int cbControlledExit( int aStatus, NG_BOOL aImmediate, NG_BOOL aQuit, int, void* )
{
    emitEvt( EVT_EXIT, nullptr, aStatus, ( aImmediate ? 1 : 0 ) | ( aQuit ? 2 : 0 ) );
    return 0;
}

// Called by the background thread itself: first thing when it comes up, last thing before
// it ends (whatever ended the run).
int cbBGThreadRunning( NG_BOOL aNotRunning, int, void* )
{
    s_run = aNotRunning ? RUN_NONE : RUN_GOING;
    emitEvt( EVT_BG, nullptr, aNotRunning ? 1 : 0, 0 );
    return 0;
}

// ---------------------------------------------------------------------------
// Values: latest + time average per vector, filled on the simulation thread
// ---------------------------------------------------------------------------

std::mutex               s_valMutex;
std::vector<std::string> s_names;
std::vector<double>      s_latest;       // value at the last accepted time point
std::vector<double>      s_integral;     // integral of the value since the last snapshot
double                   s_winStart = 0; // sim time at the last snapshot
double                   s_simTime = 0;  // last accepted sim time
int                      s_namesGen = 0; // bumped when a run announces its vectors
std::atomic<long>        s_points{ 0 };

// ngspice announces the vectors of a run before its first time point.
int cbSendInitData( pvecinfoall aInfo, int, void* )
{
    std::lock_guard<std::mutex> lock( s_valMutex );
    s_names.clear();

    for( int i = 0; i < aInfo->veccount; i++ )
        s_names.push_back( aInfo->vecs[i]->vecname ? aInfo->vecs[i]->vecname : "" );

    s_latest.assign( s_names.size(), 0.0 );
    s_integral.assign( s_names.size(), 0.0 );
    s_winStart = 0;
    s_simTime = 0;
    s_points = 0;
    s_namesGen++;
    return 0;
}

// One accepted time point.
int cbSendData( pvecvaluesall aAll, int, int, void* )
{
    std::lock_guard<std::mutex> lock( s_valMutex );
    const int                   n = aAll->veccount;

    if( (size_t) n != s_latest.size() )
        return 0;

    double t = s_simTime;

    for( int i = 0; i < n; i++ )
    {
        if( aAll->vecsa[i]->is_scale )
            t = aAll->vecsa[i]->creal;
    }

    const double dt = t - s_simTime;

    for( int i = 0; i < n; i++ )
    {
        const double v = aAll->vecsa[i]->creal;

        if( dt > 0 )
            s_integral[i] += 0.5 * ( s_latest[i] + v ) * dt; // trapezoid

        s_latest[i] = v;
    }

    s_simTime = t;
    s_points++;
    return 0;
}

// ---------------------------------------------------------------------------
// Inputs: EXTERNAL sources driven from the page, with a short ramp
// ---------------------------------------------------------------------------
//
// The simulation thread asks for every source on every solver iteration, by
// name, so the lookup must not lock: a hash table that only grows while a
// circuit is loaded. An entry is complete before it becomes visible.

constexpr int    MAX_INPUTS = 1024;
constexpr int    INPUT_SLOTS = 4096;  // a power of two, at most a quarter full
constexpr double INPUT_RAMP = 1e-3;   // seconds of simulated time

struct Input
{
    std::string         name;
    std::atomic<double> target{ 0.0 }; // written by the page
    double              applied = 0;   // the target the ramp is heading to
    double              v0 = 0;        // the value when the ramp started
    double              t0 = -1;       // sim time when the ramp started; < 0 = no ramp
};

Input            s_inputs[MAX_INPUTS];
std::atomic<int> s_inputCount{ 0 };
std::atomic<int> s_inputSlot[INPUT_SLOTS]; // 0 = empty, else index + 1
std::mutex       s_inputMutex;             // guards adding and clearing

unsigned hashNoCase( const char* aText )
{
    unsigned h = 0x811c9dc5u;

    for( ; *aText; aText++ )
    {
        h ^= (unsigned char) tolower( (unsigned char) *aText );
        h *= 0x01000193u;
    }

    return h;
}

// The slot of aName, or the empty slot where it belongs. Returns the input when found.
Input* probeInput( const char* aName, unsigned& aSlot )
{
    for( ;; aSlot = ( aSlot + 1 ) & ( INPUT_SLOTS - 1 ) )
    {
        const int idx = s_inputSlot[aSlot].load( std::memory_order_acquire );

        if( idx == 0 )
            return nullptr;

        if( strcasecmp( s_inputs[idx - 1].name.c_str(), aName ) == 0 )
            return &s_inputs[idx - 1];
    }
}

Input* findInput( const char* aName, bool aCreate )
{
    unsigned slot = hashNoCase( aName ) & ( INPUT_SLOTS - 1 );

    if( Input* found = probeInput( aName, slot ) )
        return found;

    if( !aCreate )
        return nullptr;

    std::lock_guard<std::mutex> lock( s_inputMutex );

    // the other thread may have added it in the meantime
    if( Input* found = probeInput( aName, slot ) )
        return found;

    const int count = s_inputCount.load();

    if( count >= MAX_INPUTS )
        return nullptr;

    Input& in = s_inputs[count];
    in.name = aName;
    in.target = 0.0;
    in.applied = 0.0;
    in.v0 = 0.0;
    in.t0 = -1.0;
    s_inputCount.store( count + 1 );
    s_inputSlot[slot].store( count + 1, std::memory_order_release );
    return &in;
}

// A new circuit has its own inputs. Only while nothing runs.
void clearInputs()
{
    std::lock_guard<std::mutex> lock( s_inputMutex );

    for( std::atomic<int>& slot : s_inputSlot )
        slot.store( 0, std::memory_order_release );

    s_inputCount.store( 0 );
}

double inputValueAt( const Input& aIn, double aTime )
{
    if( aIn.t0 < 0 )
        return aIn.applied;

    double k = ( aTime - aIn.t0 ) / INPUT_RAMP;
    k = k < 0 ? 0 : ( k > 1 ? 1 : k );
    return aIn.v0 + ( aIn.applied - aIn.v0 ) * k;
}

// Called on every solver iteration for every EXTERNAL source: cheap, and a pure
// function of the time ngspice asks about (steps are retried with smaller deltas).
int cbGetVsrc( double* aValue, double aTime, char* aName, int, void* )
{
    const Input* in = aName ? findInput( aName, true ) : nullptr;
    *aValue = in ? inputValueAt( *in, aTime ) : 0.0;
    return 0;
}

int cbGetIsrc( double* aValue, double, char*, int, void* )
{
    *aValue = 0.0;
    return 0;
}

// ---------------------------------------------------------------------------
// Pacing: hold simulated time to the wall clock, between time steps
// ---------------------------------------------------------------------------

std::atomic<double> s_speed{ 1.0 }; // simulated seconds per wall second
std::atomic<bool>   s_paused{ false };
std::atomic<bool>   s_stopping{ false };
std::atomic<bool>   s_paceReset{ true };

double s_wallBase = 0; // ms
double s_simBase = 0;  // s
double s_lastSpeed = 1.0;

// statistics, read by liveSnapshot()
std::atomic<double> s_sleptMs{ 0 };
std::atomic<int>    s_lagging{ 0 };

int cbSync( double aTime, double* aDelta, double, int, int, int aLoc, void* )
{
    // aLoc 0 = top of the time-step loop: aTime is the last accepted point and *aDelta the
    // step ngspice is about to take. (aLoc 1 = after a step, accept or redo; left alone.)
    if( aLoc != 0 )
        return 0;

    // start the ramps of inputs whose target changed since the last step
    const int n = s_inputCount.load();

    for( int i = 0; i < n; i++ )
    {
        Input&       in = s_inputs[i];
        const double target = in.target.load();

        if( target != in.applied )
        {
            in.v0 = inputValueAt( in, aTime );
            in.t0 = aTime;
            in.applied = target;

            // resolve the ramp: do not step over it in one go
            if( aDelta && *aDelta > INPUT_RAMP / 8 )
                *aDelta = INPUT_RAMP / 8;
        }
    }

    double now = emscripten_get_now();

    while( s_paused.load() && !s_stopping.load() )
    {
        usleep( 2000 );
        s_sleptMs = s_sleptMs.load() + ( emscripten_get_now() - now );
        s_paceReset = true;
        now = emscripten_get_now();
    }

    const double speed = s_speed.load();

    if( s_paceReset.exchange( false ) || speed != s_lastSpeed )
    {
        s_wallBase = now;
        s_simBase = aTime;
        s_lastSpeed = speed;
    }

    if( speed <= 0 ) // as fast as it goes
        return 0;

    const double allowed = s_simBase + ( now - s_wallBase ) / 1000.0 * speed;

    if( aTime > allowed )
    {
        // ahead of the clock: sleep it off, in slices, so pause and stop stay responsive
        double waitMs = ( aTime - allowed ) / speed * 1000.0;

        while( waitMs > 0 && !s_stopping.load() && !s_paused.load() )
        {
            const double slice = waitMs > 20 ? 20 : waitMs;
            const double before = emscripten_get_now();
            usleep( (useconds_t) ( slice * 1000 ) );
            s_sleptMs = s_sleptMs.load() + ( emscripten_get_now() - before ); // what it really slept
            waitMs -= slice;
        }

        s_lagging = 0;
    }
    else if( allowed - aTime > 0.05 * speed )
    {
        // more than 50 ms of wall time behind: do not try to catch up. The picture stays
        // smooth and simulated time falls behind.
        s_wallBase = now;
        s_simBase = aTime;
        s_lagging = 1;
    }

    return 0;
}

// ---------------------------------------------------------------------------
// Code parts: WebAssembly modules standing in for d_cosim's shared libraries
// ---------------------------------------------------------------------------

std::mutex                                  s_partMutex;
std::map<std::string, std::vector<uint8_t>> s_partBytes;
std::map<std::string, unsigned>             s_partSum;      // checksum of the bytes when they came in
std::map<std::string, int>                  s_partNameGen;  // bumped when a part's bytes change
std::atomic<int>                            s_partGen{ 0 }; // bumped when any part's bytes change

struct PartInst
{
    std::string            name;
    struct co_info*        info = nullptr;
    int                    seenGen = 0; // s_partGen when last checked
    int                    nameGen = 0; // s_partNameGen[name] of the loaded bytes
    std::vector<Digital_t> inputs;      // last input values, replayed after a reload
    int                    key = 0;     // this instance's name in the JavaScript part table
};

// The handles this file gave to d_cosim. Any other handle belongs to the C library.
std::mutex          s_handleMutex;
std::set<PartInst*> s_handles;

// A loaded part lives in the JavaScript of the thread that loaded it: the simulation thread.
// A circuit is taken down by another thread (the one that loads the next circuit), which
// cannot reach it. So taking a part down only notes its key; the simulation thread unloads
// it before it loads the next part. Otherwise every run would leave its parts behind.
std::atomic<int> s_nextPartKey{ 0 };
std::mutex       s_unloadMutex;
std::vector<int> s_partsToUnload;

thread_local PartInst* t_pendingPart = nullptr;

unsigned fnv1a( const uint8_t* aData, size_t aLen )
{
    unsigned h = 0x811c9dc5u;

    for( size_t i = 0; i < aLen; i++ )
    {
        h ^= aData[i];
        h *= 0x01000193u;
    }

    return h;
}

char              s_dlError[200] = "";
std::atomic<bool> s_dlErrorSet{ false };

void setDlError( const char* aFormat, const char* aArg )
{
    snprintf( s_dlError, sizeof s_dlError, aFormat, aArg );
    s_dlErrorSet = true;
}

std::mutex  s_problemMutex;
std::string s_runProblem;  // the first code part of this run that could not be loaded, in words
std::string s_lastProblem; // the last one that was reported

// A code part could not be loaded (s_dlError says why). d_cosim asks for the same part under
// several file names, so the same words come several times: they are reported once.
void partProblem()
{
    std::lock_guard<std::mutex> lock( s_problemMutex );

    if( s_lastProblem == s_dlError )
        return;

    s_lastProblem = s_dlError;

    if( s_runProblem.empty() )
        s_runProblem = s_dlError;

    emitEvt( EVT_PART, s_dlError, 2, 0 );
}

} // namespace

// Instantiate a part in THIS thread's JavaScript. The bytes are copied out of the shared
// heap; compile and instantiate are synchronous, which a Worker is allowed to do.
//
// What a part may import: pj.out (report an output change), pj.log (a line of text), and
// the few WASI calls a C library makes for stdout. Anything else of "pj" is a part made for
// a newer engine: it is refused with its name, not run with a stand-in.
// clang-format off
EM_JS( int, pj_part_load, ( const unsigned char* aBytes, int aLen, int aKey, int aInst ), {
    try {
        const bytes = new Uint8Array( aLen );
        bytes.set( HEAPU8.subarray( aBytes, aBytes + aLen ) );
        const parts = ( globalThis.__pjParts = globalThis.__pjParts || new Map() );
        const mod = new WebAssembly.Module( bytes );
        let exp = null;
        const text = ( ptr, len ) => new TextDecoder().decode( new Uint8Array( exp.memory.buffer, ptr, len ).slice() );
        const say = ( s ) => { const p = stringToNewUTF8( s ); _pj_host_log( aInst, p ); };
        const imports = {};

        for( const imp of WebAssembly.Module.imports( mod ) ) {
            if( imp.kind !== 'function' )
                continue;
            const m = ( imports[imp.module] = imports[imp.module] || {} );

            if( imp.module === 'pj' && imp.name === 'out' ) {
                m.out = ( t, bit, state, strength ) => _pj_host_out( aInst, t, bit, state, strength );
            } else if( imp.module === 'pj' && imp.name === 'log' ) {
                m.log = ( ptr, len ) => say( text( ptr, len ) );
            } else if( imp.module === 'pj' ) {
                throw new Error( 'the part asks for pj.' + imp.name + ', which this engine does not have' );
            } else if( imp.name === 'fd_write' ) {
                // WASI stdout/stderr -> the part's log
                m.fd_write = ( fd, iovs, iovsLen, nwritten ) => {
                    const dv = new DataView( exp.memory.buffer );
                    let total = 0, out = String();
                    for( let i = 0; i < iovsLen; i++ ) {
                        const ptr = dv.getUint32( iovs + i * 8, true ), len = dv.getUint32( iovs + i * 8 + 4, true );
                        out += text( ptr, len );
                        total += len;
                    }
                    if( out.trim() )
                        say( out.trimEnd() );
                    new DataView( exp.memory.buffer ).setUint32( nwritten, total, true );
                    return 0;
                };
            } else if( imp.name === 'fd_fdstat_get' ) {
                // report a character device, so C stdio flushes at every line end
                m.fd_fdstat_get = ( fd, buf ) => {
                    const dv = new DataView( exp.memory.buffer );
                    for( let i = 0; i < 24; i += 4 )
                        dv.setUint32( buf + i, 0, true );
                    dv.setUint8( buf, 2 );
                    return 0;
                };
            } else if( imp.name === 'environ_sizes_get' || imp.name === 'args_sizes_get' ) {
                m[imp.name] = ( a, b ) => {
                    const dv = new DataView( exp.memory.buffer );
                    dv.setUint32( a, 0, true );
                    dv.setUint32( b, 0, true );
                    return 0;
                };
            } else if( imp.name === 'proc_exit' ) {
                m.proc_exit = ( code ) => { throw new Error( 'the part called exit(' + code + ')' ); };
            } else {
                m[imp.name] = () => 52; // WASI ENOSYS
            }
        }

        const instance = new WebAssembly.Instance( mod, imports );
        exp = instance.exports;
        for( const name of [ 'pj_setup', 'pj_step', 'pj_input' ] ) {
            if( typeof exp[name] !== 'function' )
                throw new Error( 'the part has no ' + name );
        }
        if( exp._initialize )
            exp._initialize();
        parts.set( aKey, exp );
        return 0;
    } catch( e ) {
        const p = stringToNewUTF8( 'load failed: ' + e );
        _pj_host_log( aInst, p );
        return -1;
    }
} );

EM_JS( int, pj_part_setup, ( int aKey ), { return globalThis.__pjParts.get( aKey ).pj_setup(); } );
EM_JS( double, pj_part_step, ( int aKey, double aTarget ), {
    return globalThis.__pjParts.get( aKey ).pj_step( aTarget );
} );
EM_JS( void, pj_part_input, ( int aKey, double aTime, int aBit, int aState, int aStrength ), {
    globalThis.__pjParts.get( aKey ).pj_input( aTime, aBit, aState, aStrength );
} );
EM_JS( void, pj_part_unload, ( int aKey ), {
    if( globalThis.__pjParts )
        globalThis.__pjParts.delete( aKey );
} );
// clang-format on

extern "C" {

void* __real_dlopen( const char* aPath, int aFlags );
void* __real_dlsym( void* aHandle, const char* aSymbol );
int   __real_dlclose( void* aHandle );
char* __real_dlerror( void );

// A part reported an output change at simulated time aTime.
EMSCRIPTEN_KEEPALIVE void pj_host_out( int aInst, double aTime, int aBit, int aState, int aStrength )
{
    PartInst* inst = (PartInst*) aInst;

    if( !inst || !inst->info )
        return;

    Digital_t d = { (Digital_State_t) aState, (Digital_Strength_t) aStrength };
    inst->info->vtime = aTime;
    ( *inst->info->out_fn )( inst->info, (unsigned) aBit, &d );
}

// Text from a part (its own log call, or stdout). Takes ownership of aText.
EMSCRIPTEN_KEEPALIVE void pj_host_log( int aInst, char* aText )
{
    PartInst*   inst = (PartInst*) aInst;
    std::string line = ( inst ? inst->name : std::string( "part" ) ) + ": " + ( aText ? aText : "" );
    free( aText );
    emitEvt( EVT_PART, line.c_str(), 0, 0 );
}

// New bytes were registered under this part's name while the simulation runs: swap the
// module in place. The circuit keeps its state, the part starts from reset and is told the
// current input levels.
static void pjReloadIfChanged( PartInst* aInst )
{
    const int gen = s_partGen.load();

    if( aInst->seenGen == gen )
        return;

    aInst->seenGen = gen;

    std::vector<uint8_t> bytes;
    {
        std::lock_guard<std::mutex> lock( s_partMutex );
        const int                   nameGen = s_partNameGen[aInst->name];

        if( nameGen == aInst->nameGen )
            return;

        aInst->nameGen = nameGen;
        bytes = s_partBytes[aInst->name];
    }

    if( pj_part_load( bytes.data(), (int) bytes.size(), aInst->key, (int) aInst ) != 0 )
        return; // the old module is replaced only on success; the log says why it failed

    pj_part_setup( aInst->key );

    for( size_t i = 0; i < aInst->inputs.size(); i++ )
    {
        pj_part_input( aInst->key, aInst->info->vtime, (int) i, (int) aInst->inputs[i].state,
                       (int) aInst->inputs[i].strength );
    }

    char msg[160];
    snprintf( msg, sizeof msg, "%s: new code loaded at t=%.3f s", aInst->name.c_str(), aInst->info->vtime );
    emitEvt( EVT_PART, msg, 1, 0 );
}

static void pjStep( struct co_info* aInfo )
{
    PartInst* inst = (PartInst*) aInfo->handle;
    pjReloadIfChanged( inst );
    aInfo->vtime = pj_part_step( inst->key, aInfo->vtime );
}

static void pjInput( struct co_info* aInfo, unsigned int aBit, Digital_t* aVal )
{
    PartInst* inst = (PartInst*) aInfo->handle;

    if( aBit >= inst->inputs.size() )
        inst->inputs.resize( aBit + 1, Digital_t{ ZERO, STRONG } );

    inst->inputs[aBit] = *aVal;
    pj_part_input( inst->key, aInfo->vtime, (int) aBit, (int) aVal->state, (int) aVal->strength );
}

static void pjCleanup( struct co_info* ) {}

// What d_cosim gets back from dlsym(handle, "Cosim_setup").
static void pjCosimSetup( struct co_info* aInfo )
{
    PartInst* inst = t_pendingPart;
    t_pendingPart = nullptr;

    if( !inst )
        return;

    const int counts = pj_part_setup( inst->key );

    inst->info = aInfo;
    aInfo->handle = inst;
    aInfo->in_count = (unsigned) ( counts & 0xff );
    aInfo->out_count = (unsigned) ( ( counts >> 8 ) & 0xff );
    aInfo->inout_count = (unsigned) ( ( counts >> 16 ) & 0xff );
    aInfo->method = (Cosim_method) ( ( counts >> 24 ) & 3 );
    aInfo->step = pjStep;
    aInfo->in_fn = pjInput;
    aInfo->cleanup = pjCleanup;
}

// --- the four libc calls d_cosim makes, redirected by
// --- -Wl,--wrap=dlopen,--wrap=dlsym,--wrap=dlclose,--wrap=dlerror.
// --- In a Worker that is not a live session they are the C library's own.

void* __wrap_dlopen( const char* aPath, int aFlags )
{
    if( !s_inited.load() )
        return __real_dlopen( aPath, aFlags );

    std::string  name = aPath ? aPath : "";
    const size_t slash = name.find_last_of( '/' );

    if( slash != std::string::npos )
        name = name.substr( slash + 1 );

    const size_t dot = name.find_last_of( '.' );

    if( dot != std::string::npos )
        name = name.substr( 0, dot );

    std::vector<uint8_t> bytes;
    int                  nameGen = 0;
    unsigned             sum = 0;
    bool                 known = false;
    {
        std::lock_guard<std::mutex> lock( s_partMutex );
        auto                        it = s_partBytes.find( name );

        if( it != s_partBytes.end() )
        {
            known = true;
            bytes = it->second;
            nameGen = s_partNameGen[name];
            sum = s_partSum[name];
        }
    }

    if( !known )
    {
        setDlError( "no code part named '%s' is loaded", name.c_str() );
        partProblem();
        return nullptr;
    }

    // The bytes have been in this program's memory since they were registered. A part that
    // is no longer what came in is not run.
    if( fnv1a( bytes.data(), bytes.size() ) != sum )
    {
        setDlError( "code part '%s' is not what was loaded: its bytes changed in memory", name.c_str() );
        partProblem();
        return nullptr;
    }

    // parts of circuits that are gone: unload them here, in the thread they live in
    {
        std::vector<int> gone;
        {
            std::lock_guard<std::mutex> lock( s_unloadMutex );
            gone.swap( s_partsToUnload );
        }

        for( int key : gone )
            pj_part_unload( key );
    }

    PartInst* inst = new PartInst();
    inst->name = name;
    inst->nameGen = nameGen;
    inst->seenGen = s_partGen.load();
    inst->key = ++s_nextPartKey;

    if( pj_part_load( bytes.data(), (int) bytes.size(), inst->key, (int) inst ) != 0 )
    {
        setDlError( "code part '%s' could not be started (its own lines say why)", name.c_str() );
        partProblem();
        delete inst;
        return nullptr;
    }

    {
        std::lock_guard<std::mutex> lock( s_handleMutex );
        s_handles.insert( inst );
    }

    t_pendingPart = inst;
    return inst;
}

static bool isPartHandle( void* aHandle )
{
    std::lock_guard<std::mutex> lock( s_handleMutex );
    return s_handles.count( (PartInst*) aHandle ) != 0;
}

void* __wrap_dlsym( void* aHandle, const char* aSymbol )
{
    if( !isPartHandle( aHandle ) )
        return __real_dlsym( aHandle, aSymbol );

    if( aSymbol && strcmp( aSymbol, "Cosim_setup" ) == 0 )
        return (void*) pjCosimSetup;

    setDlError( "a code part has no symbol '%s'", aSymbol ? aSymbol : "" );
    return nullptr;
}

int __wrap_dlclose( void* aHandle )
{
    PartInst* inst = (PartInst*) aHandle;
    {
        std::lock_guard<std::mutex> lock( s_handleMutex );

        if( s_handles.erase( inst ) == 0 )
            return __real_dlclose( aHandle );
    }

    {
        std::lock_guard<std::mutex> lock( s_unloadMutex );
        s_partsToUnload.push_back( inst->key );
    }

    delete inst;
    return 0;
}

char* __wrap_dlerror( void )
{
    if( s_dlErrorSet.exchange( false ) )
        return s_dlError;

    return __real_dlerror();
}

} // extern "C"

namespace
{

// ---------------------------------------------------------------------------
// RPC surface
// ---------------------------------------------------------------------------

bool s_haveCircuit = false; // main thread only

int liveInit()
{
    if( s_inited.load() )
        return 0;

    int ret = ngSpice_Init( cbSendChar, cbSendStat, cbControlledExit, cbSendData, cbSendInitData,
                            cbBGThreadRunning, nullptr );

    if( ret == 0 )
    {
        static int ident = 1;
        ngSpice_Init_Sync( cbGetVsrc, cbGetIsrc, cbSync, &ident, nullptr );
        s_inited.store( true );
    }

    return ret;
}

void mkdirRecursive( const std::string& aDir )
{
    std::string partial;

    for( size_t i = 0; i < aDir.size(); i++ )
    {
        partial += aDir[i];

        if( aDir[i] == '/' && partial.size() > 1 )
            ::mkdir( partial.c_str(), 0777 );
    }

    if( !partial.empty() )
        ::mkdir( partial.c_str(), 0777 );
}

// lines: string[]; files: [{ path, text }], staged at the paths the circuit's .include
// lines name.
int liveCirc( val aLines, val aFiles )
{
    if( !s_inited.load() )
        return -2;

    if( s_run.load() != RUN_NONE )
        return -1;

    const unsigned nFiles = aFiles["length"].as<unsigned>();

    for( unsigned i = 0; i < nFiles; i++ )
    {
        val         f = aFiles[i];
        std::string path = f["path"].as<std::string>();
        std::string text = f["text"].as<std::string>();
        size_t      slash = path.find_last_of( '/' );

        if( slash != std::string::npos && slash > 0 )
            mkdirRecursive( path.substr( 0, slash ) );

        FILE* fp = fopen( path.c_str(), "w" );

        if( !fp )
        {
            fprintf( stderr, "[ngspice_live] cannot stage %s: %s\n", path.c_str(), strerror( errno ) );
            return 1;
        }

        fwrite( text.data(), 1, text.size(), fp );
        fclose( fp );
    }

    const unsigned           n = aLines["length"].as<unsigned>();
    std::vector<std::string> strs;
    strs.reserve( n );

    for( unsigned i = 0; i < n; i++ )
        strs.push_back( aLines[i].as<std::string>() );

    // ngSpice_Circ wants a NULL-terminated char* array; it copies the lines.
    std::vector<char*> arr( n + 1 );

    for( unsigned i = 0; i < n; i++ )
        arr[i] = const_cast<char*>( strs[i].c_str() );

    arr[n] = nullptr;

    // ngspice keeps every circuit it was ever given. Take the one of the last run away
    // first: that frees it, and it is the moment its code parts are told they are done
    // (d_cosim calls dlclose). Otherwise every run would leave its circuit and its parts
    // in memory.
    if( s_haveCircuit )
    {
        ngSpice_Command( const_cast<char*>( "remcirc" ) );
        ngSpice_Command( const_cast<char*>( "destroy all" ) );
        s_haveCircuit = false;
    }

    clearInputs();

    const int rc = ngSpice_Circ( arr.data() );
    s_haveCircuit = ( rc == 0 );
    return rc;
}

int liveRunState()
{
    return s_run.load();
}

double livePoints()
{
    return (double) s_points.load();
}

std::string liveProblem()
{
    std::lock_guard<std::mutex> lock( s_problemMutex );
    return s_runProblem;
}

// The bytes are kept as they came. Registering the same bytes again changes nothing;
// different bytes under a name that is running are swapped in at the part's next step.
void liveRegisterPart( std::string aName, val aBytes )
{
    std::vector<uint8_t>        bytes = convertJSArrayToNumberVector<uint8_t>( aBytes );
    std::lock_guard<std::mutex> lock( s_partMutex );
    auto                        it = s_partBytes.find( aName );

    if( it != s_partBytes.end() && it->second == bytes )
        return;

    s_partSum[aName] = fnv1a( bytes.data(), bytes.size() );
    s_partBytes[aName] = std::move( bytes );
    s_partNameGen[aName]++;
    s_partGen++;
}

// For tests: where the engine holds a registered part's bytes. -1: no such part.
double livePartAt( std::string aName )
{
    std::lock_guard<std::mutex> lock( s_partMutex );
    auto                        it = s_partBytes.find( aName );
    return it == s_partBytes.end() ? -1.0 : (double) (uintptr_t) it->second.data();
}

void liveSetInput( std::string aName, double aValue )
{
    Input* in = findInput( aName.c_str(), true );

    if( in )
        in->target = aValue;
}

void liveSetSpeed( double aSpeed )
{
    s_speed = std::isfinite( aSpeed ) && aSpeed > 0 ? aSpeed : 0.0;
}

void liveSetPaused( bool aPaused )
{
    s_paused = aPaused;
}

// Start the transient of the circuit loaded with liveCirc(). The circuit carries its own
// .tran line. 0 = started, -1 = already running, -2 = no circuit.
int liveStart()
{
    if( !s_inited.load() || !s_haveCircuit )
        return -2;

    if( s_run.load() != RUN_NONE )
        return -1;

    s_stopping = false;
    s_paused = false;
    s_paceReset = true;
    s_sleptMs = 0;
    s_lagging = 0;
    {
        std::lock_guard<std::mutex> lock( s_problemMutex );
        s_runProblem.clear();
        s_lastProblem.clear();
    }

    // nothing of the last run is shown as this one's
    {
        std::lock_guard<std::mutex> lock( s_valMutex );
        s_names.clear();
        s_latest.clear();
        s_integral.clear();
        s_winStart = 0;
        s_simTime = 0;
        s_points = 0;
        s_namesGen++;
    }

    // the inputs start at their values, without a ramp
    const int n = s_inputCount.load();

    for( int i = 0; i < n; i++ )
    {
        s_inputs[i].applied = s_inputs[i].target.load();
        s_inputs[i].v0 = s_inputs[i].applied;
        s_inputs[i].t0 = -1.0;
    }

    ngSpice_Command( const_cast<char*>( "save none" ) );  // keep nothing; values come through cbSendData
    ngSpice_Command( const_cast<char*>( "esave none" ) ); // no digital event history either

    s_run = RUN_STARTING;
    const int rc = ngSpice_Command( const_cast<char*>( "bg_run" ) );

    if( rc != 0 )
        s_run = RUN_NONE;

    return rc;
}

// Halt the run. 0 = halted, or nothing ran. -1 = the run's thread has not come up yet: it
// cannot be halted now, ask again. Anything else: ngspice could not halt it.
int liveStop()
{
    const int run = s_run.load();

    if( run == RUN_NONE )
        return 0;

    s_stopping = true; // also ends a pause and a sleep in cbSync
    s_paused = false;

    if( run == RUN_STARTING )
        return -1;

    return ngSpice_Command( const_cast<char*>( "bg_halt" ) );
}

val liveNames()
{
    std::lock_guard<std::mutex> lock( s_valMutex );
    val                         out = val::array();

    for( const std::string& n : s_names )
        out.call<void>( "push", n );

    return out;
}

// One frame's worth of data. The typed arrays are views into buffers that the next call
// overwrites; the Worker copies them before it posts them.
val liveSnapshot()
{
    static std::vector<double> s_outLatest;
    static std::vector<double> s_outAvg;
    static double              s_lastWall = 0;
    static double              s_lastSlept = 0;
    static double              s_lastSim = 0;

    val    out = val::object();
    double simTime;
    int    gen;
    {
        std::lock_guard<std::mutex> lock( s_valMutex );
        simTime = s_simTime;
        gen = s_namesGen;
        const double win = simTime - s_winStart;
        s_outLatest = s_latest;
        s_outAvg.resize( s_latest.size() );

        for( size_t i = 0; i < s_latest.size(); i++ )
        {
            s_outAvg[i] = win > 0 ? s_integral[i] / win : s_latest[i];
            s_integral[i] = 0;
        }

        s_winStart = simTime;
    }

    const double now = emscripten_get_now();
    const double slept = s_sleptMs.load();
    const double wallMs = now - s_lastWall;
    double       load = 0, achieved = 0;

    // (a new run starts its clock and its sleep count at zero: no figure for that frame)
    if( s_lastWall > 0 && wallMs > 0 && simTime >= s_lastSim && slept >= s_lastSlept )
    {
        load = 1.0 - ( slept - s_lastSlept ) / wallMs;
        load = load < 0 ? 0 : ( load > 1 ? 1 : load );
        achieved = ( simTime - s_lastSim ) / ( wallMs / 1000.0 );
    }

    s_lastWall = now;
    s_lastSlept = slept;
    s_lastSim = simTime;

    out.set( "t", simTime );
    out.set( "points", (double) s_points.load() );
    out.set( "load", load );
    out.set( "achieved", achieved );
    out.set( "lagging", s_lagging.load() != 0 );
    out.set( "running", s_run.load() != RUN_NONE );
    out.set( "gen", gen );
    {
        std::lock_guard<std::mutex> lock( s_problemMutex );
        out.set( "problem", s_runProblem );
    }
    out.set( "latest", val( typed_memory_view( s_outLatest.size(), s_outLatest.data() ) ) );
    out.set( "avg", val( typed_memory_view( s_outAvg.size(), s_outAvg.data() ) ) );
    return out;
}

} // namespace

EMSCRIPTEN_BINDINGS( ngspice_live )
{
    function( "liveInit", &liveInit );
    function( "liveCirc", &liveCirc );
    function( "liveStart", &liveStart );
    function( "liveStop", &liveStop );
    function( "liveRunState", &liveRunState );
    function( "livePoints", &livePoints );
    function( "liveProblem", &liveProblem );
    function( "liveSetInput", &liveSetInput );
    function( "liveSetSpeed", &liveSetSpeed );
    function( "liveSetPaused", &liveSetPaused );
    function( "liveNames", &liveNames );
    function( "liveSnapshot", &liveSnapshot );
    function( "liveRegisterPart", &liveRegisterPart );
    function( "livePartAt", &livePartAt );
}
