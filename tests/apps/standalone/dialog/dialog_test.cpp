// wxDialog/wxMessageBox Test - Tests modal dialogs in WASM
// KiCad uses dialogs for alerts, confirmations, and custom dialogs

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

class DialogTestApp : public wxApp
{
public:
    virtual bool OnInit() override;
};

class DialogTestFrame : public wxFrame
{
public:
    DialogTestFrame();

private:
    wxTextCtrl* m_log;

    void LogEvent(const wxString& msg);

    void OnInfoDialog(wxCommandEvent& evt);
    void OnYesNoDialog(wxCommandEvent& evt);
    void OnErrorDialog(wxCommandEvent& evt);
    void OnCustomDialog(wxCommandEvent& evt);
    void OnCallbackDialog(wxCommandEvent& evt);
    void OnInputDialog(wxCommandEvent& evt);

    wxDECLARE_EVENT_TABLE();
};

// Custom dialog class (like KiCad's property dialogs)
class CustomTestDialog : public wxDialog
{
public:
    CustomTestDialog(wxWindow* parent);

    wxString GetValue() const { return m_textCtrl->GetValue(); }

private:
    wxTextCtrl* m_textCtrl;
};

enum {
    ID_INFO_DIALOG = wxID_HIGHEST + 1,
    ID_YESNO_DIALOG,
    ID_ERROR_DIALOG,
    ID_CUSTOM_DIALOG,
    ID_CALLBACK_DIALOG,
    ID_INPUT_DIALOG
};

wxBEGIN_EVENT_TABLE(DialogTestFrame, wxFrame)
    EVT_BUTTON(ID_INFO_DIALOG, DialogTestFrame::OnInfoDialog)
    EVT_BUTTON(ID_YESNO_DIALOG, DialogTestFrame::OnYesNoDialog)
    EVT_BUTTON(ID_ERROR_DIALOG, DialogTestFrame::OnErrorDialog)
    EVT_BUTTON(ID_CUSTOM_DIALOG, DialogTestFrame::OnCustomDialog)
    EVT_BUTTON(ID_CALLBACK_DIALOG, DialogTestFrame::OnCallbackDialog)
    EVT_BUTTON(ID_INPUT_DIALOG, DialogTestFrame::OnInputDialog)
wxEND_EVENT_TABLE()

wxIMPLEMENT_APP(DialogTestApp);

bool DialogTestApp::OnInit()
{
    if (!wxApp::OnInit())
        return false;

    DialogTestFrame* frame = new DialogTestFrame();
    frame->Show(true);
    return true;
}

DialogTestFrame::DialogTestFrame()
    : wxFrame(nullptr, wxID_ANY, "wxDialog/wxMessageBox WASM Test",
              wxDefaultPosition, wxSize(600, 500))
{
    wxBoxSizer* mainSizer = new wxBoxSizer(wxVERTICAL);

    wxStaticText* desc = new wxStaticText(this, wxID_ANY,
        "wxDialog and wxMessageBox Test\n\n"
        "KiCad uses dialogs for alerts, confirmations, and custom property dialogs.\n"
        "Click buttons to test different dialog types.");
    mainSizer->Add(desc, 0, wxALL, 10);

    // wxMessageBox section
    wxStaticBoxSizer* msgBoxSizer = new wxStaticBoxSizer(wxVERTICAL, this, "wxMessageBox");
    wxBoxSizer* msgBtnSizer = new wxBoxSizer(wxHORIZONTAL);
    msgBtnSizer->Add(new wxButton(this, ID_INFO_DIALOG, "Info Dialog"), 0, wxALL, 5);
    msgBtnSizer->Add(new wxButton(this, ID_YESNO_DIALOG, "Yes/No Dialog"), 0, wxALL, 5);
    msgBtnSizer->Add(new wxButton(this, ID_ERROR_DIALOG, "Error Dialog"), 0, wxALL, 5);
    msgBoxSizer->Add(msgBtnSizer, 0, wxALIGN_CENTER);
    mainSizer->Add(msgBoxSizer, 0, wxEXPAND | wxALL, 10);

    // wxDialog section
    wxStaticBoxSizer* dlgSizer = new wxStaticBoxSizer(wxVERTICAL, this, "wxDialog");
    wxBoxSizer* dlgBtnSizer = new wxBoxSizer(wxHORIZONTAL);
    dlgBtnSizer->Add(new wxButton(this, ID_CUSTOM_DIALOG, "Custom Dialog"), 0, wxALL, 5);
    dlgBtnSizer->Add(new wxButton(this, ID_CALLBACK_DIALOG, "Callback Dialog"), 0, wxALL, 5);
    dlgBtnSizer->Add(new wxButton(this, ID_INPUT_DIALOG, "Input Dialog"), 0, wxALL, 5);
    dlgSizer->Add(dlgBtnSizer, 0, wxALIGN_CENTER);
    mainSizer->Add(dlgSizer, 0, wxEXPAND | wxALL, 10);

    // Event log
    wxStaticBoxSizer* logBox = new wxStaticBoxSizer(wxVERTICAL, this, "Event Log");
    m_log = new wxTextCtrl(this, wxID_ANY, "",
        wxDefaultPosition, wxSize(-1, 200), wxTE_MULTILINE | wxTE_READONLY);
    logBox->Add(m_log, 1, wxEXPAND | wxALL, 5);
    mainSizer->Add(logBox, 1, wxEXPAND | wxALL, 10);

    SetSizer(mainSizer);
    CreateStatusBar();
    SetStatusText("Ready");

    LogEvent("Dialog test app started");

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[DIALOG_TEST] wxDialog test app started successfully');
    });
