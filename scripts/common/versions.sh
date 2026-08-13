#!/bin/bash
# Dependency versions for KiCad WASM build
# These versions match KiCad 8.99 requirements from CMakeLists.txt and vcpkg.json

# Emscripten SDK version (single source of truth for Docker and local builds)
export EMSCRIPTEN_VERSION="4.0.2"

# KiCad submodule version
export KICAD_COMMIT="4bfed3f1746e8cc0a7d942767770f56fa28b393c"
export KICAD_VERSION="8.99"

# From vcpkg.json overrides (pinned versions)
export GLM_VERSION="0.9.9.8"
export NGSPICE_VERSION="46"
export PROTOBUF_VERSION="3.21.12"
export PYTHON_VERSION="3.11.5"
export WXWIDGETS_VERSION="3.3.1"

# From CMakeLists.txt minimum requirements
export WXWIDGETS_MIN="3.2.0"
export GLM_MIN="0.9.8"
export BOOST_MIN="1.71.0"
export FREETYPE_MIN="2.11.1"
export CAIRO_MIN="1.12"
export PIXMAN_MIN="0.30"
export LIBGIT2_MIN="1.5"
export OCC_MIN="7.5.0"
export SWIG_MIN="4.0"

# Recommended versions for WASM build
export OCC_VERSION="7.8.0"
# Header-only; OCC's glTF (GLB) writer requires it (HAVE_RAPIDJSON). RapidJSON
# has tagged no release since 1.1.0 (2016) — whose headers are ill-formed under
# modern clang — so, like official KiCad (whose vcpkg.json pulls opencascade's
# rapidjson feature), we pin the dated master snapshot vcpkg ships. The
# "version" is vcpkg's port date for that commit.
export RAPIDJSON_VERSION="2025-02-26"
export RAPIDJSON_COMMIT="24b5e7a8b27f42fa16b96fc70aade9106cf7102f"
export ZSTD_VERSION="1.5.5"
export FREETYPE_VERSION="2.13.2"
export HARFBUZZ_VERSION="8.3.0"
export CAIRO_VERSION="1.18.0"
export PIXMAN_VERSION="0.42.2"
export BOOST_VERSION="1.84.0"

# Download URLs
export ZSTD_URL="https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz"
export FREETYPE_URL="https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz"
export HARFBUZZ_URL="https://github.com/harfbuzz/harfbuzz/releases/download/${HARFBUZZ_VERSION}/harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
export CAIRO_URL="https://cairographics.org/releases/cairo-${CAIRO_VERSION}.tar.xz"
export PIXMAN_URL="https://cairographics.org/releases/pixman-${PIXMAN_VERSION}.tar.gz"
export OCC_URL="https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V${OCC_VERSION//./_}.tar.gz"
export RAPIDJSON_URL="https://github.com/Tencent/rapidjson/archive/${RAPIDJSON_COMMIT}.tar.gz"
# Pinned releases move under old-releases when ngspice publishes the next
# version. downloads.sourceforge.net serves the archive directly; the
# projects/.../download form can return an HTML landing page.
export NGSPICE_URL="https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/old-releases/${NGSPICE_VERSION}/ngspice-${NGSPICE_VERSION}.tar.gz"

# SHA256 checksums (to be filled in after first successful download)
# export ZSTD_SHA256=""
# export HARFBUZZ_SHA256=""
# export CAIRO_SHA256=""
# export PIXMAN_SHA256=""
# export OCC_SHA256=""
# export NGSPICE_SHA256=""
