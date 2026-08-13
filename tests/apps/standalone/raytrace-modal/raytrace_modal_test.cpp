/**
 * raytrace_modal_test.cpp
 *
 * A raytracer-style worker-join run inside a wx modal pump, in both join styles.
 *
 * A pass is dispatched from a wxTimer that fires while a ShowModal() dialog is open. The modal pump
 * runs ProcessEvents via ccall(async:true), so the timer handler runs in a fresh managed Asyncify
 * context at state == Normal (the handler probes and logs the state). Both join styles complete
 * multi-core there:
 *   ?m=0 busywait : the join is a sleep_for() busy-wait; the pre-warmed pool's workers complete it.
 *   ?m=1 yield    : the join yields via emscripten_sleep; legal at state == Normal, so it suspends
 *                   and resumes normally.
 *
 * The persistent pool is warmed in OnInit (on the free top-level slot) so the workers are alive
 * before the modal opens, which lets the in-modal busy-wait complete without on-demand Worker spawn.
 */

#include "wx/wx.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <functional>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

using clk = std::chrono::steady_clock;

static void rtlog( const char* fmt, ... )
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

static long ms( clk::time_point t0 )
{
    return (long) std::chrono::duration_cast<std::chrono::milliseconds>( clk::now() - t0 ).count();
}

// ---------------------------------------------------------------------------
// shared raytracer-style work (atomic work-stealing; mirrors render_3d_raytrace_base.cpp)
// ---------------------------------------------------------------------------
static std::atomic<size_t> g_nextBlock{ 0 };
static std::atomic<int>    g_workersRan{ 0 };
static std::atomic<double> g_sink{ 0.0 };
static int                 g_numBlocks = 48;
static long                g_iters = 600000;

static double computeBlock( int b, long iters )
{
    double acc = 0.0;
    for( long i = 0; i < iters; ++i )
        acc += std::sin( (double) ( b * 131 + i ) * 1e-6 ) * std::cos( (double) i * 1e-7 );
    return acc;
}

static void workerBody()
{
    bool counted = false;
    for( size_t b = g_nextBlock.fetch_add( 1 ); b < (size_t) g_numBlocks; b = g_nextBlock.fetch_add( 1 ) )
    {
        if( !counted )
        {
            g_workersRan.fetch_add( 1 );
            counted = true;
        }
        g_sink.store( g_sink.load( std::memory_order_relaxed ) + computeBlock( (int) b, g_iters ),
                      std::memory_order_relaxed );
    }
}

// ---------------------------------------------------------------------------
// persistent pre-warmed pool (warmed in OnInit, free slot) — so the IN-MODAL busy-wait completes
// rather than deadlocking on on-demand Worker creation.
// ---------------------------------------------------------------------------
struct PersistentPool
{
    int                      n = 0;
    std::vector<std::thread> ts;
    std::mutex               mtx;
    std::condition_variable  cv;
    unsigned long            generation = 0;
    bool                     stop = false;
    std::atomic<size_t>      finished{ 0 };
    std::atomic<size_t>      started{ 0 };

    void start( int n_ )
    {
        n = n_;
        for( int i = 0; i < n; ++i )
            ts.emplace_back( [this] { loop(); } );
    }

    bool ready() const { return started.load() == (size_t) n; }

    void loop()
    {
        started.fetch_add( 1 );
        unsigned long seen = 0;
        for( ;; )
        {
            std::unique_lock<std::mutex> lk( mtx );
            cv.wait( lk, [&] { return stop || generation != seen; } );
            if( stop )
                return;
            seen = generation;
            lk.unlock();
            workerBody();
            finished.fetch_add( 1 );
        }
    }

    // Called on the MAIN thread, from the modal pump's ProcessEvents (state == Normal).
    void runPass( bool yieldJoin )
    {
        finished.store( 0 );
        g_nextBlock.store( 0 );
        g_workersRan.store( 0 );
        {
            std::lock_guard<std::mutex> lk( mtx );
            ++generation;
        }
        cv.notify_all();
        while( finished.load() < (size_t) n )
        {
            if( yieldJoin )
#ifdef __EMSCRIPTEN__
                emscripten_sleep( 10 ); // Asyncify yield (legal here — state == Normal)
#else
                std::this_thread::sleep_for( std::chrono::milliseconds( 10 ) );
#endif
            else
                std::this_thread::sleep_for( std::chrono::microseconds( 200 ) ); // busy-wait join
        }
    }
};

static PersistentPool g_pool;

// ---------------------------------------------------------------------------
// modal scaffold (mirrors coroutine-nested/nested_test.cpp's AutoClosingDialog)
// ---------------------------------------------------------------------------
static constexpr int ID_MODAL_CLOSE = wxID_HIGHEST + 800;
static constexpr int ID_SCENARIO    = wxID_HIGHEST + 801;
static constexpr int ID_MODAL_WORK  = wxID_HIGHEST + 802;

