#!/bin/bash
# Download CURL headers for WebAssembly builds
# We only need the headers - CURL functions will be stubbed for WASM
# since networking uses browser fetch API, not native sockets

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

CURL_VERSION="${CURL_VERSION:-8.5.0}"
CURL_DIR="${DEPS_ROOT}/curl-${CURL_VERSION}"
CURL_STAMP="${BUILD_ROOT}/stamps/curl-headers.stamp"

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
    log_info "Cleaning CURL headers..."
    rm -rf "${CURL_DIR}" "${CURL_STAMP}"
    rm -rf "${SYSROOT}/include/curl"
fi

# Check if already installed
if check_stamp "${CURL_STAMP}"; then
    log_info "CURL headers already installed, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${CURL_DIR}" ]; then
    log_info "Downloading CURL ${CURL_VERSION} headers..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    # Download from curl official releases
    CURL_URL="https://curl.se/download/curl-${CURL_VERSION}.tar.gz"
    download_file "${CURL_URL}" "curl-${CURL_VERSION}.tar.gz" "${CURL_SHA256}"
    tar -xzf "curl-${CURL_VERSION}.tar.gz"
    rm "curl-${CURL_VERSION}.tar.gz"
fi

# Install headers only (no build needed - header-only for WASM stub)
log_info "Installing CURL headers to sysroot..."
mkdir -p "${SYSROOT}/include/curl"
cp "${CURL_DIR}/include/curl/"*.h "${SYSROOT}/include/curl/"

create_stamp "${CURL_STAMP}"
log_info "CURL headers installed!"
