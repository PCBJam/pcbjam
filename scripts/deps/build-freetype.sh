#!/bin/bash
# Build FreeType for WebAssembly
# FreeType is required for font rendering

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

FREETYPE_DIR="${DEPS_ROOT}/freetype-${FREETYPE_VERSION}"
FREETYPE_BUILD="${BUILD_ROOT}/deps/freetype"
FREETYPE_STAMP="${BUILD_ROOT}/stamps/freetype.stamp"

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
    log_info "Cleaning FreeType build..."
    rm -rf "${FREETYPE_BUILD}" "${FREETYPE_STAMP}"
fi

# Check if already built
if check_stamp "${FREETYPE_STAMP}"; then
    log_info "FreeType already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${FREETYPE_DIR}" ]; then
    log_info "Downloading FreeType ${FREETYPE_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    # savannah 502s regularly (took out the 2026-08-31 staging CI run); every
    # mirror must serve the byte-identical tarball — FREETYPE_SHA256 gates it.
    FREETYPE_URLS=(
        "https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
        "https://download-mirror.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
        "https://downloads.sourceforge.net/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
    )
    downloaded=0
    for FREETYPE_URL in "${FREETYPE_URLS[@]}"; do
        if download_file "${FREETYPE_URL}" "freetype-${FREETYPE_VERSION}.tar.xz" "${FREETYPE_SHA256}"; then
            downloaded=1
            break
        fi
        log_warn "FreeType download failed from ${FREETYPE_URL} — trying next mirror"
    done
    if [ "${downloaded}" != "1" ]; then
        log_error "All FreeType mirrors failed"
        exit 1
    fi
    tar -xJf "freetype-${FREETYPE_VERSION}.tar.xz"
    rm "freetype-${FREETYPE_VERSION}.tar.xz"
fi

log_info "Building FreeType ${FREETYPE_VERSION} for WASM..."

mkdir -p "${FREETYPE_BUILD}"
cd "${FREETYPE_BUILD}"

emcmake cmake "${FREETYPE_DIR}" \
    -DCMAKE_BUILD_TYPE=${BUILD_TYPE:-Debug} \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT}" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_C_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory ${DEPS_EH_FLAGS}" \
    -DCMAKE_CXX_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory ${DEPS_EH_FLAGS}" \
    -DFT_DISABLE_BZIP2=ON \
    -DFT_DISABLE_BROTLI=ON \
    -DFT_DISABLE_HARFBUZZ=ON \
    -DFT_DISABLE_PNG=ON \
    -DFT_DISABLE_ZLIB=OFF \
    -DBUILD_SHARED_LIBS=OFF

emmake make -j${JOBS}
emmake make install

# Create symlink without debug suffix for pkg-config compatibility
# FreeType CMake adds 'd' suffix for Debug builds but pkg-config expects 'libfreetype'
if [ -f "${SYSROOT}/lib/libfreetyped.a" ] && [ ! -f "${SYSROOT}/lib/libfreetype.a" ]; then
    ln -sf libfreetyped.a "${SYSROOT}/lib/libfreetype.a"
    log_info "Created libfreetype.a symlink for pkg-config"
fi

create_stamp "${FREETYPE_STAMP}"
log_info "FreeType build complete!"
