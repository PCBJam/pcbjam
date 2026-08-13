// Specialized wxWidgets Controls Test
// Tests: wxTreebook, wxBitmapComboBox, wxSpinCtrl
// These are used in KiCad for settings dialogs and layer management

#include "wx/wx.h"
#include "wx/treebook.h"
#include "wx/bmpcbox.h"
#include "wx/dcmemory.h"
#include "wx/spinctrl.h"

// Helper to create color swatch bitmaps for wxBitmapComboBox
wxBitmap CreateColorSwatch(const wxColour& color, int width = 16, int height = 16)
{
    wxBitmap bmp(width, height);
    wxMemoryDC dc(bmp);

    dc.SetPen(*wxBLACK_PEN);
    dc.SetBrush(wxBrush(color));
    dc.DrawRectangle(0, 0, width, height);

    return bmp;
}

class SpecializedFrame : public wxFrame
{
public:
    SpecializedFrame() : wxFrame(nullptr, wxID_ANY, "Specialized wxWidgets Controls Test",
                                  wxDefaultPosition, wxSize(900, 700))
    {
        wxPanel* mainPanel = new wxPanel(this);
        wxBoxSizer* mainSizer = new wxBoxSizer(wxVERTICAL);

        // Description
        wxStaticText* desc = new wxStaticText(mainPanel, wxID_ANY,
            "KiCad uses specialized controls for settings and layer management.\n"
            "Tests: wxTreebook (settings pages), wxBitmapComboBox (layer chooser), wxListBox (layer list).");
        mainSizer->Add(desc, 0, wxALL, 5);

        // Split into left and right panels
        wxBoxSizer* contentSizer = new wxBoxSizer(wxHORIZONTAL);

        // Left: wxTreebook
        wxStaticBoxSizer* treebookSizer = new wxStaticBoxSizer(wxVERTICAL, mainPanel, "wxTreebook (Settings)");
        m_treebook = new wxTreebook(mainPanel, wxID_ANY);
        treebookSizer->Add(m_treebook, 1, wxEXPAND | wxALL, 5);
        contentSizer->Add(treebookSizer, 1, wxEXPAND | wxALL, 5);

        // Right: wxBitmapComboBox and wxListBox for layer list
        wxBoxSizer* rightSizer = new wxBoxSizer(wxVERTICAL);

        // wxBitmapComboBox
        wxStaticBoxSizer* bmpComboSizer = new wxStaticBoxSizer(wxVERTICAL, mainPanel, "wxBitmapComboBox (Layer Chooser)");
        CreateBitmapComboBox(mainPanel);
        bmpComboSizer->Add(m_layerCombo, 0, wxEXPAND | wxALL, 5);

        wxStaticText* comboLabel = new wxStaticText(mainPanel, wxID_ANY, "Selected: (none)");
        m_comboLabel = comboLabel;
        bmpComboSizer->Add(comboLabel, 0, wxALL, 5);

        rightSizer->Add(bmpComboSizer, 0, wxEXPAND | wxALL, 5);

        // Layer List (simulating wxRearrangeCtrl with wxCheckListBox)
        wxStaticBoxSizer* listSizer = new wxStaticBoxSizer(wxVERTICAL, mainPanel, "Layer List (Visibility)");
        CreateLayerList(mainPanel);
        listSizer->Add(m_layerList, 1, wxEXPAND | wxALL, 5);

        wxButton* btnGetOrder = new wxButton(mainPanel, wxID_ANY, "Get Layer Status");
        btnGetOrder->Bind(wxEVT_BUTTON, &SpecializedFrame::OnGetOrder, this);
        listSizer->Add(btnGetOrder, 0, wxALL, 5);

        rightSizer->Add(listSizer, 1, wxEXPAND | wxALL, 5);

        contentSizer->Add(rightSizer, 1, wxEXPAND);

        mainSizer->Add(contentSizer, 1, wxEXPAND);

        // Event log
        mainSizer->Add(new wxStaticText(mainPanel, wxID_ANY, "Event Log"), 0, wxLEFT | wxTOP, 5);
        m_log = new wxTextCtrl(mainPanel, wxID_ANY, "", wxDefaultPosition, wxSize(-1, 100),
                               wxTE_MULTILINE | wxTE_READONLY);
        mainSizer->Add(m_log, 0, wxEXPAND | wxALL, 5);

        mainPanel->SetSizer(mainSizer);
        mainPanel->Layout();

        // KiCad's calculator lays out an empty wxTreebook and adds its pages
        // afterwards. Keep that order here: an empty-controller best-size
        // cache must not leave the later tree at zero width.
        PopulateTreebook();

        CreateStatusBar();
        SetStatusText("Specialized controls test app started");
        Log("Specialized controls test app started");
    }

private:
    void PopulateTreebook()
    {
        // Match KiCad Calculator's structure: non-selectable group nodes have
        // null pages and each real panel is a subpage.
        m_treebook->AddPage(nullptr, "General system design");

        // General settings page
        wxPanel* generalPage = new wxPanel(m_treebook);
        wxBoxSizer* generalSizer = new wxBoxSizer(wxVERTICAL);
        generalSizer->Add(new wxStaticText(generalPage, wxID_ANY, "General Settings"), 0, wxALL, 10);
        generalSizer->Add(new wxCheckBox(generalPage, wxID_ANY, "Show grid"), 0, wxALL, 5);
        generalSizer->Add(new wxCheckBox(generalPage, wxID_ANY, "Auto-save"), 0, wxALL, 5);
        generalSizer->Add(new wxCheckBox(generalPage, wxID_ANY, "Show welcome dialog"), 0, wxALL, 5);
        generalPage->SetSizer(generalSizer);
        m_treebook->AddSubPage(generalPage, "General");

        m_treebook->AddPage(nullptr, "Display group");

        // Display page with sub-pages
        wxPanel* displayPage = new wxPanel(m_treebook);
        wxBoxSizer* displaySizer = new wxBoxSizer(wxVERTICAL);
        displaySizer->Add(new wxStaticText(displayPage, wxID_ANY, "Display Settings"), 0, wxALL, 10);
        displaySizer->Add(new wxCheckBox(displayPage, wxID_ANY, "Anti-aliasing"), 0, wxALL, 5);
        displayPage->SetSizer(displaySizer);
        m_treebook->AddSubPage(displayPage, "Display");

        // Display sub-page: Colors
        wxPanel* colorsPage = new wxPanel(m_treebook);
        wxBoxSizer* colorsSizer = new wxBoxSizer(wxVERTICAL);
        colorsSizer->Add(new wxStaticText(colorsPage, wxID_ANY, "Color Settings"), 0, wxALL, 10);
        colorsSizer->Add(new wxStaticText(colorsPage, wxID_ANY, "Background:"), 0, wxLEFT | wxTOP, 5);
        wxChoice* bgChoice = new wxChoice(colorsPage, wxID_ANY);
        bgChoice->Append("White");
        bgChoice->Append("Black");
        bgChoice->Append("Gray");
        bgChoice->SetSelection(0);
        colorsSizer->Add(bgChoice, 0, wxALL, 5);
        colorsPage->SetSizer(colorsSizer);
        m_treebook->AddSubPage(colorsPage, "Colors");

        // Display sub-page: Grid
        wxPanel* gridPage = new wxPanel(m_treebook);
        wxBoxSizer* gridSizer = new wxBoxSizer(wxVERTICAL);
        gridSizer->Add(new wxStaticText(gridPage, wxID_ANY, "Grid Settings"), 0, wxALL, 10);
        gridSizer->Add(new wxStaticText(gridPage, wxID_ANY, "Grid size (mm):"), 0, wxLEFT | wxTOP, 5);
        gridSizer->Add(new wxSpinCtrl(gridPage, wxID_ANY, "1", wxDefaultPosition, wxDefaultSize,
                                       wxSP_ARROW_KEYS, 1, 100, 1), 0, wxALL, 5);
        gridPage->SetSizer(gridSizer);
        m_treebook->AddSubPage(gridPage, "Grid");

        m_treebook->AddPage(nullptr, "Editing group");

        // Editing page
        wxPanel* editPage = new wxPanel(m_treebook);
        wxBoxSizer* editSizer = new wxBoxSizer(wxVERTICAL);
        editSizer->Add(new wxStaticText(editPage, wxID_ANY, "Editing Settings"), 0, wxALL, 10);
        editSizer->Add(new wxCheckBox(editPage, wxID_ANY, "Magnetic pads"), 0, wxALL, 5);
        editSizer->Add(new wxCheckBox(editPage, wxID_ANY, "Magnetic graphics"), 0, wxALL, 5);
        editSizer->Add(new wxCheckBox(editPage, wxID_ANY, "Allow free pads"), 0, wxALL, 5);
        editPage->SetSizer(editSizer);
        m_treebook->AddSubPage(editPage, "Editing");

        // Editing sub-page: Defaults
        wxPanel* defaultsPage = new wxPanel(m_treebook);
        wxBoxSizer* defaultsSizer = new wxBoxSizer(wxVERTICAL);
        defaultsSizer->Add(new wxStaticText(defaultsPage, wxID_ANY, "Default Values"), 0, wxALL, 10);
        defaultsSizer->Add(new wxStaticText(defaultsPage, wxID_ANY, "Track width (mm):"), 0, wxLEFT | wxTOP, 5);
        defaultsSizer->Add(new wxTextCtrl(defaultsPage, wxID_ANY, "0.25"), 0, wxALL, 5);
        defaultsSizer->Add(new wxStaticText(defaultsPage, wxID_ANY, "Via size (mm):"), 0, wxLEFT | wxTOP, 5);
        defaultsSizer->Add(new wxTextCtrl(defaultsPage, wxID_ANY, "0.8"), 0, wxALL, 5);
        defaultsPage->SetSizer(defaultsSizer);
        m_treebook->AddSubPage(defaultsPage, "Defaults");

        m_treebook->AddPage(nullptr, "Printing group");

        // Printing page
        wxPanel* printPage = new wxPanel(m_treebook);
        wxBoxSizer* printSizer = new wxBoxSizer(wxVERTICAL);
        printSizer->Add(new wxStaticText(printPage, wxID_ANY, "Print Settings"), 0, wxALL, 10);
        printSizer->Add(new wxCheckBox(printPage, wxID_ANY, "Print mirrored"), 0, wxALL, 5);
        printSizer->Add(new wxCheckBox(printPage, wxID_ANY, "Print in black"), 0, wxALL, 5);
        printPage->SetSizer(printSizer);
        m_treebook->AddSubPage(printPage, "Printing");

        for (size_t page = 0; page < m_treebook->GetPageCount(); ++page)
            m_treebook->ExpandNode(page);

        m_treebook->Bind(wxEVT_TREEBOOK_PAGE_CHANGED, &SpecializedFrame::OnTreebookPageChanged, this);
    }

