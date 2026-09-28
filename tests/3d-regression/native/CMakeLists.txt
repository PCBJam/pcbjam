# Native golden-baseline generator for the 3D-renderer regression suite.
# Compiles REAL KiCad 3D-viewer sources against desktop OpenGL (macOS 2.1
# compatibility context via the vendored glad loader — no GLEW).
# Modeled on tests/gal-regression/native/CMakeLists.txt.

cmake_minimum_required(VERSION 3.16)
project(scene3d_native_test)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE)
    add_compile_definitions(GL_SILENCE_DEPRECATION)
endif()

# KiCad builds clipper2 with USINGZ (PUBLIC), so every TU touching clipper
# types must agree.
add_compile_definitions(USINGZ)

# System wxWidgets (homebrew)
set(wxWidgets_CONFIG_EXECUTABLE "/opt/homebrew/bin/wx-config")
find_package(wxWidgets REQUIRED COMPONENTS core base gl)
include(${wxWidgets_USE_FILE})

# OpenGL.framework provides GL and GLU on macOS
find_package(OpenGL REQUIRED)

# KiCad source root
set(KICAD_ROOT ${CMAKE_SOURCE_DIR}/../../../kicad)

# Vendored glad loader (the fork's kicad_gl/kiglad.h routes to it natively)
set(GLAD_SOURCES ${KICAD_ROOT}/thirdparty/glad/src/gl.c)

# Real KiCad 3D-viewer TUs — Stage 1 (standalone, no RENDER_3D_OPENGL members).
# Stage 2 adds render_3d_opengl.cpp / create_scene.cpp + the board_adapter /
# settings test impls (see the suite README).
set(KICAD_3D_SOURCES
    ${KICAD_ROOT}/3d-viewer/common_ogl/ogl_utils.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/image.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/buffers_debug.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/color_rgba.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/track_ball.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/trackball.cpp
    ${KICAD_ROOT}/common/gal/3d/camera.cpp
    # display lists / plates / stencil subtraction
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/layer_triangles.cpp
    # immediate-mode helpers (arrows, segments, bbox, half-cylinder)
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/opengl_utils.cpp
    # 3D model VBO path + navigator gizmo
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/3d_model.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/3d_spheres_gizmo.cpp
    # shapes2D objects the scenarios construct (ROUND_SEGMENT_2D et al.)
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/ray.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/accelerators/container_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/object_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/bbox_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/round_segment_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/filled_circle_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes3D/bbox_3d.cpp
    # kimath bits the above reference (RotatePoint in DrawHalfOpenCylinder)
    ${KICAD_ROOT}/libs/kimath/src/trigo.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/eda_angle.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/seg.cpp
    ${KICAD_ROOT}/libs/kimath/src/math/util.cpp

    # ---- Stage 2: RENDER_3D_OPENGL itself ----
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/render_3d_opengl.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/opengl/create_scene.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/render_3d_base.cpp
    # remaining shapes2D types the generators take as inputs
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/ring_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/triangle_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/4pt_polygon_2d.cpp
    ${KICAD_ROOT}/3d-viewer/3d_rendering/raytracing/shapes2D/polygon_2d.cpp
    # kimath polygon set + triangulation (createBoard/generateLayerList)
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_poly_set.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_line_chain.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_arc.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/vertex_set.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/geometry_utils.cpp
    ${KICAD_ROOT}/libs/kimath/src/convert_basic_shapes_to_polygon.cpp
    ${KICAD_ROOT}/libs/kimath/src/md5_hash.cpp
    ${KICAD_ROOT}/libs/kimath/src/bezier_curves.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/circle.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/arc_chord_params.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/corner_operations.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_collisions.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_compound.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_rect.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_nearest_points.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/half_line.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_utils.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/roundrect.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/line.cpp
    ${KICAD_ROOT}/libs/kimath/src/geometry/shape_segment.cpp
    ${KICAD_ROOT}/libs/kimath/src/math/vector2.cpp
    # small common/core TUs referenced by the render TUs
    ${KICAD_ROOT}/common/layer_id.cpp
    ${KICAD_ROOT}/common/gal/color4d.cpp
    ${KICAD_ROOT}/common/kicad_gl/gl_context_mgr.cpp
    ${KICAD_ROOT}/common/lset.cpp
    ${KICAD_ROOT}/libs/core/utf8.cpp
    # vendored clipper2 (SHAPE_POLY_SET booleans)
    ${KICAD_ROOT}/thirdparty/clipper2/Clipper2Lib/src/clipper.engine.cpp
    ${KICAD_ROOT}/thirdparty/clipper2/Clipper2Lib/src/clipper.offset.cpp
    ${KICAD_ROOT}/thirdparty/clipper2/Clipper2Lib/src/clipper.rectclip.cpp
)

set(SCENARIO_SOURCES
    ${CMAKE_SOURCE_DIR}/../scenarios/scene3d_test_scenarios.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scene3d_test_ctx.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/test_board_data.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_tier1_utils.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_tier1_tdl.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_tier1_model.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_tier2_generators.cpp
    ${CMAKE_SOURCE_DIR}/../scenarios/scenario_tier3_composite.cpp
)

add_executable(scene3d_native_test
    scene3d_native_test.cpp
    fbo_capture.cpp
    kicad_stubs_3d.cpp
    board_adapter_test_impl.cpp
    settings_3d_stub.cpp
    render3d_test_accessor.cpp
    ${SCENARIO_SOURCES}
    ${KICAD_3D_SOURCES}
    ${GLAD_SOURCES}
)

target_include_directories(scene3d_native_test PRIVATE
    ${CMAKE_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/../scenarios

    # KiCad includes
    ${KICAD_ROOT}/include              # kicad_gl/, gal/3d/camera.h, plugins/3dapi/
    ${KICAD_ROOT}/3d-viewer            # "3d_rendering/...", common_ogl/, 3d_math.h
    ${KICAD_ROOT}/3d-viewer/3d_rendering  # trackball.cpp does #include <trackball.h>
    ${KICAD_ROOT}/3d-viewer/3d_viewer     # create_scene.cpp: <eda_3d_viewer_frame.h>
    ${KICAD_ROOT}/pcbnew               # pad.h et al. (Stage 2 headers)
    ${KICAD_ROOT}/common

    # KiCad libs
    ${KICAD_ROOT}/libs/kimath/include
    ${KICAD_ROOT}/libs/core/include

    # KiCad thirdparty
    ${KICAD_ROOT}/thirdparty/glad/include
    ${KICAD_ROOT}/thirdparty/clipper2/Clipper2Lib/include
    ${KICAD_ROOT}/thirdparty/dynamic_bitset
    ${KICAD_ROOT}/thirdparty/rtree            # geometry/rtree.h (shape_poly_set.cpp)
    ${KICAD_ROOT}/thirdparty/magic_enum/magic_enum # magic_enum.hpp (layer_id.cpp)
    ${KICAD_ROOT}/thirdparty/expected/include # tl/expected.hpp (library_table.h)
    ${KICAD_ROOT}/thirdparty/thread-pool      # bs_thread_pool.hpp (thread_pool.h via sharded_cache.h)
    ${KICAD_ROOT}/thirdparty

    # Homebrew (glm)
    /opt/homebrew/include
)

target_link_libraries(scene3d_native_test
    ${wxWidgets_LIBRARIES}
    OpenGL::GL
)

message(STATUS "KiCad root: ${KICAD_ROOT}")
message(STATUS "Building scene3d_native_test with actual KiCad 3D-viewer sources")
