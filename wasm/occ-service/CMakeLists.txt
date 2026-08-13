# occ_service — standalone OpenCASCADE 3D service for the browser build
# (docs/features/occ-split/): STEP/3D export and STEP/IGES model tessellation
# as a separate emscripten module run in a Web Worker, so the editor drops its
# OCC link entirely.
#
# Added from the kicad fork's top-level CMakeLists.txt via
# add_subdirectory( ${KICAD_WASM_LAYER}/occ-service ) when
# EMSCRIPTEN AND KICAD_OCC_SERVICE_WASM — after pcbnew/, so the kiface library
# list and the OCC exporter source list (both exported CACHE INTERNAL there)
# exist here. Same pattern as the merged editor (wasm/editor/CMakeLists.txt).
# Only the occ_service build tree configures with the option ON; its binary
# dir doubles as the artifact subdir (build-wasm/kicad-occ_service/occ_service/).

# Mirror the pcbnew directory scope these sources were written for: the OCC
# exporters and the service main are pcbnew-kiface code (board classes, 3d
# resolver, exporter headers). OCC headers arrive via the top-level
# include_directories( SYSTEM ${OCC_INCLUDE_DIR} ); nlohmann_json/gzip-hpp via
# their INTERFACE targets.
include_directories( BEFORE ${INC_BEFORE} )
include_directories(
    ${CMAKE_SOURCE_DIR}/pcbnew
    ${CMAKE_SOURCE_DIR}/pcbnew/dialogs
    ${CMAKE_SOURCE_DIR}/pcbnew/exporters
    ${CMAKE_SOURCE_DIR}/pcbnew/specctra_import_export
    ${CMAKE_SOURCE_DIR}/3d-viewer
    ${CMAKE_SOURCE_DIR}/common
    ${CMAKE_SOURCE_DIR}/common/dialogs
    ${CMAKE_BINARY_DIR}/pcbnew
    ${INC_AFTER}
    )

# The exporter sources expect the pcbnew compile environment.
add_compile_definitions( PCBNEW )

# The OCC exporter sources are gated out of the kiface objects for EMSCRIPTEN
# (pcbnew/CMakeLists.txt) — the service compiles the real ones itself.
add_executable( occ_service
    occ_service_main.cpp
    ${PCBNEW_OCC_EXPORTER_SRCS} )

target_link_libraries( occ_service
    PRIVATE
        ${PCBNEW_KIFACE_LIBRARIES}
        nlohmann_json
        gzip-hpp    # step_pcb_model.cpp (.stpZ/.gz) — kiface-PRIVATE, so restate
    )
# Match the editors' WASM link shape: allow benign duplicate symbols, and
# --whole-archive pcbcommon so RTTI-only-referenced vtables/typeinfo are
# pulled in.
target_link_options( occ_service PRIVATE
    "LINKER:--allow-multiple-definition"
    "LINKER:--whole-archive"
    "$<TARGET_FILE:pcbcommon>"
    "LINKER:--no-whole-archive"
    )

# Persistent worker embind module: no asyncify (neither OCC job suspends).
# -Oz at link runs wasm-opt -Oz = whole-module dead-code elimination that
# strips the unreachable editor code (same mechanism sym_convert documents
# in eeschema/CMakeLists.txt); -g0 drops debug info so in-container
# finalize doesn't OOM. MODULARIZE factory booted by the JS provider inside
# a dedicated Worker; node kept in ENVIRONMENT so unit tests can drive it.
# These override the browser-oriented values inherited from
# CMAKE_EXE_LINKER_FLAGS (notably -sASYNCIFY=1). The inherited FULL pthread
# pool ('navigator.hardwareConcurrency') is kept deliberately: the exporter
# uses GetKiCadThreadPool (step_pcb_model.cpp), and a browser cannot spawn
# workers on demand while the calling thread is blocked inside occExport —
# an undersized pool deadlocks in Chromium.
# --pre-js supplies the shared wxConfig hooks backed by an in-memory store.
set_target_properties( occ_service PROPERTIES
    LINK_FLAGS "-Oz -g0 -sASYNCIFY=0 -sMODULARIZE=1 -sEXPORT_NAME=OccService -sENVIRONMENT=worker,node -sEXIT_RUNTIME=0 --pre-js ${KICAD_WASM_LAYER}/shims/in_memory_config_pre.js" )
