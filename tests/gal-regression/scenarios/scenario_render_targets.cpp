/**
 * Render Targets Scenario
 *
 * Tests GAL render target concepts:
 * - SetTarget() / GetTarget()
 * - ClearTarget()
 * - HasTarget()
 *
 * NOTE: In this test harness context, we don't switch targets mid-frame
 * as that requires specific compositor setup. Instead, we demonstrate
 * the concept visually and test the API availability.
 *
 * RENDER_TARGET values:
 * - TARGET_CACHED: Main rendering target (persistent)
 * - TARGET_NONCACHED: Auxiliary target (cleared each frame)
 * - TARGET_OVERLAY: Overlay items (cleared each frame)
 * - TARGET_TEMP: Temporary target for special operations
 */

#include <gal/graphics_abstraction_layer.h>
#include <gal/definitions.h>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace GALTest {

using KIGFX::COLOR4D;
using KIGFX::GAL;
using KIGFX::RENDER_TARGET;
using KIGFX::TARGET_CACHED;
using KIGFX::TARGET_NONCACHED;
using KIGFX::TARGET_OVERLAY;
using KIGFX::TARGET_TEMP;

void RenderRenderTargets(GAL* gal, int width, int height) {
    // All drawing to the default target (NONCACHED in test harness)

    // Background grid
    gal->SetLayerDepth(100);
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.2, 0.2, 0.25, 0.4));

    for (int x = 0; x < width; x += 30) {
        gal->DrawLine(VECTOR2D(x, 0), VECTOR2D(x, height));
    }
    for (int y = 0; y < height; y += 30) {
        gal->DrawLine(VECTOR2D(0, y), VECTOR2D(width, y));
    }

    // Visual representation of render target concept
    // Show boxes representing each target type

    double boxW = 160;
    double boxH = 200;
    double startX = 40;
    double startY = 50;
    double spacing = 180;

    // Box 1: CACHED (persistent content)
    gal->SetLayerDepth(70);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);
    gal->SetFillColor(COLOR4D(0.15, 0.3, 0.15, 1.0));
    gal->DrawRectangle(VECTOR2D(startX, startY), VECTOR2D(startX + boxW, startY + boxH));

    // Static PCB elements (what would go in cached)
    gal->SetLayerDepth(60);
    gal->SetFillColor(COLOR4D(0.7, 0.5, 0.2, 1.0));
    gal->DrawSegment(VECTOR2D(startX + 20, startY + 50), VECTOR2D(startX + boxW - 20, startY + 50), 6);
    gal->DrawSegment(VECTOR2D(startX + 20, startY + 100), VECTOR2D(startX + boxW - 20, startY + 100), 6);
    gal->DrawSegment(VECTOR2D(startX + 20, startY + 150), VECTOR2D(startX + boxW - 20, startY + 150), 6);

    gal->SetFillColor(COLOR4D(0.8, 0.6, 0.3, 1.0));
    gal->DrawCircle(VECTOR2D(startX + 40, startY + 50), 12);
    gal->DrawCircle(VECTOR2D(startX + boxW - 40, startY + 50), 12);
    gal->DrawCircle(VECTOR2D(startX + 40, startY + 100), 12);
    gal->DrawCircle(VECTOR2D(startX + boxW - 40, startY + 100), 12);
    gal->DrawCircle(VECTOR2D(startX + 40, startY + 150), 12);
    gal->DrawCircle(VECTOR2D(startX + boxW - 40, startY + 150), 12);

    // Frame
    gal->SetLayerDepth(50);
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(3.0);
    gal->SetStrokeColor(COLOR4D(0.3, 0.6, 0.3, 1.0));
    gal->DrawRectangle(VECTOR2D(startX, startY), VECTOR2D(startX + boxW, startY + boxH));

    // Label
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.5, 0.8, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(startX + 20, startY + boxH + 10), VECTOR2D(startX + boxW - 20, startY + boxH + 25));

    // Box 2: NONCACHED (dynamic content)
    double box2X = startX + spacing;
    gal->SetLayerDepth(70);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);
    gal->SetFillColor(COLOR4D(0.3, 0.25, 0.1, 1.0));
    gal->DrawRectangle(VECTOR2D(box2X, startY), VECTOR2D(box2X + boxW, startY + boxH));

    // Dynamic elements (selection highlights, moving items)
    gal->SetLayerDepth(60);
    gal->SetFillColor(COLOR4D(1.0, 1.0, 0.2, 0.4));
    gal->DrawRectangle(VECTOR2D(box2X + 30, startY + 40), VECTOR2D(box2X + boxW - 30, startY + 80));

    gal->SetFillColor(COLOR4D(0.2, 0.8, 0.2, 0.6));
    gal->DrawRectangle(VECTOR2D(box2X + 50, startY + 90), VECTOR2D(box2X + boxW - 50, startY + 140));

    // Movement arrows
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(2.0);
    gal->SetStrokeColor(COLOR4D(1.0, 0.5, 0.0, 0.8));
    gal->DrawLine(VECTOR2D(box2X + 80, startY + 160), VECTOR2D(box2X + 80, startY + 180));
    gal->DrawLine(VECTOR2D(box2X + 80, startY + 180), VECTOR2D(box2X + 70, startY + 170));
    gal->DrawLine(VECTOR2D(box2X + 80, startY + 180), VECTOR2D(box2X + 90, startY + 170));

    // Frame
    gal->SetLayerDepth(50);
    gal->SetLineWidth(3.0);
    gal->SetStrokeColor(COLOR4D(0.8, 0.7, 0.2, 1.0));
    gal->DrawRectangle(VECTOR2D(box2X, startY), VECTOR2D(box2X + boxW, startY + boxH));

    // Label
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.9, 0.8, 0.3, 0.8));
    gal->DrawRectangle(VECTOR2D(box2X + 20, startY + boxH + 10), VECTOR2D(box2X + boxW - 20, startY + boxH + 25));

    // Box 3: OVERLAY (crosshairs, measurements)
    double box3X = startX + spacing * 2;
    gal->SetLayerDepth(70);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);
    gal->SetFillColor(COLOR4D(0.15, 0.15, 0.25, 1.0));
    gal->DrawRectangle(VECTOR2D(box3X, startY), VECTOR2D(box3X + boxW, startY + boxH));

    // Crosshair overlay
    gal->SetLayerDepth(60);
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(1.0, 1.0, 1.0, 0.8));
    double crossX = box3X + boxW / 2;
    double crossY = startY + boxH / 2;
    gal->DrawLine(VECTOR2D(box3X + 10, crossY), VECTOR2D(box3X + boxW - 10, crossY));
    gal->DrawLine(VECTOR2D(crossX, startY + 10), VECTOR2D(crossX, startY + boxH - 10));

    // Measurement line
    gal->SetStrokeColor(COLOR4D(0.3, 1.0, 1.0, 0.9));
    gal->SetLineWidth(2.0);
    gal->DrawLine(VECTOR2D(box3X + 30, startY + 160), VECTOR2D(box3X + boxW - 30, startY + 160));
    gal->SetIsFill(true);
    gal->SetFillColor(COLOR4D(0.3, 1.0, 1.0, 0.9));
    gal->DrawCircle(VECTOR2D(box3X + 30, startY + 160), 4);
    gal->DrawCircle(VECTOR2D(box3X + boxW - 30, startY + 160), 4);

    // Frame
    gal->SetLayerDepth(50);
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(3.0);
    gal->SetStrokeColor(COLOR4D(0.4, 0.4, 0.8, 1.0));
    gal->DrawRectangle(VECTOR2D(box3X, startY), VECTOR2D(box3X + boxW, startY + boxH));

    // Label
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.5, 0.5, 0.9, 0.8));
    gal->DrawRectangle(VECTOR2D(box3X + 20, startY + boxH + 10), VECTOR2D(box3X + boxW - 20, startY + boxH + 25));

    // Box 4: TEMP (special operations)
    double box4X = startX + spacing * 3;
    gal->SetLayerDepth(70);
    gal->SetIsFill(true);
    gal->SetIsStroke(false);
    gal->SetFillColor(COLOR4D(0.25, 0.15, 0.25, 1.0));
    gal->DrawRectangle(VECTOR2D(box4X, startY), VECTOR2D(box4X + boxW, startY + boxH));

    // Temporary rendering (drag preview, etc)
    gal->SetLayerDepth(60);
    gal->SetFillColor(COLOR4D(0.8, 0.3, 0.8, 0.5));
    gal->DrawRectangle(VECTOR2D(box4X + 40, startY + 60), VECTOR2D(box4X + boxW - 40, startY + 120));

    // Dotted outline showing "ghost" position
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(1.0, 0.5, 1.0, 0.6));
    // Draw dashed rectangle manually
    for (int i = 0; i < 10; i++) {
        double x1 = box4X + 40 + i * 8;
        double x2 = x1 + 5;
        if (x2 > box4X + boxW - 40) x2 = box4X + boxW - 40;
        gal->DrawLine(VECTOR2D(x1, startY + 140), VECTOR2D(x2, startY + 140));
        gal->DrawLine(VECTOR2D(x1, startY + 180), VECTOR2D(x2, startY + 180));
    }

    // Frame
    gal->SetLayerDepth(50);
    gal->SetLineWidth(3.0);
    gal->SetStrokeColor(COLOR4D(0.7, 0.3, 0.7, 1.0));
    gal->DrawRectangle(VECTOR2D(box4X, startY), VECTOR2D(box4X + boxW, startY + boxH));

    // Label
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.8, 0.4, 0.8, 0.8));
    gal->DrawRectangle(VECTOR2D(box4X + 20, startY + boxH + 10), VECTOR2D(box4X + boxW - 20, startY + boxH + 25));

    // Bottom: API demonstration - HasTarget results
    double apiY = 340;
    gal->SetLayerDepth(70);

    // Check target availability (these are API calls)
    bool hasCached = gal->HasTarget(TARGET_CACHED);
    bool hasNoncached = gal->HasTarget(TARGET_NONCACHED);
    bool hasOverlay = gal->HasTarget(TARGET_OVERLAY);
    bool hasTemp = gal->HasTarget(TARGET_TEMP);

    // Show results visually
    gal->SetIsFill(true);
    gal->SetIsStroke(false);

    // Label area
    gal->SetFillColor(COLOR4D(0.15, 0.15, 0.18, 1.0));
    gal->DrawRectangle(VECTOR2D(40, apiY), VECTOR2D(760, apiY + 100));

    // Indicator for each target
    gal->SetLayerDepth(60);
    double indicatorY = apiY + 50;
    double indicatorSpacing = 180;

    // CACHED indicator
    gal->SetFillColor(hasCached ? COLOR4D(0.2, 0.9, 0.2, 1.0) : COLOR4D(0.9, 0.2, 0.2, 1.0));
    gal->DrawCircle(VECTOR2D(startX + boxW / 2, indicatorY), 15);

    // NONCACHED indicator
    gal->SetFillColor(hasNoncached ? COLOR4D(0.2, 0.9, 0.2, 1.0) : COLOR4D(0.9, 0.2, 0.2, 1.0));
    gal->DrawCircle(VECTOR2D(startX + spacing + boxW / 2, indicatorY), 15);

    // OVERLAY indicator
    gal->SetFillColor(hasOverlay ? COLOR4D(0.2, 0.9, 0.2, 1.0) : COLOR4D(0.9, 0.2, 0.2, 1.0));
    gal->DrawCircle(VECTOR2D(startX + spacing * 2 + boxW / 2, indicatorY), 15);

    // TEMP indicator
    gal->SetFillColor(hasTemp ? COLOR4D(0.2, 0.9, 0.2, 1.0) : COLOR4D(0.9, 0.2, 0.2, 1.0));
    gal->DrawCircle(VECTOR2D(startX + spacing * 3 + boxW / 2, indicatorY), 15);

    // Frame around API section
    gal->SetLayerDepth(50);
    gal->SetIsFill(false);
    gal->SetIsStroke(true);
    gal->SetLineWidth(2.0);
    gal->SetStrokeColor(COLOR4D(0.4, 0.4, 0.5, 0.8));
    gal->DrawRectangle(VECTOR2D(40, apiY), VECTOR2D(760, apiY + 100));

    // Bottom: GetTarget demonstration
    RENDER_TARGET currentTarget = gal->GetTarget();
    (void)currentTarget;  // Used - shows API works

    // Label for current target
    gal->SetLineWidth(1.0);
    gal->SetStrokeColor(COLOR4D(0.5, 0.5, 0.6, 0.8));
    gal->DrawRectangle(VECTOR2D(40, apiY + 70), VECTOR2D(300, apiY + 85));
}

}  // namespace GALTest
