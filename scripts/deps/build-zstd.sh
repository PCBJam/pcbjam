#!/bin/bash
# Build Zstd for WebAssembly
# Zstd is used for compression in KiCad project files

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

ZSTD_DIR="${DEPS_ROOT}/zstd-${ZSTD_VERSION}"
ZSTD_BUILD="${BUILD_ROOT}/deps/zstd"
ZSTD_STAMP="${BUILD_ROOT}/stamps/zstd.stamp"

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
    log_info "Cleaning Zstd build..."
    rm -rf "${ZSTD_BUILD}" "${ZSTD_STAMP}"
fi

# Check if already built
if check_stamp "${ZSTD_STAMP}"; then
    log_info "Zstd already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${ZSTD_DIR}" ]; then
    log_info "Downloading Zstd ${ZSTD_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    ZSTD_URL="https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz"
    download_file "${ZSTD_URL}" "zstd-${ZSTD_VERSION}.tar.gz" "${ZSTD_SHA256}"
    tar -xzf "zstd-${ZSTD_VERSION}.tar.gz"
    rm "zstd-${ZSTD_VERSION}.tar.gz"
fi

log_info "Building Zstd ${ZSTD_VERSION} for WASM..."

mkdir -p "${ZSTD_BUILD}"
cd "${ZSTD_BUILD}"

# Zstd uses CMake in build/cmake directory
emcmake cmake "${ZSTD_DIR}/build/cmake" \
    -DCMAKE_BUILD_TYPE=${BUILD_TYPE:-Debug} \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT}" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DZSTD_BUILD_PROGRAMS=OFF \
    -DZSTD_BUILD_TESTS=OFF \
    -DZSTD_BUILD_SHARED=OFF \
    -DZSTD_BUILD_STATIC=ON \
    -DZSTD_MULTITHREAD_SUPPORT=ON \
    -DCMAKE_C_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory" \
    -DCMAKE_CXX_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory"

emmake make -j${JOBS}
emmake make install

create_stamp "${ZSTD_STAMP}"
log_info "Zstd build complete!"
