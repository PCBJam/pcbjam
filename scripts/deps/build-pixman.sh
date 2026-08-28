#!/bin/bash
# Build Pixman for WebAssembly
# Pixman is required by Cairo for pixel manipulation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

PIXMAN_DIR="${DEPS_ROOT}/pixman-${PIXMAN_VERSION}"
PIXMAN_BUILD="${BUILD_ROOT}/deps/pixman"
PIXMAN_STAMP="${BUILD_ROOT}/stamps/pixman.stamp"

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
    log_info "Cleaning Pixman build..."
    rm -rf "${PIXMAN_BUILD}" "${PIXMAN_STAMP}"
fi

# Check if already built
if check_stamp "${PIXMAN_STAMP}"; then
    log_info "Pixman already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${PIXMAN_DIR}" ]; then
    log_info "Downloading Pixman ${PIXMAN_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    PIXMAN_URL="https://cairographics.org/releases/pixman-${PIXMAN_VERSION}.tar.gz"
    download_file "${PIXMAN_URL}" "pixman-${PIXMAN_VERSION}.tar.gz" "${PIXMAN_SHA256}"
    tar -xzf "pixman-${PIXMAN_VERSION}.tar.gz"
    rm "pixman-${PIXMAN_VERSION}.tar.gz"
fi

log_info "Building Pixman ${PIXMAN_VERSION} for WASM..."

mkdir -p "${PIXMAN_BUILD}"
cd "${PIXMAN_BUILD}"

# Determine meson build type based on DEBUG_BUILD
if [ "${DEBUG_BUILD:-1}" = "1" ]; then
    MESON_BUILD_TYPE="debug"
    MESON_DEBUG_FLAGS="'-g', '-O0'"
else
    MESON_BUILD_TYPE="release"
    MESON_DEBUG_FLAGS="'-O2'"
fi

# Pixman uses meson
cat > cross-file.txt << EOF
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
strip = 'emstrip'

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[built-in options]
c_args = [${MESON_DEBUG_FLAGS}, '-pthread', '-matomics', '-mbulk-memory']
c_link_args = ['-pthread']
EOF

meson setup "${PIXMAN_DIR}" \
    --cross-file cross-file.txt \
    --prefix="${SYSROOT}" \
    --default-library=static \
    --buildtype=${MESON_BUILD_TYPE} \
    -Dgtk=disabled \
    -Dlibpng=disabled \
    -Dtests=disabled

# JOBS is set in env.sh (default: 1 for sequential builds, use -j N to override)
ninja -j${JOBS}
ninja install

create_stamp "${PIXMAN_STAMP}"
log_info "Pixman build complete!"
