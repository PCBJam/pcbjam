/**
 * nanosleep_semantics_test.cpp — repro + regression harness for finding F-2
 * (POSIX semantics of the main-thread nanosleep shim, wasm/shims/nanosleep_yield.c),
 * with the F-1 zero-duration guard riding along (same function, same contract).
 *
 * Single-threaded ON PURPOSE (no -pthread): J-6 recorded a false-green where
 * worker threads satisfied a process-wide zero-duration counter. Here only the
 * main thread exists, so the counters can only move through the code path under
 * test. Every absence-assertion is paired with a positive control proving the
 * observable CAN fire (the yield-flips-flag check).
 *
 * The shim is compiled with -DPCBJAM_NANOSLEEP_TEST_HOOK for this app only;
 * the hooks below are declared weak so the harness LINKS (and reports FAIL)
 * against a shim that predates them — that is the red half of the TDD loop.
 *
 * Console contract (the spec asserts on these; counters, not FAIL-line absence):
 *   [NANOSLEEP] START
 *   [NANOSLEEP] CHECK <name> PASS|FAIL <detail>
 *   [NANOSLEEP] SYNC-DONE pass=<n> fail=<n>
 *   [NANOSLEEP] TIMED-SLEEP-DONE dtMs=<d>
 *   [NANOSLEEP] HUGE-SLEEP-BEGIN
 *   [NANOSLEEP] HUGE-SLEEP-END dtMs=<d>   <- must NEVER appear: a 32-bit
 *       setTimeout wrap fires it within milliseconds (the F-2 bug); the fixed
 *       chunk loop stays suspended for INT_MAX ms per chunk.
 */

#include "wx/wx.h"

#include <cerrno>
#include <cfloat>
#include <climits>
#include <cstdarg>
#include <cstdio>
#include <ctime>

#include <emscripten/emscripten.h>

// Test hooks exported by the shim under -DPCBJAM_NANOSLEEP_TEST_HOOK. Weak:
// absent in the pre-fix shim -> null -> the hook checks FAIL (red run).
extern "C" int pcbjam_nanosleep_timer_chunk_ms_for_test( double ms ) __attribute__(( weak ));
extern "C" unsigned pcbjam_nanosleep_zero_duration_call_count( void ) __attribute__(( weak ));
extern "C" unsigned pcbjam_nanosleep_main_thread_zero_duration_call_count( void ) __attribute__(( weak ));

static int g_pass = 0;
static int g_fail = 0;

static void nlog( const char* fmt, ... )
{
    char buf[512];
    va_list ap;
    va_start( ap, fmt );
    vsnprintf( buf, sizeof( buf ), fmt, ap );
    va_end( ap );
    EM_ASM( { console.log( UTF8ToString( $0 ) ); }, buf );
}

static void check( const char* name, bool ok, const char* fmt, ... )
{
    char detail[256];
    va_list ap;
    va_start( ap, fmt );
    vsnprintf( detail, sizeof( detail ), fmt, ap );
    va_end( ap );

    if( ok )
        g_pass++;
    else
        g_fail++;

    nlog( "[NANOSLEEP] CHECK %s %s %s", name, ok ? "PASS" : "FAIL", detail );
}

// A failed nanosleep must not touch the caller's remainder struct.
static const long REM_SENTINEL = 7777;

static struct timespec sentinelRem()
{
    struct timespec rem;
    rem.tv_sec = REM_SENTINEL;
    rem.tv_nsec = REM_SENTINEL;
    return rem;
}

static bool remUntouched( const struct timespec& rem )
{
    return rem.tv_sec == REM_SENTINEL && rem.tv_nsec == REM_SENTINEL;
}

