// wxDataViewCtrl item context menu, KiCad LIB_TREE style.
//
// KiCad's footprint/symbol editor library tree (common/widgets/lib_tree.cpp)
// handles wxEVT_DATAVIEW_ITEM_CONTEXT_MENU by asking its tool for a context
// menu. That menu is a CONDITIONAL_MENU marked dirty (TOOL_MENU::
// ShowContextMenu()), and the frame pops it with
//     frame->PopupMenu(menu, frame->ScreenToClient(wxGetMousePosition()))
// (TOOL_MANAGER::DispatchContextMenu). The menu's items are only built when
// wxWidgets reports wxEVT_MENU_OPEN for it: the frame catches the event
// (EDA_BASE_FRAME's EVT_MENU_OPEN -> TOOL_DISPATCHER) and forwards it to the
// menu, which then evaluates its conditions against the current selection.
// Enable state comes from wxEVT_UPDATE_UI handlers on the frame.
//
// This app reproduces that chain with plain wx:
//   - a wxDataViewCtrl tree with a column header (LIB_TREE has one),
//   - a frame with a menu bar (so the frame's client area does not start at
//     the canvas top),
//   - a LazyMenu that stays empty until wxEVT_MENU_OPEN reaches it via the
//     frame, then fills itself from the selected row,
//   - an EVT_UPDATE_UI handler that disables "Paste" until "Copy" ran.
// Every step logs a [DVCTX] line the spec asserts on.

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/dataview.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

enum {
    ID_TREE = wxID_HIGHEST + 1,
    ID_CTX_NEW_ITEM,
    ID_CTX_RENAME,
    ID_CTX_COPY,
    ID_CTX_PASTE,
    ID_CTX_EXPORT_A,
    ID_CTX_EXPORT_B
};

static void DvLog(const wxString& msg)
{
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log('[DVCTX] ' + UTF8ToString($0)); },
           (const char*)msg.utf8_str());
#else
    wxPrintf("[DVCTX] %s\n", msg);
#endif
}

// A menu that is built on demand, like KiCad's dirty CONDITIONAL_MENU.
class LazyMenu : public wxMenu
{
public:
    explicit LazyMenu(const wxString& target) : m_target(target) {}

    void OnOpened()
    {
        if (!m_dirty)
            return;
        m_dirty = false;

        DvLog("menu open: building items for '" + m_target + "'");
        Append(ID_CTX_NEW_ITEM, "New Item");
        Append(ID_CTX_RENAME, "Rename '" + m_target + "'");
        AppendSeparator();
        Append(ID_CTX_COPY, "Copy");
        Append(ID_CTX_PASTE, "Paste");

        wxMenu* sub = new wxMenu;
        sub->Append(ID_CTX_EXPORT_A, "Export A");
        sub->Append(ID_CTX_EXPORT_B, "Export B");
        AppendSubMenu(sub, "Export");
    }

private:
    wxString m_target;
    bool m_dirty = true;
};

class DvCtxApp : public wxApp
{
public:
    virtual bool OnInit() override;
};

class DvCtxFrame : public wxFrame
{
public:
    DvCtxFrame();

private:
    wxDataViewTreeCtrl* m_tree = nullptr;
    bool m_copied = false;
    int m_opens = 0;

    wxString SelectedLabel() const;

    void OnItemContextMenu(wxDataViewEvent& evt);
    void OnMenuOpen(wxMenuEvent& evt);
    void OnMenuClose(wxMenuEvent& evt);
    void OnUpdatePaste(wxUpdateUIEvent& evt);
    void OnCommand(wxCommandEvent& evt);
};

wxIMPLEMENT_APP(DvCtxApp);

bool DvCtxApp::OnInit()
{
    if (!wxApp::OnInit())
        return false;

    (new DvCtxFrame())->Show(true);
    return true;
}

