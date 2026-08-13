# Makefile for GAL WebGL Test (WASM)
#
# Builds WEBGL_GAL (ported from OPENGL_GAL) using wxWidgets WASM build.
# Uses pure WebGL 2.0 / OpenGL ES 3.0 (no LEGACY_GL_EMULATION).
#
# Usage:
#   make                    # Build
#   make clean              # Clean build artifacts
#   make DEBUG=1            # Debug build with source maps

CXX = em++

# Paths relative to this Makefile
PROJECT_ROOT = ../../..
KICAD_ROOT = $(PROJECT_ROOT)/kicad
WX_BUILD = $(PROJECT_ROOT)/build-wasm/wxwidgets
TOOLS_ROOT = $(PROJECT_ROOT)/wxwidgets/build/wasm

# Output directory
OUTPUT_DIR = ../../apps/gal-webgl

# wx-config for wxWidgets WASM
WXCONFIG = $(WX_BUILD)/wx-config
WX_CXXFLAGS := $(shell $(WXCONFIG) --cxxflags)
WX_LDFLAGS := $(shell $(WXCONFIG) --libs base,core,gl)

# Sysroot (contains boost, etc.)
SYSROOT = $(PROJECT_ROOT)/build-wasm/sysroot

# KiCad include paths
# Note: -I../native provides stub files (config.h, kicad_stubs.h, etc.)
# Note: -I../scenarios provides shared test scenarios (gal_test_scenarios.h)
KICAD_INCLUDES = -I../native \
                 -I../scenarios \
                 -Igenerated \
                 -I$(KICAD_ROOT)/include \
                 -I$(KICAD_ROOT)/include/gal \
                 -I$(KICAD_ROOT)/include/gal/webgl \
                 -I$(KICAD_ROOT)/common/gal/webgl \
                 -I$(KICAD_ROOT)/common \
                 -I$(KICAD_ROOT)/libs/kimath/include \
                 -I$(KICAD_ROOT)/libs/kimath/glu_tess \
                 -I$(KICAD_ROOT)/libs/kiplatform/include \
                 -I$(KICAD_ROOT)/libs/core/include \
                 -I$(KICAD_ROOT)/thirdparty/glm \
                 -I$(KICAD_ROOT)/thirdparty/nlohmann_json \
                 -I$(KICAD_ROOT)/thirdparty/thread-pool \
                 -I$(KICAD_ROOT)/thirdparty/clipper2/Clipper2Lib/include \
                 -I$(SYSROOT)/include

# Debug or Release build
ifdef DEBUG
    OPT_FLAGS = -g -O0
    DEBUG_LDFLAGS = -g -gsource-map
else
    OPT_FLAGS = -O2
    DEBUG_LDFLAGS =
endif

# Native WebAssembly exceptions. The wxWidgets libs (and KiCad) are built with
# -fwasm-exceptions (scripts/common/env.sh DEPS_EH_FLAGS), so this test must compile AND
# link the same way, or wasm-ld can't resolve __cpp_exception / __c_longjmp from the wx
# archives. ?= honors the value build-gal-webgl-test.sh exports via env.sh; the fallback
# keeps a bare `make` working.
DEPS_EH_FLAGS ?= -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1

# -MMD -MP generates .d dependency files for header tracking
# This ensures header changes trigger rebuilds (prevents stale object issues)
CXXFLAGS = $(OPT_FLAGS) $(DEPS_EH_FLAGS) $(WX_CXXFLAGS) $(KICAD_INCLUDES) -std=c++20 -MMD -MP

# Emscripten flags
BASE_LDFLAGS = $(DEPS_EH_FLAGS) \
               -sDYNCALLS=1 \
               -sASYNCIFY=1 \
               -sASYNCIFY_STACK_SIZE=65536 \
               -sASYNCIFY_IMPORTS=['emscripten_fiber_swap'] \
               -sALLOW_MEMORY_GROWTH=1 \
               -sERROR_ON_UNDEFINED_SYMBOLS=1 \
               -sEXPORTED_FUNCTIONS=['_main','_runScenario','_isGalReady','_getTotalScenarios','_getCurrentScenario','_getCanvasWidth','_getCanvasHeight'] \
               -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8'] \
               -sMODULARIZE=1 \
               -sEXPORT_NAME='createGALTest' \
               -sENVIRONMENT=web,worker

# GL-specific flags - pure WebGL 2.0 (matching KiCad PCBnew build, no FULL_ES3 emulation)
# No LEGACY_GL_EMULATION - WEBGL_GAL uses VBOs and custom shaders
EM_GL_FLAGS = -sMAX_WEBGL_VERSION=2

# Legacy GL stubs for wxWidgets compatibility
# wxWidgets GL library may reference legacy functions at runtime, but actual
# rendering uses WEBGL_GAL which only uses modern WebGL 2.0 APIs
# Use absolute path to ensure the library is found
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
LEGACY_GL_STUBS = --js-library=$(MAKEFILE_DIR)legacy_gl_stubs.js

