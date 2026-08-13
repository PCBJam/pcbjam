cmake_minimum_required(VERSION 3.16)
project(gal_native_test)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Suppress deprecation warnings on macOS
if(APPLE)
    add_compile_definitions(GL_SILENCE_DEPRECATION)
endif()

# Find wxWidgets (system installation)
set(wxWidgets_CONFIG_EXECUTABLE "/opt/homebrew/bin/wx-config")
find_package(wxWidgets REQUIRED COMPONENTS core base gl)
include(${wxWidgets_USE_FILE})

# Find the platform OpenGL library. KiCad supplies its own GLAD loader.
find_package(OpenGL REQUIRED)

# KiCad source root
set(KICAD_ROOT ${CMAKE_SOURCE_DIR}/../../../kicad)

# Use the same vendored OpenGL loader as the current KiCad sources.
set(GLAD_SOURCES ${KICAD_ROOT}/thirdparty/glad/src/gl.c)

# Generated shader files
set(SHADER_SOURCES
    ${CMAKE_SOURCE_DIR}/generated/glsl_kicad_frag.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_kicad_vert.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_base.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_1_frag_color.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_1_frag_luma.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_1_vert.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_2_frag.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_2_vert.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_3_frag.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_smaa_pass_3_vert.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_xor_diff_frag.cpp
    ${CMAKE_SOURCE_DIR}/generated/glsl_xor_diff_vert.cpp
)

# KiCad OpenGL GAL sources
set(KICAD_GAL_SOURCES
    ${KICAD_ROOT}/common/gal/opengl/opengl_gal.cpp
    ${KICAD_ROOT}/common/kicad_gl/gl_context_mgr.cpp
    ${KICAD_ROOT}/common/kicad_gl/gl_utils.cpp
    ${KICAD_ROOT}/common/gal/opengl/shader.cpp
    ${KICAD_ROOT}/common/gal/opengl/vertex_manager.cpp
    ${KICAD_ROOT}/common/gal/opengl/vertex_item.cpp
    ${KICAD_ROOT}/common/gal/opengl/vertex_container.cpp
    ${KICAD_ROOT}/common/gal/opengl/cached_container.cpp
    ${KICAD_ROOT}/common/gal/opengl/cached_container_gpu.cpp
    ${KICAD_ROOT}/common/gal/opengl/cached_container_ram.cpp
    ${KICAD_ROOT}/common/gal/opengl/noncached_container.cpp
    ${KICAD_ROOT}/common/gal/opengl/gpu_manager.cpp
    ${KICAD_ROOT}/common/gal/opengl/opengl_compositor.cpp
    ${KICAD_ROOT}/common/gal/opengl/antialiasing.cpp
    ${KICAD_ROOT}/common/gal/opengl/utils.cpp
    ${KICAD_ROOT}/common/gal/opengl/gl_resources.cpp
    ${KICAD_ROOT}/common/gal/graphics_abstraction_layer.cpp
    ${KICAD_ROOT}/common/gal/color4d.cpp
    ${KICAD_ROOT}/common/gal/gal_display_options.cpp
    ${KICAD_ROOT}/common/gal/hidpi_gl_canvas.cpp
)

# Our stub and test files
set(STUB_SOURCES
    ${CMAKE_SOURCE_DIR}/kicad_stubs.cpp
    ${CMAKE_SOURCE_DIR}/gal_test_accessor.cpp
)

# Test scenario files
set(SCENARIO_SOURCES
    ${CMAKE_SOURCE_DIR}/../scenarios/gal_test_scenarios.cpp
    # New modular scenarios
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_bezier_curves.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_arc_segments.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_segment_chain.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_group_caching.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_polylines_multi.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_hole_walls.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_grid_native.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_cursor_native.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_render_targets.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_screen_transform.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_clear_colors.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_depth_testing.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_negative_mode.cpp
    # Additional scenarios (24-27)
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_text_attrs.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_glyphs.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_bitmap.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_transform.cpp
)

# Main executable
add_executable(gal_native_test
    gal_native_test.cpp
    ${STUB_SOURCES}
    ${SCENARIO_SOURCES}
    ${KICAD_GAL_SOURCES}
    ${SHADER_SOURCES}
    ${GLAD_SOURCES}
)

# Include directories - our stubs first, then KiCad, then wxWidgets
target_include_directories(gal_native_test PRIVATE
    # Our stubs (for KiCad-specific types not in wxWidgets)
    ${CMAKE_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/../scenarios
    ${CMAKE_SOURCE_DIR}/generated

    # KiCad includes
    ${KICAD_ROOT}/include
    ${KICAD_ROOT}/include/gal
    ${KICAD_ROOT}/include/gal/opengl
    ${KICAD_ROOT}/common     # For gal/opengl/antialiasing.h

    # KiCad libs
    ${KICAD_ROOT}/libs/kimath/include
    ${KICAD_ROOT}/libs/kimath/include/math
    ${KICAD_ROOT}/libs/kimath/include/geometry
    ${KICAD_ROOT}/libs/core/include

    # KiCad thirdparty
    ${KICAD_ROOT}/thirdparty/thread-pool
    ${KICAD_ROOT}/thirdparty/glad/include

    # System includes
    ${OPENGL_INCLUDE_DIR}

    # Homebrew dependencies
    /opt/homebrew/include   # nlohmann-json, clipper2
)

# Link libraries
target_link_libraries(gal_native_test
    ${wxWidgets_LIBRARIES}
    OpenGL::GL
)

# Compile definitions
target_compile_definitions(gal_native_test PRIVATE
    GAL_TEST_BUILD=1
)

message(STATUS "KiCad root: ${KICAD_ROOT}")
message(STATUS "wxWidgets libraries: ${wxWidgets_LIBRARIES}")
message(STATUS "Building GAL native test with actual KiCad OPENGL_GAL sources")
