// Hiding the window that holds focus must move focus off it (DOM port).
//
// Bug (src/wasm/window.cpp): wxWindowWasm::Show(false) hid the DOM element but
// left gs_focusWindow on it. KiCad's board editor focuses the Search pane's text
// box while the frame is built, then hides that pane: from then on every key
// went to the invisible box, and KiCad's canvas refused to take focus on hover
// because a text control "had" it (KIUI::IsInputControlFocused). So hovering a
// part and pressing E (Properties) did nothing until the user clicked somewhere.
// GTK unsets a toplevel's focus when its focus widget is hidden; the port now
// hands focus back to the frame (whose SetFocus picks its largest focusable
// child, P-4).
//
// The app mirrors that boot: a side pane with a text box and a large canvas-like
// window; the text box takes focus, the pane is hidden. Then
//   - hidden_window_releases_focus: wxWindow::FindFocus() must not be a window
//     that is no longer shown on screen;
//   - key_target (after the spec presses a key): the key must reach the canvas,
//     not the hidden text box.
//
//   RED  (bug present): focus stays on the hidden text box; the key goes there.
//   GREEN (fixed):      focus moves to the canvas; the key arrives there.

#include "wx/wxprec.h"
#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

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

static wxString Describe(wxWindow *w)
{
    if (!w)
        return "NULL";
    return wxString::Format("%s (shownOnScreen=%d)", w->GetName(), w->IsShownOnScreen() ? 1 : 0);
}

// Stand-in for KiCad's GAL canvas: a plain focusable window that wants keys.
class Canvas : public wxWindow
{
public:
    explicit Canvas(wxWindow *parent)
        : wxWindow(parent, wxID_ANY, wxDefaultPosition, wxSize(400, 300), wxWANTS_CHARS, "canvas")
    {
        SetBackgroundColour(*wxWHITE);
        Bind(wxEVT_KEY_DOWN, [](wxKeyEvent &e)
        {
            Report("key_target", true, wxString::Format("canvas got key %d", e.GetKeyCode()));
            e.Skip();
        });
    }

    bool AcceptsFocus() const override { return true; }
};

class ReproFrame : public wxFrame
{
public:
    ReproFrame();

private:
    void RunTest();

    wxPanel *m_pane;
    wxTextCtrl *m_search;
};

ReproFrame::ReproFrame()
    : wxFrame(nullptr, wxID_ANY, "hidden focus repro")
{
    wxBoxSizer *sizer = new wxBoxSizer(wxHORIZONTAL);

    // The "search pane": a small side panel whose text box grabs focus.
    m_pane = new wxPanel(this, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxTAB_TRAVERSAL, "pane");
    m_search = new wxTextCtrl(m_pane, wxID_ANY, "", wxDefaultPosition, wxSize(120, -1), 0,
                              wxDefaultValidator, "searchBox");
    wxBoxSizer *paneSizer = new wxBoxSizer(wxVERTICAL);
    paneSizer->Add(m_search, 0, wxALL, 4);
    m_pane->SetSizer(paneSizer);
    m_search->Bind(wxEVT_KEY_DOWN, [](wxKeyEvent &e)
    {
        Report("key_target", false, wxString::Format("hidden search box got key %d", e.GetKeyCode()));
        e.Skip();
    });

    sizer->Add(m_pane, 0, wxEXPAND);
    sizer->Add(new Canvas(this), 1, wxEXPAND);
    SetSizer(sizer);

    CallAfter(&ReproFrame::RunTest);
}

void ReproFrame::RunTest()
{
    m_search->SetFocus();
    const bool searchTookFocus = wxWindow::FindFocus() == m_search;

    m_pane->Hide();
    Layout();

    wxWindow *focus = wxWindow::FindFocus();
    const bool pass = searchTookFocus && (focus == nullptr || focus->IsShownOnScreen());
    Report("hidden_window_releases_focus", pass,
           wxString::Format("search took focus=%d; focus after hiding its pane=%s",
                            searchTookFocus ? 1 : 0, Describe(focus)));
    Report("ready_for_key", true, "press a key now");
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
