# The fallback font of the wasm FONTCONFIG (fontconfig_wasm.cpp, fonts/README.md), compiled into
# kicommon as a byte array. Included from kicad/common/CMakeLists.txt on EMSCRIPTEN.

set( PCBJAM_FALLBACK_FONT ${KICAD_WASM_LAYER}/stubs/fonts/NotoSans-Regular.ttf )
set( PCBJAM_FALLBACK_FONT_CPP ${CMAKE_CURRENT_BINARY_DIR}/pcbjam_fallback_font.cpp )

add_custom_command(
    OUTPUT ${PCBJAM_FALLBACK_FONT_CPP}
    COMMAND ${CMAKE_COMMAND}
            -DIN=${PCBJAM_FALLBACK_FONT}
            -DOUT=${PCBJAM_FALLBACK_FONT_CPP}
            -DSYMBOL=pcbjam_fallback_font
            -P ${KICAD_WASM_LAYER}/stubs/embed_bytes.cmake
    DEPENDS ${PCBJAM_FALLBACK_FONT} ${KICAD_WASM_LAYER}/stubs/embed_bytes.cmake
    COMMENT "Embedding the fallback font"
    VERBATIM )

list( APPEND KICOMMON_SRCS ${PCBJAM_FALLBACK_FONT_CPP} )
