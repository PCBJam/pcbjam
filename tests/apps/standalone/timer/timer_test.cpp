// wxTimer Test - Tests timer functionality in WASM
// KiCad uses timers for animations, auto-save, and periodic updates

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/timer.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

class TimerTestApp : public wxApp
{
public:
    virtual bool OnInit() override;
};

class TimerTestFrame : public wxFrame
{
public:
    TimerTestFrame();
    ~TimerTestFrame();

private:
    wxTimer* m_timer;
    wxTimer* m_fastTimer;
    int m_counter;
    int m_fastCounter;
    wxStaticText* m_counterDisplay;
    wxStaticText* m_fastCounterDisplay;
    wxGauge* m_progressGauge;
    wxTextCtrl* m_log;

    void LogEvent(const wxString& msg);

    void OnStartTimer(wxCommandEvent& evt);
    void OnStopTimer(wxCommandEvent& evt);
    void OnStartFastTimer(wxCommandEvent& evt);
    void OnStopFastTimer(wxCommandEvent& evt);
    void OnResetCounters(wxCommandEvent& evt);
    void OnTimer(wxTimerEvent& evt);
    void OnFastTimer(wxTimerEvent& evt);

    wxDECLARE_EVENT_TABLE();
};

enum {
    ID_START_TIMER = wxID_HIGHEST + 1,
    ID_STOP_TIMER,
    ID_START_FAST_TIMER,
    ID_STOP_FAST_TIMER,
    ID_RESET_COUNTERS,
    ID_TIMER,
    ID_FAST_TIMER
};

wxBEGIN_EVENT_TABLE(TimerTestFrame, wxFrame)
    EVT_BUTTON(ID_START_TIMER, TimerTestFrame::OnStartTimer)
    EVT_BUTTON(ID_STOP_TIMER, TimerTestFrame::OnStopTimer)
    EVT_BUTTON(ID_START_FAST_TIMER, TimerTestFrame::OnStartFastTimer)
    EVT_BUTTON(ID_STOP_FAST_TIMER, TimerTestFrame::OnStopFastTimer)
    EVT_BUTTON(ID_RESET_COUNTERS, TimerTestFrame::OnResetCounters)
    EVT_TIMER(ID_TIMER, TimerTestFrame::OnTimer)
    EVT_TIMER(ID_FAST_TIMER, TimerTestFrame::OnFastTimer)
wxEND_EVENT_TABLE()

wxIMPLEMENT_APP(TimerTestApp);

#ifdef __EMSCRIPTEN__
// A long interval makes every callback remain in the browser-delay half of the
// mailbox. Repeating beyond MAX_MAILBOX_JOBS proves Stop() returns each exact
// reservation, and starting an already-running timer proves restart cancels
// the previous identity before it creates the replacement.
extern "C" int EMSCRIPTEN_KEEPALIVE wx_timer_cancellation_probe()
{
    wxTimer timer;
    timer.Stop(); // The public contract says this is an idempotent no-op.

    for (int i = 0; i < 4097; ++i)
    {
        if (!timer.Start(60 * 60 * 1000) || !timer.IsRunning())
            return 0;

        timer.Stop();
        if (timer.IsRunning())
            return 0;
    }

    if (!timer.Start(60 * 60 * 1000) ||
        !timer.Start(60 * 60 * 1000) || !timer.IsRunning())
    {
        return 0;
    }

    timer.Stop();
    return timer.IsRunning() ? 0 : 1;
}
#endif

bool TimerTestApp::OnInit()
{
    if (!wxApp::OnInit())
        return false;

    TimerTestFrame* frame = new TimerTestFrame();
    frame->Show(true);
    return true;
}

