/* The table of this folder's code models, in the form ngspice's code-model loader asks a
 * library for (the role of ngspice's src/xspice/icm/dlmain.c).
 *
 * ngspice loads a code-model library with dlopen() and then asks it five questions with
 * dlsym(). The browser build has no dlopen: a live session answers those calls itself
 * (ngspice_live.cpp, __wrap_dlopen and __wrap_dlsym) and, for the library named "pjcm",
 * hands out the functions below. No ngspice file is changed for this.
 *
 * cmextrn.h, cminfo.h, udnextrn.h and udninfo.h are written by ngspice's own tool (cmpp
 * -lst) from pjcm/modpath.lst and pjcm/udnpath.lst; see CMakeLists.txt.
 */
#include <stdlib.h>

#include "ngspice/config.h"
#include "ngspice/devdefs.h"
#include "ngspice/dllitf.h"
#include "ngspice/evtudn.h"
#include "cmextrn.h"
#include "udnextrn.h"

static SPICEdev *pjcm_devices[] = {
#include "cminfo.h"
    NULL
};

static int pjcm_device_count = sizeof(pjcm_devices) / sizeof(SPICEdev *) - 1;

static Evt_Udn_Info_t *pjcm_udns[] = {
#include "udninfo.h"
    NULL
};

static int pjcm_udn_count = sizeof(pjcm_udns) / sizeof(Evt_Udn_Info_t *) - 1;

/* In a real shared library the code models reach ngspice through this pointer. Here they
 * are linked into the same program and call ngspice directly, so it is only a place for
 * the loader to write to. */
static struct coreInfo_t *pjcm_core = NULL;

int       *pjcm_CMdevNum(void) { return &pjcm_device_count; }
SPICEdev **pjcm_CMdevs(void) { return pjcm_devices; }
int       *pjcm_CMudnNum(void) { return &pjcm_udn_count; }
Evt_Udn_Info_t **pjcm_CMudns(void) { return pjcm_udns; }
struct coreInfo_t **pjcm_CMgetCoreItfPtr(void) { return &pjcm_core; }
