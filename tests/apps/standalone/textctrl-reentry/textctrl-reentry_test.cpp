// wxTextCtrl DOM-sync reentry-guard reproduction (DOM port) — real-path version.
//
// Bug (src/wasm/textctrl.cpp, OnDomEvent / wxDOM_EVENT_INPUT):
//
//     m_inDomInput = true;
//     const wxString value = wxDomGetValue(WasmGetDomId());
//     DoSetValue(value, SetValue_SendEvent);   // fires wxEVT_TEXT
//     m_inDomInput = false;                     // <-- skipped if a handler throws
//
// DoSetValue()/WriteText() only push the value into the <input> element
// `if (!m_inDomInput)`. If a wxEVT_TEXT handler exits non-locally (throws), the
// reset is skipped, m_inDomInput stays true, and every later programmatic
// SetValue()/ChangeValue() silently stops updating the visible element.
//
// This repro uses the REAL delivery path (no synthetic OnDomEvent call, no
// app-level try/catch that could change unwinding): the spec types into the
// <input>, which fires a genuine DOM 'input' event -> wx-dom.js dispatch() ->
// wx_dom_event() (extern "C") -> OnDomEvent. The bound wxEVT_TEXT handler throws
// once; wxEvtHandler::SafelyProcessEvent catches it at the wx event boundary.
// This test app explicitly continues its main loop after that expected
// exception. The spec then clicks a button that does a programmatic
// ChangeValue() and checks the element.
//
//   RED  (bug present): the <input> keeps the typed text; ChangeValue is dropped.
//   GREEN (fixed):      the <input> shows the programmatic value.

#include "wx/wxprec.h"
#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include <stdexcept>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

enum
{
    ID_SET_PROGRAMMATIC = wxID_HIGHEST + 1,
    ID_BLOCK_OWNER
};

class ReproFrame : public wxFrame
{
public:
    ReproFrame();

private:
    void OnText(wxCommandEvent &evt);
    void OnSetProgrammatic(wxCommandEvent &evt);
    void OnBlockOwner(wxCommandEvent &evt);

    wxTextCtrl *m_text = nullptr;
    bool m_throwArmed = true;
};

ReproFrame::ReproFrame()
    : wxFrame(nullptr, wxID_ANY, "wxTextCtrl reentry repro")
{
    wxBoxSizer *sizer = new wxBoxSizer(wxVERTICAL);

    m_text = new wxTextCtrl(this, wxID_ANY, "");
    m_text->Bind(wxEVT_TEXT, &ReproFrame::OnText, this);
    sizer->Add(m_text, 0, wxALL, 10);

    wxButton *button = new wxButton(this, ID_SET_PROGRAMMATIC, "Set Programmatic");
    button->Bind(wxEVT_BUTTON, &ReproFrame::OnSetProgrammatic, this);
    sizer->Add(button, 0, wxALL, 10);

    wxButton *blockButton = new wxButton(this, ID_BLOCK_OWNER, "Block Owner");
    blockButton->Bind(wxEVT_BUTTON, &ReproFrame::OnBlockOwner, this);
    sizer->Add(blockButton, 0, wxALL, 10);

    SetSizer(sizer);

#ifdef __EMSCRIPTEN__
    CallAfter([] { EM_ASM({ console.log('[REPRO] textctrl ready'); }); });
#endif
}

void ReproFrame::OnText(wxCommandEvent &evt)
{
    evt.Skip();

#ifdef __EMSCRIPTEN__
    const wxScopedCharBuffer value = m_text->GetValue().utf8_str();
    EM_ASM({
        console.log('[DOM_INGRESS] value=' + UTF8ToString($0));
    }, value.data());
#endif

    // A handler that throws (a validator failure, a wxLogError turned into an
    // exception by a custom log target, ...). Throw once so the app survives.
    if (m_throwArmed)
    {
        m_throwArmed = false;
        throw std::runtime_error("repro: wxEVT_TEXT handler throws");
    }
}

void ReproFrame::OnSetProgrammatic(wxCommandEvent &WXUNUSED(evt))
{
    // Must reach the <input> element even after a prior wxEVT_TEXT handler threw.
    m_text->ChangeValue("PROGRAMMATIC_OK");
}

void ReproFrame::OnBlockOwner(wxCommandEvent &WXUNUSED(evt))
{
    // The ordering reducer needs an owner that is physically parked while two
    // browser input events arrive. Do not throw from those input handlers: this
    // scenario isolates receipt-time state from the older reentry-guard repro.
    m_throwArmed = false;

#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log('[DOM_INGRESS] block-start'); });
    emscripten_sleep(300);
    EM_ASM({ console.log('[DOM_INGRESS] block-end'); });
#endif
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

    bool OnExceptionInMainLoop() override
    {
        // The exception is the stimulus for this reducer. wxApp's default
        // implementation returns false and exits the main loop, which would
        // test application shutdown instead of the text-control reentry guard.
        return true;
    }
};

wxIMPLEMENT_APP(ReproApp);
