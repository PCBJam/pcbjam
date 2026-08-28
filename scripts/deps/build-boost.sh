#!/bin/bash
# Build Boost for WebAssembly
# KiCad requires Boost with the locale component

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

BOOST_VERSION="${BOOST_VERSION:-1.84.0}"
BOOST_VERSION_UNDERSCORE="${BOOST_VERSION//./_}"
BOOST_DIR="${DEPS_ROOT}/boost_${BOOST_VERSION_UNDERSCORE}"
BOOST_BUILD="${BUILD_ROOT}/deps/boost"
BOOST_STAMP="${BUILD_ROOT}/stamps/boost.stamp"

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
    log_info "Cleaning Boost build..."
    rm -rf "${BOOST_BUILD}" "${BOOST_STAMP}"
fi

# Check if already built
if check_stamp "${BOOST_STAMP}"; then
    log_info "Boost already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${BOOST_DIR}" ]; then
    log_info "Downloading Boost ${BOOST_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    # Use SourceForge mirror (most reliable for Boost downloads)
    BOOST_URL="https://sourceforge.net/projects/boost/files/boost/${BOOST_VERSION}/boost_${BOOST_VERSION_UNDERSCORE}.tar.gz/download"
    BOOST_ARCHIVE="boost_${BOOST_VERSION_UNDERSCORE}.tar.gz"

    # Download and extract
    download_file "${BOOST_URL}" "${BOOST_ARCHIVE}" "${BOOST_SHA256}"
    tar -xzf "${BOOST_ARCHIVE}"
    rm "${BOOST_ARCHIVE}"
fi

log_info "Building Boost ${BOOST_VERSION} for WASM..."

cd "${BOOST_DIR}"

# Bootstrap b2 if needed (use gcc for native build of b2)
if [ ! -f "b2" ]; then
    log_info "Bootstrapping b2..."
    ./bootstrap.sh --with-toolset=gcc
fi

# Determine boost variant based on DEBUG_BUILD
if [ "${DEBUG_BUILD:-1}" = "1" ]; then
    BOOST_VARIANT="debug"
    BOOST_DEBUG_FLAGS="-g -O0"
else
    BOOST_VARIANT="release"
    BOOST_DEBUG_FLAGS="-O2"
fi

# Create user-config.jam for Emscripten
cat > user-config.jam << EOF
using clang : emscripten
    : em++
    : <cxxflags>"${BOOST_DEBUG_FLAGS} -pthread -matomics -mbulk-memory"
      <linkflags>"-pthread"
    ;
EOF

# Build only the locale library (and its dependencies)
# Most of Boost is header-only, we just need locale built
log_info "Building Boost.Locale (${BOOST_VARIANT})..."
# JOBS is set in env.sh (default: 1 for sequential builds, use -j N to override)
./b2 -j${JOBS} \
    --user-config=user-config.jam \
    --prefix="${SYSROOT}" \
    --with-locale \
    toolset=clang-emscripten \
    variant=${BOOST_VARIANT} \
    link=static \
    threading=multi \
    runtime-link=static \
    cxxflags="${BOOST_DEBUG_FLAGS} -pthread -matomics -mbulk-memory" \
    install

create_stamp "${BOOST_STAMP}"
log_info "Boost build complete!"