TimerTestFrame::TimerTestFrame()
    : wxFrame(nullptr, wxID_ANY, "wxTimer WASM Test",
              wxDefaultPosition, wxSize(600, 550))
    , m_counter(0)
    , m_fastCounter(0)
{
    m_timer = new wxTimer(this, ID_TIMER);
    m_fastTimer = new wxTimer(this, ID_FAST_TIMER);

    wxBoxSizer* mainSizer = new wxBoxSizer(wxVERTICAL);

    wxStaticText* desc = new wxStaticText(this, wxID_ANY,
        "wxTimer Test\n\n"
        "KiCad uses timers for auto-save, animations, and periodic updates.\n"
        "Test both slow (1 sec) and fast (100ms) timers.");
    mainSizer->Add(desc, 0, wxALL, 10);

    // Slow timer section (1 second interval)
    wxStaticBoxSizer* timerBox = new wxStaticBoxSizer(wxVERTICAL, this, "Slow Timer (1 second)");

    wxBoxSizer* timerBtnSizer = new wxBoxSizer(wxHORIZONTAL);
    timerBtnSizer->Add(new wxButton(this, ID_START_TIMER, "Start"), 0, wxALL, 5);
    timerBtnSizer->Add(new wxButton(this, ID_STOP_TIMER, "Stop"), 0, wxALL, 5);
    timerBox->Add(timerBtnSizer, 0, wxALIGN_CENTER);

    m_counterDisplay = new wxStaticText(this, wxID_ANY, "Counter: 0",
        wxDefaultPosition, wxDefaultSize, wxALIGN_CENTER);
    m_counterDisplay->SetFont(m_counterDisplay->GetFont().Scale(2.0));
    timerBox->Add(m_counterDisplay, 0, wxALIGN_CENTER | wxALL, 10);

    mainSizer->Add(timerBox, 0, wxEXPAND | wxALL, 10);

    // Fast timer section (100ms interval)
    wxStaticBoxSizer* fastTimerBox = new wxStaticBoxSizer(wxVERTICAL, this, "Fast Timer (100ms)");

    wxBoxSizer* fastBtnSizer = new wxBoxSizer(wxHORIZONTAL);
    fastBtnSizer->Add(new wxButton(this, ID_START_FAST_TIMER, "Start Fast"), 0, wxALL, 5);
    fastBtnSizer->Add(new wxButton(this, ID_STOP_FAST_TIMER, "Stop Fast"), 0, wxALL, 5);
    fastTimerBox->Add(fastBtnSizer, 0, wxALIGN_CENTER);

    m_fastCounterDisplay = new wxStaticText(this, wxID_ANY, "Fast Counter: 0");
    fastTimerBox->Add(m_fastCounterDisplay, 0, wxALIGN_CENTER | wxALL, 5);

    m_progressGauge = new wxGauge(this, wxID_ANY, 100);
    fastTimerBox->Add(m_progressGauge, 0, wxEXPAND | wxALL, 5);

    mainSizer->Add(fastTimerBox, 0, wxEXPAND | wxALL, 10);

    // Reset button
    mainSizer->Add(new wxButton(this, ID_RESET_COUNTERS, "Reset All Counters"),
                   0, wxALIGN_CENTER | wxALL, 5);

    // Event log
    wxStaticBoxSizer* logBox = new wxStaticBoxSizer(wxVERTICAL, this, "Event Log");
    m_log = new wxTextCtrl(this, wxID_ANY, "",
        wxDefaultPosition, wxSize(-1, 120), wxTE_MULTILINE | wxTE_READONLY);
    logBox->Add(m_log, 1, wxEXPAND | wxALL, 5);
    mainSizer->Add(logBox, 1, wxEXPAND | wxALL, 10);

    SetSizer(mainSizer);
    CreateStatusBar();
    SetStatusText("Ready");

    LogEvent("Timer test app started");

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[TIMER_TEST] wxTimer test app started successfully');
    });
#endif
}

TimerTestFrame::~TimerTestFrame()
{
    m_timer->Stop();
    m_fastTimer->Stop();
    delete m_timer;
    delete m_fastTimer;
}

void TimerTestFrame::LogEvent(const wxString& msg)
{
    m_log->AppendText(msg + "\n");
    SetStatusText(msg);

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[TIMER_EVENT] ' + UTF8ToString($0));
    }, msg.c_str().AsChar());
#endif
}

void TimerTestFrame::OnStartTimer(wxCommandEvent& WXUNUSED(evt))
{
    m_timer->Start(1000); // 1 second
    LogEvent("Slow timer started (1 second interval)");
}

void TimerTestFrame::OnStopTimer(wxCommandEvent& WXUNUSED(evt))
{
    m_timer->Stop();
    LogEvent("Slow timer stopped");
}

void TimerTestFrame::OnStartFastTimer(wxCommandEvent& WXUNUSED(evt))
{
    m_fastTimer->Start(100); // 100ms
    LogEvent("Fast timer started (100ms interval)");
}

void TimerTestFrame::OnStopFastTimer(wxCommandEvent& WXUNUSED(evt))
{
    m_fastTimer->Stop();
    LogEvent("Fast timer stopped");
}

void TimerTestFrame::OnResetCounters(wxCommandEvent& WXUNUSED(evt))
{
    m_counter = 0;
    m_fastCounter = 0;
    m_counterDisplay->SetLabel("Counter: 0");
    m_fastCounterDisplay->SetLabel("Fast Counter: 0");
    m_progressGauge->SetValue(0);
    LogEvent("Counters reset");
}

void TimerTestFrame::OnTimer(wxTimerEvent& WXUNUSED(evt))
{
    m_counter++;
    m_counterDisplay->SetLabel(wxString::Format("Counter: %d", m_counter));

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[TIMER_TICK] Slow timer tick: ' + $0);
    }, m_counter);
#endif
}

void TimerTestFrame::OnFastTimer(wxTimerEvent& WXUNUSED(evt))
{
    m_fastCounter++;
    m_fastCounterDisplay->SetLabel(wxString::Format("Fast Counter: %d", m_fastCounter));
    m_progressGauge->SetValue(m_fastCounter % 101);

    // Log every 10 ticks to avoid flooding
    if (m_fastCounter % 10 == 0) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[TIMER_TICK] Fast timer tick: ' + $0);
        }, m_fastCounter);
#endif
    }
}
