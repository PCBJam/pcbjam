/**
 * Source-contract tripwire for the findings group E fixes that live in C++
 * (EM_JS bridges and KiCad simulator code) and therefore cannot be
 * behaviorally unit-tested without a full wasm build. Same style as the codex
 * thread's contract tools: read the sources, assert the load-bearing tokens
 * are present (and the reverted shapes absent), fail loudly with the finding
 * ID. Run: npm run findings-e:contract
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const read = (rel: string) => readFileSync(path.join(repo, rel), "utf8");

const sharedspice = read("wasm/stubs/sharedspice_client.cpp");
const exporterStub = read("wasm/stubs/exporter_step_stub.cpp");
const oceStub = read("wasm/stubs/oce_plugin_stub.cpp");
const simFrame = read("kicad/eeschema/sim/simulator_frame.cpp");
const ngspiceCpp = read("kicad/eeschema/sim/ngspice.cpp");
const shim = read("scripts/common/shims/jspi-scheduler.js");

// --- E-5: ngspice event handler bound to exact module identity --------------
assert.ok(sharedspice.includes("const installingModule = Module"),
  "E-5: js_ngspice_install_events must capture the installing module");
assert.ok((sharedspice.match(/__pcbjamNgspiceOwnerModule/g) ?? []).length >= 2,
  "E-5: the handler must be stamped AND compared by owner module identity");
assert.ok(sharedspice.includes("globalThis.__ngspiceOnEvent !== handler"),
  "E-5: a superseded handler must disarm itself");
assert.ok(!/if\(\s*globalThis\.__ngspiceOnEvent\s*\)/.test(sharedspice),
  "E-5 REGRESSION: the install-once presence guard is back — presence is not identity");
assert.ok(sharedspice.includes("canTouchNative"),
  "E-5/E-8: event dispatch must check the scheduler liveness gate");

// --- E-8: all four completion sites route native work through the gate ------
for (const [name, src, site] of [
  ["exporter_step_stub.cpp", exporterStub, "'OCC export completion'"],
  ["oce_plugin_stub.cpp", oceStub, "'OCC model completion'"],
  ["sharedspice_client.cpp", sharedspice, "'ngspice request completion'"],
  ["sharedspice_client.cpp", sharedspice, "'ngspice vector completion'"],
] as const) {
  assert.ok(src.includes(`runWaitCompletion( ${site}`),
    `E-8: ${name} must run its ${site} through runWaitCompletion`);
}
for (const [name, src] of [
  ["exporter_step_stub.cpp", exporterStub],
  ["oce_plugin_stub.cpp", oceStub],
  ["sharedspice_client.cpp", sharedspice],
] as const) {
  assert.ok(!/__wxScheduler\.resolveWait\(/.test(src),
    `E-8 REGRESSION: ${name} resolves a wait directly, bypassing the admission gate`);
  assert.ok(/if\(\s*token\s*<=\s*0\s*\)/.test(src),
    `E-8: ${name} must bail when wxWasmBeginWait refuses the token`);
}
for (const symbol of ["runWaitCompletion", "_terminalizeNativeTrap",
  "canTouchNative", "beginWaitRefused"]) {
  assert.ok(shim.includes(symbol),
    `E-8: jspi-scheduler.js must provide ${symbol}`);
}

// --- E-7: per-session run generation, behavioral drops wasm-only ------------
for (const token of ["s_nextSimRunGeneration", "allocateSimRunGeneration",
  "SetExtraLong", "m_lastAppliedSimRunGeneration"]) {
  assert.ok(simFrame.includes(token),
    `E-7: simulator_frame.cpp must carry the run-generation mechanism (${token})`);
}
assert.equal(
  (simFrame.match(/Generation acceptance is confined to the wasm build/g) ?? []).length, 2,
  "E-7: both handler acceptance guards must be confined to the wasm build");
assert.ok(simFrame.includes("drop is confined to the wasm build"),
  "E-7: the unowned-event drop must be confined to the wasm build");
assert.ok(simFrame.includes("Wasm-only, findings E-7"),
  "E-7: the post-wxYield re-check must be confined to the wasm build");

// --- E-9: destructor unregisters the sharedspice callbacks ------------------
assert.ok(/#ifdef __EMSCRIPTEN__[\s\S]{0,400}pcbjam_ngspice_reset_callbacks\( this \)/
  .test(ngspiceCpp),
  "E-9: ~NGSPICE must call pcbjam_ngspice_reset_callbacks(this) under __EMSCRIPTEN__");
assert.ok(/pcbjam_ngspice_reset_callbacks\( void\* aUser \)[\s\S]{0,200}s_user != aUser/
  .test(sharedspice),
  "E-9: the reset must be identity-checked so a stale destructor cannot clear a successor");

console.log("findings-e-source-contract: all green");