#endif
}

void DialogTestFrame::LogEvent(const wxString& msg)
{
    m_log->AppendText(msg + "\n");
    SetStatusText(msg);

#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[DIALOG_EVENT] ' + UTF8ToString($0));
    }, msg.c_str().AsChar());
#endif
}

void DialogTestFrame::OnInfoDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Info dialog...");

    int result = wxMessageBox("This is an informational message.\n\nKiCad uses these for status updates.",
                              "Information", wxOK | wxICON_INFORMATION, this);

    LogEvent(wxString::Format("Info dialog closed with result: %d", result));
}

void DialogTestFrame::OnYesNoDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Yes/No dialog...");

    int result = wxMessageBox("Do you want to save changes?\n\nKiCad uses these for confirmations.",
                              "Confirm", wxYES_NO | wxCANCEL | wxICON_QUESTION, this);

    wxString resultStr;
    switch (result) {
        case wxYES: resultStr = "YES"; break;
        case wxNO: resultStr = "NO"; break;
        case wxCANCEL: resultStr = "CANCEL"; break;
        default: resultStr = wxString::Format("Unknown (%d)", result);
    }
    LogEvent(wxString::Format("Yes/No dialog closed with: %s", resultStr));
}

void DialogTestFrame::OnErrorDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Error dialog...");

    int result = wxMessageBox("An error has occurred!\n\nKiCad uses these for error messages.",
                              "Error", wxOK | wxICON_ERROR, this);

    LogEvent(wxString::Format("Error dialog closed with result: %d", result));
}

void DialogTestFrame::OnCustomDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Custom dialog...");

    CustomTestDialog dlg(this);
    int result = dlg.ShowModal();

    if (result == wxID_OK) {
        LogEvent(wxString::Format("Custom dialog OK - value: '%s'", dlg.GetValue()));
    } else {
        LogEvent("Custom dialog cancelled");
    }
}

void DialogTestFrame::OnCallbackDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Callback dialog...");

    CustomTestDialog dlg(this);
    int callbackRuns = 0;
    dlg.ShowModal([this, &dlg, &callbackRuns](int result) {
        ++callbackRuns;
        LogEvent(wxString::Format("Callback dialog callback: %d", result));
#ifdef __EMSCRIPTEN__
        EM_ASM({
            var state = {};
            state.phase = 'first-complete';
            state.runs = $0;
            state.result = $1;
            window.__dialogCallbackResult = state;
        }, callbackRuns, result);
#endif

        // A completion callback must run only after the first lease has
        // closed. Reusing the same dialog here is the strongest public-API
        // reducer: an EndModal-time callback would try to nest beneath a
        // half-closed lease and wedge or fail-stop.
        const int reuseResult = dlg.ShowModal();
        LogEvent(wxString::Format("Callback dialog reused with result: %d",
                                  reuseResult));
#ifdef __EMSCRIPTEN__
        EM_ASM({
            var state = {};
            state.phase = 'reuse-complete';
            state.runs = $0;
            state.result = $1;
            state.reuseResult = $2;
            window.__dialogCallbackResult = state;
        }, callbackRuns, result, reuseResult);
#endif
    });
    LogEvent(wxString::Format("Callback dialog returned; callbacks: %d", callbackRuns));
}

void DialogTestFrame::OnInputDialog(wxCommandEvent& WXUNUSED(evt))
{
    LogEvent("Opening Input dialog...");

    wxTextEntryDialog dlg(this, "Enter a component reference:",
                          "Input Dialog", "R1");

    if (dlg.ShowModal() == wxID_OK) {
        LogEvent(wxString::Format("Input dialog OK - value: '%s'", dlg.GetValue()));
    } else {
        LogEvent("Input dialog cancelled");
    }
}

// Custom dialog implementation. wxRESIZE_BORDER makes it resizable (like KiCad's
// DIALOG_SHIM dialogs, e.g. Print) so the resize-repaint behaviour can be tested:
// a modal dialog whose 2D canvas is cleared by a resize must repaint synchronously
// (its Asyncify pump otherwise defers the paint until the next click → black bg).
CustomTestDialog::CustomTestDialog(wxWindow* parent)
    : wxDialog(parent, wxID_ANY, "Custom Test Dialog",
               wxDefaultPosition, wxSize(300, 200),
               wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER)
{
    wxBoxSizer* mainSizer = new wxBoxSizer(wxVERTICAL);

    wxStaticText* label = new wxStaticText(this, wxID_ANY,
        "This is a custom wxDialog\nlike KiCad's property dialogs:");
    mainSizer->Add(label, 0, wxALL, 10);

    m_textCtrl = new wxTextCtrl(this, wxID_ANY, "Sample value");
    mainSizer->Add(m_textCtrl, 0, wxEXPAND | wxLEFT | wxRIGHT, 10);

    wxBoxSizer* btnSizer = new wxBoxSizer(wxHORIZONTAL);
    btnSizer->Add(new wxButton(this, wxID_OK, "OK"), 0, wxALL, 5);
    btnSizer->Add(new wxButton(this, wxID_CANCEL, "Cancel"), 0, wxALL, 5);
    mainSizer->Add(btnSizer, 0, wxALIGN_CENTER | wxALL, 10);

    SetSizer(mainSizer);
}
