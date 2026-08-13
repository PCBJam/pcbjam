#!/bin/bash

# GAL Regression Test - Master Script
# ====================================
# Single script to build, run, and compare native OpenGL and WebGL GAL implementations.
#
# Two-level comparison:
# 1. native vs baseline - Catches if native code regressed
# 2. webgl vs native   - Verifies WebGL implementation matches native
#
# Usage:
#   ./scripts/test-gal-regression.sh           # Run all tests
#   ./scripts/test-gal-regression.sh native    # Run native only
#   ./scripts/test-gal-regression.sh webgl     # Run webgl only (requires native output)
#   ./scripts/test-gal-regression.sh compare   # Compare only (skip builds)
#   ./scripts/test-gal-regression.sh -v        # Verbose output

# Redirect all output to a log file (re-execs script with redirection)
source "$(dirname "$0")/common/logging.sh"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Directories
GAL_REGRESSION_DIR="$PROJECT_ROOT/tests/gal-regression"
BASELINE_DIR="$GAL_REGRESSION_DIR/baseline"
OUTPUT_DIR="$GAL_REGRESSION_DIR/output"
NATIVE_OUTPUT_DIR="$OUTPUT_DIR/native"
WEBGL_OUTPUT_DIR="$OUTPUT_DIR/webgl"
NATIVE_BUILD_DIR="$GAL_REGRESSION_DIR/native/build"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
VERBOSE=""
RUN_NATIVE=true
RUN_WEBGL=true
COMPARE_ONLY=false

for arg in "$@"; do
    case $arg in
        native)
            RUN_WEBGL=false
            ;;
        webgl)
            RUN_NATIVE=false
            ;;
        compare)
            COMPARE_ONLY=true
            ;;
        -v|--verbose)
            VERBOSE="-v"
            ;;
    esac
done

# ============================================================================
# Helper Functions
# ============================================================================

log_header() {
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
}

log_step() {
    echo -e "${YELLOW}>>> $1${NC}"
}

log_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

