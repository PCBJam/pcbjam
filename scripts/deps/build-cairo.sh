#!/bin/bash
# Build Cairo for WebAssembly
# Cairo provides 2D graphics rendering

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

# Cairo requires Pixman and FreeType
"${SCRIPT_DIR}/build-pixman.sh"
"${SCRIPT_DIR}/build-freetype.sh"

CAIRO_DIR="${DEPS_ROOT}/cairo-${CAIRO_VERSION}"
CAIRO_BUILD="${BUILD_ROOT}/deps/cairo"
CAIRO_STAMP="${BUILD_ROOT}/stamps/cairo.stamp"

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
    log_info "Cleaning Cairo build..."
    rm -rf "${CAIRO_BUILD}" "${CAIRO_STAMP}"
fi

# Check if already built
if check_stamp "${CAIRO_STAMP}"; then
    log_info "Cairo already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${CAIRO_DIR}" ]; then
    log_info "Downloading Cairo ${CAIRO_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    CAIRO_URL="https://cairographics.org/releases/cairo-${CAIRO_VERSION}.tar.xz"
    download_file "${CAIRO_URL}" "cairo-${CAIRO_VERSION}.tar.xz" "${CAIRO_SHA256}"
    tar -xJf "cairo-${CAIRO_VERSION}.tar.xz"
    rm "cairo-${CAIRO_VERSION}.tar.xz"
fi

log_info "Building Cairo ${CAIRO_VERSION} for WASM..."

# Always start meson fresh on a (re)build: meson caches its configuration, so a `meson setup` on an
# existing build dir IGNORES a regenerated cross-file.txt — which silently dropped the EH/longjmp
# flags (DEPS_EH_FLAGS) when switching JS-EH -> native-EH and left libcairo.a referencing
# emscripten_longjmp. Wiping here (we only reach this past the stamp check, i.e. on a real rebuild)
# forces meson to re-read the cross-file. Cairo is small, so the full reconfigure is cheap.
rm -rf "${CAIRO_BUILD}"
mkdir -p "${CAIRO_BUILD}"
cd "${CAIRO_BUILD}"

# Determine meson build type based on DEBUG_BUILD
if [ "${DEBUG_BUILD:-1}" = "1" ]; then
    MESON_BUILD_TYPE="debug"
    MESON_DEBUG_FLAGS="'-g', '-O0'"
else
    MESON_BUILD_TYPE="release"
    MESON_DEBUG_FLAGS="'-O2'"
fi

# Exception-model flags (DEPS_EH_FLAGS from env.sh) as meson list elements, e.g.
# ", '-fwasm-exceptions', '-sSUPPORT_LONGJMP=wasm', '-sWASM_LEGACY_EXCEPTIONS=1'". Empty for legacy.
MESON_EH_FLAGS=""
for _ehf in ${DEPS_EH_FLAGS}; do MESON_EH_FLAGS="${MESON_EH_FLAGS}, '${_ehf}'"; done

# Cairo uses meson
cat > cross-file.txt << EOF
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
strip = 'emstrip'
pkgconfig = 'pkg-config'

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[properties]
# Don't set sys_root - it gets prepended to pkg-config paths which are already absolute
# Just use pkg_config_libdir to control where we find .pc files
pkg_config_libdir = '${SYSROOT}/lib/pkgconfig'

[built-in options]
default_library = 'static'
b_staticpic = false
b_pie = false
# Emscripten has these functions but meson checks fail - provide HAVE_ defines
# to prevent Cairo from defining its own conflicting implementations
# Include ft2build.h and ftcolor.h to fix FT_Color forward declaration bug in cairo-ft-private.h
# (the forward declaration is inside HAVE_FT_SVG_DOCUMENT but used in HAVE_FT_COLR_V1)
c_args = [${MESON_DEBUG_FLAGS}${MESON_EH_FLAGS}, '-pthread', '-matomics', '-mbulk-memory', '-I${SYSROOT}/include', '-I${SYSROOT}/include/freetype2', '-I${SYSROOT}/include/pixman-1', '-DHAVE_CTIME_R=1', '-DHAVE_LOCALTIME_R=1', '-DHAVE_GMTIME_R=1', '-DHAVE_STRNDUP=1', '-include', 'ft2build.h', '-include', 'freetype/ftcolor.h']
c_link_args = ['-pthread'${MESON_EH_FLAGS}, '-L${SYSROOT}/lib']
pkg_config_path = '${SYSROOT}/lib/pkgconfig'
EOF

# Set PKG_CONFIG_PATH for dependency discovery
# Use LIBDIR to ONLY search our sysroot, preventing system lzo2 from being found
export PKG_CONFIG_LIBDIR="${SYSROOT}/lib/pkgconfig"
unset PKG_CONFIG_PATH

meson setup "${CAIRO_DIR}" \
    --cross-file cross-file.txt \
    --prefix="${SYSROOT}" \
    --default-library=static \
    --buildtype=${MESON_BUILD_TYPE} \
    -Dfontconfig=disabled \
    -Dfreetype=enabled \
    -Dglib=disabled \
    -Dpng=disabled \
    -Dxlib=disabled \
    -Dxcb=disabled \
    -Dzlib=enabled \
    -Dtests=disabled \
    -Dspectre=disabled \
    -Dsymbol-lookup=disabled \
    -Dfreetype2:default_library=static \
    -Dlibpng:default_library=static

# Remove .git directories from meson subprojects
# Meson clones subprojects (like freetype) as full git repos and creates
# .meson-subproject-wrap-hash.txt which shows as untracked in those repos.
# IDEs detect these nested git repos and show dirty status in commit sidebar.
# We only need the source files for building, not git history.
find "${CAIRO_DIR}/subprojects" -name ".git" -type d -exec rm -rf {} + 2>/dev/null || true

# JOBS is set in env.sh (default: 1 for sequential builds, use -j N to override)
# Build only the library targets we need - utility executables fail to link and aren't needed
ninja -j${JOBS} src/libcairo.a

# Manual installation - ninja install tries to build everything including utilities
# which fail due to freetype atomics issues
log_info "Installing Cairo library and headers..."
mkdir -p "${SYSROOT}/lib" "${SYSROOT}/include/cairo" "${SYSROOT}/lib/pkgconfig"
cp src/libcairo.a "${SYSROOT}/lib/"
cp "${CAIRO_DIR}/src/cairo.h" "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-deprecated.h" "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-version.h" "${SYSROOT}/include/cairo/"
# cairo-features.h is generated during configure in the build directory
cp src/cairo-features.h "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-ft.h" "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-pdf.h" "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-ps.h" "${SYSROOT}/include/cairo/"
cp "${CAIRO_DIR}/src/cairo-script.h" "${SYSROOT}/include/cairo/"

# Create pkg-config file
cat > "${SYSROOT}/lib/pkgconfig/cairo.pc" << PKGEOF
prefix=${SYSROOT}
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: cairo
Description: Multi-platform 2D graphics library
Version: 1.18.0
Libs: -L\${libdir} -lcairo
Cflags: -I\${includedir}/cairo
Requires.private: freetype2 pixman-1
PKGEOF

create_stamp "${CAIRO_STAMP}"
log_info "Cairo build complete!"
