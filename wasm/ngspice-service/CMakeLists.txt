# ngspice_service — ngspice's sharedspice engine as a standalone emscripten
# module run in a dedicated Web Worker (the SPICE analog of wasm/occ-service).
# The eeschema simulator drives it over postMessage RPC via the sharedspice
# client stub (wasm/stubs/sharedspice_client.cpp); the editor bundle links no
# ngspice code at all.
#
# The same module also carries the live-simulation engine (ngspice_live.cpp:
# pacing, inputs, a stream of values, code parts). A live session runs in a
# second Worker of its own and uses only the live* entry points; the simulator
# window's Worker never touches them.
#
# Unlike occ_service this module contains NO KiCad or wxWidgets code, so it is
# NOT hooked into the kicad CMake tree: it configures standalone against the
# sysroot artifacts produced by scripts/deps/build-ngspice.sh (see
# scripts/kicad/build-ngspice_service.sh).
#
# Threading: ngspice's bg_run spawns its own pthread; the module main thread
# stays free to service RPC (bg_halt, status, vector reads) mid-simulation.
# The 4MB/2MB stacks are load-bearing: ngspice's parser overflows emscripten's
# default 64KB stack (found by the Gate-1 smoke; the CIDER deck died parsing
# spinit). Nothing in the service suspends, so no JSPI.
# PTHREAD_POOL_DELAY_LOAD: boot must not block on the pool — Firefox stalls
# nested-worker spawning under multi-page pressure (the SECOND simulator
# session in an e2e run hung forever in module boot without it); bg_run's
# thread starts as soon as a pool worker lands.

cmake_minimum_required( VERSION 3.20 )
project( ngspice_service C CXX )

if( NOT EMSCRIPTEN )
    message( FATAL_ERROR "ngspice_service is an emscripten-only target (use emcmake)" )
endif()

if( NOT NGSPICE_SYSROOT )
    message( FATAL_ERROR "pass -DNGSPICE_SYSROOT=<build-wasm/sysroot> (run scripts/deps/build-ngspice.sh first)" )
endif()

# The exception model must match the objects in libngspice.a (DEPS_EH_FLAGS
# from scripts/common/env.sh: wasm EH + wasm setjmp/longjmp — sharedspice's
# error recovery longjmps through errbufm/errbufc). Passed by
# scripts/kicad/build-ngspice_service.sh.
if( NOT NGSPICE_EH_FLAGS )
    message( FATAL_ERROR "pass -DNGSPICE_EH_FLAGS=\"\${DEPS_EH_FLAGS}\" (see scripts/common/env.sh)" )
endif()
separate_arguments( NGSPICE_EH_FLAGS_LIST UNIX_COMMAND "${NGSPICE_EH_FLAGS}" )

# The dep build's "code model kit" in the sysroot: ngspice's headers and its
# build-host tool cmpp, neither of which ngspice installs. Everything this
# module needs of ngspice is in the sysroot; the dep's source and build folders
# are not used (CI restores the sysroot only).
set( NGSPICE_CM_KIT "${NGSPICE_SYSROOT}/lib/ngspice/cm-kit" )
set( NGSPICE_CMPP "${NGSPICE_CM_KIT}/cmpp" )
if( NOT EXISTS "${NGSPICE_CMPP}" OR NOT EXISTS "${NGSPICE_CM_KIT}/include/ngspice/cosim.h" )
    message( FATAL_ERROR "the sysroot has no ngspice code model kit (${NGSPICE_CM_KIT}): run scripts/deps/build-ngspice.sh" )
endif()

# ngspice_live.cpp speaks ngspice's co-simulation contract (d_cosim). Take that
# one header from the kit into the build folder; the rest of ngspice's headers
# stay off the include path of the C++ sources.
configure_file( "${NGSPICE_CM_KIT}/include/ngspice/cosim.h"
                "${CMAKE_BINARY_DIR}/ngspice-headers/ngspice/cosim.h" COPYONLY )

set( NGSPICE_LIB_DIR "${NGSPICE_SYSROOT}/lib" )
set( NGSPICE_CM_DIR "${NGSPICE_SYSROOT}/lib/ngspice" )

add_executable( ngspice_service ngspice_service_main.cpp ngspice_live.cpp )

# Our own code models (codemodel/): the "voltage tap" a live session's parts
# read voltages through (see ngspice_live.cpp). A code model is two description
# files that ngspice's own tool, cmpp, turns into C. cmpp and the headers the
# generated C compiles against come from the code model kit. Nothing of ngspice
# is changed. These headers stay off the include path of the two C++ sources
# above.

set( PJCM_SRC "${CMAKE_CURRENT_SOURCE_DIR}/codemodel" )
set( PJCM_OUT "${CMAKE_BINARY_DIR}/pjcm" )
file( STRINGS "${PJCM_SRC}/pjcm/modpath.lst" PJCM_MODELS )

# the tables of the library: which models it holds
set( PJCM_LISTS "${PJCM_OUT}/cmextrn.h" "${PJCM_OUT}/cminfo.h" "${PJCM_OUT}/udnextrn.h" "${PJCM_OUT}/udninfo.h" )
set( PJCM_LIST_DEPENDS "${PJCM_SRC}/pjcm/modpath.lst" "${PJCM_SRC}/pjcm/udnpath.lst" )
set( PJCM_GENERATED "" )

