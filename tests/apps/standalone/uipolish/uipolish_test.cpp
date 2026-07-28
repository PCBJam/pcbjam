// UI Polish Test - Regression guards for the wasm-ui-polish fixes
// (wxwidgets wasm-port commit 4a02a39c07).
//
// Each check is independent and logs one line:
//   [UIPOLISH_TEST] <check>: PASS
//   [UIPOLISH_TEST] <check>: FAIL <detail>
// followed by a summary line the spec polls for:
//   [UIPOLISH_TEST] done checks=<n> pass=<n>
//
// Checks:
//   clip-clear      DoSetClippingRegion reaches the canvas: dc.Clear() under a
//                   cell clip only wipes the clip rect. Pre-fix the port read
//                   the legacy logical m_clipX* fields (always zero in this wx
//                   fork — the base stores the box in device m_devClip*), the
//                   JS layer expanded the "empty" rect to the full context, and
//                   Clear() wiped everything (the collapsed wire-properties-
//                   panel bug: KiCad's color-swatch cell renderer Clear()s
//                   trusting the cell clip).
//   clip-empty      A clip fully outside the DC is EMPTY: nothing paints.
//                   Pre-fix the JS empty→full fallback made it paint all.
//   clip-box        GetClippingBox round-trips the rect just set.
//   blit-origin     Blit honors the source DC's device origin (the
//                   wxBufferedDC::UnMask contract: source position is
//                   -GetDeviceOrigin()). Pre-fix raw logical coords were
//                   passed to the canvas and the copy came from the wrong
//                   rows (displaced propgrid content).
//   mask-alpha      ConvertToImage() bakes wxMask transparency into alpha.
//                   Pre-fix the mask was dropped and mask-XPM art (e.g. the
//                   infobar close button) flattened to an opaque block.
//   scaled-dims     ConvertToImage() of a scale-factor-2 bitmap returns the
//                   physical pixel size, not a logical-sized top-left crop.
//   checkbox-floor  wxCheckBox::DoGetBestSize() floors the height to
//                   GetCharHeight()+8 (same guard as the wxChoice fix, see
//                   selectheight test) — queried before Show()/layout.
//   statbmp-best    wxStaticBitmap::DoGetBestSize() reports the bundle's
//                   LOGICAL default size. Pre-fix the base implementation's
//                   FromPhys path inflated it by the DPI scale (32 instead of
//                   16 on a devicePixelRatio>=1.5 display), which is what made
//                   the layers-panel rows tall and the eye icons blurry. Only
//                   discriminating at DPR>=1.5 — the spec runs a
//                   deviceScaleFactor:2 pass for that.

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/dcmemory.h"
#include "wx/bmpbndl.h"
#include "wx/statbmp.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

static int s_checks = 0;
static int s_passed = 0;

static void Report(const char* check, bool ok, const wxString& detail)
{
    s_checks++;
    if (ok)
        s_passed++;

#ifdef __EMSCRIPTEN__
    const wxString line = ok
        ? wxString::Format("[UIPOLISH_TEST] %s: PASS", check)
        : wxString::Format("[UIPOLISH_TEST] %s: FAIL %s", check, detail);
    EM_ASM({
        if ($1) console.log(UTF8ToString($0));
        else console.error(UTF8ToString($0));
    }, (const char*)line.utf8_str(), ok ? 1 : 0);
#else
    wxLogMessage("%s: %s %s", check, ok ? "PASS" : "FAIL", detail);
#endif
}

static bool PixelIs(const wxImage& img, int x, int y,
                    unsigned char r, unsigned char g, unsigned char b)
{
    return img.GetRed(x, y) == r && img.GetGreen(x, y) == g && img.GetBlue(x, y) == b;
}

static wxString PixelStr(const wxImage& img, int x, int y)
{
    return wxString::Format("(%d,%d)=%d,%d,%d", x, y,
                            img.GetRed(x, y), img.GetGreen(x, y), img.GetBlue(x, y));
}

