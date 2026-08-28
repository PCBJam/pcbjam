#!/bin/bash
# Common functions for KiCad WASM build scripts

# Exit on error by default
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Error handler
on_error() {
    local exit_code=$?
    local line_no=$1
    log_error "Build failed at line $line_no with exit code $exit_code"

    # Save build log if available
    if [ -n "$BUILD_LOG" ] && [ -f "$BUILD_LOG" ]; then
        local log_file="$BUILD_ROOT/logs/build-$(date +%Y%m%d-%H%M%S).log"
        mkdir -p "$(dirname "$log_file")"
        cp "$BUILD_LOG" "$log_file"
        log_error "Build log saved to: $log_file"
    fi

    exit $exit_code
}

# Set up error trap
setup_error_trap() {
    trap 'on_error ${LINENO}' ERR
}

# Verify Emscripten is available
verify_emscripten() {
    if ! command -v emcc &> /dev/null; then
        log_error "Emscripten not found. Run: ./scripts/setup-emsdk.sh"
        exit 1
    fi
    log_info "Using Emscripten: $(emcc --version | head -1)"
}

# Verify submodules are initialized
verify_submodules() {
    local project_root="$1"

    if [ ! -f "$project_root/kicad/CMakeLists.txt" ]; then
        log_error "KiCad submodule not initialized. Run: git submodule update --init --recursive"
        exit 1
    fi

    if [ ! -f "$project_root/wxwidgets/configure" ]; then
        log_error "wxWidgets submodule not initialized. Run: git submodule update --init --recursive"
        exit 1
    fi

    log_info "Submodules verified"
}

# Download file with optional verification
# sha256 of a file. Prefer coreutils (always in the builder image); fall back
# to perl's shasum (macOS hosts; present in the image only because git pulls
# in perl).
file_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# download_file URL DEST SHA256
# The pin is mandatory (X-1 / security-audit-v3 #15): a fetched-then-compiled
# tarball with no content pin is the supply-chain hole. Set
# PCBJAM_ALLOW_UNPINNED=1 only while bootstrapping a new dependency, to obtain
# the value that then goes into scripts/common/versions.sh.
download_file() {
    local url="$1"
    local dest="$2"
    local expected_sha256="${3:-}"

    if [ -z "$expected_sha256" ] && [ "${PCBJAM_ALLOW_UNPINNED:-0}" != "1" ]; then
        log_error "download_file: no SHA256 pin for $url"
        log_error "  add <NAME>_SHA256 to scripts/common/versions.sh (PCBJAM_ALLOW_UNPINNED=1 to bootstrap)"
        return 1
    fi
    if [ -n "$expected_sha256" ] && ! printf '%s' "$expected_sha256" | grep -Eq '^[0-9a-f]{64}$'; then
        log_error "download_file: malformed SHA256 pin for $url: $expected_sha256"
        return 1
    fi

    if [ -f "$dest" ]; then
        if [ -n "$expected_sha256" ]; then
            local actual_sha256
            actual_sha256=$(file_sha256 "$dest" 2>/dev/null)
            if [ "$actual_sha256" = "$expected_sha256" ]; then
                log_info "$(basename "$dest") already downloaded and verified"
                return 0
            fi
            log_warn "Checksum mismatch, re-downloading..."
        else
            log_info "$(basename "$dest") already exists"
            return 0
        fi
    fi

    log_info "Downloading $(basename "$dest")..."
    mkdir -p "$(dirname "$dest")"

    # -f: fail (non-zero exit) on HTTP >= 400 instead of silently saving the error
    #     page as the file — otherwise a transient GitHub 504 gets written as the
    #     "tarball" and only blows up later at `tar`/`unzip` ("not in gzip format").
    # --retry-all-errors + --retry: ride out transient 5xx from release CDNs
    #     (GitHub release assets intermittently 504) within a single call.
    if ! curl -fL --retry 5 --retry-all-errors --retry-delay 5 \
              --connect-timeout 30 -o "$dest" "$url"; then
        log_error "Failed to download $url after retries"
        rm -f "$dest"
        return 1
    fi

    # Defense in depth: validate archive integrity so a bad download fails here
    # with a clear message rather than deep in a later build step.
    case "$dest" in
        *.tar.gz|*.tgz)
            if ! gzip -t "$dest" 2>/dev/null; then
                log_error "Downloaded file is not a valid gzip archive: $dest"
                rm -f "$dest"
                return 1
            fi
            ;;
        *.zip)
            if command -v unzip >/dev/null 2>&1 && ! unzip -tqq "$dest" >/dev/null 2>&1; then
                log_error "Downloaded file is not a valid zip archive: $dest"
                rm -f "$dest"
                return 1
            fi
            ;;
    esac

    if [ -n "$expected_sha256" ]; then
        local actual_sha256
        actual_sha256=$(file_sha256 "$dest")
        if [ "$actual_sha256" != "$expected_sha256" ]; then
            log_error "SHA256 mismatch for $dest"
            log_error "  Expected: $expected_sha256"
            log_error "  Actual:   $actual_sha256"
            rm -f "$dest"
            return 1
        fi
        log_info "Checksum verified"
    fi

    return 0
}

