# Makefile for the 3D-renderer WebGL test harness (WASM).
#
# Compiles the SAME shared scenarios + real KiCad 3D-viewer TUs as the native
# golden generator (tests/3d-regression/native/CMakeLists.txt), linking the
# fixed-function GL surface against the wasm/gl1 GL1->WebGL2 emulation layer —
# exactly how the production kicad build satisfies RENDER_3D_OPENGL's link.
# `npm run 3d:check:parity` compares the browser renders against the native
# goldens (47/47 under floor since the port).
#
# Usage:
#   make                    # Build
#   make clean              # Clean build artifacts
#   make DEBUG=1            # Debug build with source maps

CXX = em++
CC = emcc

PROJECT_ROOT = ../../..
KICAD_ROOT = $(PROJECT_ROOT)/kicad
WX_BUILD = $(PROJECT_ROOT)/build-wasm/wxwidgets

OUTPUT_DIR = ../../apps/3d-webgl

# wxWidgets WASM (the KiCad TUs reference wxString/wxLogTrace/wxASSERT).
WXCONFIG = $(WX_BUILD)/wx-config
WX_CXXFLAGS := $(shell $(WXCONFIG) --cxxflags)
WX_LDFLAGS := $(shell $(WXCONFIG) --libs base,core,gl)

# Sysroot (boost, glm, ...)
SYSROOT = $(PROJECT_ROOT)/build-wasm/sysroot

# Mirrors the include set of tests/3d-regression/native/CMakeLists.txt.
KICAD_INCLUDES = -I../native \
                 -I../scenarios \
                 -I$(KICAD_ROOT)/include \
                 -I$(KICAD_ROOT)/3d-viewer \
                 -I$(KICAD_ROOT)/3d-viewer/3d_rendering \
                 -I$(KICAD_ROOT)/3d-viewer/3d_viewer \
                 -I$(KICAD_ROOT)/pcbnew \
                 -I$(KICAD_ROOT)/common \
                 -I$(KICAD_ROOT)/libs/kimath/include \
                 -I$(KICAD_ROOT)/libs/core/include \
                 -I$(KICAD_ROOT)/thirdparty/clipper2/Clipper2Lib/include \
                 -I$(KICAD_ROOT)/thirdparty/dynamic_bitset \
                 -I$(KICAD_ROOT)/thirdparty/rtree \
                 -I$(KICAD_ROOT)/thirdparty/magic_enum/magic_enum \
                 -I$(KICAD_ROOT)/thirdparty/expected/include \
                 -I$(KICAD_ROOT)/thirdparty/nlohmann_json \
                 -I$(KICAD_ROOT)/thirdparty \
                 -I$(PROJECT_ROOT)/wasm/stubs \
                 -I$(PROJECT_ROOT)/wasm/gl1/include \
                 -I$(SYSROOT)/include

ifdef DEBUG
    OPT_FLAGS = -g -O0
    DEBUG_LDFLAGS = -g -gsource-map
else
    OPT_FLAGS = -O1
    DEBUG_LDFLAGS =
endif

# Match the wx/KiCad WASM exception model (scripts/common/env.sh DEPS_EH_FLAGS).
DEPS_EH_FLAGS ?= -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1

# USINGZ: KiCad builds clipper2 with it (PUBLIC compile definition).
CXXFLAGS = $(OPT_FLAGS) $(DEPS_EH_FLAGS) -DUSINGZ $(WX_CXXFLAGS) $(KICAD_INCLUDES) -std=c++20 -MMD -MP
CFLAGS = $(OPT_FLAGS) $(DEPS_EH_FLAGS) -I$(PROJECT_ROOT)/wasm/stubs

BASE_LDFLAGS = $(DEPS_EH_FLAGS) \
               -sALLOW_MEMORY_GROWTH=1 \
               -sERROR_ON_UNDEFINED_SYMBOLS=0 \
               -sEXPORTED_FUNCTIONS=['_main','_runScenario','_getTotalScenarios','_getScenarioName','_getCanvasWidth','_getCanvasHeight','_recreateContext','_appQuadInit','_appQuadDraw','_ffpMakeStale','_ffpClearStale','_createSecondContext','_useContext','_quadDrawFresh'] \
               -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap'] \
               -sMODULARIZE=1 \
               -sEXPORT_NAME='create3DTest' \
               -sENVIRONMENT=web,worker

# Pure WebGL 2.0 context; the FFP surface is implemented by wasm/gl1 (no
# LEGACY_GL_EMULATION), same as the production kicad_editor build.
EM_GL_FLAGS = -sMAX_WEBGL_VERSION=2

LDFLAGS = $(DEBUG_LDFLAGS) $(BASE_LDFLAGS) $(EM_GL_FLAGS) $(WX_LDFLAGS) $(GL1_WRAP_LDFLAGS)

MAIN_SRCS = 3d_webgl_test.cpp

SCENARIO_SRCS = ../scenarios/scene3d_test_scenarios.cpp \
                ../scenarios/scene3d_test_ctx.cpp \
                ../scenarios/test_board_data.cpp \
                $(wildcard ../scenarios/scenario_*.cpp)

