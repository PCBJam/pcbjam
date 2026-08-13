// Secondary-window wxGLCanvas compositing test (WASM DOM port).
//
// Regression for the "two canvases over each other" bug. The wx DOM port draws
// each top-level window's chrome onto 2D canvases and reveals a wxGLCanvas
// through it. A wxGLCanvas in a *secondary* top-level window was hidden behind
// that window's own opaque chrome: every glcanvas-* was hard-coded to z-index
// 100, but showing the secondary frame raises its window-N chrome div to
// z-index 101 (raiseWindow → maxZ+1 over the visible main canvas at 100), so the
// chrome painted over the GL canvas. The fix has wxGLCanvas pass its owning
// top-level window's explicit role to wx.js createGLCanvas: the main-frame GL
// canvas stays at z-index 100 and the secondary-frame GL canvas is lifted to
// z-index 2147483647, above the chrome.
//
// This is the minimal pure-wxWidgets repro: a main frame with a wxGLCanvas plus
// a button that opens a SECOND top-level frame with its own wxGLCanvas. Opening
// the second frame after the main one is visible mirrors opening KiCad's 3D
// viewer from a menu. The e2e spec asserts both exact semantic z-index roles and
// that the secondary GL canvas remains above the other canvases and window chrome.

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/glcanvas.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

namespace
{
// Build a wxGLCanvas with default attributes; the wasm port's
// ConvertWXAttrsToWebGL fills in WebGL2 + preserveDrawingBuffer. No GL drawing is
// needed — createGLCanvas (which assigns the z-index) runs at construction.
wxGLCanvas* MakeGLCanvas( wxWindow* parent )
{
    wxGLAttributes attrs;
    attrs.PlatformDefaults().Defaults().EndList();
    return new wxGLCanvas( parent, attrs, wxID_ANY, wxDefaultPosition, wxSize( 320, 240 ) );
}
} // namespace

// A secondary top-level frame that owns its own wxGLCanvas — the window whose
// chrome used to occlude its GL canvas.
class SecondGLFrame : public wxFrame
{
public:
    SecondGLFrame()
        : wxFrame( nullptr, wxID_ANY, "Secondary GL Window", wxDefaultPosition, wxSize( 360, 280 ) )
    {
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );
        sizer->Add( MakeGLCanvas( this ), 1, wxEXPAND );
        SetSizer( sizer );
    }
};

class MainGLFrame : public wxFrame
{
public:
    MainGLFrame()
        : wxFrame( nullptr, wxID_ANY, "Main GL Window", wxDefaultPosition, wxSize( 700, 520 ) )
    {
        wxPanel*    panel = new wxPanel( this );
        wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

        wxButton* open = new wxButton( panel, wxID_ANY, "Open Second Window" );
        open->Bind( wxEVT_BUTTON, &MainGLFrame::OnOpenSecond, this );

        sizer->Add( open, 0, wxALL, 8 );
        sizer->Add( MakeGLCanvas( panel ), 1, wxEXPAND );
        panel->SetSizer( sizer );
    }

private:
    void OnOpenSecond( wxCommandEvent& WXUNUSED( evt ) )
    {
        // Create the secondary frame's GL canvas only now, with the main canvas
        // already visible, to mirror the real 3D viewer lifecycle.
        ( new SecondGLFrame() )->Show( true );
    }
};

class SecondaryGLCanvasApp : public wxApp
{
public:
    bool OnInit() override
    {
        if( !wxApp::OnInit() )
            return false;

        MainGLFrame* frame = new MainGLFrame();
        frame->Show( true );
        return true;
    }
};

wxIMPLEMENT_APP( SecondaryGLCanvasApp );
