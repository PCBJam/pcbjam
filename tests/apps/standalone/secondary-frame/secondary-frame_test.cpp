// Secondary-frame input test - a secondary wxFrame (like KiCad's 3D viewer)
// overlapping the main frame's native DOM controls.
//
// The wasm port renders wxChoice as a real DOM <select> with
// pointer-events:auto, while a secondary frame's window div is
// pointer-events:none (clicks fall through to #canvas for the C++ hit-test).
// Without an input barrier for the main window's controls, a click on the
// secondary frame's toolbar lands on the hidden <select> underneath and pops
// its native dropdown (pcbjam: 3D viewer toolbar vs pcbnew's track-width
// selector).

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/artprov.h"
#include "wx/aui/auibar.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

class SecondaryFrameTestApp : public wxApp
{
public:
    virtual bool OnInit() override;
};

enum {
    ID_CHOICE_TRACK = wxID_HIGHEST + 1,
    ID_TOOL_ORTHO,
    ID_TOOL_LAYERS
};

class SecondaryFrame : public wxFrame
{
public:
    explicit SecondaryFrame(wxWindow* parent)
        : wxFrame(parent, wxID_ANY, "Secondary Frame",
                  wxPoint(0, 10), wxSize(420, 220))
    {
        wxAuiToolBar* tb = new wxAuiToolBar(this, wxID_ANY, wxDefaultPosition,
            wxDefaultSize, wxAUI_TB_HORZ_LAYOUT | wxAUI_TB_HORIZONTAL);
        tb->AddTool(ID_TOOL_ORTHO, "Ortho",
            wxArtProvider::GetBitmap(wxART_TICK_MARK, wxART_TOOLBAR),
            "Use orthographic projection", wxITEM_CHECK);
        tb->AddTool(ID_TOOL_LAYERS, "Layers",
            wxArtProvider::GetBitmap(wxART_LIST_VIEW, wxART_TOOLBAR),
            "Show layers manager", wxITEM_CHECK);
        tb->Realize();

        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(tb, 0, wxEXPAND);
        sizer->AddStretchSpacer(1);
        SetSizer(sizer);

        Bind(wxEVT_TOOL, &SecondaryFrame::OnTool, this);
    }

private:
    void OnTool(wxCommandEvent& evt)
    {
        const char* name = evt.GetId() == ID_TOOL_ORTHO ? "Ortho" : "Layers";
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[SECFRAME] tool ' + UTF8ToString($0) + ' toggled ' + ($1 ? 'on' : 'off'));
        }, name, evt.IsChecked() ? 1 : 0);
#else
        wxUnusedVar(name);
#endif
    }
};

class MainTestFrame : public wxFrame
{
public:
    MainTestFrame()
        : wxFrame(nullptr, wxID_ANY, "Secondary Frame Input WASM Test",
                  wxDefaultPosition, wxSize(900, 600))
    {
        // Native wxChoice (a DOM <select> in the wasm port) near the top-left,
        // where the secondary frame will overlap it — mirrors pcbnew's
        // track-width selector under the 3D viewer's toolbar. On a panel: a
        // wxFrame auto-sizes a lone child to fill its client area, which
        // would stretch a bare choice fullscreen.
        wxPanel* panel = new wxPanel(this);
        wxArrayString widths;
        widths.Add("Track: use netclass width");
        widths.Add("0.2 mm");
        widths.Add("0.25 mm");
        widths.Add("0.4 mm");
        m_choice = new wxChoice(panel, ID_CHOICE_TRACK, wxPoint(10, 40),
                                wxSize(180, 24), widths);
        m_choice->SetSelection(0);

        Bind(wxEVT_CHOICE, &MainTestFrame::OnChoice, this, ID_CHOICE_TRACK);

        SecondaryFrame* sec = new SecondaryFrame(this);
        sec->Show(true);

#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[SECFRAME] secondary-frame test app started');
        });
#endif
    }

private:
    void OnChoice(wxCommandEvent& evt)
    {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[SECFRAME] choice selected ' + $0);
        }, evt.GetSelection());
#else
        wxUnusedVar(evt);
#endif
    }

    wxChoice* m_choice;
};

wxIMPLEMENT_APP(SecondaryFrameTestApp);

bool SecondaryFrameTestApp::OnInit()
{
    if (!wxApp::OnInit())
        return false;

    MainTestFrame* frame = new MainTestFrame();
    frame->Show(true);
    return true;
}
