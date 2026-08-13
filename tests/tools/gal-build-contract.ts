/**
 * Deterministic GAL WebGL build contract.
 *
 * The GAL harness is not built by the normal wx test-app Makefile.  Keep its
 * native-EH/Asyncify post-link pipeline and custom HTML shell from silently
 * drifting away from the execution-owner runtime.
 *
 * Run: cd tests && npm run gal:contract
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const sourceHtmlPath = path.join(repo, "tests/gal-regression/wasm/gal_webgl_test.html");
const outputHtmlPath = path.join(repo, "tests/apps/gal-webgl/gal_webgl_test.html");
const makefilePath = path.join(repo, "tests/gal-regression/wasm/Makefile");
const buildScriptPath = path.join(repo, "scripts/build-gal-webgl-test.sh");
const importsPath = path.join(repo, "scripts/common/asyncify-imports.txt");
const findZlibPath = path.join(repo, "wasm/cmake/FindZLIB.cmake");
const outputJsPath = path.join(repo, "tests/apps/gal-webgl/gal_webgl_test.js");
const outputWasmPath = path.join(repo, "tests/apps/gal-webgl/gal_webgl_test.wasm");

const sourceHtml = readFileSync(sourceHtmlPath, "utf8");
const outputHtml = readFileSync(outputHtmlPath, "utf8");
const makefile = readFileSync(makefilePath, "utf8");
const buildScript = readFileSync(buildScriptPath, "utf8");
const asyncifyImports = readFileSync(importsPath, "utf8");
const findZlib = readFileSync(findZlibPath, "utf8");

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }

  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function containsAll(text: string, values: string[]): boolean {
  return values.every((value) => text.includes(value));
}

// The copied browser fixture must always be the exact source harness.  This
// catches editing only tests/apps after a build, which the next clean build
// would silently overwrite.
check("generated GAL HTML matches its source", outputHtml === sourceHtml);

const mainWindowBinding = "var mainWindow = document.getElementById('main-window');";
const bindingIndex = sourceHtml.indexOf(mainWindowBinding);
const firstMainWindowUse = sourceHtml.indexOf("mainWindow.appendChild(canvas);");
const moduleConfigIndex = sourceHtml.indexOf("var Module = {");
check("custom shell defines mainWindow", bindingIndex >= 0);
check(
  "mainWindow is bound before native callbacks and canvas setup",
  bindingIndex >= 0
    && firstMainWindowUse > bindingIndex
    && moduleConfigIndex > bindingIndex,
);

const onReadyIndex = sourceHtml.indexOf("function onModuleReady(module)");
const readyOverlayCall = sourceHtml.indexOf("positionGalOverlay();", onReadyIndex);
const readyNativeCheck = sourceHtml.indexOf("if (!nativeGalReady())", onReadyIndex);
const overlayFunctionIndex = sourceHtml.indexOf("function positionGalOverlay()");
const startFunctionIndex = sourceHtml.indexOf("function startGalModule()");
const factoryResolutionIndex = sourceHtml.indexOf(".then(onModuleReady)", startFunctionIndex);
const overlayFunction = sourceHtml.slice(overlayFunctionIndex, startFunctionIndex);

check("module readiness repositions the GAL overlay", onReadyIndex >= 0
  && readyOverlayCall > onReadyIndex
  && readyOverlayCall < overlayFunctionIndex);
check("overlay is repositioned before native readiness is published", readyOverlayCall >= 0
  && readyNativeCheck > readyOverlayCall
  && readyNativeCheck < overlayFunctionIndex);
check("module factory resolves through onModuleReady", startFunctionIndex >= 0
  && factoryResolutionIndex > startFunctionIndex);
check("GAL overlay has explicit host geometry", containsAll(overlayFunction, [
  "overlay.style.position = 'absolute';",
  "overlay.style.left = '0';",
  "overlay.style.top = '0';",
  "overlay.style.width = '100%';",
  "overlay.style.height = '100%';",
]));
check(
  "script onload enters the guarded module startup",
  sourceHtml.includes('onload="startGalModule()"'),
);

check("GAL link enables dynCall trampolines", makefile.includes("-sDYNCALLS=1"));
check("GAL link enables a 64-KiB Asyncify stack", containsAll(makefile, [
  "-sASYNCIFY=1",
  "-sASYNCIFY_STACK_SIZE=65536",
]));
check(
  "GAL link declares the fiber swap boundary",
  makefile.includes("-sASYNCIFY_IMPORTS=['emscripten_fiber_swap']"),
);
check(
  "post-link Asyncify declares the qualified fiber swap import",
  /^env\.emscripten_fiber_swap\s*$/m.test(asyncifyImports),
);
check("GAL link rejects unresolved native symbols", makefile.includes("-sERROR_ON_UNDEFINED_SYMBOLS=1"));
check("GAL link exports the native readiness probe", makefile.includes("'_isGalReady'"));

// An imported Emscripten port must not turn the compiler's implicit C sysroot
// into an explicit target include.  With Clang 21 that explicit path precedes
// libc++'s C++ wrapper directory.  A forced C++ header then resolves raw
// <stddef.h>/<stdint.h> first and the 3D plug-ins fail before their source is
// parsed.
check("Emscripten zlib remains on the link interface", findZlib.includes(
  'INTERFACE_LINK_LIBRARIES "-sUSE_ZLIB=1"',
));
check("Emscripten C sysroot is not exported as a target include", !findZlib.includes(
  'INTERFACE_INCLUDE_DIRECTORIES "${ZLIB_INCLUDE_DIR}"',
));

const overlayIndex = buildScript.indexOf('export EM_BINARYEN_ROOT="$GAL_BINARYEN_OVERLAY"');
const buildIndex = buildScript.indexOf('make -j"${JOBS:-1}"');
const asyncifyIndex = buildScript.indexOf('"$SCRIPT_DIR/common/apply-asyncify.sh" --no-removelist');
const schedulerIndex = buildScript.indexOf('"$SCRIPT_DIR/common/inject-dyncall-shims.sh" gal_webgl_test.js');

check("GAL link uses a private Binaryen overlay", overlayIndex >= 0);
check("private overlay keeps the real wasm finalizer", containsAll(buildScript, [
  'ln -s "$WASMOPT_STUB" "$GAL_BINARYEN_OVERLAY/bin/wasm-opt"',
  'ln -s "$REAL_FINALIZE" "$GAL_BINARYEN_OVERLAY/bin/wasm-emscripten-finalize"',
]));
check("GAL post-link Asyncify runs after the native link", buildIndex >= 0
  && asyncifyIndex > buildIndex);
check("scheduler injection runs after post-link Asyncify", schedulerIndex > asyncifyIndex);

// Generated JS/WASM are intentionally not tracked.  When setup or a local
// build provides them, make this contract reject stale pre-fix artifacts too.
if (existsSync(outputJsPath) || existsSync(outputWasmPath)) {
  check("generated GAL JS and WASM are both present",
    existsSync(outputJsPath) && existsSync(outputWasmPath));

  if (existsSync(outputJsPath) && existsSync(outputWasmPath)) {
    const outputJs = readFileSync(outputJsPath, "utf8");
    const outputWasm = readFileSync(outputWasmPath);
    const fiberMarkerIndex = outputJs.indexOf("_emscripten_fiber_swap.isAsync = true;");
    const schedulerMarkerIndex = outputJs.indexOf("__WX_SCHEDULER_SHIM_SOURCE__");

    check("generated GAL JS contains Asyncify glue",
      outputJs.includes("Asyncify.instrumentWasmExports"));
    check("generated GAL JS contains the execution-owner scheduler",
      schedulerMarkerIndex > fiberMarkerIndex && fiberMarkerIndex >= 0);
    check("generated GAL WASM was post-link Asyncified", [
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ].every((name) => outputWasm.includes(Buffer.from(name))));
  }
} else {
  console.log("skip generated GAL artifact checks (harness not built)");
}

console.log(failures ? `gal-build-contract: ${failures} FAILURE(S)` : "gal-build-contract: all green");
process.exit(failures ? 1 : 0);
