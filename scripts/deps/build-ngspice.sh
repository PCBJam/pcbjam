#!/bin/bash
w# Build ngspice for WebAssembly: sharedspice STATIC library + statically
# registered XSPICE code models. Consumed by the ngspice_service worker that
# backs KiCad eeschema's simulator.
#
# Deviations from a stock ngspice build, all load-bearing for wasm:
#  - --with-ngshared + --disable-shared: libtool builds libngspice.a with the
#    sharedspice API (ngSpice_Init & co.) compiled in and no CLI programs
#    (bin_PROGRAMS is gated !SHARED_MODULE upstream, so no duplicate main()).
#  - XSPICE code models (.cm) are dlopen'd at runtime natively, which a static
#    wasm module cannot do. Under NGCM_STATIC the icm build archives each code
#    model instead of linking a shared object (per-cm renamed table symbols via
#    ngcm_dlmain_static.c), and a registry appended to dev.c resolves the seven
#    bundled .cm basenames without dlopen. dlopen remains the fallback for
#    unknown paths so user code models fail with ngspice's normal error text.
#    Sources in scripts/deps/ngspice-wasm/; edits to the ngspice tree are
#    idempotent (marker-guarded) since the tree is an extracted tarball.
#  - /proc/meminfo header check is forced off: configure runs on the build
#    host (Linux in docker), the browser runtime has no procfs, and ngspice's
#    memory guard treats "0 bytes available" as out-of-memory.
#  - -pthread everywhere: sharedspice's bg_run/bg_halt background thread is
#    gated on HAVE_LIBPTHREAD; without it bg_run silently degrades to a
#    synchronous blocking call.
#  - Exception model must match the rest of the tree (DEPS_EH_FLAGS).
#  - XSPICE + CIDER enabled: parity with native KiCad's bundled ngspice.
#  - cmpp (XSPICE preprocessor) runs on the build host; ngspice's configure
#    handles that itself when cross_compiling=yes (src/xspice/cmpp/build/).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"

NGSPICE_DIR="${DEPS_ROOT}/ngspice-${NGSPICE_VERSION}"
NGSPICE_BUILD="${BUILD_ROOT}/deps/ngspice"
NGSPICE_STAMP="${BUILD_ROOT}/stamps/ngspice.stamp"
NGCM_SRC_DIR="${SCRIPT_DIR}/ngspice-wasm"

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
    log_info "Cleaning ngspice build..."
    rm -rf "${NGSPICE_BUILD}" "${NGSPICE_STAMP}"
fi

# Check if already built
if check_stamp "${NGSPICE_STAMP}"; then
    log_info "ngspice already built, skipping..."
    exit 0
fi

# Download if needed
if [ ! -d "${NGSPICE_DIR}" ]; then
    log_info "Downloading ngspice ${NGSPICE_VERSION}..."
    mkdir -p "${DEPS_ROOT}"
    cd "${DEPS_ROOT}"

    download_file "${NGSPICE_URL}" "ngspice-${NGSPICE_VERSION}.tar.gz" "${NGSPICE_SHA256}"
    tar -xzf "ngspice-${NGSPICE_VERSION}.tar.gz"
    rm "ngspice-${NGSPICE_VERSION}.tar.gz"
fi

# ---------------------------------------------------------------------------
# Static code-model support (NGCM_STATIC) - idempotent source edits
# ---------------------------------------------------------------------------

DEV_C="${NGSPICE_DIR}/src/spicelib/devices/dev.c"
ICM_MK="${NGSPICE_DIR}/src/xspice/icm/GNUmakefile.in"

# 1. Hook load_opus(): consult the registry before attempting dlopen.
#    Must run BEFORE the registry append: the registry body contains the
#    ngcm_static_load definition, so a plain grep for the name would mask the
#    hook forever. The guard matches the call site only.
if ! grep -q "ngcm_static_load(name)" "${DEV_C}"; then
    log_info "Inserting registry hook into load_opus()"
    python3 - "${DEV_C}" <<'EOF'
import sys