# Test-impl TUs shared with the native harness (BOARD_ADAPTER seam, settings
# stub, link stubs, private-member accessor).
TESTIMPL_SRCS = ../native/board_adapter_test_impl.cpp \
                ../native/settings_3d_stub.cpp \
                ../native/kicad_stubs_3d.cpp \
                ../native/render3d_test_accessor.cpp

# Same real-KiCad TU list as the native CMakeLists (minus glad — Emscripten
# provides the modern GL surface, wasm/gl1 the legacy one).
KICAD_3D_SRCS = \
    $(KICAD_ROOT)/3d-viewer/common_ogl/ogl_utils.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/image.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/buffers_debug.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/color_rgba.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/track_ball.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/trackball.cpp \
    $(KICAD_ROOT)/common/gal/3d/camera.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/layer_triangles.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/opengl_utils.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/3d_model.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/3d_spheres_gizmo.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/ray.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/accelerators/container_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/object_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/bbox_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/round_segment_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/filled_circle_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes3D/bbox_3d.cpp \
    $(KICAD_ROOT)/libs/kimath/src/trigo.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/eda_angle.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/seg.cpp \
    $(KICAD_ROOT)/libs/kimath/src/math/util.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/render_3d_opengl.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/opengl/create_scene.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/render_3d_base.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/ring_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/triangle_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/4pt_polygon_2d.cpp \
    $(KICAD_ROOT)/3d-viewer/3d_rendering/raytracing/shapes2D/polygon_2d.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_poly_set.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_line_chain.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_arc.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/vertex_set.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/geometry_utils.cpp \
    $(KICAD_ROOT)/libs/kimath/src/convert_basic_shapes_to_polygon.cpp \
    $(KICAD_ROOT)/libs/kimath/src/md5_hash.cpp \
    $(KICAD_ROOT)/libs/kimath/src/bezier_curves.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/circle.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/arc_chord_params.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/corner_operations.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_collisions.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_compound.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_rect.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_nearest_points.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/half_line.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_utils.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/roundrect.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/line.cpp \
    $(KICAD_ROOT)/libs/kimath/src/geometry/shape_segment.cpp \
    $(KICAD_ROOT)/libs/kimath/src/math/vector2.cpp \
    $(KICAD_ROOT)/common/layer_id.cpp \
    $(KICAD_ROOT)/common/gal/color4d.cpp \
    $(KICAD_ROOT)/common/kicad_gl/gl_context_mgr.cpp \
    $(KICAD_ROOT)/common/lset.cpp \
    $(KICAD_ROOT)/libs/core/utf8.cpp \
    $(KICAD_ROOT)/thirdparty/clipper2/Clipper2Lib/src/clipper.engine.cpp \
    $(KICAD_ROOT)/thirdparty/clipper2/Clipper2Lib/src/clipper.offset.cpp \
    $(KICAD_ROOT)/thirdparty/clipper2/Clipper2Lib/src/clipper.rectclip.cpp

# The GL1->WebGL2 emulation layer (wasm/gl1): implements the FFP surface the
# renderer needs and --wrap-intercepts the Emscripten-owned names it must
# observe. sources.txt / wrapped_symbols.txt are shared with the production
# link site (scripts/kicad/build-kicad-target.sh).
GL1_DIR = $(PROJECT_ROOT)/wasm/gl1
GL1_SRCS := $(addprefix $(GL1_DIR)/src/,$(shell cat $(GL1_DIR)/sources.txt))

comma := ,
GL1_WRAP_LDFLAGS := $(foreach sym,$(shell cat $(GL1_DIR)/wrapped_symbols.txt),-Wl$(comma)--wrap=$(sym))

SRCS = $(MAIN_SRCS) $(SCENARIO_SRCS) $(TESTIMPL_SRCS) $(KICAD_3D_SRCS) $(GL1_SRCS)
OBJS = $(SRCS:.cpp=.o)
DEPS = $(SRCS:.cpp=.d)

TARGET = $(OUTPUT_DIR)/3d_webgl_test.js

all: $(OUTPUT_DIR) $(TARGET)

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)

%.o: %.cpp
	$(CXX) -c $(CXXFLAGS) $< -o $@

%.o: %.c
	$(CC) -c $(CFLAGS) $< -o $@

$(TARGET): $(OBJS)
	@echo "Linking $(words $(OBJS)) objects..."
	$(CXX) $(OBJS) $(LDFLAGS) -o $@
	cp 3d_webgl_test.html $(OUTPUT_DIR)/

clean:
	rm -f $(OBJS) $(DEPS)
	rm -f $(OUTPUT_DIR)/3d_webgl_test.js
	rm -f $(OUTPUT_DIR)/3d_webgl_test.wasm
	rm -f $(OUTPUT_DIR)/3d_webgl_test.html
	rm -f ../scenarios/*.o ../scenarios/*.d ../native/*.o ../native/*.d
	rm -f $(GL1_DIR)/src/*.o $(GL1_DIR)/src/*.d

.PHONY: all clean

-include $(DEPS)
