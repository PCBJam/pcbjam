// wxToolTip hover-window lifetime reproduction (DOM port).
//
// Bug (src/wasm/tooltip.cpp):
//
//   wxWindow *gs_hoverWindow = NULL;            // raw pointer, set on hover
//   ... wxWasmTooltipTimer::Notify() {
//       wxWindow *win = FindTooltipWindow(gs_hoverWindow);  // 600 ms later:
//       ...                                                 // win->GetParent()/
//   }                                                       // GetToolTip()/...
//
// Nothing clears gs_hoverWindow when the hovered window is destroyed, so a
// window destroyed within the 600 ms tooltip delay leaves gs_hoverWindow
// dangling -> use-after-free when the timer fires.
//
// ASAN can't catch this here (the read lives in the wx library, which is not
// instrumented), so the repro checks the invariant the bug violates directly:
// it arms the hover for a window (the same call wxApp::HandleMouseEvent makes on
// hover-in), destroys that window, and asks — via a diagnostic accessor — whether
// the hovered-window pointer was cleared.
//
//   RED  (bug present): gs_hoverWindow still points at the freed window.
//   GREEN (fixed):      gs_hoverWindow was cleared on destruction.

#include "wx/wxprec.h"
#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

// Hooks defined in src/wasm/tooltip.cpp.
extern void wxWasmTooltipOnHoverChange(wxWindow *win);
extern wxWindow *wxWasmTooltipDebugHoverWindow();

static void Report(const char *name, bool pass, const wxString &detail)
{
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var msg = '[REPRO] ' + UTF8ToString($0) + ': ' + ($1 ? 'PASS' : 'FAIL')
                  + ' - ' + UTF8ToString($2);
        if ($1) { console.log(msg); } else { console.error(msg); }
    }, name, pass ? 1 : 0, (const char *)detail.utf8_str());
#endif
}

class ReproFrame : public wxFrame
{
public:
    ReproFrame();

private:
    void RunTest();
    void OnOpenModal(wxCommandEvent& event);
    void OnOpenPointerModal(wxCommandEvent& event);
};

ReproFrame::ReproFrame()
    : wxFrame(nullptr, wxID_ANY, "wxToolTip lifetime repro",
              wxDefaultPosition, wxSize(420, 180))
{
    wxBoxSizer * const sizer = new wxBoxSizer(wxVERTICAL);
    sizer->Add(new wxStaticText(
            this, wxID_ANY,
            "Tooltip ownership and window-lifetime reducer"),
            0, wxALL, 12);

    wxButton * const open = new wxButton(
            this, wxID_ANY, "Open Modal Tooltip");
    open->Bind(wxEVT_BUTTON, &ReproFrame::OnOpenModal, this);
    sizer->Add(open, 0, wxLEFT | wxRIGHT | wxBOTTOM, 12);

    wxButton * const openPointer = new wxButton(
            this, wxID_ANY, "Open Pointer Scroll Modal");
    openPointer->Bind(wxEVT_BUTTON,
                      &ReproFrame::OnOpenPointerModal, this);
    sizer->Add(openPointer, 0, wxLEFT | wxRIGHT | wxBOTTOM, 12);
    SetSizer(sizer);

    CallAfter(&ReproFrame::RunTest);
}

void ReproFrame::RunTest()
{
    wxWindow *victim = new wxPanel(this, wxID_ANY,
                                   wxDefaultPosition, wxSize(120, 60));
    victim->SetToolTip("VICTIM_TOOLTIP");

    // Arm the hover exactly like wxApp::HandleMouseEvent does on hover-in:
    // gs_hoverWindow = victim, and the 600 ms tooltip timer starts.
    wxWasmTooltipOnHoverChange(victim);
    const bool armed = (wxWasmTooltipDebugHoverWindow() == victim);

    const uintptr_t victimAddr = reinterpret_cast<uintptr_t>(victim);

    // Destroy the hovered window while the tooltip timer is still pending.
    delete victim;

    // Invariant: the hovered-window pointer must not outlive its window.
    wxWindow *hover = wxWasmTooltipDebugHoverWindow();
    const bool cleared = (hover == nullptr);
    const bool pass = armed && cleared;

    Report("tooltip_hover_window_cleared_on_destroy", pass,
           wxString::Format("armed=%d hover=%p victim=0x%lx",
                            armed ? 1 : 0, (void *)hover,
                            static_cast<unsigned long>(victimAddr)));
}

