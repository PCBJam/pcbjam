#!/bin/bash
# Build HarfBuzz for WebAssembly
# HarfBuzz is used for text shaping in KiCad

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

# HarfBuzz requires FreeType
"${SCRIPT_DIR}/build-freetype.sh"

HARFBUZZ_DIR="${DEPS_ROOT}/harfbuzz-${HARFBUZZ_VERSION}"
HARFBUZZ_BUILD="${BUILD_ROOT}/deps/harfbuzz"
HARFBUZZ_STAMP="${BUILD_ROOT}/stamps/harfbuzz.stamp"

# Parse arguments
CLEAN=0
for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN=1
            shift
            ;;
    esac
done

if [ $CLEAN -eq 1 ]; then
    log_info "Cleaning HarfBuzz build..."
    rm -rf "${HARFBUZZ_BUILD}" "${HARFBUZZ_STAMP}"
fi

# Check if already built
if check_stamp "${HARFBUZZ_STAMP}"; then
    log_info "HarfBuzz already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${HARFBUZZ_DIR}" ]; then
    log_info "Downloading HarfBuzz ${HARFBUZZ_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    HARFBUZZ_URL="https://github.com/harfbuzz/harfbuzz/releases/download/${HARFBUZZ_VERSION}/harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
    download_file "${HARFBUZZ_URL}" "harfbuzz-${HARFBUZZ_VERSION}.tar.xz" "${HARFBUZZ_SHA256}"
    tar -xJf "harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
    rm "harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
fi

log_info "Building HarfBuzz ${HARFBUZZ_VERSION} for WASM..."

mkdir -p "${HARFBUZZ_BUILD}"
cd "${HARFBUZZ_BUILD}"

# HarfBuzz uses meson, but also has CMake support
emcmake cmake "${HARFBUZZ_DIR}" \
    -DCMAKE_BUILD_TYPE=${BUILD_TYPE:-Debug} \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT}" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_C_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory" \
    -DCMAKE_CXX_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory -DHB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR" \
    -DHB_HAVE_FREETYPE=ON \
    -DHB_HAVE_GLIB=OFF \
    -DHB_HAVE_ICU=OFF \
    -DHB_HAVE_GOBJECT=OFF \
    -DHB_HAVE_CAIRO=OFF \
    -DHB_BUILD_UTILS=OFF \
    -DHB_BUILD_SUBSET=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_PREFIX_PATH="${SYSROOT}" \
    -DFREETYPE_LIBRARY="${SYSROOT}/lib/libfreetype.a" \
    -DFREETYPE_INCLUDE_DIRS="${SYSROOT}/include/freetype2"

emmake make -j${JOBS}
emmake make install

create_stamp "${HARFBUZZ_STAMP}"
log_info "HarfBuzz build complete!"
