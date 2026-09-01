/**
 * Deterministic source contract for allocation failure at JS-to-Wasm bridges
 * (finding F-3, ported from the codex-core reference checker onto the JSPI
 * line's producers).
 *
 * A Wasm allocator returns address 0 on failure — and address 0 IS writable
 * wasm memory, so an unchecked write there silently corrupts the low heap.
 * These producers must never treat a null allocation as writable: pointer-
 * result bridges settle their wait with the ordinary failure value 0 that
 * their native callers already understand; the ngspice vector bridge
 * publishes only a complete allocation set (and keeps the E-11 length clamp);
 * the ngspice event path drops an unallocatable line without entering native.
 *
 * Run: cd tests && npm run allocator-zero:contract
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

const repo = path.resolve(__dirname, "../..");

const read = (relative: string): string =>
  readFileSync(path.join(repo, relative), "utf8");

const symbols = read("kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp");
const footprints = read("kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp");
const models = read("kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp");
const exporter = read("wasm/stubs/exporter_step_stub.cpp");
const oce = read("wasm/stubs/oce_plugin_stub.cpp");
const ngspice = read("wasm/stubs/sharedspice_client.cpp");
const secrets = read("wasm/kiplatform/secrets.cpp");
const sysinfo = read("wasm/kiplatform/sysinfo.cpp");

let failures = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }

  failures++;
  console.error(`FAIL ${name}`);
}

function sliceBetween(text: string, start: string, end: string): string {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  return first >= 0 && last > first ? text.slice(first, last) : "";
}

function ordered(text: string, tokens: string[]): boolean {
  let cursor = -1;

  for (const token of tokens) {
    cursor = text.indexOf(token, cursor + 1);
    if (cursor < 0) return false;
  }

  return true;
}

// The symbol/footprint bridges copy two shapes: raw bytes (Uint8Array) and a
// UTF-8 string. Both allocations must be guarded, and the failure must settle
// the wait with 0 (the callers' existing "request unavailable" value).
function guardedByteAndStringCopies(
  text: string,
  allocator: string,
  settle: string
): boolean {
  const escaped = allocator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bytes = new RegExp(
    `const p = ${escaped}\\( res\\.length \\+ 1 \\);\\s*\\n\\s*if\\( !p \\)\\s*\\n\\s*(return )?\\{?\\s*${settle}\\( 0 \\)`
  );
  const string = new RegExp(
    `const ptr = ${escaped}\\( len \\);\\s*\\n\\s*if\\( !ptr \\)\\s*\\n\\s*(return )?\\{?\\s*${settle}\\( 0 \\)`
  );
  // Every allocation in the slice carries a guard — a new unguarded producer
  // in the same function cannot slip past the two shape regexes above.
  const allocs = (text.match(new RegExp(escaped + "\\(", "g")) ?? []).length;
  const guards = (text.match(/if\( !(p|ptr) \)/g) ?? []).length;
  return bytes.test(text) && string.test(text) && allocs === guards;
}

const symbolMain = sliceBetween(
  symbols,
  "EM_JS( void, pcbjam_libs_request_start",
  "// Token waits live"
);
const symbolProxy = sliceBetween(
  symbols,
  "static void pcbjam_libs_request_on_main",
  "// Single-flight throttle"
);
const footprintMain = sliceBetween(
  footprints,
  "EM_JS( void, pcbjam_fp_libs_request_start",
  "// Token waits live"
);
const footprintProxy = sliceBetween(
  footprints,
  "static void pcbjam_fp_libs_request_on_main",
  "// Single-flight throttle"
);

check(
  "symbol main guards byte and string writes and settles 0 on a miss",
  guardedByteAndStringCopies(symbolMain, "_pcbjam_libs_alloc", "finish")
);
check(
  "symbol proxy guards byte and string writes and settles 0 on a miss",
  guardedByteAndStringCopies(symbolProxy, "_pcbjam_libs_alloc", "done")
);
check(
  "footprint main guards byte and string writes and settles 0 on a miss",
  guardedByteAndStringCopies(footprintMain, "_pcbjam_fp_libs_alloc", "finish")
);
check(
  "footprint proxy guards byte and string writes and settles 0 on a miss",
  guardedByteAndStringCopies(footprintProxy, "_pcbjam_fp_libs_alloc", "done")
);

// The proxy halves must still release the blocked worker on a miss: done()
// publishes the (null) result and calls the finish export in one place.
for (const [name, proxy, finish] of [
  ["symbol", symbolProxy, "_pcbjam_libs_finish( ctx )"],
  ["footprint", footprintProxy, "_pcbjam_fp_libs_finish( ctx )"],
  ["3D", sliceBetween(models, "static void pcbjam_3d_request_on_main", "// Single-flight throttle"), "_pcbjam_3d_finish( ctx )"],
] as const) {
  check(
    `${name} proxy publishes the result pointer and finishes through one settle path`,
    ordered(proxy, ["const done = ( ptr ) =>", "HEAPU32[resultPtr >> 2] = ptr", finish])
  );
}

const modelMain = sliceBetween(
  models,
  "EM_JS( void, pcbjam_3d_request_start",
  "// Token waits live"
);
const modelProxy = sliceBetween(
  models,
  "static void pcbjam_3d_request_on_main",
  "// Single-flight throttle"
);
const guardedModelPath = (text: string, settle: string): boolean =>
  new RegExp(
    `const ptr = _pcbjam_3d_alloc\\( len \\);\\s*\\n\\s*if\\( !ptr \\)\\s*\\n\\s*(return )?\\{?\\s*${settle}\\( 0 \\)`
  ).test(text);

check("3D main path guards its result write and settles 0 on a miss",
  guardedModelPath(modelMain, "finish"));
check("3D proxy guards its result write and settles 0 on a miss",
  guardedModelPath(modelProxy, "done"));

// Pointer-result completion gates (JSON/path rides the wait as an int32; the
// native side already parses null as "{}" / treats it as no-result).
function guardedPointerResult(text: string, start: string, end: string): boolean {
  const body = sliceBetween(text, start, end);
  return /const p = _malloc\( n \);\s*\n\s*if\( !p \)\s*\n\s*return 0;[^\n]*\n\s*stringToUTF8/.test(
    body
  );
}

check("OCC export completion resolves 0 without a write on a miss",
  guardedPointerResult(exporter, "const finish =", "let req;"));
check("OCC model completion resolves 0 without a write on a miss",
  guardedPointerResult(oce, "const finish =", "let req;"));
check("ngspice request completion resolves 0 without a write on a miss",
  guardedPointerResult(ngspice, "const finish =", "let req;"));

const vector = sliceBetween(
  ngspice,
  "EM_JS( void, js_ngspice_get_vec_start",
  "// Event dispatcher"
);

check("ngspice vector outputs start unpublished", ordered(vector, [
  "HEAP32[aMeta >> 2] = 0",
  "HEAPU32[aReal >> 2] = 0",
  "HEAPU32[aComp >> 2] = 0",
  "HEAPU32[aVName >> 2] = 0",
]));
check("ngspice vector keeps the E-11 transfer-clamped length", ordered(vector, [
  "Math.max( 0, res.length | 0 )",
  "Math.min( length, nReal )",
  "Math.min( length, nComp >> 1 )",
]));
check("ngspice vector allocates and guards the complete result before copying",
  ordered(vector, [
    "real = _malloc",
    "if( !real )",
    "comp = _malloc",
    "if( !comp )",
    "vname = _malloc",
    "if( !vname )",
    "HEAPF64.set( res.real, real >> 3 )",
    "HEAPF64.set( res.comp, comp >> 3 )",
    "stringToUTF8( s, vname, n )",
  ]));
check("ngspice vector frees partial allocations and returns ordinary error status",
  (vector.match(/release\(\);\s+return 1;/g) ?? []).length === 3);
check("ngspice vector publishes pointers and found only after all copies",
  ordered(vector, [
    "stringToUTF8( s, vname, n )",
    "HEAPU32[aReal >> 2] = real",
    "HEAPU32[aComp >> 2] = comp",
    "HEAPU32[aVName >> 2] = vname",
    "HEAP32[aMeta >> 2] = 1",
  ]));

// The event dispatcher: an unallocatable line is dropped loudly BEFORE the
// native entry (never a native call carrying a write through address 0).
const eventCall = sliceBetween(
  ngspice,
  "const call = ( kind, text, a, b ) =>",
  "pendingText = 0;"
);
check("ngspice event line drops allocation failure before entering native",
  ordered(eventCall, [
    "p = _malloc( n )",
    "if( !p )",
    "return;",
    "stringToUTF8( text, p, n )",
    "_pcbjam_ngspice_event( kind, p",
  ]));

// Synchronous EM_ASM_PTR producers found on the current line (same defect
// class; their natives already treat 0 as "not available").
check("secrets GetSecret guards its copy and returns 0 on a miss",
  /var buf = _malloc\(len\);\s*\n\s*if \(!buf\) \{?\s*\n?\s*return 0;/.test(secrets));
check("sysinfo GPU renderer guards its copy and returns 0 on a miss",
  /var buf = _malloc\(len\);\s*\n\s*if \(!buf\) \{?\s*\n?\s*return 0;/.test(sysinfo));

console.log(
  failures
    ? `allocator-zero-contract: ${failures} FAILURE(S)`
    : "allocator-zero-contract: all green"
);
process.exit(failures ? 1 : 0);