foreach( model ${PJCM_MODELS} )
    file( MAKE_DIRECTORY "${PJCM_OUT}/${model}" )
    add_custom_command(
        OUTPUT "${PJCM_OUT}/${model}/ifspec.c" "${PJCM_OUT}/${model}/cfunc.c"
        COMMAND ${CMAKE_COMMAND} -E env "CMPP_IDIR=${PJCM_SRC}/pjcm/${model}" "CMPP_ODIR=${PJCM_OUT}/${model}" "${NGSPICE_CMPP}" -ifs
        COMMAND ${CMAKE_COMMAND} -E env "CMPP_IDIR=${PJCM_SRC}/pjcm/${model}" "CMPP_ODIR=${PJCM_OUT}/${model}" "${NGSPICE_CMPP}" -mod
        DEPENDS "${PJCM_SRC}/pjcm/${model}/ifspec.ifs" "${PJCM_SRC}/pjcm/${model}/cfunc.mod"
        COMMENT "cmpp: code model ${model}"
        VERBATIM )
    list( APPEND PJCM_GENERATED "${PJCM_OUT}/${model}/ifspec.c" "${PJCM_OUT}/${model}/cfunc.c" )
    list( APPEND PJCM_LIST_DEPENDS "${PJCM_SRC}/pjcm/${model}/ifspec.ifs" )
endforeach()

add_custom_command(
    OUTPUT ${PJCM_LISTS}
    COMMAND ${CMAKE_COMMAND} -E env "CMPP_IDIR=${PJCM_SRC}/pjcm" "CMPP_ODIR=${PJCM_OUT}" "${NGSPICE_CMPP}" -lst
    DEPENDS ${PJCM_LIST_DEPENDS}
    COMMENT "cmpp: the list of our code models"
    VERBATIM )

add_library( pjcm OBJECT ${PJCM_GENERATED} "${PJCM_SRC}/pj_tables.c" ${PJCM_LISTS} )
target_include_directories( pjcm PRIVATE
    "${NGSPICE_CM_KIT}/include"
    "${PJCM_OUT}" )
# the flags the code models of ngspice itself are compiled with (scripts/deps/build-ngspice.sh)
target_compile_definitions( pjcm PRIVATE NGCM_STATIC )
target_compile_options( pjcm PRIVATE -std=gnu11 -pthread ${NGSPICE_EH_FLAGS_LIST} )
target_sources( ngspice_service PRIVATE $<TARGET_OBJECTS:pjcm> )

target_include_directories( ngspice_service PRIVATE
    "${NGSPICE_SYSROOT}/include"
    "${CMAKE_BINARY_DIR}/ngspice-headers" )

# The sysroot libngspice.a is built with XSPICE; sharedspice.h guards the
# XSPICE-only declarations (ngCM_Input_Path & co.) behind this define.
target_compile_definitions( ngspice_service PRIVATE XSPICE )

# -pthread at COMPILE stage too (atomics/bulk-memory object features must
# match --shared-memory at link).
target_compile_options( ngspice_service PRIVATE -pthread ${NGSPICE_EH_FLAGS_LIST} )

# The .cm archives resolve through the static code-model registry appended to
# dev.c (its extern table references pull each archive's tables member, which
# pulls that model's cfunc/ifspec objects); ngcm_common.a carries the shared
# dlmain utility tail + tline commons. lld's implicit group semantics handle
# the cm -> core back-references.
target_link_libraries( ngspice_service PRIVATE
    "${NGSPICE_LIB_DIR}/libngspice.a"
    "${NGSPICE_CM_DIR}/analog.cm"
    "${NGSPICE_CM_DIR}/digital.cm"
    "${NGSPICE_CM_DIR}/spice2poly.cm"
    "${NGSPICE_CM_DIR}/table.cm"
    "${NGSPICE_CM_DIR}/tlines.cm"
    "${NGSPICE_CM_DIR}/xtradev.cm"
    "${NGSPICE_CM_DIR}/xtraevt.cm"
    "${NGSPICE_CM_DIR}/ngcm_common.a"
    )

# --wrap: ngspice's d_cosim loads a code part with dlopen/dlsym/dlclose/dlerror.
# ngspice_live.cpp answers those four calls for a live session and hands every
# other call on to the C library's own (__real_*), so the simulator window's
# Worker behaves exactly as without them.
#
# spinit is embedded at the path main() points SPICE_LIB_DIR at, so ngspice's
# own init (incl. the `codemodel .../<cm>.cm` lines the registry resolves by
# basename) runs identically to a native install regardless of the prefix the
# dep build happened to use.
set_target_properties( ngspice_service PROPERTIES
    LINK_FLAGS "-O2 -g0 --bind -pthread ${NGSPICE_EH_FLAGS} -Wl,--wrap=dlopen -Wl,--wrap=dlsym -Wl,--wrap=dlclose -Wl,--wrap=dlerror -sMODULARIZE=1 -sEXPORT_NAME=NgspiceService -sENVIRONMENT=worker,node -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sPTHREAD_POOL_SIZE=4 -sPTHREAD_POOL_SIZE_STRICT=0 -sPTHREAD_POOL_DELAY_LOAD=1 -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB --embed-file ${NGSPICE_SYSROOT}/share/ngspice/scripts/spinit@/ngspice/scripts/spinit" )
