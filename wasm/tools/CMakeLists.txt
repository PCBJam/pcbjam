# Merged headless KiCad CLI (kicad_tools) — pcbjam-mcp 0001 tier 3a.
#
# ONE node-WASM executable links BOTH dieted kifaces and carries every
# sym_convert + pcb_convert subcommand:
#   kicad_tools <in.lib> <out.kicad_sym>              (legacy convert)
#   kicad_tools --lint | --erc | --netlist | --bom | --plot   (eeschema side)
#   kicad_tools --drc                                          (pcbnew side)
#
# Added from the kicad fork's top-level CMakeLists.txt via
# add_subdirectory( ${KICAD_WASM_LAYER}/tools ) when EMSCRIPTEN AND
# KICAD_TOOLS_WASM — after eeschema/ and pcbnew/, so both kifaces' CACHE
# INTERNAL library lists exist here (same pattern as wasm/editor/). The tree
# must configure with BOTH diet options ON (KICAD_SYM_CONVERTER_WASM +
# KICAD_PCB_CONVERTER_WASM — build-kicad-target.sh passes all three flags).
#
# Collision note: the merged *editor* needs KICAD_WASM_PCB_SIDE_RENAMES
# (Kiface() + dialog/tool-layer classes, audited via llvm-nm intersection).
# Under the two CLI diets every TU in that audited set is pruned on at least
# one side — neither tree even defines Kiface() — so no renames here. Re-audit
# with scripts/kicad/audit-merged-symbols.sh on kicad version bumps.
#
# The standalone sym_convert / pcb_convert targets still exist in this
# (options-ON) tree but are built from their own per-app trees as before.

include_directories( BEFORE ${INC_BEFORE} )
include_directories(
    ${CMAKE_SOURCE_DIR}/common
    ${CMAKE_SOURCE_DIR}/pcbnew
    ${INC_AFTER}
    )

add_executable( kicad_tools
    # Link-order diet stubs: listed before the kiface objects so
    # --allow-multiple-definition resolves duplicated definitions to these
    # (first definition wins) — both sides' stub sets apply.
    ${KICAD_WASM_LAYER}/cli/sym_convert_stubs.cpp
    ${KICAD_WASM_LAYER}/cli/pcb_convert_stubs.cpp
    ${KICAD_WASM_LAYER}/cli/sym_convert_main.cpp
    ${KICAD_WASM_LAYER}/cli/pcb_convert_main.cpp
    ${KICAD_WASM_LAYER}/cli/kicad_tools_main.cpp
    )

# The per-app mains compile as libraries here: KICAD_TOOLS_COMBINED renames
# their entry points (symConvertMain / pcbConvertMain) and drops their own
# main(); kicad_tools_main.cpp dispatches between them.
target_compile_definitions( kicad_tools PRIVATE KICAD_TOOLS_COMBINED )

# Both kifaces' full library sets (exported CACHE INTERNAL by pcbnew/ and
# eeschema/). The overlap (common, kicommon, gal, ...) is deduped.
set( KICAD_TOOLS_LIBS ${PCBNEW_KIFACE_LIBRARIES} ${EESCHEMA_KIFACE_LIBRARIES} )
list( REMOVE_DUPLICATES KICAD_TOOLS_LIBS )

target_link_libraries( kicad_tools PRIVATE ${KICAD_TOOLS_LIBS} )

# Same link shape as pcb_convert: allow-multiple-definition for the wx/KiCad
# dupes and --whole-archive pcbcommon so RTTI-only-referenced vtables/typeinfo
# are pulled in.
target_link_options( kicad_tools PRIVATE
    "LINKER:--allow-multiple-definition"
    "LINKER:--whole-archive"
    "$<TARGET_FILE:pcbcommon>"
    "LINKER:--no-whole-archive"
    )

# Node CLI link shape — identical rationale to sym_convert (see
# eeschema/CMakeLists.txt): real FS, auto-run main(), synchronous, no embind,
# -g0 so wasm-emscripten-finalize doesn't OOM on DWARF, undefined symbols
# become aborting JS imports (both diets leave dangling refs from
# vtable-pinned-but-never-run editor code). One pre-js copies process.env into
# the Wasm ENV. The shared pre-js backs wxConfig with an in-memory store.
set_target_properties( kicad_tools PROPERTIES
    LINK_FLAGS "-Oz -g0 --profiling-funcs -sSTACK_SIZE=2MB -sENVIRONMENT=node -sNODERAWFS=1 -sINVOKE_RUN=1 -sEXIT_RUNTIME=1 -sASYNCIFY=0 -sPTHREAD_POOL_SIZE=2 -sERROR_ON_UNDEFINED_SYMBOLS=0 --pre-js ${KICAD_WASM_LAYER}/cli/sym_convert_pre.js --pre-js ${KICAD_WASM_LAYER}/shims/in_memory_config_pre.js" )