path = sys.argv[1]
src = open(path).read()
anchor = "    lib = dlopen(name, RTLD_NOW);"
hook = """#ifdef NGCM_STATIC
    {
        extern int ngcm_static_load(const char *path);
        int ngcm_ret = ngcm_static_load(name);
        if (ngcm_ret >= 0)
            return ngcm_ret;
        /* not a bundled code model: fall through to dlopen */
    }
#endif
"""
assert src.count(anchor) == 1, "load_opus dlopen anchor not unique"
open(path, "w").write(src.replace(anchor, hook + anchor))
EOF
fi

# 2. Append the code-model registry to dev.c (marker-guarded).
if ! grep -q "NGCM_REGISTRY_MARKER" "${DEV_C}"; then
    log_info "Appending static code-model registry to dev.c"
    cat "${NGCM_SRC_DIR}/ngcm_registry.c" >> "${DEV_C}"
fi

# 3. Fix an upstream 32-bit union-punning bug in the CIDER card parser
#    (found by the Gate-1 smoke, ngspice 46). The cleanup tests use
#    `dataType & IF_REALVEC` (0x8004): every scalar IF_SET|IF_REAL parameter
#    (0x2004) matches through the shared 0x4 bit, and the code then frees the
#    vec-pointer union member overlaying the parsed scalar double. On 64-bit
#    hosts that misread lands in zeroed padding after the double
#    (free(NULL) no-op), which is why upstream never noticed; on wasm32 the
#    pointer member overlays the HIGH HALF of the double and free() faults.
#    TODO: upstream this to ngspice.
python3 - "${NGSPICE_DIR}/src/spicelib/parser/inpgmod.c" <<'EOF'
import sys

path = sys.argv[1]
src = open(path).read()
old = """                if (info->cardParms[idx].dataType & IF_STRING) {
                    FREE(value->sValue);
                } else if (info->cardParms[idx].dataType & IF_REALVEC) {
                    FREE(value->v.vec.rVec);
                } else if (info->cardParms[idx].dataType & IF_INTVEC) {
                    FREE(value->v.vec.iVec);
                }"""
new = """                /* kicad-wasm: exact variant-type tests. The original
                 * `& IF_REALVEC` composite masks also match scalar
                 * IF_SET|IF_REAL parameters (shared 0x4 bit) and free the
                 * vec-pointer union member overlaying the scalar double -
                 * benign on 64-bit (lands in zero padding), heap fault on
                 * wasm32. */
                int ngcm_vt = info->cardParms[idx].dataType & IF_VARTYPES;
                if (ngcm_vt == IF_STRING) {
                    FREE(value->sValue);
                } else if (ngcm_vt == IF_REALVEC) {
                    FREE(value->v.vec.rVec);
                } else if (ngcm_vt == IF_INTVEC) {
                    FREE(value->v.vec.iVec);
                }"""
if new in src:
    pass  # already applied
else:
    assert src.count(old) == 1, "inpgmod.c cleanup-tests anchor not found"
    open(path, "w").write(src.replace(old, new))
    print("patched inpgmod.c IF_VARTYPES cleanup tests")
EOF

# 4. Redirect the icm build: archive code models instead of shared-linking,
#    compile our renamed-tables TU instead of dlmain.c, and pass the cm name.
#    All three edits are exact-string replacements, applied once.
python3 - "${ICM_MK}" <<'EOF'
import sys

path = sys.argv[1]
src = open(path).read()

