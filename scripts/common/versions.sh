#!/bin/bash
# Dependency versions for KiCad WASM build
# These versions match KiCad 8.99 requirements from CMakeLists.txt and vcpkg.json

# Emscripten SDK version (single source of truth for Docker and local builds)
# 6.0.6: JSPI-capable toolchain for the experiment/jspi branch (was 4.0.2).
export EMSCRIPTEN_VERSION="6.0.6"

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
# downloads.sourceforge.net serves the file directly; the projects/... /download
# form returns an HTML redirect page that breaks curl-based fetches.
# Superseded releases move from ng-spice-rework/<v>/ to old-releases/<v>/ on
# sourceforge (46 moved there when 47 shipped, 2026-08 - the top-level path
# 404s). old-releases is the durable home for a pinned version.
export NGSPICE_URL="https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/old-releases/${NGSPICE_VERSION}/ngspice-${NGSPICE_VERSION}.tar.gz"

# Pinned versions for deps whose URL is composed in their build script.
export BOOST_VERSION="1.84.0"
export CURL_VERSION="8.5.0"
export LIBGIT2_VERSION="1.7.1"

# SHA256 pins for every download_file() fetch (X-1 / security-audit-v3 #15).
# download_file refuses an empty pin unless PCBJAM_ALLOW_UNPINNED=1.
# Values computed 2026-08-28 from the URLs above and cross-checked against an
# independent publisher (Homebrew / Buildroot / nixpkgs / FreeBSD ports / vcpkg /
# boost.org / curl PGP); the table with each corroboration lives in
# docs/features/findings/groups/X-build-supply-chain-audit-tooling.md (private
# superproject). glm's .zip is the one nobody else records (TOFU).
# OCC / rapidjson / libgit2 are GitHub auto-generated tag archives: if one of
# those pins ever fails on an unchanged tag, GitHub's archive bytes moved
# (it happened 2023-01) — re-corroborate before re-pinning.
export ZSTD_SHA256="9c4396cc829cfae319a6e2615202e82aad41372073482fce286fac78646d3ee4"
export FREETYPE_SHA256="12991c4e55c506dd7f9b765933e62fd2be2e06d421505d7950a132e4f1bb484d"
export HARFBUZZ_SHA256="109501eaeb8bde3eadb25fab4164e993fbace29c3d775bcaa1c1e58e2f15f847"
export CAIRO_SHA256="243a0736b978a33dee29f9cca7521733b78a65b5418206fef7bd1c3d4cf10b64"
export PIXMAN_SHA256="ea1480efada2fd948bc75366f7c349e1c96d3297d09a3fe62626e38e234a625e"
export OCC_SHA256="096cd0f268fa9f6a50818e1d628ac92ecf87e10fd72187e2e8d6be57dfe12530"
export RAPIDJSON_SHA256="2d2601a82d2d3b7e143a3c8d43ef616671391034bc46891a9816b79cf2d3e7a8"
export NGSPICE_SHA256="a0d1699af1940b06649276dcd6ff5a566c8c0cad01b2f7b5e99dedbb4d64c19b"
export GLM_SHA256="37e2a3d62ea3322e43593c34bae29f57e3e251ea89f4067506c94043769ade4c"
export BOOST_SHA256="a5800f405508f5df8114558ca9855d2640a2de8f0445f051fa1c7c3383045724"
export CURL_SHA256="05fc17ff25b793a437a0906e0484b82172a9f4de02be5ed447e0cab8c3475add"
export LIBGIT2_SHA256="17d2b292f21be3892b704dddff29327b3564f96099a1c53b00edc23160c71327"
export PROTOBUF_SHA256="4eab9b524aa5913c6fffb20b2a8abf5ef7f95a80bc0701f3a6dbb4c607f73460"
