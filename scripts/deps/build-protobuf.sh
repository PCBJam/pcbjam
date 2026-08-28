#!/bin/bash
# Build Protocol Buffers for WebAssembly
# Protobuf is used for IPC in KiCad

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

PROTOBUF_DIR="${DEPS_ROOT}/protobuf-${PROTOBUF_VERSION}"
PROTOBUF_BUILD="${BUILD_ROOT}/deps/protobuf"
PROTOBUF_STAMP="${BUILD_ROOT}/stamps/protobuf.stamp"

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
    log_info "Cleaning Protobuf build..."
    rm -rf "${PROTOBUF_BUILD}" "${PROTOBUF_STAMP}"
fi

# Check if already built
if check_stamp "${PROTOBUF_STAMP}"; then
    log_info "Protobuf already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${PROTOBUF_DIR}" ]; then
    log_info "Downloading Protobuf ${PROTOBUF_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    # Protobuf 3.21.x uses tag format v21.12 (major version 3 is implicit)
    PROTOBUF_TAG_VERSION="${PROTOBUF_VERSION#3.}"  # Strip leading "3." -> "21.12"
    PROTOBUF_URL="https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOBUF_TAG_VERSION}/protobuf-cpp-${PROTOBUF_VERSION}.tar.gz"
    download_file "${PROTOBUF_URL}" "protobuf-${PROTOBUF_VERSION}.tar.gz" "${PROTOBUF_SHA256}"
    tar -xzf "protobuf-${PROTOBUF_VERSION}.tar.gz"
    rm "protobuf-${PROTOBUF_VERSION}.tar.gz"
fi

log_info "Building Protobuf ${PROTOBUF_VERSION}..."

# Step 1: Build native protoc for the host (needed for code generation)
# This is required because the system protoc may be a different version
PROTOBUF_HOST_BUILD="${BUILD_ROOT}/deps/protobuf-host"
PROTOC_NATIVE="${PROTOBUF_HOST_BUILD}/protoc"

if [ ! -f "${PROTOC_NATIVE}" ]; then
    log_info "Building native protoc for host..."
    mkdir -p "${PROTOBUF_HOST_BUILD}"
    cd "${PROTOBUF_HOST_BUILD}"

    # Build native (not cross-compiled) protoc
    # Explicitly use system compilers to avoid Emscripten (which is in PATH)
    cmake "${PROTOBUF_DIR}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=/usr/bin/gcc \
        -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
        -Dprotobuf_BUILD_TESTS=OFF \
        -Dprotobuf_BUILD_EXAMPLES=OFF \
        -Dprotobuf_BUILD_SHARED_LIBS=OFF \
        -Dprotobuf_WITH_ZLIB=OFF

    make -j${JOBS} protoc
    log_info "Native protoc built: ${PROTOC_NATIVE}"
fi

# Install native protoc to sysroot/bin for CMake to find
mkdir -p "${SYSROOT}/bin"
cp "${PROTOC_NATIVE}" "${SYSROOT}/bin/protoc"
log_info "Native protoc installed to ${SYSROOT}/bin/protoc"

# Step 2: Build WASM library
log_info "Building Protobuf library for WASM..."
mkdir -p "${PROTOBUF_BUILD}"
cd "${PROTOBUF_BUILD}"

emcmake cmake "${PROTOBUF_DIR}" \
    -DCMAKE_BUILD_TYPE=${BUILD_TYPE:-Debug} \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT}" \
    -DCMAKE_C_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory" \
    -DCMAKE_CXX_FLAGS="${DEBUG_CFLAGS:--g -O0} -pthread -matomics -mbulk-memory" \
    -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_EXAMPLES=OFF \
    -Dprotobuf_BUILD_PROTOC_BINARIES=OFF \
    -Dprotobuf_BUILD_SHARED_LIBS=OFF \
    -Dprotobuf_WITH_ZLIB=OFF

emmake make -j${JOBS}
emmake make install

# Create symlinks without debug suffix for pkg-config compatibility
# Protobuf CMake adds 'd' suffix for Debug builds but pkg-config expects 'libprotobuf'
if [ -f "${SYSROOT}/lib/libprotobufd.a" ] && [ ! -f "${SYSROOT}/lib/libprotobuf.a" ]; then
    ln -sf libprotobufd.a "${SYSROOT}/lib/libprotobuf.a"
    log_info "Created libprotobuf.a symlink for pkg-config"
fi
if [ -f "${SYSROOT}/lib/libprotobuf-lited.a" ] && [ ! -f "${SYSROOT}/lib/libprotobuf-lite.a" ]; then
    ln -sf libprotobuf-lited.a "${SYSROOT}/lib/libprotobuf-lite.a"
    log_info "Created libprotobuf-lite.a symlink for pkg-config"
fi

create_stamp "${PROTOBUF_STAMP}"
log_info "Protobuf build complete!"
