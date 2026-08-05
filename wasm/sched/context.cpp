/*
 * Scheduler contexts — implementation. See context.h for the contract and why
 * this is a star topology rather than libcontext's symmetric swap.
 */
#include "context.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <vector>

#include <emscripten/emscripten.h>
#include <emscripten/fiber.h>
#include <emscripten/threading.h>

namespace pcbjam_sched
{

namespace
{

// Sizes are DELIBERATELY not libcontext's 512K asyncify buffer: doc 20 risk 1
// requires them re-derived from measurement, and this layer measures its own
// high-water use (see asyncify_used()). Start at a quarter of libcontext's and
// let the gate tell us whether that is generous or tight — an inherited
// constant nobody can justify is exactly what the risk warns about.
//
// The C stack is separate from the asyncify buffer: the former holds live
// frames while running, the latter holds their locals while parked.
constexpr size_t DEFAULT_C_STACK_BYTES = 128 * 1024;
constexpr size_t DEFAULT_ASYNCIFY_BYTES = 128 * 1024;

// A hard ceiling turns "contexts leaked until the tab died" into a loud,
// early failure with a registry dump. Deliberately low for D1: nothing in
// production runs on contexts yet, and the test app's worst battery uses ~8.
constexpr size_t MAX_LIVE_CONTEXTS = 64;

struct Context
{
    ContextId id = 0;
    const char* label = "";
    const char* park_reason = "";
    Status status = Status::Fresh;
    int result = 0;

    emscripten_fiber_t fiber {};
    std::vector<char> c_stack;
    std::vector<char> asyncify_stack;

    void ( *entry )( void* ) = nullptr;
    void* arg = nullptr;

    uint32_t parks = 0;
    uint32_t resumes = 0;
    size_t asyncify_high_water = 0;
};

struct Registry
{
    std::map<ContextId, Context*> contexts;
    std::vector<ContextId> ready_fifo;   // FIFO: no starvation (doc 13 §1.5 inv. 8)

    ContextId next_id = 1;
    ContextId running = 0;               // 0 = the scheduler stack is running
    bool transition = false;             // at most one swap in flight
    bool scheduler_initialized = false;
    emscripten_fiber_t scheduler_fiber {};
    std::vector<char> scheduler_asyncify_stack;

