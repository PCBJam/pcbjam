#!/usr/bin/env node
// Publish the @pcbjam/kicad-tools CLI package (mcp 0004 §11.5) to the CDN as
// an npm tarball — no npm registry. Run AFTER publish-wasm.mjs: it pins the
// package manifest to the kicad_tools + occ_service versions publish-wasm
// just wrote to <prefix>/registry.json (with each file's sha256 from their
// meta.json), packs the package, then uploads
//
//   tools/kicad-tools/<version>/kicad-tools.tgz   immutable, never rewritten
//   tools/kicad-tools/latest.json                 { version, url, sha256 } (the only moving file)
//
//   node scripts/deploy/publish-kicad-tools.mjs --driver local --out /tmp/cdn
//   node scripts/deploy/publish-kicad-tools.mjs --driver r2 --bucket pcbjam-cdn --remote
//
// The package version comes from web/kicad-tools/package.json; publishing the
// same version with different bytes is refused (bump the version).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IMMUTABLE, makeStore, NO_STORE, putJSON, sha256hex } from "./lib/cdn-store.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PKG_DIR = join(ROOT, "web", "kicad-tools");
const CDN = process.env.PCBJAM_CDN_URL ?? "https://cdn.pcbjam.com";

function parseArgs(argv) {
  const a = { driver: "local", out: ".cdn-out", bucket: "pcbjam-cdn", remote: false, prefix: "wasm" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--driver") a.driver = next();
    else if (k === "--out") a.out = next();
    else if (k === "--bucket") a.bucket = next();
    else if (k === "--remote") a.remote = true;
    else if (k === "--prefix") a.prefix = next();
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  const store = makeStore(a.driver, a);
  const registry = store.getJSON(`${a.prefix}/registry.json`);
  if (!registry) throw new Error(`no ${a.prefix}/registry.json — run publish-wasm.mjs first`);

  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
  const tools = {};
  for (const tool of ["kicad_tools", "occ_service"]) {
    const ver = registry.tools[tool]?.version;
    if (!ver) throw new Error(`${tool} is not in ${a.prefix}/registry.json`);
    const meta = store.getJSON(`${a.prefix}/${tool}/${ver}/meta.json`);
    if (!meta?.files) throw new Error(`${a.prefix}/${tool}/${ver}/meta.json missing`);
    tools[tool] = { ver, files: meta.files };
  }
  const manifest = { version: pkg.version, cdn: `${CDN}/${a.prefix}`, tools };

  // Pack a copy with the pinned manifest (the repo keeps the dev manifest).
  const work = mkdtempSync(join(tmpdir(), "kicad-tools-pack-"));
  try {
    execFileSync("cp", ["-R", join(PKG_DIR, "src"), join(PKG_DIR, "package.json"), join(PKG_DIR, "README.md"), work]);
    writeFileSync(join(work, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: work, encoding: "utf8" }).trim().split("\n").pop();
    const tgz = readFileSync(join(work, name));
    const sha = sha256hex(tgz);

    const key = `tools/kicad-tools/${pkg.version}/kicad-tools.tgz`;
    const prior = store.getJSON(`tools/kicad-tools/${pkg.version}/meta.json`);
    if (prior && prior.sha256 !== sha) {
      throw new Error(`tools/kicad-tools/${pkg.version}/ already holds ${prior.sha256}; bump web/kicad-tools/package.json`);
    }
    if (!prior) {
      store.put(key, tgz, { contentType: "application/gzip", contentEncoding: null, cacheControl: IMMUTABLE });
      putJSON(store, `tools/kicad-tools/${pkg.version}/meta.json`, { version: pkg.version, sha256: sha, manifest }, IMMUTABLE);
    }
    putJSON(store, "tools/kicad-tools/latest.json", { version: pkg.version, url: `${CDN}/${key}`, sha256: sha }, NO_STORE);
    console.log(`publish-kicad-tools: ${pkg.version} (${(tgz.length / 1024).toFixed(1)} KB, sha256 ${sha.slice(0, 12)}…)${prior ? " — already published" : ""}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
