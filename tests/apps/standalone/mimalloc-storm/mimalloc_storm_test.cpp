/**
 * Deterministic regression for an Asyncify suspension inside mimalloc.
 *
 * Emscripten's mimalloc uses sleep(0) as a spin-wait hint.  The project's
 * nanosleep override must treat that duration as a no-op: turning it into an
 * Asyncify event-loop yield can suspend the main thread in the middle of
 * malloc or mi_collect.
 *
 * This test makes workers free main-thread allocations while the main thread
 * allocates from and collects the same size class.  A self-rearming JavaScript
 * timer counts event-loop turns during that otherwise synchronous storm.  The
 * count must stay zero.  A subsequent 5 ms nanosleep must still run a timer,
 * which proves that positive sleeps retain the yield used to boot on-demand
 * pthread workers.
 *
 * Console contract:
 *   [MIMALLOC_STORM] START threads=W blocks=B rounds=R
 *   [MIMALLOC_STORM] SUMMARY zeroSleepCalls=Z mainZeroSleepCalls=M
 *                    stormMainZeroSleeps=S stormTurns=N sleepTurned=0|1
 *                    completed=0|1
 */

#include <emscripten/emscripten.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <climits>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <time.h>
#include <vector>

extern "C" void mi_collect( bool force );
extern "C" unsigned pcbjam_nanosleep_zero_duration_call_count();
extern "C" unsigned pcbjam_nanosleep_main_thread_zero_duration_call_count();
extern "C" int pcbjam_nanosleep_timer_chunk_ms_for_test( double ms );

namespace
{
constexpr size_t   BLOCK_COUNT = 200000;
constexpr size_t   BLOCK_SIZE = 64;
constexpr unsigned MAX_ROUNDS = 40;
constexpr int      TURN_LIMIT = 50;

void*                 g_blocks[BLOCK_COUNT];
std::atomic<size_t>   g_nextBlock{ 0 };
std::atomic<unsigned> g_generation{ 0 };
std::atomic<unsigned> g_workersReady{ 0 };
std::atomic<unsigned> g_workersDone{ 0 };
std::atomic<bool>     g_stop{ false };

void logLine( const char* format, ... )
{
    char text[256];
    va_list args;
    va_start( args, format );
    std::vsnprintf( text, sizeof( text ), format, args );
    va_end( args );
    EM_ASM( { console.log( UTF8ToString( $0 ) ); }, text );
}

void workerBody()
{
    unsigned seenGeneration = 0;
    g_workersReady.fetch_add( 1, std::memory_order_release );

    for( ;; )
    {
        const unsigned generation = g_generation.load( std::memory_order_acquire );

        if( generation == seenGeneration )
        {
            std::this_thread::yield();
            continue;
        }

        seenGeneration = generation;

        if( g_stop.load( std::memory_order_acquire ) )
            return;

        for( size_t i = g_nextBlock.fetch_add( 1, std::memory_order_relaxed );
             i < BLOCK_COUNT;
             i = g_nextBlock.fetch_add( 1, std::memory_order_relaxed ) )
        {
            std::free( g_blocks[i] );
        }

        g_workersDone.fetch_add( 1, std::memory_order_release );
    }
}

__attribute__(( noinline )) void churnAllocation( unsigned value )
{
    void* block = std::malloc( BLOCK_SIZE );

    if( block )
    {
        static_cast<volatile unsigned char*>( block )[0] = static_cast<unsigned char>( value );
        std::free( block );
    }
}

void startStormTurnDetector()
{
    EM_ASM( {
        globalThis.__mimallocStormActive = true;
        globalThis.__mimallocStormTurns = 0;

        const tick = function() {
            if( !globalThis.__mimallocStormActive )
                return;

            ++globalThis.__mimallocStormTurns;
            setTimeout( tick, 0 );
        };

        setTimeout( tick, 0 );
    } );
}

int stopStormTurnDetector()
{
    return EM_ASM_INT( {
        globalThis.__mimallocStormActive = false;
        return globalThis.__mimallocStormTurns | 0;
    } );
}

bool positiveSleepTurnsEventLoop()
{
    EM_ASM( {
        globalThis.__mimallocPositiveSleepTurned = 0;
        setTimeout( function() { globalThis.__mimallocPositiveSleepTurned = 1; }, 0 );
    } );

    const timespec delay{ 0, 5 * 1000 * 1000 };
    nanosleep( &delay, nullptr );

    return EM_ASM_INT( { return globalThis.__mimallocPositiveSleepTurned | 0; } ) != 0;
}

bool positiveSleepDelaysAreSafe()
{
    // One nanosecond becomes a one-millisecond timer.  A value beyond the
    // browser timer range becomes one maximum-sized chunk; nanosleep repeats
    // chunks after each wake instead of returning early.
    return pcbjam_nanosleep_timer_chunk_ms_for_test( 1.0e-6 ) == 1
           && pcbjam_nanosleep_timer_chunk_ms_for_test(
                      static_cast<double>( INT_MAX ) + 1000.0 ) == INT_MAX;
}

bool invalidSleepsAreRejected()
{
    timespec remainder{ 7, 11 };
    const timespec negativeSeconds{ -1, 0 };
    errno = 0;

    if( nanosleep( &negativeSeconds, &remainder ) != -1 || errno != EINVAL
        || remainder.tv_sec != 7 || remainder.tv_nsec != 11 )
    {
        return false;
    }

    const timespec invalidNanoseconds{ 0, 1000 * 1000 * 1000L };
    errno = 0;
    return nanosleep( &invalidNanoseconds, &remainder ) == -1
           && errno == EINVAL
           && remainder.tv_sec == 7 && remainder.tv_nsec == 11;
}
} // namespace