DvCtxFrame::DvCtxFrame()
    : wxFrame(nullptr, wxID_ANY, "DataView Context Menu WASM Test",
              wxDefaultPosition, wxSize(640, 480))
{
    wxMenuBar* bar = new wxMenuBar;
    wxMenu* file = new wxMenu;
    file->Append(wxID_EXIT, "Quit");
    bar->Append(file, "File");
    SetMenuBar(bar);

    wxPanel* panel = new wxPanel(this, wxID_ANY);
    wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);

    // LIB_TREE builds its wxDataViewCtrl with a visible header.
    m_tree = new wxDataViewTreeCtrl(panel, ID_TREE, wxDefaultPosition,
                                    wxDefaultSize, wxDV_SINGLE);
    m_tree->GetColumn(0)->SetTitle("Item");
    wxDataViewItem libA = m_tree->AppendContainer(wxDataViewItem(), "LibA");
    m_tree->AppendItem(libA, "PartA1");
    m_tree->AppendItem(libA, "PartA2");
    wxDataViewItem libB = m_tree->AppendContainer(wxDataViewItem(), "LibB");
    m_tree->AppendItem(libB, "PartB1");
    m_tree->AppendContainer(wxDataViewItem(), "LibC");
    m_tree->Expand(libA);
    m_tree->Expand(libB);

    sizer->Add(m_tree, 1, wxEXPAND | wxALL, 8);
    panel->SetSizer(sizer);

    m_tree->Bind(wxEVT_DATAVIEW_ITEM_CONTEXT_MENU,
                 &DvCtxFrame::OnItemContextMenu, this);

    Bind(wxEVT_MENU_OPEN, &DvCtxFrame::OnMenuOpen, this);
    Bind(wxEVT_MENU_CLOSE, &DvCtxFrame::OnMenuClose, this);
    Bind(wxEVT_UPDATE_UI, &DvCtxFrame::OnUpdatePaste, this, ID_CTX_PASTE);
    Bind(wxEVT_MENU, &DvCtxFrame::OnCommand, this, ID_CTX_NEW_ITEM,
         ID_CTX_EXPORT_B);

    DvLog("app started");
}

wxString DvCtxFrame::SelectedLabel() const
{
    const wxDataViewItem sel = m_tree->GetSelection();
    return sel.IsOk() ? m_tree->GetItemText(sel) : wxString("(none)");
}

void DvCtxFrame::OnItemContextMenu(wxDataViewEvent& evt)
{
    const wxDataViewItem item = evt.GetItem();
    const wxString label = item.IsOk() ? m_tree->GetItemText(item)
                                       : wxString("(none)");
    DvLog("context menu on '" + label + "', selection '" + SelectedLabel()
          + "'");

    LazyMenu menu(label);
    const wxPoint mouse = wxGetMousePosition();
    const wxPoint at = ScreenToClient(mouse);
    DvLog(wxString::Format("popup at screen %d,%d", mouse.x, mouse.y));

    // The KiCad call: the frame pops the menu at the client coords of the
    // pointer (TOOL_MANAGER::DispatchContextMenu).
    PopupMenu(&menu, at);

    DvLog(wxString::Format("popup returned, opens=%d", m_opens));
}

void DvCtxFrame::OnMenuOpen(wxMenuEvent& evt)
{
    m_opens++;
    // Forward to the menu, like KiCad's TOOL_DISPATCHER does.
    if (LazyMenu* lazy = dynamic_cast<LazyMenu*>(evt.GetMenu()))
        lazy->OnOpened();
    DvLog(wxString::Format("MENU_OPEN popup=%d", evt.IsPopup() ? 1 : 0));
    evt.Skip();
}

void DvCtxFrame::OnMenuClose(wxMenuEvent& evt)
{
    DvLog(wxString::Format("MENU_CLOSE popup=%d", evt.IsPopup() ? 1 : 0));
    evt.Skip();
}

void DvCtxFrame::OnUpdatePaste(wxUpdateUIEvent& evt)
{
    evt.Enable(m_copied);
}

void DvCtxFrame::OnCommand(wxCommandEvent& evt)
{
    switch (evt.GetId())
    {
        case ID_CTX_NEW_ITEM:  DvLog("chosen: New Item on '" + SelectedLabel() + "'"); break;
        case ID_CTX_RENAME:    DvLog("chosen: Rename on '" + SelectedLabel() + "'"); break;
        case ID_CTX_COPY:      m_copied = true; DvLog("chosen: Copy"); break;
        case ID_CTX_PASTE:     DvLog("chosen: Paste"); break;
        case ID_CTX_EXPORT_A:  DvLog("chosen: Export A"); break;
        case ID_CTX_EXPORT_B:  DvLog("chosen: Export B"); break;
    }
}
