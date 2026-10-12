#!/usr/bin/env node
// Verify the exact runtime from a local deployment directory or HTTPS origin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [receiptFile, target] = process.argv.slice(2);
assert.ok(
  receiptFile && target,
  "Usage: verify-plugin-runtime.mjs <runtime-receipt.json> <dist-directory|https://editor-origin>"
);
const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
assert.match(receipt.version, /^[a-f0-9]{64}$/);
const remote = /^https:\/\//.test(target);
if (/^https?:/.test(target)) assert.ok(remote, "Deployed checks require HTTPS");
const prefix = `/plugin-runtime/${receipt.version}/`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function get(name) {
  if (!remote) return readFile(path.join(target, prefix, name));
  const response = await fetch(new URL(prefix + name, target), {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, name);
  const headers = response.headers;
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.match(headers.get("cache-control") ?? "", /immutable/);
  const csp = headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "script-src 'wasm-unsafe-eval'",
  ])
    assert.ok(csp.includes(directive), `${name}: ${directive}`);
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'/);
  assert.match(
    headers.get("content-type") ?? "",
    name.endsWith(".wasm")
      ? /application\/wasm/
      : name.endsWith(".json")
        ? /application\/json/
        : /(?:javascript|ecmascript)/
  );
  return Buffer.from(await response.arrayBuffer());
}
const manifest = JSON.parse((await get("manifest.json")).toString());
assert.equal(
  sha(JSON.stringify(manifest)),
  receipt.version,
  "Manifest must match its immutable URL"
);
assert.equal(manifest.protocolVersion, 1);
assert.equal(manifest.apiVersion, 1);
assert.deepEqual(Object.keys(manifest.files).sort(), [...receipt.files].sort());
for (const [name, metadata] of Object.entries(manifest.files)) {
  assert.match(name, /^[a-z][a-z-]*\.(?:js|wasm)$/);
  const bytes = await get(name);
  assert.equal(bytes.length, metadata.bytes, name);
  assert.equal(sha(bytes), metadata.sha256, name);
}
if (remote) {
  // A plugin with direct sites (plugins 0022 M3): the same Worker bytes, connect-src limited
  // to exactly the sites in the path.
  const net = await fetch(new URL(`${prefix}net/api.example.com/package-worker.js`, target), {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(net.status, 200, "net Worker");
  assert.equal(
    net.headers.get("content-security-policy"),
    "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src https://api.example.com; worker-src 'none'; object-src 'none'; base-uri 'none'",
    "net Worker CSP"
  );
  assert.equal(net.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(sha(Buffer.from(await net.arrayBuffer())), manifest.files["package-worker.js"].sha256, "net Worker bytes");
  for (const missing of [
    `${prefix}missing.js`,
    `${prefix}package-worker.js?unversioned=1`,
    `/plugin-runtime/${"0".repeat(64)}/package-worker.js`,
    `${prefix}net/files.example.org,api.example.com/package-worker.js`,
    `${prefix}net/api.pcbjam.com/package-worker.js`,
    `${prefix}net/api.example.com/quickjs.wasm`,
  ]) {
    const response = await fetch(new URL(missing, target), {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 404, missing);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /<html|<script/i);
  }
}
console.log(
  `Verified plugin runtime ${receipt.version}: ${Object.keys(manifest.files).length} exact artifacts${remote ? ", deployed security headers, the per-plugin Worker policy and missing-asset handling" : ""}.`
);
