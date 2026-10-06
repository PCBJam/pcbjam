#!/usr/bin/env node
// Publish the @pcbjam/kicad-tools CLI package (mcp 0004 §11.5) to the CDN as
// an npm tarball — no npm registry. Run AFTER publish-wasm.mjs: it pins the
// package manifest to the kicad_tools + occ_service versions publish-wasm
// just wrote to <prefix>/registry.json (with each file's sha256 from their
// meta.json), packs the package, then uploads
//
//   tools/kicad-tools/<version>/kicad-tools.tgz   immutable, never rewritten
//   tools/kicad-tools/latest.json                 { version, url, sha256 } (the only moving file)
//   tools/kicad-tools/by-sha/<commit>.json        the same, for the pcbjam commit it was
//                                                 built from (--sha) — how the PCBJam
//                                                 runner image finds the build matching
//                                                 its pcbjam submodule pointer
//
//   node scripts/deploy/publish-kicad-tools.mjs --driver local --out /tmp/cdn
//   node scripts/deploy/publish-kicad-tools.mjs --driver r2 --bucket pcbjam-cdn --remote \
//     --version 0.2.6 --sha "$GITHUB_SHA" [--cdn https://cdn.pcbjam.com]
//
// --version overrides web/kicad-tools/package.json's (releases: the tag;
// staging: <pkg>-staging.<sha7>); publishing a version again with different
// bytes is refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IMMUTABLE, makeStore, NO_STORE, putJSON, sha256hex } from "./lib/cdn-store.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PKG_DIR = join(ROOT, "web", "kicad-tools");

function parseArgs(argv) {
  const a = {
    driver: "local",
    out: ".cdn-out",
    bucket: "pcbjam-cdn",
    remote: false,
    prefix: "wasm",
    cdn: process.env.PCBJAM_CDN_URL ?? "https://cdn.pcbjam.com",
    version: null,
    sha: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--driver") a.driver = next();
    else if (k === "--out") a.out = next();
    else if (k === "--bucket") a.bucket = next();
    else if (k === "--remote") a.remote = true;
    else if (k === "--prefix") a.prefix = next();
    else if (k === "--cdn") a.cdn = next().replace(/\/+$/, "");
    else if (k === "--version") a.version = next().replace(/^v/, "");
    else if (k === "--sha") a.sha = next();
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  const store = makeStore(a.driver, a);
  const registry = store.getJSON(`${a.prefix}/registry.json`);
  if (!registry) throw new Error(`no ${a.prefix}/registry.json — run publish-wasm.mjs first`);

  const CDN = a.cdn;
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
  if (a.version) pkg.version = a.version;
  const tools = {};
  for (const tool of ["kicad_tools", "occ_service"]) {
    const ver = registry.tools[tool]?.version;
    if (!ver) throw new Error(`${tool} is not in ${a.prefix}/registry.json`);
    const meta = store.getJSON(`${a.prefix}/${tool}/${ver}/meta.json`);
    if (!meta?.files) throw new Error(`${a.prefix}/${tool}/${ver}/meta.json missing`);
    tools[tool] = { ver, files: meta.files };
  }
  const manifest = { version: pkg.version, cdn: `${CDN}/${a.prefix}`, tools };

  // Pack a copy with the pinned manifest (the repo keeps the dev manifest),
  // compiled there (TypeScript → dist/; the tarball ships dist/ only). The
  // compiler comes from the package's own devDependency ranges, so this
  // needs no workspace install.
  const work = mkdtempSync(join(tmpdir(), "kicad-tools-pack-"));
  try {
    for (const f of ["src", "tsconfig.json", "README.md"]) {
      execFileSync("cp", ["-R", join(PKG_DIR, f), work]);
    }
    // The published package.json: this version, no workspace-only devDependencies.
    const { devDependencies: _dev, ...published } = pkg;
    writeFileSync(join(work, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    writeFileSync(join(work, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const dev = _dev ?? {};
    execFileSync(
      "npm",
      ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts",
        `typescript@${dev.typescript}`, `@types/node@${dev["@types/node"]}`],
      { cwd: work, stdio: "inherit" },
    );
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: work, stdio: "inherit" });
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
    const pointer = { version: pkg.version, url: `${CDN}/${key}`, sha256: sha };
    putJSON(store, "tools/kicad-tools/latest.json", pointer, NO_STORE);
    if (a.sha) putJSON(store, `tools/kicad-tools/by-sha/${a.sha}.json`, pointer, NO_STORE);
    console.log(`publish-kicad-tools: ${pkg.version} (${(tgz.length / 1024).toFixed(1)} KB, sha256 ${sha.slice(0, 12)}…)${prior ? " — already published" : ""}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
