// Stub trace_helpers.h for native GAL test
// Provides simplified TRACE_MANAGER that doesn't use wxWidgets macros

#ifndef TRACE_HELPERS_H_STUB
#define TRACE_HELPERS_H_STUB

#include <wx/wx.h>
#include <map>
#include <cstdarg>

// Forward declaration
class wxArrayString;

// Trace channel names (extern declarations)
extern const wxString traceGalProfile;
extern const wxString traceOpenGL;
extern const wxString traceGalCachedContainer;
extern const wxString traceShader;
extern const wxString traceGalContext;

// Definitions
inline const wxString traceGalProfile = "KICAD_GAL_PROFILE";
inline const wxString traceOpenGL = "KICAD_OPENGL";
inline const wxString traceGalCachedContainer = "KICAD_GAL_CACHED_CONTAINER";
inline const wxString traceShader = "KICAD_SHADER";
inline const wxString traceGalContext = "KICAD_GAL_CONTEXT";

// TRACE_MANAGER - simplified stub
class TRACE_MANAGER {
public:
    TRACE_MANAGER() : m_globalTraceEnabled(false), m_printAllTraces(false) {}
    ~TRACE_MANAGER() {}

    static TRACE_MANAGER& Instance() {
        static TRACE_MANAGER instance;
        return instance;
    }

    // Trace methods - variadic template version
    template<typename... Args>
    void Trace(const wxString&, Args...) {
        // No-op - tracing disabled for test
    }

    // wxWidgets-style methods for compatibility
    void DoTrace(const wxString&, const char*, ...) {}
    void DoTraceUtf8(const wxString&, const char*, ...) {}

    bool IsTraceEnabled(const wxString&) const {
        return false;  // Always disabled for test
    }

private:
    std::map<wxString, bool> m_enabledTraces;
    bool m_globalTraceEnabled;
    bool m_printAllTraces;
};

// KI_TRACE macro - no-op since IsTraceEnabled always returns false
#define KI_TRACE(aWhat, ...) \
    if (TRACE_MANAGER::Instance().IsTraceEnabled(aWhat)) { \
        TRACE_MANAGER::Instance().Trace(aWhat, __VA_ARGS__); \
    }

// Dump function stub
inline wxString dump(const wxArrayString&) { return wxString(); }

#endif // TRACE_HELPERS_H_STUB
