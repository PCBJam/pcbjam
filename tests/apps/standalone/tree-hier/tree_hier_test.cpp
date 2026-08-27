// wxTreeCtrl configured like eeschema's HIERARCHY_PANE: hidden root, buttons,
// per-item images (wxBitmapBundle), bold "current sheet" item, no explicit lines.
// Repro for the mangled hierarchy pane in the wasm port (icon/text misaligned,
// oversized rows, black text on the selection highlight).
#include <wx/wxprec.h>
#ifndef WX_PRECOMP
#include <wx/wx.h>
#endif
#include <wx/treectrl.h>
#include <wx/bmpbndl.h>
#include <wx/dcmemory.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

static wxBitmap MakeDot(int size, const wxColour& fill)
{
    wxBitmap bmp(size, size, 32);
    bmp.UseAlpha();
    wxMemoryDC dc(bmp);
    dc.SetBackground(*wxTRANSPARENT_BRUSH);
    dc.Clear();
    dc.SetPen(wxPen(fill));
    dc.SetBrush(wxBrush(fill));
    dc.DrawEllipse(1, 1, size - 2, size - 2);
    dc.SelectObject(wxNullBitmap);
    return bmp;
}

class HierFrame : public wxFrame
{
public:
    HierFrame() : wxFrame(nullptr, wxID_ANY, "Hierarchy tree test", wxDefaultPosition, wxSize(420, 420))
    {
        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
        m_tree = new wxTreeCtrl(this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                wxTR_HAS_BUTTONS | wxTR_EDIT_LABELS | wxTR_HIDE_ROOT);
        wxVector<wxBitmapBundle> images;
        // KiCad's tree_nosel/tree_sel are 16px dots (bundle carries 16 + 32 variants).
        images.push_back(wxBitmapBundle::FromBitmaps(MakeDot(16, wxColour(160, 160, 160)),
                                                     MakeDot(32, wxColour(160, 160, 160))));
        images.push_back(wxBitmapBundle::FromBitmaps(MakeDot(16, wxColour(40, 40, 40)),
                                                     MakeDot(32, wxColour(40, 40, 40))));
        m_tree->SetImages(images);

        wxTreeItemId root = m_tree->AddRoot("root");
        wxTreeItemId top = m_tree->AppendItem(root, "Arduino Leonardo (page 1)", 0, 1);
        m_tree->SetItemBold(top, true);
        m_tree->AppendItem(top, "Headers (page 2)", 0, 1);
        m_tree->AppendItem(top, "Power (page 3)", 0, 1);
        wxTreeItemId mcu = m_tree->AppendItem(top, "ATMEGA32U4-AU (page 4)", 0, 1);
        m_tree->AppendItem(mcu, "USB (page 5)", 0, 1);
        m_tree->ExpandAll();
        m_tree->SelectItem(top);
        sizer->Add(m_tree, 1, wxEXPAND);

        wxBoxSizer* btns = new wxBoxSizer(wxHORIZONTAL);
        wxButton* focusBtn = new wxButton(this, wxID_ANY, "Take focus");
        btns->Add(focusBtn, 0, wxALL, 4);
        sizer->Add(btns, 0);
        SetSizer(sizer);
        Layout();
#ifdef __EMSCRIPTEN__
        EM_ASM({ console.log('[TREE_HIER_TEST] started'); });
#endif
    }
private:
    wxTreeCtrl* m_tree;
};

class HierApp : public wxApp
{
public:
    bool OnInit() override
    {
        (new HierFrame())->Show();
        return true;
    }
};
wxIMPLEMENT_APP(HierApp);
