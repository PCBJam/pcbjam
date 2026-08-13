/**
 * GAL WebGL Test - WASM Entry Point
 *
 * This test harness renders GAL test scenarios using WEBGL_GAL
 * and allows Playwright to capture screenshots for comparison against native.
 */

// Include kiglew.h first to set GLEW guard before anything includes <GL/glew.h>
#include "webgl/kiglew.h"

#include <wx/wx.h>
#include <wx/glcanvas.h>

#include <emscripten.h>
#include <emscripten/html5.h>

// KiCad GAL headers
#include <gal/graphics_abstraction_layer.h>
#include <math/vector2d.h>
#include "webgl/webgl_gal.h"

// Test scenarios (shared with native test)
#include "gal_test_scenarios.h"

// Stubs
#include "kicad_stubs.h"

#include <cstdio>

// Canvas dimensions
// Physical canvas is 1600x1200 (matching native baseline at 2x Retina scale)
// But GAL coordinate space is 800x600 (matching native logical dimensions)
// The 2x scaling happens via devicePixelRatio in the canvas
static const int CANVAS_WIDTH = 1600;
static const int CANVAS_HEIGHT = 1200;
static const int GAL_WIDTH = 800;   // Logical coordinate space (matches native)
static const int GAL_HEIGHT = 600;

// Global state
static int g_currentScenario = -1;
static int g_totalScenarios = 28;
static KIGFX::WEBGL_GAL* g_gal = nullptr;
static wxFrame* g_frame = nullptr;
static bool g_ready = false;

/**
 * Render the current scenario
 */
void renderCurrentScenario() {
    if (!g_gal || g_currentScenario < 0) {
        return;
    }

    printf("Rendering scenario %d: %s\n", g_currentScenario,
           GALTest::GetScenarioName(g_currentScenario));

    // Lock context before drawing (required by GAL)
    g_gal->LockContext(g_currentScenario);

    // Begin drawing
    g_gal->BeginDrawing();

    // Set target to non-cached for immediate rendering
    g_gal->SetTarget(KIGFX::TARGET_NONCACHED);

    // Clear the target buffer first (clears the FBO where content is rendered)
    g_gal->ClearTarget(KIGFX::TARGET_NONCACHED);

    // Clear the screen (clears the direct rendering buffer)
    g_gal->ClearScreen();

    // Render the scenario using logical coordinate space (matches native)
    GALTest::RenderScenario(g_gal, g_currentScenario, GAL_WIDTH, GAL_HEIGHT);

    // End drawing and present
    g_gal->EndDrawing();

    // Unlock context (pass same cookie as LockContext)
    g_gal->UnlockContext(g_currentScenario);

    printf("Scenario %d rendered\n", g_currentScenario);
}

/**
 * C API for JavaScript calls
 */
