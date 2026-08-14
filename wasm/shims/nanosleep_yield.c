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
 */
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <time.h>

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
    if( req )
    {
        double ms = (double) req->tv_sec * 1000.0 + (double) req->tv_nsec / 1.0e6;
        if( ms > 0.0 )
        {
            if( emscripten_is_main_runtime_thread() )
                __wasm_main_thread_yield_ms( ms ); /* yield -> event loop runs -> Worker boots */
            else
                emscripten_thread_sleep( ms );     /* worker: real blocking sleep */
        }
    }
    if( rem )
    {
        rem->tv_sec = 0;
        rem->tv_nsec = 0;
    }
    return 0;
}