class AutoClosingDialog : public wxDialog
{
public:
    AutoClosingDialog( wxWindow* parent ) :
            wxDialog( parent, wxID_ANY, "rt-modal", wxDefaultPosition, wxSize( 280, 120 ) ),
            m_workTimer( this, ID_MODAL_WORK )
    {
        Bind( wxEVT_SHOW, &AutoClosingDialog::OnShow, this );
        Bind( wxEVT_TIMER, &AutoClosingDialog::OnWorkTimer,
              this, ID_MODAL_WORK );
    }

    void RunWorkAfterShow( std::function<void()> work, int delayMs )
    {
        m_work = std::move( work );
        m_workDelayMs = delayMs;
    }

    void EndModalExternal( int code ) { EndModal( code ); }

private:
    void OnShow( wxShowEvent& event )
    {
        if( event.IsShown() && m_work )
            m_workTimer.StartOnce( m_workDelayMs );

        event.Skip();
    }

    void OnWorkTimer( wxTimerEvent& )
    {
        if( m_work )
        {
            auto work = std::move( m_work );
            m_work = nullptr;
            work();
        }
    }

    wxTimer m_workTimer;
    std::function<void()> m_work;
    int m_workDelayMs = 0;
};

class RtModalFrame : public wxFrame
{
public:
    RtModalFrame( int mode ) :
            wxFrame( nullptr, wxID_ANY, "Raytrace Modal Test", wxDefaultPosition, wxSize( 420, 140 ) ),
            m_mode( mode ),
            m_scenarioTimer( this, ID_SCENARIO )
    {
        wxPanel* p = new wxPanel( this );
        wxBoxSizer* s = new wxBoxSizer( wxVERTICAL );
        s->Add( new wxStaticText( p, wxID_ANY, "Raytrace-in-modal repro — see console." ), 0, wxALL, 16 );
        p->SetSizer( s );
        Bind( wxEVT_TIMER, &RtModalFrame::OnScenario, this, ID_SCENARIO );
    }

    void armScenario() { m_scenarioTimer.StartOnce( 50 ); }

private:
    // In the main loop: arm the modal-work timer BEFORE ShowModal so it fires from within the modal
    // pump, then show the modal.
    void OnScenario( wxTimerEvent& )
    {
        AutoClosingDialog* dlg = new AutoClosingDialog( this );
        m_activeDialog = dlg;
        dlg->RunWorkAfterShow( [this]() { OnModalWork(); }, 30 );
        rtlog( "[RTPOOL] showing modal (mode=%d) — work runs from the modal pump's ProcessEvents", m_mode );
        dlg->ShowModal(); // returns when OnModalWork's pass finishes and closes it
        m_activeDialog = nullptr;
        rtlog( "[RTPOOL] SUCCESS mode=%d workersRan=%d totalMs=%ld",
               m_mode, g_workersRan.load(), ms( m_t0 ) );
        dlg->Destroy();
    }

    // Fires from the modal pump's ProcessEvents — a fresh managed entry at Asyncify state == Normal.
    void OnModalWork()
    {
#ifdef __EMSCRIPTEN__
        int st = EM_ASM_INT( {
            return ( typeof Asyncify !== 'undefined' && Asyncify.state !== undefined ) ? Asyncify.state : -1;
        } );
        rtlog( "[RTPOOL] modal-work: Asyncify.state=%d (0=Normal,1=Unwinding,2=Rewinding) mode=%d", st, m_mode );
#endif
        rtlog( "[RTPOOL] modal-work: running pass from the modal pump (mode=%d)", m_mode );
        m_t0 = clk::now();
        g_pool.runPass( m_mode == 1 ); // m=1 yields via emscripten_sleep; m=0 busy-waits
        rtlog( "[RTPOOL] PASS done workersRan=%d", g_workersRan.load() );
        if( m_activeDialog )
            m_activeDialog->EndModalExternal( wxID_OK );
    }

    int                m_mode;
    AutoClosingDialog* m_activeDialog = nullptr;
    clk::time_point    m_t0;
    wxTimer            m_scenarioTimer;
};

class RtModalApp : public wxApp
{
public:
    bool OnInit() override
    {
        const int mode = readMode();
        const int hwc = std::max( 1u, std::thread::hardware_concurrency() );
        rtlog( "[RTPOOL] START mode=%d hwc=%d", mode, hwc );

        // Warm the persistent pool on the FREE top-level slot (emscripten_sleep is legal here), so
        // the in-modal join runs against already-alive workers.
        g_pool.start( hwc );
        while( !g_pool.ready() )
#ifdef __EMSCRIPTEN__
            emscripten_sleep( 5 );
#else
            std::this_thread::sleep_for( std::chrono::milliseconds( 5 ) );
#endif
        rtlog( "[RTPOOL] pool warmed (%d workers)", hwc );

        RtModalFrame* f = new RtModalFrame( mode );
        f->Show();
        f->armScenario();
        return true;
    }
};

wxIMPLEMENT_APP( RtModalApp );
