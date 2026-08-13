/*
 * nanosleep_yield.c — make a MAIN-THREAD nanosleep() YIELD to the JS event loop via
 * Asyncify instead of busy-spinning, so on-demand pthread-Worker creation can complete
 * WITHOUT editing KiCad.
 *
 * THE PROBLEM (the "non-warm thread" deadlock): once KiCad's thread pool has consumed all
 * the pre-warmed Workers (-sPTHREAD_POOL_SIZE), a later raw std::thread (the raytracer)
 * must spawn a NEW Worker on demand. Finalizing it needs the main thread's event loop to
 * run the new-Worker 'loaded' -> 'run' handshake. KiCad's join is a sleep_for() busy-wait
 * -> nanosleep -> emscripten_thread_sleep, which busy-spins and NEVER returns to the JS
 * event loop, so the new Worker never starts -> deadlock.
 *
 * THE FIX: the only main-thread primitive that returns to the event loop is an Asyncify
 * unwind (emscripten_sleep). This provides a nanosleep that, ON THE MAIN THREAD, yields via
 * an EM_ASYNC_JS await (= emscripten_sleep semantics; __asyncjs__* is already in the
 * post-link asyncify-imports). The unmodified sleep_for busy-wait then pumps the loop, the
 * Worker handshake completes, and on-demand creation works with no KiCad edit.
 *
 * MECHANISM: a STRONG definition of nanosleep here SHADOWS musl's archive member — the
 * linker only pulls musl's nanosleep.o if the symbol is left undefined, and ours defines it.
 * (-Wl,--wrap=nanosleep is not an option here — it crashes wasm-ld with a SIGSEGV in
 * lld::wasm::ImportSection::addImport.) On a pthread worker we fall back to
 * emscripten_thread_sleep (the real underlying blocking sleep — workers may block).
 *
 * ZERO-DURATION SLEEPS: mimalloc uses sleep(0) as a spin-politeness hint in
 * mi_atomic_yield.  It must remain a no-op: turning it into an event-loop yield can
 * suspend the main thread in the middle of malloc.  A zero-duration sleep does not
 * promise an event-loop turn.  A 2026-08-10 module audit found mimalloc to be the only
 * zero-duration caller; all other nanosleep callers request at least 1 ms.
 *
 * SCOPE: only positive sleeps on the main browser thread yield; only that thread must
 * never block the event loop.
 */
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <time.h>

/*
 * Browser timers use a signed 32-bit millisecond delay.  Values below one
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
static unsigned g_zero_duration_sleep_calls;
static unsigned g_main_thread_zero_duration_sleep_calls;

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
    return __atomic_load_n( &g_main_thread_zero_duration_sleep_calls,
                            __ATOMIC_RELAXED );
}

#ifdef __cplusplus
extern "C"
#endif
int pcbjam_nanosleep_timer_chunk_ms_for_test( double ms )
{
    return pcbjam_nanosleep_timer_chunk_ms( ms );
}
#endif

/* EM_ASYNC_JS integrates with Asyncify automatically (binaryen instruments every caller). */
EM_ASYNC_JS( void, __wasm_main_thread_yield_ms, ( int ms ), {
    await new Promise( function( resolve ) { setTimeout( resolve, ms ); } );
} );

/*
 * Scheduler-aware sleep (context_sleep.cpp, docs/features/async/22 Phase B):
 * when this frame stands on a scheduler context that owns the stack, the wait
 * PARKS THAT CONTEXT instead of suspending the stack in place. Returns 0 when
 * no context owns the stack, and then the Asyncify yield below is still right.
 *
 * This is what makes TOOL_MANAGER::RunSynchronousAction's spin loop safe under
 * Phase D: an in-place park inside a tool body leaves a capture in flight for a
 * star transfer to land on (doRewind -> "index out of bounds").
 *
 * extern "C" + WEAK, both load-bearing: some app builds compile this file as
 * C++ (em++ keys language off the DRIVER, not the .c extension — a bare extern
 * here mangles and the app aborts at "missing function" on first sleep), and
 * the standalone wx test apps do not link context_sleep.cpp at all. A weak
 * null resolves to "no context lane here — always yield in place", which is
 * exactly the pre-context behaviour those apps pin.
 */
#ifdef __cplusplus
extern "C"
#endif
int pcbjam_context_sleep_ms( double ms ) __attribute__(( weak ));

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
        {
            __atomic_fetch_add( &g_main_thread_zero_duration_sleep_calls, 1,
                                __ATOMIC_RELAXED );
        }
    }
#endif

    if( ms > 0.0 )
    {
        double remaining = ms;

        /*
         * One chunk owns one timer/park.  Repeat after each exact wake so a
         * large timespec cannot wrap a browser timer and return early.  An
         * infinite duration intentionally remains asleep in INT_MAX chunks.
         */
        while( remaining > 0.0 )
        {
            const int delay = pcbjam_nanosleep_timer_chunk_ms( remaining );

            if( emscripten_is_main_runtime_thread() )
            {
                if( !pcbjam_context_sleep_ms || !pcbjam_context_sleep_ms( delay ) )
                    __wasm_main_thread_yield_ms( delay );
            }
            else
            {
                emscripten_thread_sleep( delay );
            }

            if( isfinite( remaining ) )
                remaining -= (double) delay;
        }
    }

    if( rem )
    {
        rem->tv_sec = 0;
        rem->tv_nsec = 0;
    }
    return 0;
}
