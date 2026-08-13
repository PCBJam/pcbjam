/**
 * KiCad stubs for native GAL test build
 *
 * This header ONLY provides includes - no type definitions.
 * Implementations of missing symbols are in kicad_stubs.cpp.
 */

#ifndef KICAD_STUBS_H
#define KICAD_STUBS_H

// KiCad's GLAD loader must come before any OpenGL headers.
#include <kicad_gl/kiglad.h>

// System wxWidgets
#include <wx/wx.h>
#include <wx/glcanvas.h>

// Profiler macros - no-op
#ifndef PROF_TIMER
#define PROF_TIMER(name)
#endif

#ifndef PROF_END
#define PROF_END(name)
#endif

#endif // KICAD_STUBS_H