# Extract archive (supports .tar.gz, .tar.xz, .zip)
extract_archive() {
    local archive="$1"
    local dest_dir="$2"

    mkdir -p "$dest_dir"

    case "$archive" in
        *.tar.gz|*.tgz)
            tar -xzf "$archive" -C "$dest_dir" --strip-components=1
            ;;
        *.tar.xz)
            tar -xJf "$archive" -C "$dest_dir" --strip-components=1
            ;;
        *.zip)
            unzip -q "$archive" -d "$dest_dir"
            ;;
        *)
            log_error "Unknown archive format: $archive"
            return 1
            ;;
    esac

    log_info "Extracted to $dest_dir"
}

# Create build stamp file
# Can accept either a simple name like "zstd" or a full path like "/path/to/stamps/zstd.stamp"
create_stamp() {
    local name="$1"
    local stamp_file

    if [[ "$name" == /* ]]; then
        # Full path provided
        stamp_file="$name"
    else
        # Just a name, use default stamps dir
        local stamp_dir="${BUILD_ROOT:-$PROJECT_ROOT/build-wasm}/stamps"
        mkdir -p "$stamp_dir"
        stamp_file="$stamp_dir/$name.stamp"
    fi

    mkdir -p "$(dirname "$stamp_file")"
    date +%s > "$stamp_file"
    log_info "Created stamp: $(basename "$stamp_file" .stamp)"
}

# Check if build stamp exists
# Can accept either a simple name like "zstd" or a full path like "/path/to/stamps/zstd.stamp"
check_stamp() {
    local name="$1"
    local stamp_file

    if [[ "$name" == /* ]]; then
        # Full path provided
        stamp_file="$name"
    else
        # Just a name, use default stamps dir
        stamp_file="${BUILD_ROOT:-$PROJECT_ROOT/build-wasm}/stamps/$name.stamp"
    fi

    [ -f "$stamp_file" ]
}

# Remove build stamp
remove_stamp() {
    local name="$1"
    local stamp_file="${BUILD_ROOT:-$PROJECT_ROOT/build-wasm}/stamps/$name.stamp"
    rm -f "$stamp_file"
}

# Build if stamp doesn't exist
build_if_needed() {
    local name="$1"
    local script="$2"
    local force="${3:-0}"

    if [ "$force" = "1" ]; then
        remove_stamp "$name"
    fi

    if check_stamp "$name"; then
        log_info "Skipping $name (already built)"
        return 0
    fi

    log_step "Building $name..."
    "$script"
}

# Get number of CPU cores for parallel builds
get_nproc() {
    if command -v nproc &> /dev/null; then
        nproc
    elif command -v sysctl &> /dev/null; then
        sysctl -n hw.ncpu
    else
        echo 4
    fi
}

# Parse common command line arguments
parse_common_args() {
    CLEAN_BUILD=0
    DEBUG_BUILD="${DEBUG_BUILD:-1}"  # Default ON (use --release to disable)
    PARALLEL_JOBS=$(get_nproc)

    while [[ $# -gt 0 ]]; do
        case $1 in
            --clean)
                CLEAN_BUILD=1
                shift
                ;;
            --debug)
                DEBUG_BUILD=1
                shift
                ;;
            --release)
                DEBUG_BUILD=0
                shift
                ;;
            -j)
                PARALLEL_JOBS="$2"
                shift 2
                ;;
            -j*)
                PARALLEL_JOBS="${1#-j}"
                shift
                ;;
            *)
                # Unknown option, pass through
                shift
                ;;
        esac
    done

    export CLEAN_BUILD DEBUG_BUILD PARALLEL_JOBS
}

# Print build configuration
print_build_config() {
    echo "========================================"
    echo "Build Configuration:"
    echo "  Clean build: $CLEAN_BUILD"
    echo "  Debug build: $DEBUG_BUILD"
    echo "  Parallel jobs: $PARALLEL_JOBS"
    echo "  Build root: ${BUILD_ROOT:-not set}"
    echo "========================================"
}