// dc.Clear() under a clip must only wipe the clip rect.
static void CheckClipClear()
{
    wxBitmap bmp(100, 100, 24);
    {
        wxMemoryDC dc(bmp);
        dc.SetBrush(*wxRED_BRUSH);
        dc.SetPen(*wxTRANSPARENT_PEN);
        dc.DrawRectangle(0, 0, 100, 100);

        dc.SetBackground(*wxWHITE_BRUSH);
        dc.SetClippingRegion(10, 10, 20, 20);
        dc.Clear();
        dc.DestroyClippingRegion();
        dc.SelectObject(wxNullBitmap);
    }

    wxImage img = bmp.ConvertToImage();
    const bool insideWhite = PixelIs(img, 15, 15, 255, 255, 255);
    const bool outsideRed1 = PixelIs(img, 5, 5, 255, 0, 0);
    const bool outsideRed2 = PixelIs(img, 60, 60, 255, 0, 0);

    Report("clip-clear", insideWhite && outsideRed1 && outsideRed2,
           wxString::Format("inside %s outside %s / %s",
                            PixelStr(img, 15, 15), PixelStr(img, 5, 5), PixelStr(img, 60, 60)));
}

// A clip entirely outside the DC surface is empty: painting is fully clipped out.
static void CheckClipEmpty()
{
    wxBitmap bmp(100, 100, 24);
    {
        wxMemoryDC dc(bmp);
        dc.SetBrush(*wxRED_BRUSH);
        dc.SetPen(*wxTRANSPARENT_PEN);
        dc.DrawRectangle(0, 0, 100, 100);

        dc.SetBackground(*wxWHITE_BRUSH);
        dc.SetClippingRegion(200, 200, 10, 10); // outside the 100x100 surface
        dc.Clear();
        dc.DestroyClippingRegion();
        dc.SelectObject(wxNullBitmap);
    }

    wxImage img = bmp.ConvertToImage();
    const bool untouched = PixelIs(img, 5, 5, 255, 0, 0) && PixelIs(img, 95, 95, 255, 0, 0);

    Report("clip-empty", untouched,
           wxString::Format("%s / %s", PixelStr(img, 5, 5), PixelStr(img, 95, 95)));
}

// GetClippingBox must round-trip the rect just set.
static void CheckClipBox()
{
    wxBitmap bmp(100, 100, 24);
    wxMemoryDC dc(bmp);
    dc.SetClippingRegion(10, 20, 30, 40);

    wxRect box;
    dc.GetClippingBox(box);
    dc.DestroyClippingRegion();

    const bool ok = box == wxRect(10, 20, 30, 40);
    Report("clip-box", ok,
           wxString::Format("got (%d,%d %dx%d)", box.x, box.y, box.width, box.height));
}

// Blit must honor the source DC's device origin (wxBufferedDC::UnMask passes
// -GetDeviceOrigin() as the source position).
static void CheckBlitOrigin()
{
    wxBitmap src(50, 50, 24);
    wxBitmap dst(50, 25, 24);
    {
        wxMemoryDC sdc(src);
        sdc.SetPen(*wxTRANSPARENT_PEN);
        sdc.SetBrush(*wxGREEN_BRUSH);
        sdc.DrawRectangle(0, 0, 50, 25);   // top half green
        sdc.SetBrush(*wxBLUE_BRUSH);
        sdc.DrawRectangle(0, 25, 50, 25);  // bottom half blue

        // Logical (0,0) now maps to physical (0,25): copying logical rows
        // 0..24 must fetch the BLUE bottom half.
        sdc.SetDeviceOrigin(0, 25);

        wxMemoryDC ddc(dst);
        ddc.SetPen(*wxTRANSPARENT_PEN);
        ddc.SetBrush(*wxBLACK_BRUSH);
        ddc.DrawRectangle(0, 0, 50, 25);

        ddc.Blit(0, 0, 50, 25, &sdc, 0, 0);

        ddc.SelectObject(wxNullBitmap);
        sdc.SelectObject(wxNullBitmap);
    }

    wxImage img = dst.ConvertToImage();
    const bool blue = PixelIs(img, 10, 10, 0, 0, 255) && PixelIs(img, 40, 20, 0, 0, 255);

    Report("blit-origin", blue,
           wxString::Format("%s / %s", PixelStr(img, 10, 10), PixelStr(img, 40, 20)));
}