edits = [
    # .cm link recipe -> archive under NGCM_STATIC. The three common objects
    # are excluded: dstring.o duplicates the core's, and the tline commons are
    # shipped once via ngcm_common.a (they are prerequisites of every cm here
    # but only the tlines models reference them).
    ("\t$(CC) $(CFLAGS) $(EXTRA_CFLAGS) $(VIS_CFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@",
     "\t$(if $(NGCM_STATIC),emar rcs $@ $(filter-out dstring.o msline_common.o tline_common.o,$^),$(CC) $(CFLAGS) $(EXTRA_CFLAGS) $(VIS_CFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@)"),
    # dlmain.o compiles our static-tables TU under NGCM_STATIC ($< follows the
    # first prerequisite).
    ("$(cm)/dlmain.o : $(srcdir)/dlmain.c $(cm-descr)",
     "$(cm)/dlmain.o : $(if $(NGCM_STATIC),$(NGCM_DLMAIN),$(srcdir)/dlmain.c) $(cm-descr)"),
    # Per-cm symbol prefix for the tables TU (harmless for the other objects).
    ("COMPILE = $(CC) $(INCLUDES) -I$(cm) -I$(srcdir)/$(cm) $(CFLAGS) $(EXTRA_CFLAGS) $(VIS_CFLAGS)",
     "COMPILE = $(CC) $(INCLUDES) -I$(cm) -I$(srcdir)/$(cm) $(CFLAGS) $(EXTRA_CFLAGS) $(VIS_CFLAGS) $(if $(NGCM_STATIC),-DNGCM_NAME=$(cm))"),
    # The $(shell cmpp -p) model-list calls hardcode the in-tree cmpp, which
    # is the CROSS-compiled (wasm) binary the build host cannot execute -
    # the lists come back empty and the code models silently lose all their
    # cfunc/ifspec objects. makedefs' CMPP is the host-built one under
    # cross-compilation (configure.ac:1470-1475).
    ("""ifeq ($(OS),Windows_NT)
    cmpp = ../cmpp/cmpp.exe
else
    cmpp = ../cmpp/cmpp
endif""",
     "cmpp = $(CMPP)"),
]

changed = False
for old, new in edits:
    if new in src:
        continue  # already applied
    assert old in src, f"icm GNUmakefile.in anchor not found: {old!r}"
    src = src.replace(old, new)
    changed = True

if changed:
    open(path, "w").write(src)
    print("patched icm GNUmakefile.in")
EOF

log_info "Building ngspice ${NGSPICE_VERSION} for WASM..."

mkdir -p "${NGSPICE_BUILD}"
cd "${NGSPICE_BUILD}"

# ngspice must run at real speed even in debug builds of the rest of the tree:
# the simulator is compute-bound and its own module is finalized separately.
if [ "${DEBUG_BUILD:-1}" = "1" ]; then
    NGSPICE_OPT="-O2 -g"
else
    NGSPICE_OPT="-O2"
fi

# -Wno-error guards: CIDER and parts of XSPICE are legacy C that modern clang
# (emcc >= llvm 16) rejects by default.
export CFLAGS="${NGSPICE_OPT} -pthread ${DEPS_EH_FLAGS} -DNGCM_STATIC \
-Wno-error=implicit-function-declaration -Wno-error=implicit-int"
export CXXFLAGS="${NGSPICE_OPT} -pthread ${DEPS_EH_FLAGS}"
export LDFLAGS="-pthread ${DEPS_EH_FLAGS}"

# Makefile-level knobs for the icm (code model) build, read from the
# environment by our GNUmakefile.in edits above.
export NGCM_STATIC=1
export NGCM_DLMAIN="${NGCM_SRC_DIR}/ngcm_dlmain_static.c"

emconfigure "${NGSPICE_DIR}/configure" \
    --prefix="${SYSROOT}" \
    --host=wasm32-unknown-emscripten \
    --build="$("${NGSPICE_DIR}/config.guess")" \
    --with-ngshared \
    --disable-shared \
    --enable-static \
    --enable-xspice \
    --enable-cider \
    --disable-openmp \
    --disable-debug \
    --without-x \
    --with-readline=no \
    --without-editline \
    ac_cv_header__proc_meminfo=no

# ngspice hardwires libtool's -shared mode for the ngshared build: configure
# sets STATIC=-shared (consumed as AM_CFLAGS by every convenience lib) and
# src/Makefile.am gives libngspice_la_{CFLAGS,LDFLAGS} a literal -shared.
# libtool refuses -shared outright on a target without shared-library support
# ("Fatal configuration error"), so force static mode: the make command line
# overrides $(STATIC) everywhere, and the two hardwired lines are rewritten in
# the generated Makefile (regenerated by configure on every build, so this
# stays idempotent).
sed -i.ngcm.bak \
    -e 's/^\(libngspice_la_[A-Z]*FLAGS *=.*\)-shared/\1-static/' \
    src/Makefile

