#!/bin/bash
#
# Build script for the native GAL test harness
#
# This builds a standalone test application that uses KiCad's actual OPENGL_GAL
# to render test scenarios and generate baseline screenshots.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR="$PROJECT_ROOT/tests/gal-regression/native"
BUILD_DIR="$TEST_DIR/build"
LOG_FILE="$PROJECT_ROOT/tests/logs/gal-native-build.log"

# Create log directory
mkdir -p "$(dirname "$LOG_FILE")"

echo "Building GAL Native Test..."
echo "  Test dir: $TEST_DIR"
echo "  Build dir: $BUILD_DIR"
echo "  Log file: $LOG_FILE"

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Regenerate the small checked-in shader wrappers on every build. This keeps the
# harness in sync when KiCad adds or changes a built-in shader.
echo "Generating shader headers..."
python3 "$TEST_DIR/generate_shaders.py" >> "$LOG_FILE" 2>&1

# Configure
echo "Running CMake..."
cmake .. >> "$LOG_FILE" 2>&1
CMAKE_STATUS=$?

if [ $CMAKE_STATUS -ne 0 ]; then
    echo "CMake configuration failed! Check $LOG_FILE for details."
    echo ""
    echo "Last 50 lines of log:"
    tail -50 "$LOG_FILE"
    exit 1
fi

# Build
echo "Building..."
make -j$(sysctl -n hw.ncpu 2>/dev/null || echo 4) >> "$LOG_FILE" 2>&1
BUILD_STATUS=$?

if [ $BUILD_STATUS -ne 0 ]; then
    echo "Build failed! Check $LOG_FILE for details."
    echo ""
    echo "Last 100 lines of log:"
    tail -100 "$LOG_FILE"
    exit 1
fi

echo "Build successful!"
echo "Executable: $BUILD_DIR/gal_native_test"
echo ""
echo "To run:"
echo "  $BUILD_DIR/gal_native_test"
echo ""
echo "Options:"
echo "  --output <dir>   Output directory for baseline PNGs"
echo "  --width <w>      Canvas width (default: 800)"
echo "  --height <h>     Canvas height (default: 600)"
echo "  --show           Show window (default: headless)"