// ConvertToImage must carry wxMask transparency as alpha.
static void CheckMaskAlpha()
{
    wxImage in(8, 8);
    in.SetRGB(wxRect(0, 0, 8, 8), 255, 0, 0);
    in.SetRGB(0, 0, 255, 0, 255);           // one magenta pixel...
    in.SetMaskColour(255, 0, 255);          // ...masked out

    wxBitmap bmp(in);
    wxImage out = bmp.ConvertToImage();

    const bool hasAlpha = out.HasAlpha();
    const bool maskedOut = hasAlpha && out.GetAlpha(0, 0) == 0;
    const bool restOpaque = hasAlpha && out.GetAlpha(3, 3) == 255 && PixelIs(out, 3, 3, 255, 0, 0);

    Report("mask-alpha", hasAlpha && maskedOut && restOpaque,
           wxString::Format("hasAlpha=%d a(0,0)=%d a(3,3)=%d %s",
                            hasAlpha ? 1 : 0,
                            hasAlpha ? out.GetAlpha(0, 0) : -1,
                            hasAlpha ? out.GetAlpha(3, 3) : -1,
                            PixelStr(out, 3, 3)));
}

// ConvertToImage of a scale-2 bitmap must return physical pixels, not a
// logical-sized top-left crop.
static void CheckScaledDims()
{
    wxBitmap bmp;
    bmp.CreateScaled(16, 16, 32, 2.0);

    wxImage img = bmp.ConvertToImage();
    const bool ok = img.GetWidth() == 32 && img.GetHeight() == 32;

    Report("scaled-dims", ok,
           wxString::Format("got %dx%d", img.GetWidth(), img.GetHeight()));
}

class UiPolishFrame : public wxFrame
{
public:
    UiPolishFrame()
        : wxFrame(nullptr, wxID_ANY, "UI Polish Test",
                  wxDefaultPosition, wxSize(420, 260))
    {
        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(new wxStaticText(this, wxID_ANY,
            "UI Polish Test\n\n"
            "Self-asserting regression guards for the wasm-ui-polish DC,\n"
            "checkbox and static-bitmap fixes. Results go to the console."),
            0, wxALL, 10);

        // checkbox-floor: best size queried BEFORE Show()/layout, where the
        // DOM measure can be degenerate.
        wxCheckBox* cb = new wxCheckBox(this, wxID_ANY, "Guard checkbox");
        const wxSize cbBest = cb->GetBestSize();
        const int minHeight = GetCharHeight() + 8;
        Report("checkbox-floor", cbBest.y >= minHeight,
               wxString::Format("best=%dx%d min=%d", cbBest.x, cbBest.y, minHeight));
        sizer->Add(cb, 0, wxALL, 10);

        // statbmp-best: a 16px + 32px bundle must lay out at the LOGICAL 16px.
        // Fill both resolutions so the DOM <img> ships real content (like a
        // real icon bundle would).
        wxBitmap b16(16, 16, 32);
        wxBitmap b32(32, 32, 32);
        {
            wxMemoryDC dc16(b16);
            dc16.SetBackground(*wxRED_BRUSH);
            dc16.Clear();
            dc16.SelectObject(wxNullBitmap);
            wxMemoryDC dc32(b32);
            dc32.SetBackground(*wxBLUE_BRUSH);
            dc32.Clear();
            dc32.SelectObject(wxNullBitmap);
        }
        wxStaticBitmap* sb = new wxStaticBitmap(this, wxID_ANY,
            wxBitmapBundle::FromBitmaps(b16, b32));
        const wxSize sbBest = sb->GetBestSize();
        Report("statbmp-best", sbBest == wxSize(16, 16),
               wxString::Format("best=%dx%d dpiScale=%.1f",
                                sbBest.x, sbBest.y, GetDPIScaleFactor()));
        sizer->Add(sb, 0, wxALL, 10);

        SetSizer(sizer);
    }
};

class UiPolishApp : public wxApp
{
public:
    virtual bool OnInit() override
    {
        if (!wxApp::OnInit())
            return false;

        // The DOM port serves wxStaticBitmap content as a PNG data URL;
        // encoding needs the PNG handler (KiCad registers it, a bare test app
        // must do it itself).
        wxInitAllImageHandlers();

        CheckClipClear();
        CheckClipEmpty();
        CheckClipBox();
        CheckBlitOrigin();
        CheckMaskAlpha();
        CheckScaledDims();

        UiPolishFrame* frame = new UiPolishFrame();
        frame->Show(true);

#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[UIPOLISH_TEST] done checks=' + $0 + ' pass=' + $1);
        }, s_checks, s_passed);
#endif
        return true;
    }
};

wxIMPLEMENT_APP(UiPolishApp);