log_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Compare two directories of screenshots using ImageMagick
# Supports different dimensions (resizes to match) and allows small pixel differences
# Usage: compare_screenshots <dir1> <dir2> <label> [threshold]
# Returns 0 if match within threshold, 1 if different
compare_screenshots() {
    local dir1="$1"
    local dir2="$2"
    local label="$3"
    local threshold="${4:-1.0}"  # Default 1% difference allowed

    echo ""
    echo "Comparing: $label"
    echo "  Reference: $dir1"
    echo "  Current:   $dir2"
    echo "  Threshold: ${threshold}% pixel difference"
    echo ""

    if [ ! -d "$dir1" ]; then
        log_error "Reference directory not found: $dir1"
        return 1
    fi

    if [ ! -d "$dir2" ]; then
        log_error "Current directory not found: $dir2"
        return 1
    fi

    # Check for ImageMagick
    if ! command -v compare &> /dev/null; then
        log_error "ImageMagick 'compare' command not found. Install with: brew install imagemagick"
        return 1
    fi

    local total=0
    local matching=0
    local different=0
    local missing=0

    # Create temp directory for resized images
    local tmpdir=$(mktemp -d)
    trap "rm -rf '$tmpdir'" EXIT

    # Files to exclude from comparison (documented as broken/dead code)
    local excluded_files="gal-transform-api.png"

    # Compare all reference screenshots
    for ref in "$dir1"/*.png; do
        [ -e "$ref" ] || continue  # Handle no matches

        local filename=$(basename "$ref")

        # Skip excluded files
        if echo "$excluded_files" | grep -q "$filename"; then
            if [ -n "$VERBOSE" ]; then
                echo "  SKIPPED: $filename (excluded - see README.md)"
            fi
            continue
        fi

        local current="$dir2/$filename"
        total=$((total + 1))

        if [ ! -f "$current" ]; then
            echo "  MISSING: $filename"
            missing=$((missing + 1))
            continue
        fi

        # Get dimensions
        local ref_dims=$(identify -format "%wx%h" "$ref" 2>/dev/null)
        local cur_dims=$(identify -format "%wx%h" "$current" 2>/dev/null)

        # If dimensions differ, resize current to match reference
        local compare_file="$current"
        if [ "$ref_dims" != "$cur_dims" ]; then
            compare_file="$tmpdir/resized_$filename"
            convert "$current" -resize "$ref_dims!" "$compare_file" 2>/dev/null
            if [ -n "$VERBOSE" ]; then
                echo "  RESIZED: $filename ($cur_dims -> $ref_dims)"
            fi
        fi

        # Normalize both images to TrueColor RGB for consistent comparison
        # This handles PNG format differences (RGBA vs RGB, palette vs truecolor)
        local ref_normalized="$tmpdir/ref_$filename"
        local cur_normalized="$tmpdir/cur_$filename"
        convert "$ref" -flatten -colorspace sRGB -type TrueColor "$ref_normalized" 2>/dev/null
        convert "$compare_file" -flatten -colorspace sRGB -type TrueColor "$cur_normalized" 2>/dev/null

        # Compare with fuzz factor (allows small pixel differences from anti-aliasing)
        # Use AE (Absolute Error) metric - counts differing pixels
        # Output format: "123456 (0.123)" - extract just the first number
        local compare_output=$(compare -metric AE -fuzz 2% "$ref_normalized" "$cur_normalized" null: 2>&1 || true)
        local diff_pixels=$(echo "$compare_output" | awk '{print $1}')

        # Handle scientific notation (e.g., 1.92e+06)
        if [[ "$diff_pixels" =~ [eE] ]]; then
            diff_pixels=$(printf "%.0f" "$diff_pixels")
        fi

        # Handle error cases (non-numeric output)
        if ! [[ "$diff_pixels" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            echo "  ERROR: $filename (comparison failed: $compare_output)"
            different=$((different + 1))
            continue
        fi

        # Calculate percentage
        local total_pixels=$(identify -format "%[fx:w*h]" "$ref_normalized" 2>/dev/null)
        # Handle scientific notation in total_pixels
        if [[ "$total_pixels" =~ [eE] ]]; then
            total_pixels=$(printf "%.0f" "$total_pixels")
        fi
        if [ -z "$total_pixels" ] || [ "$total_pixels" = "0" ]; then
            total_pixels=1  # Avoid division by zero
        fi

        # Use awk for floating point arithmetic (more portable than bc)
        local diff_pct=$(awk "BEGIN {printf \"%.4f\", ($diff_pixels * 100.0) / $total_pixels}")

        # Compare against threshold
        local is_match=$(awk "BEGIN {print ($diff_pct < $threshold) ? 1 : 0}")

        if [ "$is_match" -eq 1 ]; then
            matching=$((matching + 1))
            local has_diff=$(awk "BEGIN {print ($diff_pixels > 0) ? 1 : 0}")
            if [ -n "$VERBOSE" ] || [ "$has_diff" -eq 1 ]; then
                echo "  MATCH: $filename (${diff_pct}% different)"
            fi
        else
            different=$((different + 1))
            echo "  DIFFERENT: $filename (${diff_pct}% different, threshold: ${threshold}%)"
        fi
    done

    # Check for extra files
    local extra=0
    for current in "$dir2"/*.png; do
        [ -e "$current" ] || continue
        local filename=$(basename "$current")
        local ref="$dir1/$filename"
        if [ ! -f "$ref" ]; then
            extra=$((extra + 1))
            echo "  EXTRA: $filename (not in reference)"
        fi
    done

    echo ""
    echo "  Results: $matching/$total matching, $different different, $missing missing, $extra extra"

    # Show diagnostic details for failing scenarios
    if [ "$different" -gt 0 ] && [ -n "$VERBOSE" ]; then
        echo ""
        echo "  === DIAGNOSTIC DETAILS for DIFFERENT scenarios ==="
        for ref in "$dir1"/*.png; do
            [ -e "$ref" ] || continue
            local filename=$(basename "$ref")
            local current="$dir2/$filename"
            [ -f "$current" ] || continue

            # Recalculate diff to identify failing scenarios
            local ref_normalized="$tmpdir/ref_$filename"
            local cur_normalized="$tmpdir/cur_$filename"
            [ -f "$ref_normalized" ] || convert "$ref" -flatten -colorspace sRGB -type TrueColor "$ref_normalized" 2>/dev/null
            [ -f "$cur_normalized" ] || convert "$current" -flatten -colorspace sRGB -type TrueColor "$cur_normalized" 2>/dev/null

            local compare_output=$(compare -metric AE -fuzz 2% "$ref_normalized" "$cur_normalized" null: 2>&1 || true)
            local diff_pixels=$(echo "$compare_output" | awk '{print $1}')
            [[ "$diff_pixels" =~ [eE] ]] && diff_pixels=$(printf "%.0f" "$diff_pixels")
            [[ "$diff_pixels" =~ ^[0-9]+\.?[0-9]*$ ]] || continue

            local total_pixels=$(identify -format "%[fx:w*h]" "$ref_normalized" 2>/dev/null)
            [[ "$total_pixels" =~ [eE] ]] && total_pixels=$(printf "%.0f" "$total_pixels")
            [ -z "$total_pixels" ] || [ "$total_pixels" = "0" ] && total_pixels=1
            local diff_pct=$(awk "BEGIN {printf \"%.4f\", ($diff_pixels * 100.0) / $total_pixels}")
            local is_match=$(awk "BEGIN {print ($diff_pct < $threshold) ? 1 : 0}")

            if [ "$is_match" -eq 0 ]; then
                echo ""
                echo "  --- $filename (${diff_pct}% different) ---"

                # Content bounds
                local ref_bounds=$(magick "$ref" -flatten -fuzz 1% -trim -format "%w x %h at %O" info: 2>/dev/null || echo "N/A")
                local cur_bounds=$(magick "$current" -fuzz 1% -trim -format "%w x %h at %O" info: 2>/dev/null || echo "N/A")
                echo "    Content bounds:"
                echo "      Ref:     $ref_bounds"
                echo "      Current: $cur_bounds"

                # Sample pixel colors at center
                local ref_dims=$(identify -format "%w %h" "$ref" 2>/dev/null)
                local cx=$(echo "$ref_dims" | awk '{print int($1/2)}')
                local cy=$(echo "$ref_dims" | awk '{print int($2/2)}')
                local ref_pixel=$(magick "$ref" -format "%[pixel:p{$cx,$cy}]" info: 2>/dev/null || echo "N/A")
                local cur_pixel=$(magick "$current" -format "%[pixel:p{$cx,$cy}]" info: 2>/dev/null || echo "N/A")
                echo "    Center pixel ($cx,$cy):"
                echo "      Ref:     $ref_pixel"
                echo "      Current: $cur_pixel"

                # Check for mostly-empty content
                local cur_unique=$(magick "$current" -format %c histogram:info: 2>/dev/null | wc -l)
                if [ "$cur_unique" -lt 10 ]; then
                    echo "    WARNING: Current image has only $cur_unique unique colors (possible rendering issue)"
                fi
            fi
        done
        echo ""
    fi

    if [ "$different" -gt 0 ] || [ "$missing" -gt 0 ]; then
        log_error "$label: FAILED"
        return 1
    else
        log_success "$label: PASSED"
        return 0
    fi
}

# ============================================================================
# Build Functions
# ============================================================================

build_native() {
    log_header "Building Native Test"
    log_step "Running scripts/build-gal-native-test.sh..."

    if "$SCRIPT_DIR/build-gal-native-test.sh"; then
        log_success "Native build succeeded"
    else
        log_error "Native build failed"
        exit 1
    fi
}

build_webgl() {
    log_header "Building WebGL Test"

    if [ ! -f "$SCRIPT_DIR/build-gal-webgl-test.sh" ]; then
        log_step "WebGL build script not found"
        return 0
    fi

    # Delegate to build-gal-webgl-test.sh (handles Emscripten check, clean build, etc.)
    log_step "Running scripts/build-gal-webgl-test.sh..."

    if "$SCRIPT_DIR/build-gal-webgl-test.sh"; then
        log_success "WebGL build succeeded"
    else
        log_error "WebGL build failed"
        log_step "Check if KiCad is built first: docker/build.sh"
        return 0  # Don't fail the whole test, just skip WebGL
    fi
}

# ============================================================================
# Run Functions
# ============================================================================

run_native() {
    log_header "Running Native Test"

    local native_exe="$NATIVE_BUILD_DIR/gal_native_test"

    if [ ! -f "$native_exe" ]; then
        log_error "Native test executable not found: $native_exe"
        log_step "Run build first: ./scripts/test-gal-regression.sh"
        exit 1
    fi

    # Create output directory
    mkdir -p "$NATIVE_OUTPUT_DIR"

    log_step "Running gal_native_test --output $NATIVE_OUTPUT_DIR"

    if "$native_exe" --output "$NATIVE_OUTPUT_DIR"; then
        local count=$(ls -1 "$NATIVE_OUTPUT_DIR"/*.png 2>/dev/null | wc -l | tr -d ' ')
        log_success "Native test completed: $count screenshots generated"
    else
        log_error "Native test failed"
        exit 1
    fi
}

run_webgl() {
    log_header "Running WebGL Test"

    local spec_file="$PROJECT_ROOT/tests/e2e/gal-webgl.spec.ts"

    if [ ! -f "$spec_file" ]; then
        log_step "WebGL test spec not found (Phase 2)"
        return 0
    fi

    # Create output directory
    mkdir -p "$WEBGL_OUTPUT_DIR"

    log_step "Running Playwright test..."

    cd "$PROJECT_ROOT/tests"
    if npx playwright test gal-webgl.spec.ts; then
        local count=$(ls -1 "$WEBGL_OUTPUT_DIR"/*.png 2>/dev/null | wc -l | tr -d ' ')
        log_success "WebGL test completed: $count screenshots generated"
    else
        log_error "WebGL test failed"
        exit 1
    fi
    cd "$PROJECT_ROOT"
}

# ============================================================================
# Compare Functions
# ============================================================================

compare_native_vs_baseline() {
    log_header "Comparing Native vs Baseline"
    compare_screenshots "$BASELINE_DIR" "$NATIVE_OUTPUT_DIR" "native vs baseline"
}

compare_webgl_vs_native() {
    log_header "Comparing WebGL vs Native"

    if [ ! -d "$WEBGL_OUTPUT_DIR" ] || [ -z "$(ls -A "$WEBGL_OUTPUT_DIR" 2>/dev/null)" ]; then
        log_step "WebGL output not found (Phase 2)"
        return 0
    fi

    compare_screenshots "$NATIVE_OUTPUT_DIR" "$WEBGL_OUTPUT_DIR" "webgl vs native"
}

# ============================================================================
# Main
# ============================================================================

log_header "GAL Regression Test Suite"
echo "Project Root: $PROJECT_ROOT"
echo "Baseline Dir: $BASELINE_DIR"
echo "Output Dir:   $OUTPUT_DIR"

# Track overall status
NATIVE_COMPARE_STATUS=0
WEBGL_COMPARE_STATUS=0

if [ "$COMPARE_ONLY" = false ]; then
    # Build phase
    if [ "$RUN_NATIVE" = true ]; then
        build_native
    fi

    if [ "$RUN_WEBGL" = true ]; then
        build_webgl
    fi

    # Run phase
    if [ "$RUN_NATIVE" = true ]; then
        run_native
    fi

    if [ "$RUN_WEBGL" = true ]; then
        run_webgl
    fi
fi

# Compare phase
if [ "$RUN_NATIVE" = true ]; then
    if ! compare_native_vs_baseline; then
        NATIVE_COMPARE_STATUS=1
    fi
fi

if [ "$RUN_WEBGL" = true ]; then
    if ! compare_webgl_vs_native; then
        WEBGL_COMPARE_STATUS=1
    fi
fi

# Final summary
log_header "Final Results"

if [ "$NATIVE_COMPARE_STATUS" -eq 0 ]; then
    log_success "Native vs Baseline: PASSED"
else
    log_error "Native vs Baseline: FAILED"
fi

if [ "$RUN_WEBGL" = true ]; then
    if [ -d "$WEBGL_OUTPUT_DIR" ] && [ -n "$(ls -A "$WEBGL_OUTPUT_DIR" 2>/dev/null)" ]; then
        if [ "$WEBGL_COMPARE_STATUS" -eq 0 ]; then
            log_success "WebGL vs Native: PASSED"
        else
            log_error "WebGL vs Native: FAILED"
        fi
    else
        echo "WebGL vs Native: SKIPPED (Phase 2)"
    fi
fi

# Exit status
if [ "$NATIVE_COMPARE_STATUS" -ne 0 ] || [ "$WEBGL_COMPARE_STATUS" -ne 0 ]; then
    echo ""
    log_error "Some comparisons failed!"
    exit 1
else
    echo ""
    log_success "All comparisons passed!"
    exit 0
fi