void ReproFrame::OnOpenModal(wxCommandEvent& WXUNUSED(event))
{
    wxDialog dialog(this, wxID_ANY, "Tooltip Modal");
    wxBoxSizer * const sizer = new wxBoxSizer(wxVERTICAL);

    wxButton * const target = new wxButton(
            &dialog, wxID_ANY, "Modal Tooltip Target");
    target->SetToolTip("MODAL_TOOLTIP");
    sizer->Add(target, 0, wxALL | wxALIGN_CENTER_HORIZONTAL, 16);
    sizer->Add(new wxButton(&dialog, wxID_CANCEL, "Close"),
               0, wxLEFT | wxRIGHT | wxBOTTOM | wxALIGN_CENTER_HORIZONTAL,
               16);

    dialog.SetSizerAndFit(sizer);

    // Queue the exact hover operation before ShowModal(), then let the modal
    // pump admit it after the dialog lease is open. This is the deterministic
    // equivalent of wxApp::HandleMouseEvent's hover call, without depending on
    // browser scroll geometry for a secondary DOM-backed top-level window.
    //
    // RED before the owner-aware fix: the derived tooltip timer owns itself,
    // so its expiry is Ordinary and waits behind this parked modal opener.
    // GREEN after the fix: Arm() binds it to target and captures this dialog's
    // exact top-level scope and active lease generation.
    dialog.CallAfter([target]() {
        wxWasmTooltipOnHoverChange(target);
        Report("tooltip_modal_timer_armed",
               wxWasmTooltipDebugHoverWindow() == target,
               wxString::Format("hover=%p target=%p",
                                (void *)wxWasmTooltipDebugHoverWindow(),
                                (void *)target));
    });

    dialog.ShowModal();
}

void ReproFrame::OnOpenPointerModal(wxCommandEvent& WXUNUSED(event))
{
    wxDialog dialog(this, wxID_ANY, "Pointer Scroll Modal");
    wxBoxSizer * const sizer = new wxBoxSizer(wxVERTICAL);

    wxButton * const target = new wxButton(
            &dialog, wxID_ANY, "Pointer Scroll Target");
    sizer->Add(target, 0, wxALL | wxALIGN_CENTER_HORIZONTAL, 16);
    sizer->Add(new wxButton(&dialog, wxID_CANCEL, "Close Pointer Modal"),
               0, wxLEFT | wxRIGHT | wxBOTTOM | wxALIGN_CENTER_HORIZONTAL,
               16);

    dialog.SetSizerAndFit(sizer);

    // The generated standalone shell leaves #window-container in document
    // flow after the full-height main canvas. A browser therefore scrolls this
    // real DOM button into view. Its visual client coordinates no longer share
    // an origin with #canvas, but the forwarded event must remain in wx screen
    // coordinates and reach this exact native control.
    bool motionReported = false;
    target->Bind(wxEVT_MOTION,
                 [target, &motionReported](wxMouseEvent& motion) {
        if ( !motionReported )
        {
            motionReported = true;
            const wxPoint client = motion.GetPosition();
            const wxPoint screen = target->ClientToScreen(client);
            const wxRect targetRect = target->GetScreenRect();
            const bool pass = target->GetClientRect().Contains(client)
                              && targetRect.Contains(screen);

            Report("dom_pointer_scroll_target", pass,
                   wxString::Format(
                           "client=%d,%d screen=%d,%d target=%d,%d,%d,%d",
                           client.x, client.y, screen.x, screen.y,
                           targetRect.x, targetRect.y,
                           targetRect.width, targetRect.height));
        }

        motion.Skip();
    });

    dialog.CallAfter([target]() {
        const wxRect rect = target->GetScreenRect();
        Report("dom_pointer_scroll_ready", true,
               wxString::Format("target=%d,%d,%d,%d",
                                rect.x, rect.y, rect.width, rect.height));
    });

    dialog.ShowModal();
}

class ReproApp : public wxApp
{
public:
    bool OnInit() override
    {
        if (!wxApp::OnInit())
            return false;

        (new ReproFrame())->Show(true);
        return true;
    }
};

wxIMPLEMENT_APP(ReproApp);