    // Counters (stats_json)
    uint32_t created = 0;
    uint32_t finished = 0;
    uint32_t transitions = 0;
    uint32_t refusals = 0;
    size_t live = 0;
    size_t peak_live = 0;
    size_t bytes = 0;
    size_t peak_bytes = 0;
    size_t asyncify_high_water = 0;
};

Registry& reg()
{
    static Registry s_registry;
    return s_registry;
}

void beacon( const char* aWhat, const char* aDetail, unsigned aId )
{
    std::printf( "[sched-ctx] %s id=%u %s\n", aWhat, aId, aDetail ? aDetail : "" );
    std::fflush( stdout );
}

bool on_main_thread()
{
    // Contexts are a main-thread concept by construction (doc 21 §2). A worker
    // has its own Asyncify state; a context swapped there would corrupt both.
    return emscripten_is_main_runtime_thread() != 0;
}

/**
 * Bytes of asyncify buffer this context has consumed at its deepest park.
 *
 * asyncify_data_t is {stack_ptr, stack_limit, rewind_id}; the unwind fills
 * from the buffer's base upward, so used = stack_ptr - base. This is the same
 * quantity the shim's `rem=` telemetry reports from the other direction
 * (limit - ptr), and it is what doc 20 risk 1 wants sizing derived from.
 */
size_t asyncify_used( const Context& aCtx )
{
    const char* base = aCtx.asyncify_stack.data();
    const char* ptr = static_cast<const char*>( aCtx.fiber.asyncify_data.stack_ptr );

    if( !base || !ptr || ptr < base )
        return 0;

    const size_t used = static_cast<size_t>( ptr - base );
    return used > aCtx.asyncify_stack.size() ? aCtx.asyncify_stack.size() : used;
}

void note_asyncify_use( Context& aCtx )
{
    const size_t used = asyncify_used( aCtx );

    if( used > aCtx.asyncify_high_water )
        aCtx.asyncify_high_water = used;

    if( used > reg().asyncify_high_water )
        reg().asyncify_high_water = used;

    // Overflow here is silent corruption (libcontext's 512K comment documents
    // exactly that failure), so shout well before the edge rather than after.
    if( used * 4 > aCtx.asyncify_stack.size() * 3 )
    {
        char detail[128];
        std::snprintf( detail, sizeof( detail ),
                       "asyncify buffer >75%% used (%zu/%zu) - raise the size",
                       used, aCtx.asyncify_stack.size() );
        beacon( "BUFFER-PRESSURE", detail, aCtx.id );
    }
}

Context* find( ContextId aId )
{
    auto it = reg().contexts.find( aId );
    return it == reg().contexts.end() ? nullptr : it->second;
}

void ensure_scheduler_context()
{
    Registry& r = reg();

    if( r.scheduler_initialized )
        return;

    // The scheduler runs on whatever stack called drain() first — a fresh JS
    // task entry. Contexts swap back INTO this fiber, which is what makes the
    // topology a star: every yield lands here, and only here decides who runs
    // next.
    r.scheduler_asyncify_stack.assign( DEFAULT_ASYNCIFY_BYTES, 0 );
    emscripten_fiber_init_from_current_context( &r.scheduler_fiber,
                                                r.scheduler_asyncify_stack.data(),
                                                r.scheduler_asyncify_stack.size() );
    r.scheduler_initialized = true;
}

/**
 * Context trampoline. Per emscripten fiber.h the entry function must NEVER
 * return (returning ends the whole program), so it loops: run the body, mark
 * Finished, swap back to the scheduler, and if the scheduler ever enters this
 * context again, run again.
 */
void context_trampoline( void* aArg )
{
    auto* ctx = static_cast<Context*>( aArg );

    while( true )
    {
        ctx->status = Status::Running;

        if( ctx->entry )
            ctx->entry( ctx->arg );

        ctx->status = Status::Finished;
        ctx->park_reason = "finished";
        reg().finished++;
        reg().running = 0;
        reg().transition = false;

        // Back to the scheduler. A finished context is never re-entered by
        // drain() (it only picks Ready), so this swap is terminal in practice.
        emscripten_fiber_swap( &ctx->fiber, &reg().scheduler_fiber );
    }
}

} // namespace


const char* status_name( Status aStatus )
{
    switch( aStatus )
    {
    case Status::Fresh:    return "fresh";
    case Status::Running:  return "running";
    case Status::Parked:   return "parked";
    case Status::Ready:    return "ready";
    case Status::Finished: return "finished";
    }

    return "?";
}


ContextId create( void ( *aEntry )( void* ), void* aArg, const char* aLabel )
{
    Registry& r = reg();

    if( !on_main_thread() )
    {
        beacon( "REFUSED", "create() off the main thread", 0 );
        r.refusals++;
        return 0;
    }

    if( !aEntry )
    {
        beacon( "REFUSED", "create() with a null entry", 0 );
        r.refusals++;
        return 0;
    }

    if( r.live >= MAX_LIVE_CONTEXTS )
    {
        char detail[160];
        std::snprintf( detail, sizeof( detail ),
                       "context ceiling reached (%zu live) - registry: %s",
                       r.live, registry_json().c_str() );
        beacon( "REFUSED", detail, 0 );
        r.refusals++;
        return 0;
    }

    auto* ctx = new( std::nothrow ) Context();

    if( !ctx )
    {
        beacon( "REFUSED", "context allocation failed", 0 );
        r.refusals++;
        return 0;
    }

    ctx->id = r.next_id++;
    ctx->label = aLabel ? aLabel : "";
    ctx->entry = aEntry;
    ctx->arg = aArg;
    ctx->c_stack.assign( DEFAULT_C_STACK_BYTES, 0 );
    ctx->asyncify_stack.assign( DEFAULT_ASYNCIFY_BYTES, 0 );

    emscripten_fiber_init( &ctx->fiber, context_trampoline, ctx,
                           ctx->c_stack.data(), ctx->c_stack.size(),
                           ctx->asyncify_stack.data(), ctx->asyncify_stack.size() );

    ctx->status = Status::Ready;   // enters at aEntry on the first drain()
    ctx->park_reason = "created";

    r.contexts[ctx->id] = ctx;
    r.ready_fifo.push_back( ctx->id );
    r.created++;
    r.live++;

    if( r.live > r.peak_live )
        r.peak_live = r.live;

    r.bytes += ctx->c_stack.size() + ctx->asyncify_stack.size();

    if( r.bytes > r.peak_bytes )
        r.peak_bytes = r.bytes;

    return ctx->id;
}


int yield_park( const char* aReason )
{
    Registry& r = reg();
    Context* ctx = find( r.running );

    if( !ctx )
    {
        // Called on the scheduler stack: there is nothing to yield. This is
        // the "parked in place" mistake the whole design forbids, so it is a
        // loud refusal rather than a silent no-op.
        beacon( "REFUSED", "yield_park() with no running context", 0 );
        r.refusals++;
        return -1;
    }

    ctx->status = Status::Parked;
    ctx->park_reason = aReason ? aReason : "";
    ctx->parks++;
    r.running = 0;
    r.transition = false;   // the swap below completes this transition

    // Yield to the scheduler. Control returns here when drain() swaps us back
    // in after mark_ready() — and ONLY then, because Parked→Ready→resume is
    // the single path in.
    emscripten_fiber_swap( &ctx->fiber, &r.scheduler_fiber );

    // Resumed. The registry set status/result before swapping in.
    note_asyncify_use( *ctx );
    return ctx->result;
}


bool mark_ready( ContextId aId, int aResult )
{
    Registry& r = reg();
    Context* ctx = find( aId );

    if( !ctx )
    {
        beacon( "REFUSED", "mark_ready() for an unknown context", aId );
        r.refusals++;
        return false;
    }

    if( ctx->status != Status::Parked )
    {
        char detail[96];
        std::snprintf( detail, sizeof( detail ), "mark_ready() on a %s context",
                       status_name( ctx->status ) );
        beacon( "REFUSED", detail, aId );
        r.refusals++;
        return false;
    }

    ctx->result = aResult;
    ctx->status = Status::Ready;
    r.ready_fifo.push_back( aId );
    return true;
}


ContextId drain()
{
    Registry& r = reg();

    if( !on_main_thread() )
    {
        beacon( "REFUSED", "drain() off the main thread", 0 );
        r.refusals++;
        return 0;
    }

    // One transition at a time, and never re-entrantly from a context (a
    // context reaching drain() would make the star a cycle).
    if( r.transition || r.running != 0 )
        return 0;

    ensure_scheduler_context();

    // Skip ids that died or were consumed while queued.
    ContextId id = 0;
    Context* ctx = nullptr;

    while( !r.ready_fifo.empty() )
    {
        id = r.ready_fifo.front();
        r.ready_fifo.erase( r.ready_fifo.begin() );
        ctx = find( id );

        if( ctx && ctx->status == Status::Ready )
            break;

        ctx = nullptr;
    }

    if( !ctx )
        return 0;

    r.transition = true;
    r.transitions++;
    r.running = id;
    ctx->status = Status::Running;
    ctx->resumes++;

    // Swap in. Returns when the context parks (yield_park) or finishes; both
    // clear running/transition before swapping back.
    emscripten_fiber_swap( &r.scheduler_fiber, &ctx->fiber );

    r.transition = false;
    r.running = 0;

    // The context object may still exist (parked) or be finished; either way
    // its buffer use is now measurable.
    if( Context* back = find( id ) )
        note_asyncify_use( *back );

    return id;
}


bool transition_in_flight()
{
    return reg().transition;
}


ContextId current()
{
    return reg().running;
}


Status status_of( ContextId aId )
{
    Context* ctx = find( aId );
    return ctx ? ctx->status : Status::Finished;
}


bool destroy( ContextId aId )
{
    Registry& r = reg();
    Context* ctx = find( aId );

    if( !ctx )
        return false;

    if( ctx->status != Status::Finished )
    {
        // Freeing a parked context's stack would strand whatever is on it —
        // the very failure mode this layer exists to make impossible.
        char detail[96];
        std::snprintf( detail, sizeof( detail ), "destroy() on a %s context",
                       status_name( ctx->status ) );
        beacon( "REFUSED", detail, aId );
        r.refusals++;
        return false;
    }

    r.bytes -= ctx->c_stack.size() + ctx->asyncify_stack.size();
    r.live--;
    r.contexts.erase( aId );
    delete ctx;
    return true;
}


std::string stats_json()
{
    Registry& r = reg();
    char buf[640];
    std::snprintf( buf, sizeof( buf ),
                   "{\"live\":%zu,\"peakLive\":%zu,\"created\":%u,\"finished\":%u,"
                   "\"transitions\":%u,\"refusals\":%u,\"running\":%u,"
                   "\"transitionInFlight\":%s,\"readyQueued\":%zu,"
                   "\"bytes\":%zu,\"peakBytes\":%zu,"
                   "\"perContextBytes\":%zu,\"cStackBytes\":%zu,\"asyncifyBytes\":%zu,"
                   "\"asyncifyHighWater\":%zu}",
                   r.live, r.peak_live, r.created, r.finished,
                   r.transitions, r.refusals, r.running,
                   r.transition ? "true" : "false", r.ready_fifo.size(),
                   r.bytes, r.peak_bytes,
                   DEFAULT_C_STACK_BYTES + DEFAULT_ASYNCIFY_BYTES,
                   DEFAULT_C_STACK_BYTES, DEFAULT_ASYNCIFY_BYTES,
                   r.asyncify_high_water );
    return buf;
}


std::string registry_json()
{
    std::string out = "[";
    bool first = true;

    for( const auto& [id, ctx] : reg().contexts )
    {
        char entry[256];
        std::snprintf( entry, sizeof( entry ),
                       "%s{\"id\":%u,\"label\":\"%s\",\"status\":\"%s\",\"reason\":\"%s\","
                       "\"parks\":%u,\"resumes\":%u,\"asyncifyHighWater\":%zu}",
                       first ? "" : ",", id, ctx->label, status_name( ctx->status ),
                       ctx->park_reason, ctx->parks, ctx->resumes,
                       ctx->asyncify_high_water );
        out += entry;
        first = false;
    }

    out += "]";
    return out;
}


void reset_stats()
{
    Registry& r = reg();
    r.created = 0;
    r.finished = 0;
    r.transitions = 0;
    r.refusals = 0;
    r.peak_live = r.live;
    r.peak_bytes = r.bytes;
    r.asyncify_high_water = 0;
}

} // namespace pcbjam_sched
