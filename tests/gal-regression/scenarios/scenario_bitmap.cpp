/**
 * Bitmap Scenario
 *
 * Tests GAL DrawBitmap() method using BITMAP_BASE with various test patterns.
 *
 * DrawBitmap() renders a raster image centered at the current transformation origin.
 * In OPENGL_GAL, it uses GL_BITMAP_CACHE to create GPU textures from wxImage data.
 * Position is controlled via Save/Translate/Restore, not by arguments to DrawBitmap.
 *
 * This scenario demonstrates:
 * 1. Basic bitmap rendering with checkerboard pattern
 * 2. Gradient patterns (horizontal, vertical, radial)
 * 3. Custom KiCad logo-style pattern
 * 4. Different bitmap sizes
 * 5. Multiple bitmaps in a scene
 */

#include <gal/graphics_abstraction_layer.h>
#include "../native/bitmap_base_stub.h"
#include <cmath>

// Native-only includes for shader workaround
// WebGL uses a different shader architecture and doesn't need this workaround
#ifndef __EMSCRIPTEN__
#include <kicad_gl/kiglad.h>
#include <gal/opengl/opengl_gal.h>
#include "../native/gal_test_accessor.h"
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace GALTest {

using KIGFX::COLOR4D;
using KIGFX::GAL;

#ifndef __EMSCRIPTEN__
// Native build only: OpenGL-specific code

using KIGFX::OPENGL_GAL;

// Setup state needed for DrawBitmap (width/height cached per scenario)
static int s_viewportWidth = 0;
static int s_viewportHeight = 0;

static void SetupFixedFunctionMatrices() {
    // Save current matrix state
    glMatrixMode(GL_PROJECTION);
    glPushMatrix();
    glLoadIdentity();
    // Note: GAL uses Y-down coordinate system with origin at top-left
    glOrtho(0, s_viewportWidth, s_viewportHeight, 0, -1, 1);

    glMatrixMode(GL_MODELVIEW);
    glPushMatrix();
    glLoadIdentity();
}

static void RestoreFixedFunctionMatrices() {
    glMatrixMode(GL_MODELVIEW);
    glPopMatrix();
    glMatrixMode(GL_PROJECTION);
    glPopMatrix();
}

// Helper to draw bitmap with shader deactivation
// DrawBitmap uses glBegin/glEnd which requires fixed-function pipeline
//
// NOTE: This workaround attempts to make DrawBitmap work by deactivating the shader
// and setting up fixed-function projection matrices. However, it doesn't fully work
// because the legacy OpenGL immediate mode (glBegin/glEnd) used by OPENGL_GAL::DrawBitmap
// is incompatible with the compositor FBO rendering used by this test harness.
// See README.md for details.
static void DrawBitmapWithShaderFix(GAL* gal, const BITMAP_BASE& bitmap, double alpha = 1.0) {
    auto* oglGal = static_cast<OPENGL_GAL*>(gal);

    DeactivateGALShader(oglGal);

    // Set up fixed-function matrices for the orthographic projection
    SetupFixedFunctionMatrices();

    gal->DrawBitmap(bitmap, alpha);

    // Restore matrices before reactivating shader
    RestoreFixedFunctionMatrices();

    ActivateGALShader(oglGal);
}

#else
// WebGL build: Use DrawBitmap directly through the abstract interface
// WEBGL_GAL::DrawBitmap should be implemented using modern GL (VAO/VBO) not immediate mode

static void DrawBitmapWithShaderFix(GAL* gal, const BITMAP_BASE& bitmap, double alpha = 1.0) {
    // In WebGL, just call DrawBitmap directly
    // The shader is managed internally by WEBGL_GAL
    gal->DrawBitmap(bitmap, alpha);
}

#endif

void RenderBitmap(GAL* gal, int width, int height) {
#ifndef __EMSCRIPTEN__
    // Cache viewport size for fixed-function matrix setup (native only)
    s_viewportWidth = width;
    s_viewportHeight = height;
#endif

    gal->SetLayerDepth(100);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background
    gal->SetFillColor(COLOR4D(0.1, 0.1, 0.12, 1.0));
    gal->DrawRectangle(VECTOR2D(0, 0), VECTOR2D(width, height));

    //=========================================================================
    // Section 1: Basic checkerboard bitmap
    //=========================================================================
    gal->SetLayerDepth(50);

    // Create checkerboard bitmap (64x64)
    auto checkerboard = CreateCheckerboardBitmap(64, 64, 8);

    // Position bitmap at (80, 80) - use transform
    gal->Save();
    gal->Translate(VECTOR2D(100, 100));  // Center position
    DrawBitmapWithShaderFix(gal, *checkerboard, 1.0);
    gal->Restore();

    // Section label frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(2.0);
    gal->SetStrokeColor(COLOR4D(0.5, 0.5, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(20, 20), VECTOR2D(180, 180));

    //=========================================================================
    // Section 2: Gradient bitmap (horizontal)
    //=========================================================================
    gal->SetLayerDepth(50);

    auto gradient = CreateGradientBitmap(80, 60);

    gal->Save();
    gal->Translate(VECTOR2D(300, 100));
    DrawBitmapWithShaderFix(gal, *gradient, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.5, 0.4, 0.4, 0.8));
    gal->DrawRectangle(VECTOR2D(200, 20), VECTOR2D(400, 180));

    //=========================================================================
    // Section 3: KiCad logo pattern
    //=========================================================================
    gal->SetLayerDepth(50);

    auto logo = CreateKiCadLogoBitmap(80, 80);

    gal->Save();
    gal->Translate(VECTOR2D(520, 100));
    DrawBitmapWithShaderFix(gal, *logo, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.4, 0.5, 0.3, 0.8));
    gal->DrawRectangle(VECTOR2D(420, 20), VECTOR2D(620, 180));

    //=========================================================================
    // Section 4: Radial gradient
    //=========================================================================
    gal->SetLayerDepth(50);

    auto radial = CreateRadialBitmap(64, 64);

    gal->Save();
    gal->Translate(VECTOR2D(720, 100));
    DrawBitmapWithShaderFix(gal, *radial, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.4, 0.4, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(640, 20), VECTOR2D(800, 180));

    //=========================================================================
    // Section 5: Different bitmap sizes
    //=========================================================================
    gal->SetLayerDepth(50);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background panel
    gal->SetFillColor(COLOR4D(0.12, 0.12, 0.15, 1.0));
    gal->DrawRectangle(VECTOR2D(20, 200), VECTOR2D(380, 380));

    // Small bitmap (32x32)
    auto small = CreateCheckerboardBitmap(32, 32, 4);
    gal->Save();
    gal->Translate(VECTOR2D(80, 280));
    DrawBitmapWithShaderFix(gal, *small, 1.0);
    gal->Restore();

    // Medium bitmap (64x64)
    auto medium = CreateCheckerboardBitmap(64, 64, 8);
    gal->Save();
    gal->Translate(VECTOR2D(180, 290));
    DrawBitmapWithShaderFix(gal, *medium, 1.0);
    gal->Restore();

    // Large bitmap (96x96)
    auto large = CreateCheckerboardBitmap(96, 96, 12);
    gal->Save();
    gal->Translate(VECTOR2D(300, 290));
    DrawBitmapWithShaderFix(gal, *large, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(2.0);
    gal->SetStrokeColor(COLOR4D(0.5, 0.5, 0.4, 0.8));
    gal->DrawRectangle(VECTOR2D(20, 200), VECTOR2D(380, 380));

    //=========================================================================
    // Section 6: Striped patterns
    //=========================================================================
    gal->SetLayerDepth(50);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background panel
    gal->SetFillColor(COLOR4D(0.15, 0.12, 0.12, 1.0));
    gal->DrawRectangle(VECTOR2D(400, 200), VECTOR2D(600, 380));

    // Horizontal stripes
    auto hStripes = CreateStripedBitmap(64, 64, true);
    gal->Save();
    gal->Translate(VECTOR2D(460, 290));
    DrawBitmapWithShaderFix(gal, *hStripes, 1.0);
    gal->Restore();

    // Vertical stripes
    auto vStripes = CreateStripedBitmap(64, 64, false);
    gal->Save();
    gal->Translate(VECTOR2D(550, 290));
    DrawBitmapWithShaderFix(gal, *vStripes, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.5, 0.4, 0.4, 0.8));
    gal->DrawRectangle(VECTOR2D(400, 200), VECTOR2D(600, 380));

    //=========================================================================
    // Section 7: Multiple bitmaps composition - colored checkerboards
    //=========================================================================
    gal->SetLayerDepth(50);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background panel
    gal->SetFillColor(COLOR4D(0.12, 0.15, 0.15, 1.0));
    gal->DrawRectangle(VECTOR2D(620, 200), VECTOR2D(800, 380));

    // Create a variety of colored checkerboards in a grid
    wxImage img1 = CreateCheckerboardImage(40, 40, 5, 255, 200, 200, 100, 50, 50);
    wxImage img2 = CreateCheckerboardImage(40, 40, 5, 200, 255, 200, 50, 100, 50);
    wxImage img3 = CreateCheckerboardImage(40, 40, 5, 200, 200, 255, 50, 50, 100);
    wxImage img4 = CreateCheckerboardImage(40, 40, 5, 255, 255, 200, 100, 100, 50);

    auto bmp1 = std::make_unique<BITMAP_BASE>(); bmp1->SetImage(img1);
    auto bmp2 = std::make_unique<BITMAP_BASE>(); bmp2->SetImage(img2);
    auto bmp3 = std::make_unique<BITMAP_BASE>(); bmp3->SetImage(img3);
    auto bmp4 = std::make_unique<BITMAP_BASE>(); bmp4->SetImage(img4);

    gal->Save();
    gal->Translate(VECTOR2D(670, 260));
    DrawBitmapWithShaderFix(gal, *bmp1, 1.0);
    gal->Restore();

    gal->Save();
    gal->Translate(VECTOR2D(750, 260));
    DrawBitmapWithShaderFix(gal, *bmp2, 1.0);
    gal->Restore();

    gal->Save();
    gal->Translate(VECTOR2D(670, 330));
    DrawBitmapWithShaderFix(gal, *bmp3, 1.0);
    gal->Restore();

    gal->Save();
    gal->Translate(VECTOR2D(750, 330));
    DrawBitmapWithShaderFix(gal, *bmp4, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.4, 0.5, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(620, 200), VECTOR2D(800, 380));

    //=========================================================================
    // Section 8: Bitmap with surrounding graphics
    //=========================================================================
    gal->SetLayerDepth(50);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background panel
    gal->SetFillColor(COLOR4D(0.1, 0.12, 0.15, 1.0));
    gal->DrawRectangle(VECTOR2D(20, 400), VECTOR2D(400, 580));

    // Central bitmap
    auto central = CreateKiCadLogoBitmap(100, 100);
    gal->Save();
    gal->Translate(VECTOR2D(210, 490));
    DrawBitmapWithShaderFix(gal, *central, 1.0);
    gal->Restore();

    // Decorative circles around bitmap
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(2.0);

    COLOR4D circleColors[] = {
        COLOR4D(0.9, 0.4, 0.4, 0.7),
        COLOR4D(0.4, 0.9, 0.4, 0.7),
        COLOR4D(0.4, 0.4, 0.9, 0.7),
        COLOR4D(0.9, 0.9, 0.4, 0.7)
    };

    for (int i = 0; i < 4; i++) {
        gal->SetStrokeColor(circleColors[i]);
        double angle = i * M_PI / 2;
        double cx = 210 + cos(angle) * 80;
        double cy = 490 + sin(angle) * 80;
        gal->DrawCircle(VECTOR2D(cx, cy), 15);
    }

    // Connecting lines
    gal->SetLineWidth(1.5);
    gal->SetStrokeColor(COLOR4D(0.6, 0.6, 0.7, 0.5));
    for (int i = 0; i < 4; i++) {
        double angle1 = i * M_PI / 2;
        double angle2 = ((i + 1) % 4) * M_PI / 2;
        VECTOR2D p1(210 + cos(angle1) * 80, 490 + sin(angle1) * 80);
        VECTOR2D p2(210 + cos(angle2) * 80, 490 + sin(angle2) * 80);
        gal->DrawLine(p1, p2);
    }

    // Section frame
    gal->SetLineWidth(2.0);
    gal->SetStrokeColor(COLOR4D(0.4, 0.4, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(20, 400), VECTOR2D(400, 580));

    //=========================================================================
    // Section 9: Gradient showcase
    //=========================================================================
    gal->SetLayerDepth(50);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Background panel
    gal->SetFillColor(COLOR4D(0.12, 0.1, 0.12, 1.0));
    gal->DrawRectangle(VECTOR2D(420, 400), VECTOR2D(800, 580));

    // Horizontal gradient
    wxImage hGradImg = CreateGradientHImage(100, 40, 255, 100, 100, 100, 100, 255);
    auto hGradBitmap = std::make_unique<BITMAP_BASE>();
    hGradBitmap->SetImage(hGradImg);
    gal->Save();
    gal->Translate(VECTOR2D(520, 450));
    DrawBitmapWithShaderFix(gal, *hGradBitmap, 1.0);
    gal->Restore();

    // Vertical gradient
    wxImage vGradImg = CreateGradientVImage(100, 40, 100, 255, 100, 100, 100, 255);
    auto vGradBitmap = std::make_unique<BITMAP_BASE>();
    vGradBitmap->SetImage(vGradImg);
    gal->Save();
    gal->Translate(VECTOR2D(520, 510));
    DrawBitmapWithShaderFix(gal, *vGradBitmap, 1.0);
    gal->Restore();

    // Radial gradient (larger)
    wxImage radialImg = CreateRadialGradientImage(80, 80, 255, 255, 100, 100, 50, 150);
    auto radialBitmap = std::make_unique<BITMAP_BASE>();
    radialBitmap->SetImage(radialImg);
    gal->Save();
    gal->Translate(VECTOR2D(700, 490));
    DrawBitmapWithShaderFix(gal, *radialBitmap, 1.0);
    gal->Restore();

    // Section frame
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetStrokeColor(COLOR4D(0.5, 0.4, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(420, 400), VECTOR2D(800, 580));
}

}  // namespace GALTest
