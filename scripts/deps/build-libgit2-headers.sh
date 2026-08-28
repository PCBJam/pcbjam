#!/bin/bash
# Download libgit2 headers for WebAssembly builds
# We only need the headers - git functionality won't work in browser

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

LIBGIT2_VERSION="${LIBGIT2_VERSION:-1.7.1}"
LIBGIT2_DIR="${DEPS_ROOT}/libgit2-${LIBGIT2_VERSION}"
LIBGIT2_STAMP="${BUILD_ROOT}/stamps/libgit2-headers.stamp"

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
    log_info "Cleaning libgit2 headers..."
    rm -rf "${LIBGIT2_DIR}" "${LIBGIT2_STAMP}"
    rm -rf "${SYSROOT}/include/git2.h" "${SYSROOT}/include/git2"
fi

# Check if already installed
if check_stamp "${LIBGIT2_STAMP}"; then
    log_info "libgit2 headers already installed, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${LIBGIT2_DIR}" ]; then
    log_info "Downloading libgit2 ${LIBGIT2_VERSION} headers..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    LIBGIT2_URL="https://github.com/libgit2/libgit2/archive/refs/tags/v${LIBGIT2_VERSION}.tar.gz"
    download_file "${LIBGIT2_URL}" "libgit2-${LIBGIT2_VERSION}.tar.gz" "${LIBGIT2_SHA256}"
    tar -xzf "libgit2-${LIBGIT2_VERSION}.tar.gz"
    rm "libgit2-${LIBGIT2_VERSION}.tar.gz"
fi

# Install headers only
log_info "Installing libgit2 headers to sysroot..."
mkdir -p "${SYSROOT}/include/git2/sys"
cp "${LIBGIT2_DIR}/include/git2.h" "${SYSROOT}/include/"
cp -r "${LIBGIT2_DIR}/include/git2/"* "${SYSROOT}/include/git2/"

create_stamp "${LIBGIT2_STAMP}"
log_info "libgit2 headers installed!"
