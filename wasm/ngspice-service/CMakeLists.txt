# ngspice_service — ngspice's sharedspice engine as a standalone emscripten
# module run in a dedicated Web Worker (the SPICE analog of wasm/occ-service).
# The eeschema simulator drives it over postMessage RPC via the sharedspice
# client stub (wasm/stubs/sharedspice_client.cpp); the editor bundle links no
# ngspice code at all.
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
project( ngspice_service CXX )

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

set( NGSPICE_LIB_DIR "${NGSPICE_SYSROOT}/lib" )
set( NGSPICE_CM_DIR "${NGSPICE_SYSROOT}/lib/ngspice" )

add_executable( ngspice_service ngspice_service_main.cpp )

target_include_directories( ngspice_service PRIVATE "${NGSPICE_SYSROOT}/include" )

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

# spinit is embedded at the path main() points SPICE_LIB_DIR at, so ngspice's
# own init (incl. the `codemodel .../<cm>.cm` lines the registry resolves by
# basename) runs identically to a native install regardless of the prefix the
# dep build happened to use.
set_target_properties( ngspice_service PROPERTIES
    LINK_FLAGS "-O2 -g0 --bind -pthread ${NGSPICE_EH_FLAGS} -sMODULARIZE=1 -sEXPORT_NAME=NgspiceService -sENVIRONMENT=worker,node -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sPTHREAD_POOL_SIZE=4 -sPTHREAD_POOL_SIZE_STRICT=0 -sPTHREAD_POOL_DELAY_LOAD=1 -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB --embed-file ${NGSPICE_SYSROOT}/share/ngspice/scripts/spinit@/ngspice/scripts/spinit" )
