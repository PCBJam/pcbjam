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

/* EM_ASYNC_JS integrates with Asyncify automatically (binaryen instruments every caller). */
EM_ASYNC_JS( void, __wasm_main_thread_yield_ms, ( double ms ), {
    /* JSPI: route through the scheduler's turnstile when it exists - a raw
       await's engine-level resume bypasses the shim's SP discipline and
       leaves its window marked live (the pump then refuses every later
       resume). Asyncify builds (no jspi scheduler) keep the raw await. */
    var S = globalThis.__wxScheduler;
    if( S && S.backend === 'jspi' ) {
        await S.sleepYield( ms );
        return;
    }
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
    if( req )
    {
        double ms = (double) req->tv_sec * 1000.0 + (double) req->tv_nsec / 1.0e6;
        if( ms > 0.0 )
        {
            if( emscripten_is_main_runtime_thread() )
            {
                if( !pcbjam_context_sleep_ms || !pcbjam_context_sleep_ms( ms ) )
                    __wasm_main_thread_yield_ms( ms ); /* yield -> event loop runs -> Worker boots */
            }
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
