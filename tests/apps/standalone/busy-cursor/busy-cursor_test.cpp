// Installing an invalid cursor must not dereference its (null) ref data (DOM port).
//
// Bug (src/wasm/cursor.cpp): wxCursor::Install() reads M_CURSORDATA->GetCursorType()
// without checking IsOk(). An invalid cursor (wxCursor() / wxNullCursor) has no ref
// data, so this is a null dereference. wxEndBusyCursor() installs exactly such a
// cursor whenever no global cursor was set before wxBeginBusyCursor(): it restores
// g_globalCursor, which is still default-constructed. KiCad hits this on every
// schematic open (SCH_EDIT_FRAME::OpenProjectFiles holds a wxBusyCursor).
//
// On wasm the null read does not trap; it returns whatever lies at address 8. With
// zeros there (a module linked at -O1+, no ASSERTIONS) that is 0 =
// HTML5_CURSOR_TYPE_POINTER and nothing visible happens. With ASSERTIONS (any -O0
// link, e.g. scripts/kicad/build-kicad-target.sh --release, and these test apps)
// Emscripten's stack cookies sit at addresses 0..8 (0x89BACDFE at 8): the "type" is
// negative, setCursor() in wx.js takes the custom-bitmap branch, bitmapMap.get()
// returns undefined and `.width` throws a TypeError. Thrown under ~wxBusyCursor (a
// noexcept destructor), the JS exception hits the terminate landing pad:
// "libc++abi: terminating", Aborted(native code called abort()).
//
//   RED  (bug present): the first check throws a TypeError (the scope check would abort).
//   GREEN (fixed):      every check leaves the canvas cursor at the default pointer.

#include "wx/wxprec.h"
#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/utils.h"

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

// the cursor the canvas shows now (CSS)
static wxString CanvasCursor()
{
#ifdef __EMSCRIPTEN__
    char *css = (char *)EM_ASM_PTR({
        return stringToNewUTF8(String(Module.canvas && Module.canvas.style.cursor));
    });
    wxString s = wxString::FromUTF8(css);
    free(css);
    return s;
#else
    return wxString();
#endif
}

// run one step, then report the cursor the canvas shows. With the bug the step throws a
// JS TypeError, which C++ cannot catch: the line is never printed and the error shows in
// the console instead (the spec reports it).
template <typename F>
static void Check(const char *name, F step)
{
    step();
    const wxString cursor = CanvasCursor();
    Report(name, cursor == "default", wxString::Format("canvas cursor '%s'", cursor));
}

class ReproFrame : public wxFrame
{
public:
    ReproFrame();

private:
    void RunTest();
};

ReproFrame::ReproFrame()
    : wxFrame(nullptr, wxID_ANY, "busy cursor / null cursor repro")
{
    CallAfter(&ReproFrame::RunTest);
}

void ReproFrame::RunTest()
{
    // No global cursor was ever set (g_globalCursor is default-constructed), like at
    // KiCad's first schematic open.

    // 1. Resetting the cursor the documented way: wxSetCursor(wxNullCursor).
    Check("busycursor_set_null_cursor", [] { wxSetCursor(wxNullCursor); });

    // 2. A busy cursor without a prior global cursor: the end restores the invalid one.
    Check("busycursor_begin_end", [] {
        wxBeginBusyCursor();
        wxEndBusyCursor();
    });

    // 3. The same through wxBusyCursor (KiCad: SCH_EDIT_FRAME::OpenProjectFiles). The
    // end runs in a noexcept destructor, so with the bug this aborts the runtime and
    // the line below is never printed.
    Check("busycursor_scope", [] { wxBusyCursor busy; });
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