    void CreateBitmapComboBox(wxWindow* parent)
    {
        m_layerCombo = new wxBitmapComboBox(parent, wxID_ANY, "", wxDefaultPosition,
                                             wxSize(200, -1), 0, nullptr, wxCB_READONLY);

        // Add layers with color swatches
        m_layerCombo->Append("F.Cu (Top Copper)", CreateColorSwatch(*wxRED));
        m_layerCombo->Append("B.Cu (Bottom Copper)", CreateColorSwatch(*wxBLUE));
        m_layerCombo->Append("F.SilkS (Top Silk)", CreateColorSwatch(*wxYELLOW));
        m_layerCombo->Append("B.SilkS (Bottom Silk)", CreateColorSwatch(wxColour(255, 0, 255)));
        m_layerCombo->Append("F.Mask (Top Mask)", CreateColorSwatch(wxColour(0, 128, 0)));
        m_layerCombo->Append("B.Mask (Bottom Mask)", CreateColorSwatch(wxColour(0, 128, 128)));
        m_layerCombo->Append("Edge.Cuts", CreateColorSwatch(*wxWHITE));
        m_layerCombo->Append("Dwgs.User", CreateColorSwatch(wxColour(128, 128, 128)));

        m_layerCombo->SetSelection(0);

        m_layerCombo->Bind(wxEVT_COMBOBOX, &SpecializedFrame::OnLayerComboChanged, this);
    }

