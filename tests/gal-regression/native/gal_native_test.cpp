/**
 * Native GAL Test Application
 *
 * This app uses KiCad's actual OPENGL_GAL to render test scenarios
 * and captures baseline screenshots for visual regression testing.
 *
 * The test scenarios call GAL API methods (gal->DrawLine(), gal->DrawCircle(), etc.)
 * which are rendered by the real OPENGL_GAL implementation.
 */

// Our stubs - includes wx/wx.h from system wxWidgets
#include "kicad_stubs.h"

// KiCad GAL headers
#include <gal/graphics_abstraction_layer.h>
#include <gal/opengl/opengl_gal.h>
#include <advanced_config.h>

// stb_image_write for PNG output
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

// Standard library
#include <iostream>
#include <string>
#include <vector>
#include <cstdlib>
#include <filesystem>

// Test accessor for private GAL members
#include "gal_test_accessor.h"

// Test scenarios
#include "gal_test_scenarios.h"

namespace fs = std::filesystem;

// Global config
static std::string g_outputDir = "../baseline";
static int g_width = 800;
static int g_height = 600;
static bool g_showWindow = false;

/**
 * Save a screenshot by reading directly from the compositor's FBO
 * This bypasses macOS framebuffer reading issues by reading the FBO directly
 */
bool SaveScreenshot(const std::string& path, KIGFX::OPENGL_GAL* gal, int width, int height) {
    glFinish();

    // Try reading from FBO directly
    std::vector<uint8_t> pixels;
    int readWidth = 0, readHeight = 0;

    GLuint fboId = GetCompositorMainFBO(gal);
    unsigned int bufferHandle = GetMainBufferHandle(gal);
    GLuint textureId = GetCompositorMainBufferTexture(gal);

    std::cout << "FBO ID: " << fboId << ", Buffer handle: " << bufferHandle
              << ", Texture ID: " << textureId << std::endl;

    if (ReadCompositorFBOPixels(gal, pixels, &readWidth, &readHeight)) {
        std::cout << "Read from FBO: " << readWidth << "x" << readHeight << std::endl;
    } else {
        std::cerr << "Failed to read from FBO, falling back to texture read" << std::endl;
        // Fallback to texture read
        readWidth = width;
        readHeight = height;
        pixels.resize(readWidth * readHeight * 4);
        glBindTexture(GL_TEXTURE_2D, textureId);
        glGetTexImage(GL_TEXTURE_2D, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    }

    // Check for GL errors
    GLenum err = glGetError();
    if (err != GL_NO_ERROR) {
        std::cerr << "GL error: 0x" << std::hex << err << std::dec << std::endl;
    }

    // Debug: Check if we got any non-black pixels and show some sample values
    bool hasContent = false;
    int nonBlackCount = 0;
    for (size_t i = 0; i < pixels.size(); i += 4) {
        if (pixels[i] > 0 || pixels[i+1] > 0 || pixels[i+2] > 0) {
            hasContent = true;
            nonBlackCount++;
            if (nonBlackCount <= 3) {
                int pixelIdx = i / 4;
                int px = pixelIdx % readWidth;
                int py = pixelIdx / readWidth;
                std::cout << "  Sample pixel at (" << px << "," << py << "): RGBA("
                          << (int)pixels[i] << "," << (int)pixels[i+1] << ","
                          << (int)pixels[i+2] << "," << (int)pixels[i+3] << ")" << std::endl;
            }
        }
    }
    std::cout << "Has non-black content: " << (hasContent ? "YES" : "NO");
    if (hasContent) std::cout << " (" << nonBlackCount << " non-black pixels)";
    std::cout << std::endl;

    // Force all alpha values to 255 (opaque) to match the composited canvas output.
    // Native reads from the FBO where alpha < 255 for semi-transparent regions.
    // WebGL captures the composited canvas where alpha is always 1.0 (composited on
    // black with GL_ONE blend). By making native output opaque, both tests produce
    // equivalent "user-visible" screenshots that can be compared directly.
    for (size_t i = 3; i < pixels.size(); i += 4) {
        pixels[i] = 255;
    }

    // Flip vertically (OpenGL has origin at bottom-left)
    stbi_flip_vertically_on_write(1);

    int result = stbi_write_png(path.c_str(), readWidth, readHeight, 4, pixels.data(), readWidth * 4);

    if (result) {
        std::cout << "Saved: " << path << std::endl;
    } else {
        std::cerr << "Failed to save: " << path << std::endl;
    }

    return result != 0;
}

/**
 * Test frame containing the OPENGL_GAL canvas
 */
class GALTestFrame : public wxFrame {
public:
    GALTestFrame()
        : wxFrame(nullptr, wxID_ANY, "GAL Native Test", wxDefaultPosition, wxSize(g_width, g_height))
    {
        // Create display options
        KIGFX::GAL_DISPLAY_OPTIONS displayOptions;
        KIGFX::VC_SETTINGS vcSettings;

        std::cout << "Creating OPENGL_GAL instance...\n";

        try {
            m_gal = new KIGFX::OPENGL_GAL(
                vcSettings,
                displayOptions,
                this,               // parent window
                nullptr,            // mouse listener
                nullptr,            // paint listener
                "GAL Native Test"   // name
            );
        } catch (const std::exception& e) {
            std::cerr << "Failed to create OPENGL_GAL: " << e.what() << std::endl;
            Close();
            return;
        }

        std::cout << "OPENGL_GAL created successfully\n";

        // Set up sizer
        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(m_gal, 1, wxEXPAND);
        SetSizer(sizer);

        // Bind close event
        Bind(wxEVT_CLOSE_WINDOW, &GALTestFrame::OnClose, this);

        // Run tests after the frame is shown
        CallAfter(&GALTestFrame::RunTests);
    }

    ~GALTestFrame() {
        // GAL will be deleted by wxWidgets when frame closes
    }

    void OnClose(wxCloseEvent& event) {
        event.Skip();
    }

    void RunTests() {
        if (!m_gal) {
            wxTheApp->ExitMainLoop();
            return;
        }

        // Create output directory
        fs::create_directories(g_outputDir);

        // Set up the viewport - use ResizeScreen to properly initialize compositor
        m_gal->ResizeScreen(g_width, g_height);
        // Use white background to match WebGL test (which captures the composited canvas).
        // Native reads from the FBO (pre-compositing), so we set alpha to 255 in SaveScreenshot
        // to simulate the composited result. White background ensures both tests see the same
        // blended colors for semi-transparent shapes.
        m_gal->SetClearColor(KIGFX::COLOR4D(1.0, 1.0, 1.0, 1.0));

        // CRITICAL: Set worldUnitLength for 1:1 world-to-screen coordinate mapping
        // GAL default worldUnitLength is for PCB nanometers (3.937e-8), which would
        // compress our pixel-scale coordinates (0-800) to ~0.003 screen pixels total!
        // We need: worldScale = screenDPI * worldUnitLength * zoomFactor = 1.0
        // With screenDPI=91 and zoomFactor=1.0, worldUnitLength should be 1/91
        m_gal->SetWorldUnitLength(1.0 / ADVANCED_CFG::GetCfg().m_ScreenDPI);

        // Set up coordinate transformation for 1:1 world-to-screen mapping
        // LookAtPoint should be at center, ZoomFactor of 1.0 gives 1:1 mapping
        m_gal->SetLookAtPoint(VECTOR2D(g_width / 2.0, g_height / 2.0));
        m_gal->SetZoomFactor(1.0);
        m_gal->ComputeWorldScreenMatrix();

        // Get framebuffer size for screenshots
        wxSize clientSize = m_gal->GetClientSize();
        double scaleFactor = m_gal->GetContentScaleFactor();
        int fbWidth = (int)(clientSize.GetWidth() * scaleFactor);
        int fbHeight = (int)(clientSize.GetHeight() * scaleFactor);

        std::cout << "Canvas size: " << g_width << "x" << g_height << "\n";
        std::cout << "Client size: " << clientSize.GetWidth() << "x" << clientSize.GetHeight() << "\n";
        std::cout << "Framebuffer size: " << fbWidth << "x" << fbHeight << "\n";
        std::cout << "Scale factor: " << scaleFactor << "\n\n";

        // Get scenario count
        int scenarioCount = GALTest::GetScenarioCount();
        std::cout << "Running " << scenarioCount << " test scenarios...\n\n";

        // Run each scenario
        int passed = 0;
        for (int i = 0; i < scenarioCount; i++) {
            const char* name = GALTest::GetScenarioName(i);
            std::cout << "Scenario " << i << ": " << name << "... ";

            // Render using proper GAL sequence
            m_gal->LockContext(i);
            m_gal->BeginDrawing();

            // Must call SetTarget after BeginDrawing to set m_currentManager
            m_gal->SetTarget(KIGFX::TARGET_NONCACHED);

            // Clear all targets (FBOs) to prevent content accumulation between scenarios
            m_gal->ClearTarget(KIGFX::TARGET_NONCACHED);

            // Clear the screen (window framebuffer)
            m_gal->ClearScreen();

            // Render the scenario using GAL API
            GALTest::RenderScenario(m_gal, i, g_width, g_height);

            // Test Flush() API - flushes vertex buffer to GPU
            m_gal->Flush();

            // EndDrawing renders vertices to FBO, composites to screen, swaps buffers
            m_gal->EndDrawing();
            m_gal->UnlockContext(i);

            // Save screenshot by reading directly from compositor's texture
            std::string filename = g_outputDir + "/gal-" + name + ".png";
            if (SaveScreenshot(filename, m_gal, fbWidth, fbHeight)) {
                std::cout << "OK\n";
                passed++;
            } else {
                std::cout << "FAILED\n";
            }
        }

        std::cout << "\nResults: " << passed << "/" << scenarioCount << " scenarios saved\n";

        m_passed = passed;
        m_total = scenarioCount;

        // Close if not showing window
        if (!g_showWindow) {
            Close();
        }
    }

    int GetPassed() const { return m_passed; }
    int GetTotal() const { return m_total; }

private:
    KIGFX::OPENGL_GAL* m_gal = nullptr;
    int m_passed = 0;
    int m_total = 0;
};

/**
 * Test application
 */
class GALTestApp : public wxApp {
public:
    bool OnInit() override {
        // Parse command line
        for (int i = 1; i < argc; i++) {
            wxString arg = argv[i];
            if (arg == "--output" && i + 1 < argc) {
                g_outputDir = argv[++i].ToStdString();
            } else if (arg == "--width" && i + 1 < argc) {
                g_width = wxAtoi(argv[++i]);
            } else if (arg == "--height" && i + 1 < argc) {
                g_height = wxAtoi(argv[++i]);
            } else if (arg == "--show") {
                g_showWindow = true;
            } else if (arg == "--help") {
                std::cout << "Usage: gal_native_test [options]\n";
                std::cout << "  --output <dir>   Output directory for baseline PNGs\n";
                std::cout << "  --width <w>      Canvas width (default: 800)\n";
                std::cout << "  --height <h>     Canvas height (default: 600)\n";
                std::cout << "  --show           Show window (default: headless)\n";
                return false;
            }
        }

        std::cout << "GAL Native Test - OPENGL_GAL Baseline Generator\n";
        std::cout << "================================================\n\n";

        m_frame = new GALTestFrame();
        m_frame->Show(true);

        return true;
    }

    int OnExit() override {
        if (m_frame) {
            return (m_frame->GetPassed() == m_frame->GetTotal()) ? 0 : 1;
        }
        return 1;
    }

private:
    GALTestFrame* m_frame = nullptr;
};

wxIMPLEMENT_APP(GALTestApp);
