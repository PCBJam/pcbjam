#!/bin/bash
# Install GLM headers for WebAssembly
# GLM is a header-only math library

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

GLM_DIR="${DEPS_ROOT}/glm-${GLM_VERSION}"
GLM_STAMP="${BUILD_ROOT}/stamps/glm.stamp"

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
    log_info "Cleaning GLM install..."
    rm -rf "${GLM_STAMP}"
fi

# Check if already installed
if check_stamp "${GLM_STAMP}"; then
    log_info "GLM already installed, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${GLM_DIR}" ]; then
    log_info "Downloading GLM ${GLM_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    GLM_URL="https://github.com/g-truc/glm/releases/download/${GLM_VERSION}/glm-${GLM_VERSION}.zip"
    download_file "${GLM_URL}" "glm-${GLM_VERSION}.zip" "${GLM_SHA256}"
    unzip -q "glm-${GLM_VERSION}.zip"
    mv glm "glm-${GLM_VERSION}"
    rm "glm-${GLM_VERSION}.zip"
fi

log_info "Installing GLM ${GLM_VERSION} headers..."

# GLM is header-only, just copy headers
mkdir -p "${SYSROOT}/include"
cp -r "${GLM_DIR}/glm" "${SYSROOT}/include/"

create_stamp "${GLM_STAMP}"
log_info "GLM install complete!"
