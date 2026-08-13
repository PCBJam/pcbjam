# FindZLIB.cmake - WASM builds use Emscripten's zlib port
# Emscripten provides zlib via -sUSE_ZLIB=1 flag

if(EMSCRIPTEN)
    message(STATUS "Using Emscripten's zlib port (-sUSE_ZLIB=1)")

    # Find the Emscripten cache sysroot
    execute_process(
        COMMAND em-config CACHE
        OUTPUT_VARIABLE EMSCRIPTEN_CACHE
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )

    # Set ZLIB variables
    set(ZLIB_FOUND TRUE)
    set(ZLIB_INCLUDE_DIR "${EMSCRIPTEN_CACHE}/sysroot/include")
    set(ZLIB_INCLUDE_DIRS "${ZLIB_INCLUDE_DIR}")

    # The library will be linked via -sUSE_ZLIB=1
    # We set a placeholder for CMake checks
    set(ZLIB_LIBRARY "-sUSE_ZLIB=1")
    set(ZLIB_LIBRARIES "-sUSE_ZLIB=1")
    set(ZLIB_VERSION_STRING "1.3.1")

    # Create imported target
    if(NOT TARGET ZLIB::ZLIB)
        add_library(ZLIB::ZLIB INTERFACE IMPORTED)

        # The Emscripten compiler already searches its C sysroot.  Do not
        # publish that directory as an explicit SYSTEM include.  Clang places
        # an explicit system directory before libc++'s implicit C++ wrapper
        # directory.  A forced C++ header can then resolve <stddef.h> (and the
        # other C compatibility headers) to the raw C header instead of the
        # libc++ wrapper.  The result is a target-dependent compile failure in
        # consumers such as the static WASM VRML plug-in.
        set_target_properties(ZLIB::ZLIB PROPERTIES
            INTERFACE_LINK_LIBRARIES "-sUSE_ZLIB=1"
        )
    endif()

    mark_as_advanced(ZLIB_INCLUDE_DIR ZLIB_LIBRARY)
else()
    # For non-WASM builds, use the system FindZLIB
    include(${CMAKE_ROOT}/Modules/FindZLIB.cmake OPTIONAL)
endif()