extern "C" {

EMSCRIPTEN_KEEPALIVE
int runScenario(int scenarioIndex) {
    printf("[DEBUG] runScenario called with index %d, g_gal=%p\n",
           scenarioIndex, (void*)g_gal);

    if (scenarioIndex < 0 || scenarioIndex >= g_totalScenarios) {
        printf("ERROR: Invalid scenario index %d (valid: 0-%d)\n",
               scenarioIndex, g_totalScenarios - 1);
        return -1;
    }

    if (!g_ready || !g_gal) {
        printf("ERROR: GAL is not ready\n");
        return -2;
    }

    g_currentScenario = scenarioIndex;
    renderCurrentScenario();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int isGalReady() {
    return g_ready ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int getTotalScenarios() {
    return g_totalScenarios;
}

EMSCRIPTEN_KEEPALIVE
int getCurrentScenario() {
    return g_currentScenario;
}

EMSCRIPTEN_KEEPALIVE
int getCanvasWidth() {
    return CANVAS_WIDTH;
}

EMSCRIPTEN_KEEPALIVE
int getCanvasHeight() {
    return CANVAS_HEIGHT;
}

}  // extern "C"

/**
 * wxWidgets Application
 */
class GALTestApp : public wxApp {
public:
    virtual bool OnInit() override;
};

wxIMPLEMENT_APP_NO_MAIN(GALTestApp);

bool GALTestApp::OnInit() {
    printf("GAL WebGL Test - Initializing wxWidgets\n");

    // Create a frame to host the GL canvas
    g_frame = new wxFrame(nullptr, wxID_ANY, "GAL WebGL Test",
                          wxDefaultPosition, wxSize(CANVAS_WIDTH, CANVAS_HEIGHT));

    // Create display options
    KIGFX::GAL_DISPLAY_OPTIONS displayOptions;
    KIGFX::VC_SETTINGS vcSettings;

    printf("Creating WEBGL_GAL instance...\n");

    try {
        g_gal = new KIGFX::WEBGL_GAL(
            vcSettings,
            displayOptions,
            g_frame,            // parent window
            nullptr,            // mouse listener
            nullptr,            // paint listener
            "GAL WebGL Test"    // name
        );
    } catch (const std::exception& e) {
        printf("ERROR: Failed to create WEBGL_GAL: %s\n", e.what());
        return false;
    }

    printf("WEBGL_GAL created successfully\n");

    // Add GAL to frame's sizer (like native test)
    wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
    sizer->Add(g_gal, 1, wxEXPAND);
    g_frame->SetSizer(sizer);

    // Show the frame (required for GAL visibility)
    g_frame->Show(true);

    // Set up the GAL
    // Native test runs at 800x600 logical but outputs 1600x1200 due to Retina 2x scaling
    // We need to match this: GAL thinks it's 800x600, but actually renders to 1600x1200
    g_gal->SetScreenSize(VECTOR2I(CANVAS_WIDTH, CANVAS_HEIGHT));  // Physical: 1600x1200
    g_gal->ResizeScreen(CANVAS_WIDTH, CANVAS_HEIGHT);  // Framebuffer: 1600x1200
    // Native screenshots have transparent backgrounds that flatten to WHITE during comparison
    // WebGL must use white background to match after flattening
    g_gal->SetClearColor(KIGFX::COLOR4D(1.0, 1.0, 1.0, 1.0));

    // CRITICAL: Set worldUnitLength to match native (which uses DPI=91)
    g_gal->SetWorldUnitLength(1.0 / 91.0);  // Match native KiCad default

    // Set up coordinate transformation to simulate Retina 2x scaling:
    // - LookAtPoint at center of LOGICAL space (400, 300)
    // - ZoomFactor of 2.0 to scale 800x600 content to fill 1600x1200
    g_gal->SetLookAtPoint(VECTOR2D(GAL_WIDTH / 2.0, GAL_HEIGHT / 2.0));
    g_gal->SetZoomFactor(2.0);  // 2x zoom to simulate Retina scaling
    g_gal->ComputeWorldScreenMatrix();

    // Initialize the compositor with proper context locking
    g_gal->LockContext(-1);  // Lock with init ID
    g_gal->BeginDrawing();
    g_gal->SetTarget(KIGFX::TARGET_NONCACHED);
    g_gal->ClearScreen();
    g_gal->EndDrawing();
    g_gal->UnlockContext(-1);  // Pass same cookie

    printf("\nReady for scenarios. Total: %d\n", g_totalScenarios);
    printf("Call runScenario(index) from JavaScript to render.\n");

    g_ready = true;

    return true;
}

/**
 * Main entry point
 */
int main(int argc, char* argv[]) {
    printf("GAL WebGL Test\n");
    printf("==============\n\n");

    // Initialize wxWidgets
    wxEntryStart(argc, argv);

    if (!wxTheApp->OnInit()) {
        printf("ERROR: wxApp initialization failed\n");
        return 1;
    }

    // Don't exit - keep runtime alive for JavaScript calls
    emscripten_exit_with_live_runtime();

    return 0;
}