    void CreateLayerList(wxWindow* parent)
    {
        wxArrayString items;
        items.Add("F.Cu");
        items.Add("In1.Cu");
        items.Add("In2.Cu");
        items.Add("B.Cu");
        items.Add("F.SilkS");
        items.Add("B.SilkS");
        items.Add("F.Mask");
        items.Add("B.Mask");

        m_layerList = new wxCheckListBox(parent, wxID_ANY, wxDefaultPosition,
                                          wxSize(-1, 200), items);

        // Check all by default
        for (unsigned int i = 0; i < m_layerList->GetCount(); i++)
        {
            m_layerList->Check(i, true);
        }

        m_layerList->Bind(wxEVT_CHECKLISTBOX, &SpecializedFrame::OnLayerListCheck, this);
    }

    void OnTreebookPageChanged(wxBookCtrlEvent& event)
    {
        int page = event.GetSelection();
        wxString pageName = m_treebook->GetPageText(page);
        Log(wxString::Format("Treebook page changed to: %s (page %d)", pageName, page));
    }

    void OnLayerComboChanged(wxCommandEvent& event)
    {
        int sel = m_layerCombo->GetSelection();
        if (sel != wxNOT_FOUND)
        {
            wxString layer = m_layerCombo->GetString(sel);
            m_comboLabel->SetLabel(wxString::Format("Selected: %s", layer));
            Log(wxString::Format("Layer selected: %s", layer));
        }
    }

    void OnLayerListCheck(wxCommandEvent& event)
    {
        int idx = event.GetInt();
        bool checked = m_layerList->IsChecked(idx);
        wxString layer = m_layerList->GetString(idx);
        Log(wxString::Format("Layer %s visibility: %s", layer, checked ? "visible" : "hidden"));
    }

    void OnGetOrder(wxCommandEvent& event)
    {
        wxString orderStr = "Layer status:\n";

        for (unsigned int i = 0; i < m_layerList->GetCount(); i++)
        {
            wxString layer = m_layerList->GetString(i);
            bool visible = m_layerList->IsChecked(i);
            orderStr += wxString::Format("  %d. %s [%s]\n",
                (int)(i + 1), layer, visible ? "visible" : "hidden");
        }

        Log(orderStr);
    }

    void Log(const wxString& msg)
    {
        m_log->AppendText(msg + "\n");
    }

    wxTreebook* m_treebook;
    wxBitmapComboBox* m_layerCombo;
    wxStaticText* m_comboLabel;
    wxCheckListBox* m_layerList;
    wxTextCtrl* m_log;
};

class SpecializedApp : public wxApp
{
public:
    virtual bool OnInit() override
    {
        SpecializedFrame* frame = new SpecializedFrame();
        frame->Show();
        return true;
    }
};

wxIMPLEMENT_APP(SpecializedApp);
