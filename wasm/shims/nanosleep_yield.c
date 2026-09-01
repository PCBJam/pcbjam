/*
 * nanosleep_yield.c — make a MAIN-THREAD nanosleep() YIELD to the JS event loop
 * (a JSPI suspension) instead of busy-spinning, so on-demand pthread-Worker
 * creation can complete WITHOUT editing KiCad.
 *
 * THE PROBLEM (the "non-warm thread" deadlock): once KiCad's thread pool has consumed all
 * the pre-warmed Workers (-sPTHREAD_POOL_SIZE), a later raw std::thread (the raytracer)
 * must spawn a NEW Worker on demand. Finalizing it needs the main thread's event loop to
 * run the new-Worker 'loaded' -> 'run' handshake. KiCad's join is a sleep_for() busy-wait
 * -> nanosleep -> emscripten_thread_sleep, which busy-spins and NEVER returns to the JS
 * event loop, so the new Worker never starts -> deadlock.
 *
 * THE FIX: the only main-thread primitive that returns to the event loop is a suspension.
 * This provides a nanosleep that, ON THE MAIN THREAD, yields via an EM_ASYNC_JS await
 * (= emscripten_sleep semantics under JSPI). The unmodified sleep_for busy-wait then pumps
 * the loop, the Worker handshake completes, and on-demand creation works with no KiCad
 * edit.
 *
 * MECHANISM: a STRONG definition of nanosleep here SHADOWS musl's archive member — the
 * linker only pulls musl's nanosleep.o if the symbol is left undefined, and ours defines it.
 * (-Wl,--wrap=nanosleep is not an option here — it crashes wasm-ld with a SIGSEGV in
 * lld::wasm::ImportSection::addImport.) On a pthread worker we fall back to
 * emscripten_thread_sleep (the real underlying blocking sleep — workers may block).
 *
 * SCOPE: only the main browser thread yields; only it must never block the event loop.
 *
 * ZERO-DURATION GUARD (ported from staging 29c61b8): a nanosleep of 0 ms
 * returns immediately WITHOUT yielding. mimalloc's spin-wait hint
 * mi_atomic_yield() is sleep(0) on wasm, reached from malloc's slow path
 * under cross-thread delayed-free contention. Under JSPI a yield there
 * SUSPENDS the activation inside the allocator — any other activation that
 * then runs can re-enter mimalloc mid-operation. A zero-duration sleep never
 * promised an event-loop turn — stock emscripten busy-waits and returns
 * immediately. mimalloc is the module's only zero-duration sleeper; the
 * worker-boot deadlock this shim fixes needs only the ms-scale yields.
 *
 * POSIX SEMANTICS (finding F-2, adapted from the codex-core reference fix):
 * browser timers take a signed 32-bit millisecond delay, so a raw
 * setTimeout(ms) truncates fractional waits (a 1.9 ms sleep returned after
 * ~1 ms — nanosleep must never return early) and WRAPS anything past INT_MAX
 * ms (a huge timespec fired almost immediately). The shim also swallowed
 * invalid input: a NULL req must be EFAULT, an out-of-range timespec EINVAL,
 * and neither may clobber the caller's remainder struct. Now: validate first,
 * then sleep in ceil()'d chunks of at most INT_MAX ms — one chunk owns one
 * timer — repeating until the requested duration is exhausted.
 */
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <time.h>

/*
 * Browser timers use a signed 32-bit millisecond delay. Values below one
 * millisecond must round up (nanosleep may not return early), and larger waits
 * must be split instead of letting setTimeout wrap/clamp them to a short wait.
 */
static int pcbjam_nanosleep_timer_chunk_ms( double ms )
{
    const double rounded = ceil( ms );

    if( !( rounded >= 1.0 ) )
        return 1;

    if( rounded >= (double) INT_MAX )
        return INT_MAX;

    return (int) rounded;
}