LDFLAGS = $(DEBUG_LDFLAGS) $(BASE_LDFLAGS) $(EM_GL_FLAGS) $(LEGACY_GL_STUBS) $(WX_LDFLAGS)

# Templates
# wx-dom.js rides as a second pre-js ("--pre-js A --pre-js B" after
# expansion) — the WASM port's DOM layer is required at runtime.
JS = $(TOOLS_ROOT)/wx.js --pre-js $(TOOLS_ROOT)/wx-dom.js
HTML_TEMPLATE = $(TOOLS_ROOT)/template.html

# Source files
MAIN_SRCS = gal_webgl_test.cpp wasm_stubs.cpp

# Test scenario sources (shared with native test)
# Include ALL scenario files - they should use the abstract GAL interface only.
# The harness decides whether to use OPENGL_GAL (native) or WEBGL_GAL (wasm).
SCENARIO_SRCS = ../scenarios/gal_test_scenarios.cpp \
                $(wildcard ../scenarios/scenario_*.cpp)

# Generated shader sources (from generate_shaders.py)
# TODO: Eventually these should come from KiCad's build, but for now we generate them here
SHADER_SRCS = generated/glsl_kicad_frag.cpp \
              generated/glsl_kicad_vert.cpp \
              generated/glsl_smaa_base.cpp \
              generated/glsl_smaa_pass_1_frag_color.cpp \
              generated/glsl_smaa_pass_1_frag_luma.cpp \
              generated/glsl_smaa_pass_1_vert.cpp \
              generated/glsl_smaa_pass_2_frag.cpp \
              generated/glsl_smaa_pass_2_vert.cpp \
              generated/glsl_smaa_pass_3_frag.cpp \
              generated/glsl_smaa_pass_3_vert.cpp

# KiCad GAL sources needed for linking (base GAL classes)
KICAD_GAL_SRCS = $(KICAD_ROOT)/common/gal/hidpi_gl_canvas.cpp \
                 $(KICAD_ROOT)/common/gal/graphics_abstraction_layer.cpp \
                 $(KICAD_ROOT)/common/gal/gal_display_options.cpp

# GLU tesselator - implemented using Mapbox earcut.hpp
GLU_SRCS = $(KICAD_ROOT)/libs/kimath/glu_tess/glu_tess_impl.cpp

# WebGL GAL sources (now in kicad/common/gal/webgl/)
WEBGL_SRCS = $(KICAD_ROOT)/common/gal/webgl/webgl_gal.cpp \
             $(KICAD_ROOT)/common/gal/webgl/vertex_manager.cpp \
             $(KICAD_ROOT)/common/gal/webgl/vertex_container.cpp \
             $(KICAD_ROOT)/common/gal/webgl/vertex_item.cpp \
             $(KICAD_ROOT)/common/gal/webgl/gpu_manager.cpp \
             $(KICAD_ROOT)/common/gal/webgl/noncached_container.cpp \
             $(KICAD_ROOT)/common/gal/webgl/cached_container.cpp \
             $(KICAD_ROOT)/common/gal/webgl/cached_container_gpu.cpp \
             $(KICAD_ROOT)/common/gal/webgl/cached_container_ram.cpp \
             $(KICAD_ROOT)/common/gal/webgl/shader.cpp \
             $(KICAD_ROOT)/common/gal/webgl/webgl_compositor.cpp \
             $(KICAD_ROOT)/common/gal/webgl/fullscreen_quad.cpp \
             $(KICAD_ROOT)/common/gal/webgl/utils.cpp \
             $(KICAD_ROOT)/common/gal/webgl/gl_context_mgr.cpp \
             $(KICAD_ROOT)/common/gal/webgl/gl_resources.cpp \
             $(KICAD_ROOT)/common/gal/webgl/webgl_antialiasing.cpp

SRCS = $(MAIN_SRCS) $(KICAD_GAL_SRCS) $(SCENARIO_SRCS) $(GLU_SRCS) $(SHADER_SRCS) $(WEBGL_SRCS)
OBJS = $(SRCS:.cpp=.o)
DEPS = $(OBJS:.o=.d)

# Target
TARGET = $(OUTPUT_DIR)/gal_webgl_test.js

all: $(OUTPUT_DIR) $(TARGET)

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)

%.o: %.cpp
	$(CXX) -c $(CXXFLAGS) $< -o $@

# Link test harness (compiles WebGL sources directly from kicad/)
$(TARGET): $(OBJS)
	@echo "Linking $(words $(OBJS)) objects..."
	$(CXX) $(OBJS) $(LDFLAGS) --pre-js $(JS) -o $@
	cp gal_webgl_test.html $(OUTPUT_DIR)/

clean:
	rm -f $(OBJS) $(DEPS)
	rm -f $(OUTPUT_DIR)/gal_webgl_test.js
	rm -f $(OUTPUT_DIR)/gal_webgl_test.wasm
	rm -f $(OUTPUT_DIR)/gal_webgl_test.html
	# Also clean object files in scenario directories
	rm -f ../scenarios/*.o ../scenarios/*.d

.PHONY: all clean

# Include generated dependency files (silently ignore if missing on first build)
-include $(DEPS)