int main()
{
    const unsigned hardwareThreads = std::max( 1u, std::thread::hardware_concurrency() );
    const unsigned workerCount = std::min( 8u, hardwareThreads );
    std::vector<std::thread> workers;
    workers.reserve( workerCount );

    for( unsigned i = 0; i < workerCount; ++i )
        workers.emplace_back( workerBody );

    while( g_workersReady.load( std::memory_order_acquire ) != workerCount )
        std::this_thread::yield();

    logLine( "[MIMALLOC_STORM] START threads=%u blocks=%zu rounds=%u",
             workerCount, BLOCK_COUNT, MAX_ROUNDS );
    startStormTurnDetector();
    const unsigned stormMainZeroSleepStart =
            pcbjam_nanosleep_main_thread_zero_duration_call_count();

    bool completed = true;

    for( unsigned round = 0; round < MAX_ROUNDS; ++round )
    {
        size_t allocated = 0;

        for( ; allocated < BLOCK_COUNT; ++allocated )
        {
            g_blocks[allocated] = std::malloc( BLOCK_SIZE );

            if( !g_blocks[allocated] )
                break;

            static_cast<volatile unsigned char*>( g_blocks[allocated] )[0] =
                    static_cast<unsigned char>( round );
        }

        if( allocated != BLOCK_COUNT )
        {
            for( size_t i = 0; i < allocated; ++i )
                std::free( g_blocks[i] );

            completed = false;
            break;
        }

        g_nextBlock.store( 0, std::memory_order_relaxed );
        g_workersDone.store( 0, std::memory_order_relaxed );
        g_generation.fetch_add( 1, std::memory_order_release );

        do
        {
            for( unsigned i = 0; i < 1024; ++i )
                churnAllocation( round + i );

            mi_collect( true );
        } while( g_workersDone.load( std::memory_order_acquire ) != workerCount );

        if( EM_ASM_INT( { return globalThis.__mimallocStormTurns | 0; } ) >= TURN_LIMIT )
            break;
    }

    const unsigned stormMainZeroSleepEnd =
            pcbjam_nanosleep_main_thread_zero_duration_call_count();
    const unsigned stormMainZeroSleeps =
            stormMainZeroSleepEnd - stormMainZeroSleepStart;
    const int stormTurns = stopStormTurnDetector();

    g_stop.store( true, std::memory_order_release );
    g_generation.fetch_add( 1, std::memory_order_release );

    for( std::thread& worker : workers )
        worker.join();

    const unsigned zeroSleepCalls = pcbjam_nanosleep_zero_duration_call_count();
    const unsigned mainZeroSleepCalls =
            pcbjam_nanosleep_main_thread_zero_duration_call_count();
    const bool sleepTurned = positiveSleepTurnsEventLoop();
    const bool safePositiveDelays = positiveSleepDelaysAreSafe();
    const bool invalidRejected = invalidSleepsAreRejected();
    logLine( "[MIMALLOC_STORM] SUMMARY zeroSleepCalls=%u mainZeroSleepCalls=%u "
             "stormMainZeroSleeps=%u stormTurns=%d sleepTurned=%d completed=%d "
             "invalidRejected=%d safePositiveDelays=%d",
             zeroSleepCalls, mainZeroSleepCalls, stormMainZeroSleeps, stormTurns,
             static_cast<int>( sleepTurned ), static_cast<int>( completed ),
             static_cast<int>( invalidRejected ),
             static_cast<int>( safePositiveDelays ) );
    return stormMainZeroSleeps > 0 && stormTurns == 0 && completed && sleepTurned
                   && invalidRejected && safePositiveDelays
           ? 0
           : 1;
}