# The XSPICE verilog/vhdl subdirs build VPI co-simulation shims (ivlng.la,
# ivlngvpi.la) that are inherently SHARED objects plugging into an external
# Icarus/GHDL process - impossible in wasm and unbuildable without shared-lib
# support. Skipping them matches native behaviour when no cosimulator is
# installed: the d_cosim code model fails at runtime with ngspice's normal
# error message.
sed -i.ngcm.bak \
    -e 's/^\(SUBDIRS = mif cm enh evt idn cmpp icm\) verilog vhdl$/\1/' \
    src/xspice/Makefile

emmake make -j${JOBS} STATIC=-static
emmake make install STATIC=-static

# dlmain.c's tail (fopen_with_path, cm_message_printf, cm_is_inertial) is
# utility code the cfunc objects call but that exists nowhere in the core -
# natively each .cm DLL carries its own copy. Extract it once from the
# pristine dlmain.c (BSD-3) so the seven archives stay collision-free; the
# coreitf wrapper section above the marker must NOT come along (it would
# shadow real core functions with calls through a never-initialized coreitf).
python3 - "${NGSPICE_DIR}/src/xspice/icm/dlmain.c" "${NGSPICE_BUILD}/ngcm_cmutil.c" <<'EOF'
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
src = open(src_path).read()
marker = "#define DFLT_BUF_SIZE   256"
assert src.count(marker) == 1, "dlmain.c utility-tail marker not unique"
tail = src[src.index(marker):]
preamble = """/* Generated by build-ngspice.sh: utility tail of ngspice's
 * src/xspice/icm/dlmain.c (BSD-3-Clause, Copyright 2000 The ngspice team),
 * shared once across the statically linked code models. */
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ngspice/config.h"
#include "ngspice/cpextern.h"
#include "ngspice/devdefs.h"
#include "ngspice/dstring.h"
#include "ngspice/dllitf.h"
#include "ngspice/evtudn.h"
#include "ngspice/inpdefs.h"
#include "ngspice/inertial.h"
#include "ngspice/cmproto.h"

/* In the DLL world cm_getvar is a dlmain.c wrapper that reaches the core's
 * cp_getvar through coreitf (see cmexport.c binding dllitf_cm_getvar to
 * cp_getvar). Statically there is no coreitf; bind it directly. */
bool cm_getvar(char *name, enum cp_types type, void *retval, size_t rsize)
{
    return cp_getvar(name, type, retval, rsize);
}

"""
open(out_path, "w").write(preamble + tail)
EOF

emcc -c "${NGSPICE_BUILD}/ngcm_cmutil.c" -o "${NGSPICE_BUILD}/ngcm_cmutil.o" \
    ${CFLAGS} \
    -I"${NGSPICE_DIR}/src/include" \
    -I"${NGSPICE_BUILD}/src/include"

# The tline/msline common objects every cm build compiles but only the tlines
# models reference; shipped once so whole-archiving the .cm archives stays
# duplicate-free.
emar rcs "${SYSROOT}/lib/ngspice/ngcm_common.a" \
    src/xspice/icm/msline_common.o \
    src/xspice/icm/tline_common.o \
    src/xspice/icm/dstring.o \
    "${NGSPICE_BUILD}/ngcm_cmutil.o"

# Sanity: everything the ngspice_service link needs must exist.
for f in \
    "${SYSROOT}/lib/libngspice.a" \
    "${SYSROOT}/include/ngspice/sharedspice.h" \
    "${SYSROOT}/lib/ngspice/analog.cm" \
    "${SYSROOT}/lib/ngspice/digital.cm" \
    "${SYSROOT}/lib/ngspice/spice2poly.cm" \
    "${SYSROOT}/lib/ngspice/table.cm" \
    "${SYSROOT}/lib/ngspice/tlines.cm" \
    "${SYSROOT}/lib/ngspice/xtradev.cm" \
    "${SYSROOT}/lib/ngspice/xtraevt.cm" \
    "${SYSROOT}/share/ngspice/scripts/spinit"; do
    if [ ! -f "$f" ]; then
        log_error "ngspice install incomplete: missing $f"
        exit 1
    fi
done

create_stamp "${NGSPICE_STAMP}"
log_info "ngspice build complete!"