#ifdef PCBJAM_NANOSLEEP_TEST_HOOK
/* Harness-only instrumentation (tests/apps/standalone/nanosleep-semantics):
 * production builds compile these out. The counters let the harness prove the
 * zero-duration path was actually reached (the J-6 false-green lesson), and
 * the chunk hook pins the fractional/floor/clamp contract deterministically. */
static unsigned g_zero_duration_sleep_calls;
static unsigned g_main_thread_zero_duration_sleep_calls;

/* extern "C": em++ compiles this .c as C++ (deprecated but current 6.0.6
 * behavior), which would otherwise mangle the hook names away from the
 * harness's weak C declarations. nanosleep itself is covered by musl's own
 * extern "C" in <time.h>. */
#ifdef __cplusplus
extern "C"
#endif
unsigned pcbjam_nanosleep_zero_duration_call_count( void )
{
    return __atomic_load_n( &g_zero_duration_sleep_calls, __ATOMIC_RELAXED );
}

#ifdef __cplusplus
extern "C"
#endif
unsigned pcbjam_nanosleep_main_thread_zero_duration_call_count( void )
{
    return __atomic_load_n( &g_main_thread_zero_duration_sleep_calls, __ATOMIC_RELAXED );
}

#ifdef __cplusplus
extern "C"
#endif
int pcbjam_nanosleep_timer_chunk_ms_for_test( double ms )
{
    return pcbjam_nanosleep_timer_chunk_ms( ms );
}
#endif

/* EM_ASYNC_JS is a suspending import: JSPI suspends every activation that awaits it. */
EM_ASYNC_JS( void, __wasm_main_thread_yield_ms, ( double ms ), {
    /* Route through the scheduler's turnstile when it exists - a raw await's
       engine-level resume bypasses the shim's SP discipline and leaves its
       window marked live (the pump then refuses every later resume). The
       scheduler-free harness builds keep the raw await. */
    var S = globalThis.__wxScheduler;
    if( S ) {
        await S.sleepYield( ms );
        return;
    }
    await new Promise( function( resolve ) { setTimeout( resolve, ms ); } );
} );

int nanosleep( const struct timespec* req, struct timespec* rem )
{
    if( !req )
    {
        errno = EFAULT;
        return -1;
    }

    if( req->tv_sec < 0 || req->tv_nsec < 0 || req->tv_nsec >= 1000000000L )
    {
        errno = EINVAL;
        return -1;
    }

    double ms = (double) req->tv_sec * 1000.0 + (double) req->tv_nsec / 1.0e6;

#ifdef PCBJAM_NANOSLEEP_TEST_HOOK
    if( ms == 0.0 )
    {
        __atomic_fetch_add( &g_zero_duration_sleep_calls, 1, __ATOMIC_RELAXED );

        if( emscripten_is_main_runtime_thread() )
            __atomic_fetch_add( &g_main_thread_zero_duration_sleep_calls, 1, __ATOMIC_RELAXED );
    }
#endif

    if( ms > 0.0 )
    {
        double remaining = ms;

        /*
         * One chunk owns one timer/park. Repeat after each exact wake so a
         * large timespec cannot wrap a browser timer and return early. An
         * infinite duration intentionally remains asleep in INT_MAX chunks.
         */
        while( remaining > 0.0 )
        {
            const int delay = pcbjam_nanosleep_timer_chunk_ms( remaining );

            if( emscripten_is_main_runtime_thread() )
                __wasm_main_thread_yield_ms( delay ); /* yield -> event loop runs -> Worker boots */
            else
                emscripten_thread_sleep( delay );     /* worker: real blocking sleep */

            if( isfinite( remaining ) )
                remaining -= (double) delay;
            else
                break; /* unreachable from integer timespec input; belt and braces */
        }
    }

    if( rem )
    {
        rem->tv_sec = 0;
        rem->tv_nsec = 0;
    }
    return 0;
}