// One invalid-argument case: expect -1 + the given errno, remainder untouched.
static void expectError( const char* name, const struct timespec* req, int wantErrno )
{
    struct timespec rem = sentinelRem();
    errno = 0;
    int rc = nanosleep( req, &rem );
    check( name, rc == -1 && errno == wantErrno && remUntouched( rem ),
           "rc=%d errno=%d wantErrno=%d remUntouched=%d", rc, errno, wantErrno,
           (int) remUntouched( rem ) );
}

static void runChecks()
{
    nlog( "[NANOSLEEP] START" );

    // --- chunk helper: the deterministic pin for fractional / floor / clamp ---
    check( "hook-chunk-present", pcbjam_nanosleep_timer_chunk_ms_for_test != nullptr,
           "weak symbol %s", pcbjam_nanosleep_timer_chunk_ms_for_test ? "bound" : "missing" );

    if( pcbjam_nanosleep_timer_chunk_ms_for_test )
    {
        check( "chunk-ceils-fractional", pcbjam_nanosleep_timer_chunk_ms_for_test( 1.9 ) == 2,
               "chunk(1.9)=%d want 2", pcbjam_nanosleep_timer_chunk_ms_for_test( 1.9 ) );
        check( "chunk-floors-subms", pcbjam_nanosleep_timer_chunk_ms_for_test( 0.25 ) == 1,
               "chunk(0.25)=%d want 1", pcbjam_nanosleep_timer_chunk_ms_for_test( 0.25 ) );
        check( "chunk-clamps-huge", pcbjam_nanosleep_timer_chunk_ms_for_test( 5.0e9 ) == INT_MAX,
               "chunk(5e9)=%d want INT_MAX=%d", pcbjam_nanosleep_timer_chunk_ms_for_test( 5.0e9 ),
               INT_MAX );
    }
    else
    {
        check( "chunk-ceils-fractional", false, "hook missing" );
        check( "chunk-floors-subms", false, "hook missing" );
        check( "chunk-clamps-huge", false, "hook missing" );
    }

    // --- POSIX error semantics ---
    {
        struct timespec rem = sentinelRem();
        errno = 0;
        int rc = nanosleep( nullptr, &rem );
        check( "efault-null-req", rc == -1 && errno == EFAULT && remUntouched( rem ),
               "rc=%d errno=%d remUntouched=%d", rc, errno, (int) remUntouched( rem ) );
    }
    {
        struct timespec req;
        req.tv_sec = 0;
        req.tv_nsec = -1;
        expectError( "einval-neg-nsec", &req, EINVAL );
    }
    {
        struct timespec req;
        req.tv_sec = 0;
        req.tv_nsec = 1000000000L;
        expectError( "einval-nsec-overflow", &req, EINVAL );
    }
    {
        struct timespec req;
        req.tv_sec = -1;
        req.tv_nsec = 0;
        expectError( "einval-neg-sec", &req, EINVAL );
    }

    // --- zero-duration guard (F-1): must be counted, must not yield ---
    // Arm a JS observable: a 0 ms setTimeout can only fire if the main thread
    // takes an event-loop turn (i.e. the shim suspended).
    EM_ASM( {
        globalThis.__nsTurnFlag = 0;
        setTimeout( function() { globalThis.__nsTurnFlag = 1; }, 0 );
    } );

    const unsigned zeroBefore =
        pcbjam_nanosleep_zero_duration_call_count ? pcbjam_nanosleep_zero_duration_call_count() : 0;
    const unsigned mainZeroBefore = pcbjam_nanosleep_main_thread_zero_duration_call_count
                                        ? pcbjam_nanosleep_main_thread_zero_duration_call_count()
                                        : 0;

    struct timespec zero;
    zero.tv_sec = 0;
    zero.tv_nsec = 0;

    for( int i = 0; i < 50; ++i )
        nanosleep( &zero, nullptr );

    check( "zero-sleep-no-event-loop-turn", EM_ASM_INT( { return globalThis.__nsTurnFlag; } ) == 0,
           "turnFlag=%d want 0 after 50 zero-duration sleeps",
           EM_ASM_INT( { return globalThis.__nsTurnFlag; } ) );

    if( pcbjam_nanosleep_zero_duration_call_count
        && pcbjam_nanosleep_main_thread_zero_duration_call_count )
    {
        const unsigned zeroAfter = pcbjam_nanosleep_zero_duration_call_count();
        const unsigned mainZeroAfter = pcbjam_nanosleep_main_thread_zero_duration_call_count();
        check( "zero-sleep-counters", zeroAfter - zeroBefore == 50 && mainZeroAfter - mainZeroBefore == 50,
               "zeroDelta=%u mainZeroDelta=%u want 50/50", zeroAfter - zeroBefore,
               mainZeroAfter - mainZeroBefore );
    }
    else
    {
        check( "zero-sleep-counters", false, "counter hooks missing" );
    }

    // --- positive control: the SAME observable fires for a real yield, so the
    // absence above is meaningful (the J-6 lesson) ---
    {
        struct timespec req;
        req.tv_sec = 0;
        req.tv_nsec = 5L * 1000000L; // 5 ms
        struct timespec rem = sentinelRem();
        int rc = nanosleep( &req, &rem );
        check( "positive-yield-flips-flag",
               EM_ASM_INT( { return globalThis.__nsTurnFlag; } ) == 1,
               "turnFlag=%d want 1 after a 5 ms sleep",
               EM_ASM_INT( { return globalThis.__nsTurnFlag; } ) );
        check( "rem-zeroed-on-success", rc == 0 && rem.tv_sec == 0 && rem.tv_nsec == 0,
               "rc=%d rem={%ld,%ld} want 0,{0,0}", rc, (long) rem.tv_sec, (long) rem.tv_nsec );
    }

    nlog( "[NANOSLEEP] SYNC-DONE pass=%d fail=%d", g_pass, g_fail );

    // --- a mid-size positive sleep completes and honors its duration ---
    {
        const double t0 = emscripten_get_now();
        struct timespec req;
        req.tv_sec = 0;
        req.tv_nsec = 120L * 1000000L; // 120 ms
        nanosleep( &req, nullptr );
        nlog( "[NANOSLEEP] TIMED-SLEEP-DONE dtMs=%.1f", emscripten_get_now() - t0 );
    }

    // --- the F-2 headline: a wait beyond INT_MAX ms must not return early.
    // 3.0e9 ms > 2^31-1: the pre-fix shim hands it to setTimeout, whose signed
    // 32-bit coercion wraps it negative -> fires immediately -> END logs within
    // milliseconds. The fixed chunk loop parks INT_MAX ms at a time. ---
    {
        const double t0 = emscripten_get_now();
        nlog( "[NANOSLEEP] HUGE-SLEEP-BEGIN" );
        struct timespec req;
        req.tv_sec = 3000000; // 3.0e9 ms
        req.tv_nsec = 0;
        nanosleep( &req, nullptr );
        nlog( "[NANOSLEEP] HUGE-SLEEP-END dtMs=%.1f", emscripten_get_now() - t0 );
    }
}

class NanosleepFrame : public wxFrame
{
public:
    NanosleepFrame() : wxFrame( nullptr, wxID_ANY, "nanosleep semantics test (F-2)",
                                wxDefaultPosition, wxSize( 420, 140 ) )
    {
        wxPanel* p = new wxPanel( this );
        wxBoxSizer* s = new wxBoxSizer( wxVERTICAL );
        s->Add( new wxStaticText( p, wxID_ANY, "nanosleep semantics harness - see console." ),
                0, wxALL, 16 );
        p->SetSizer( s );
    }
};

class NanosleepApp : public wxApp
{
public:
    bool OnInit() override
    {
        ( new NanosleepFrame() )->Show();
        // Runs on the main thread from a promising export; the huge sleep at
        // the end intentionally never returns on a fixed shim.
        runChecks();
        return true;
    }
};

wxIMPLEMENT_APP( NanosleepApp );
