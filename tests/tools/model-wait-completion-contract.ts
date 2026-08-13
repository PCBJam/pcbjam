/**
 * Deterministic source contract for K1/K2/K3 provider completions.
 *
 * Exact main-thread waits must complete through runWaitCompletion. Worker
 * proxy requests have no exact token and must keep their short native apply in
 * the physical completion FIFO. K3 source/network preparation must remain
 * separate from both kinds of native application.
 *
 * Run: cd tests && npm run model-wait:contract
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
const modelBridge = read("web/standalone/src/wasm/libs/models-bridge.ts");
const scheduler = read("scripts/common/shims/asyncify-scheduler.js");

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

const symbolMain = sliceBetween(
  symbols,
  "EM_JS( void, pcbjam_libs_request_start",
  "// Token waits live",
);
const symbolWorker = sliceBetween(
  symbols,
  "static void pcbjam_libs_request_on_main",
  "// Dispatch on the calling thread",
);
const footprintMain = sliceBetween(
  footprints,
  "EM_JS( void, pcbjam_fp_libs_request_start",
  "// Token waits live",
);
const footprintWorker = sliceBetween(
  footprints,
  "static void pcbjam_fp_libs_request_on_main",
  "// Dispatch on the calling thread",
);
const modelMain = sliceBetween(
  models,
  "EM_JS( void, pcbjam_3d_request_start",
  "// Token waits live",
);
const modelWorker = sliceBetween(
  models,
  "static void pcbjam_3d_request_on_main",
  "// Dispatch on the calling thread",
);

for (const [name, main] of [
  ["symbol", symbolMain],
  ["footprint", footprintMain],
  ["3D model", modelMain],
] as const) {
  check(`${name} main path uses the exact-token completion lane`,
    main.includes("scheduler.runWaitCompletion"));
  check(`${name} main path does not queue behind physical readiness`,
    !main.includes("enqueueNativeCompletion"));
}

for (const [name, worker] of [
  ["symbol", symbolWorker],
  ["footprint", footprintWorker],
  ["3D model", modelWorker],
] as const) {
  check(`${name} worker proxy retains the physical completion FIFO`,
    worker.includes("scheduler.enqueueNativeCompletion"));
  check(`${name} worker proxy cannot use an unrelated exact token`,
    !worker.includes("runWaitCompletion"));
}

check("K3 exact completion applies before allocating and returning the path",
  ordered(modelMain, [
    "scheduler.runWaitCompletion",
    "res = res.apply()",
    "_pcbjam_3d_alloc",
    "return ptr",
  ]));
check("K3 worker applies, publishes its result slot, then finishes the exact proxy",
  ordered(modelWorker, [
    "const deliver = () =>",
    "res = res.apply()",
    "_pcbjam_3d_alloc",
    "HEAPU32[resultPtr >> 2] = ptr",
    "_pcbjam_3d_finish( ctx )",
  ]));
check("K3 worker reserves the prepared body's retained bytes",
  modelWorker.includes("value.retainedBytes")
    && modelWorker.includes("scheduler.enqueueNativeCompletion( site, retainedBytes, deliver )"));

const prepare = sliceBetween(
  modelBridge,
  "export function prepareModelInMemfs",
  "async function doEnsure",
);
const ordinaryApply = sliceBetween(
  modelBridge,
  "async function doEnsure",
  "/**\n * Provider dispatch",
);
const preparedApply = sliceBetween(
  modelBridge,
  "function makePreparedModel",
  "/**\n * Complete only the source/IDB/network half",
);

check("model preparation performs source work without touching MEMFS",
  prepare.includes("source.getModelBody(candidate)")
    && !prepare.includes("toolFS()")
    && !prepare.includes("writeFile(")
    && !prepare.includes("runToolNativeEntry("));
check("ordinary prescan/OCC callers still use physical native admission",
  ordered(ordinaryApply, ["prepareModelInMemfs(ref)", "runToolNativeEntry("]));
check("prepared apply checks generation before any MEMFS publication",
  ordered(preparedApply, [
    "generation === installedGeneration",
    "source === installedSource",
    "if (!isCurrent()) return null",
    "const fs = toolFS()",
    "fs.writeFile(target, body)",
  ]));
check("fetch coalescing is separate from physical apply coalescing",
  modelBridge.includes("const preparing = new Map")
    && modelBridge.includes("const prepared = new Map")
    && modelBridge.includes("const ensuring = new Map")
    && prepare.includes("const ready = prepared.get(ref)")
    && prepare.includes("const inFlight = preparing.get(ref)"));

const exactLane = sliceBetween(
  scheduler,
  "runWaitCompletion: function",
  "// Event-time ingress receipts",
);
check("the exact lane prepares output before resolving its token",
  ordered(exactLane, ["var result = prepare()", "self.resolveWait(token, result)"]));
check("the exact lane is not implemented through the physical FIFO",
  !exactLane.includes("enqueueNativeCompletion"));

console.log(
  failures
    ? `model-wait-completion-contract: ${failures} FAILURE(S)`
    : "model-wait-completion-contract: all green",
);
process.exit(failures ? 1 : 0);
