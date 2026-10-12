// Combo popup over a dialog's DOM controls (libs 0020 P17).
//
// The generic wxBitmapComboBox / wxOwnerDrawnComboBox popup (a canvas-drawn
// wxVListBoxComboPopup in a wxPopupTransientWindow) has a pointer-events:none
// .window: a click on one of its rows is meant to fall through to #canvas and
// reach the popup via the C++ hit-test. But the dialog's text inputs beneath
// the popup are real DOM <input>s with pointer-events:auto, so before the fix
// a row lying over an input lost the click to that input: the input took
// focus, focus leaving the popup dismissed it, and the row was never picked
// (KiCad's Pin Properties orientation / type / style pickers "sometimes"
// focused the field underneath instead of choosing the option).
//
// Shape: a modeless dialog with a wxBitmapComboBox at the top and a column of
// wxTextCtrls directly below it, where the dropdown opens.
//
// Console lines (read by tests/e2e/combo-shadow.spec.ts):
//   [COMBOSHADOW] ready
//   [COMBOSHADOW] dropdown
//   [COMBOSHADOW] selected N <item>
//   [COMBOSHADOW] closeup

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/bmpcbox.h"
#include "wx/dcmemory.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

static void ConsoleLog(const wxString& msg)
{
#ifdef __EMSCRIPTEN__
    const wxScopedCharBuffer utf8 = msg.utf8_str();
    EM_ASM({ console.log('[COMBOSHADOW] ' + UTF8ToString($0)); }, utf8.data());
#else
    wxLogMessage("%s", msg);
#endif
}

static const char* const kItems[] = {
    "Right", "Left", "Up", "Down", "Input", "Output", "Bidirectional", "Passive"
};

static wxBitmap Swatch(const wxColour& colour)
{
    wxBitmap bmp(16, 16);
    wxMemoryDC dc(bmp);
    dc.SetBackground(*wxWHITE_BRUSH);
    dc.Clear();
    dc.SetPen(*wxBLACK_PEN);
    dc.SetBrush(wxBrush(colour));
    dc.DrawRectangle(2, 2, 12, 12);
    dc.SelectObject(wxNullBitmap);
    return bmp;
}

class ShadowDialog : public wxDialog
{
public:
    explicit ShadowDialog(wxWindow* parent)
        : wxDialog(parent, wxID_ANY, "Pin Properties", wxPoint(40, 40),
                   wxSize(620, 380))
    {
        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);

        sizer->Add(new wxStaticText(this, wxID_ANY, "Orientation:"), 0,
                   wxLEFT | wxRIGHT | wxTOP, 8);

        m_combo = new wxBitmapComboBox(this, wxID_ANY, wxEmptyString,
                                       wxDefaultPosition, wxSize(300, -1),
                                       0, nullptr, wxCB_READONLY);
        m_combo->SetName("orientation");
        const wxColour colours[] = { *wxRED, *wxBLUE, *wxGREEN, *wxCYAN,
                                     wxColour(255, 0, 255), *wxYELLOW,
                                     wxColour(128, 128, 128), *wxBLACK };
        for (size_t i = 0; i < WXSIZEOF(kItems); ++i)
            m_combo->Append(kItems[i], Swatch(colours[i]));
        m_combo->SetSelection(0);
        sizer->Add(m_combo, 0, wxALL, 8);

        // A column of inputs exactly where the dropdown opens, and one input
        // beside it that the dropdown never covers (it must stay live).
        wxBoxSizer* row = new wxBoxSizer(wxHORIZONTAL);
        wxBoxSizer* column = new wxBoxSizer(wxVERTICAL);
        const char* const names[] = { "pinname", "pinnumber", "pinlength",
                                      "pinnamesize", "pinnumsize" };
        for (const char* name : names)
        {
            wxTextCtrl* text = new wxTextCtrl(this, wxID_ANY, name,
                                              wxDefaultPosition,
                                              wxSize(300, -1));
            text->SetName(name);
            column->Add(text, 0, wxBOTTOM, 8);
        }
        row->Add(column, 0, wxLEFT, 8);
        wxTextCtrl* side = new wxTextCtrl(this, wxID_ANY, "sidefield",
                                          wxDefaultPosition, wxSize(140, -1));
        side->SetName("sidefield");
        row->Add(side, 0, wxLEFT | wxRIGHT, 100);
        sizer->Add(row, 0);

        SetSizer(sizer);
        Layout();

        m_combo->Bind(wxEVT_COMBOBOX, [this](wxCommandEvent& event) {
            ConsoleLog(wxString::Format("selected %d %s", event.GetInt(),
                                        m_combo->GetString(event.GetInt())));
        });
        m_combo->Bind(wxEVT_COMBOBOX_DROPDOWN, [](wxCommandEvent& event) {
            ConsoleLog("dropdown");
            event.Skip();
        });
        m_combo->Bind(wxEVT_COMBOBOX_CLOSEUP, [](wxCommandEvent& event) {
            ConsoleLog("closeup");
            event.Skip();
        });
    }

private:
    wxBitmapComboBox* m_combo = nullptr;
};

class ShadowFrame : public wxFrame
{
public:
    ShadowFrame()
        : wxFrame(nullptr, wxID_ANY, "Combo popup shadow test", wxPoint(0, 0),
                  wxSize(640, 480))
    {
        new wxPanel(this);
    }
};

class ShadowApp : public wxApp
{
public:
    bool OnInit() override
    {
        ShadowFrame* frame = new ShadowFrame();
        frame->Show();

        ShadowDialog* dlg = new ShadowDialog(frame);
        dlg->Show();
        CallAfter([] { ConsoleLog("ready"); });
        return true;
    }
};

wxIMPLEMENT_APP(ShadowApp);
