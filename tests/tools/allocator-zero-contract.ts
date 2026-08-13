/**
 * Deterministic source contract for allocation failure at JS-to-Wasm bridges.
 *
 * A Wasm allocator returns address 0 on failure. These producers must never
 * treat that address as writable memory. Pointer-result waits resolve 0 as the
 * ordinary failure value already understood by their native callers. The
 * ngspice vector bridge publishes only a complete allocation set, and the
 * fire-and-forget output batch drops an unallocatable batch without poisoning
 * the native execution owner.
 *
 * Run: cd tests && npm run allocator-zero:contract
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const read = (relative: string): string =>
  readFileSync(path.join(repo, relative), "utf8");

const symbols = read("kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp");
const footprints = read("kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp");
const models = read("kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp");
const exporter = read("wasm/stubs/exporter_step_stub.cpp");
const oce = read("wasm/stubs/oce_plugin_stub.cpp");
const ngspice = read("wasm/stubs/sharedspice_client.cpp");

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

function guardedByteAndStringCopies(text: string, allocator: string): boolean {
  const escaped = allocator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bytes = new RegExp(
    `ptr = ${escaped}\\( res\\.length \\+ 1 \\);\\s+if\\( ptr \\)\\s+\\{\\s+HEAPU8\\.set`,
  );
  const string = new RegExp(
    `ptr = ${escaped}\\( len \\);\\s+if\\( ptr \\)\\s+stringToUTF8`,
  );
  return bytes.test(text) && string.test(text);
}

const symbolMain = sliceBetween(
  symbols,
  "EM_JS( void, pcbjam_libs_request_start",
  "// Token waits live",
);
const symbolProxy = sliceBetween(
  symbols,
  "static void pcbjam_libs_request_on_main",
  "// Dispatch on the calling thread",
);
const footprintMain = sliceBetween(
  footprints,
  "EM_JS( void, pcbjam_fp_libs_request_start",
  "// Token waits live",
);
const footprintProxy = sliceBetween(
  footprints,
  "static void pcbjam_fp_libs_request_on_main",
  "// Dispatch on the calling thread",
);

for (const [name, source, allocator] of [
  ["symbol main", symbolMain, "_pcbjam_libs_alloc"],
  ["symbol proxy", symbolProxy, "_pcbjam_libs_alloc"],
  ["footprint main", footprintMain, "_pcbjam_fp_libs_alloc"],
  ["footprint proxy", footprintProxy, "_pcbjam_fp_libs_alloc"],
] as const) {
  check(`${name} guards byte and string writes`,
    guardedByteAndStringCopies(source, allocator));
}

for (const [name, proxy, resultSlot, finish] of [
  ["symbol", symbolProxy, "HEAPU32[resultPtr >> 2] = ptr", "_pcbjam_libs_finish( ctx )"],
  ["footprint", footprintProxy, "HEAPU32[resultPtr >> 2] = ptr", "_pcbjam_fp_libs_finish( ctx )"],
] as const) {
  check(`${name} proxy publishes null and finishes after an allocation miss`,
    ordered(proxy, ["if( ptr )", resultSlot, finish]));
}

const modelMain = sliceBetween(
  models,
  "EM_JS( void, pcbjam_3d_request_start",
  "// Token waits live",
);
const modelProxy = sliceBetween(
  models,
  "static void pcbjam_3d_request_on_main",
  "// Dispatch on the calling thread",
);
const guardedModelPath = (text: string): boolean =>
  /ptr = _pcbjam_3d_alloc\( len \);\s+if\( ptr \)\s+stringToUTF8/.test(text);

check("3D main path guards its result-path write",
  guardedModelPath(modelMain));
check("3D proxy guards its result-path write and still finishes",
  guardedModelPath(modelProxy)
    && ordered(modelProxy, [
      "if( ptr )",
      "HEAPU32[resultPtr >> 2] = ptr",
      "_pcbjam_3d_finish( ctx )",
    ]));

function guardedPointerResult(text: string, start: string, end: string): boolean {
  const body = sliceBetween(text, start, end);
  return /const p = _malloc\( n \);\s+if\( !p \)\s+return 0;\s+stringToUTF8/.test(body)
    && !body.includes("wxWasmExecutionFailStop");
}

check("OCC export resolves null without a write or global failure",
  guardedPointerResult(exporter, "const finish =", "let req;"));
check("OCC model resolves null without a write or global failure",
  guardedPointerResult(oce, "const complete =", "let req;"));
check("ngspice request resolves null without a write or global failure",
  guardedPointerResult(ngspice, "const finish =", "let req;"));

const vector = sliceBetween(
  ngspice,
  "EM_JS( void, js_ngspice_get_vec_start",
  "// Token waits live",
);

check("ngspice vector outputs start unpublished", ordered(vector, [
  "HEAP32[aMeta >> 2] = 0",
  "HEAPU32[aReal >> 2] = 0",
  "HEAPU32[aComp >> 2] = 0",
  "HEAPU32[aVName >> 2] = 0",
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
  (vector.match(/release\(\);\s+return 1;/g) ?? []).length === 3
    && !vector.includes("wxWasmExecutionFailStop"));
check("ngspice vector publishes pointers and found only after all copies", ordered(vector, [
  "stringToUTF8( s, vname, n )",
  "HEAPU32[aReal >> 2] = real",
  "HEAPU32[aComp >> 2] = comp",
  "HEAPU32[aVName >> 2] = vname",
  "HEAP32[aMeta >> 2] = 1",
]));

const eventBatch = sliceBetween(
  ngspice,
  "enqueue( 'ngspice output event'",
  "} else if( evt.kind === 'bg' )",
);
check("ngspice event batch drops allocation failure before writing or entering native",
  ordered(eventBatch, [
    "enqueue( 'ngspice output event', payloadBytes, ( module ) =>",
    "const p = _malloc( n )",
    "if( !p )",
    "return;",
    "stringToUTF8( payload, p, n )",
    "module._pcbjam_ngspice_event_batch( kind, p )",
  ]) && !eventBatch.includes("wxWasmExecutionFailStop"));

console.log(failures
  ? `allocator-zero-contract: ${failures} FAILURE(S)`
  : "allocator-zero-contract: all green");
process.exit(failures ? 1 : 0);
