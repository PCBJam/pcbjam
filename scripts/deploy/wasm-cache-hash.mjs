#!/usr/bin/env node
// Computes the "sc" (source-content) hash for the KiCad-WASM output cache key
// in .github/workflows/wasm-build.yml.
//
// The cache key is:
//   kwasm-<os>-k<kicad-sha>-wx<wx-sha>-sc<HASH>-3d<flag>-e<epoch>
//
// The kicad/wx submodule SHAs already capture the *sources*. This hash captures
// the *build logic* that shapes the wasm bytes but lives outside those
// submodules — the host ENV-shim patch, the per-tool
// compile scripts, the dependency builds, and the Docker toolchain. Those were
// deliberately dropped from the key's hashFiles() (so routine script edits don't
// trigger a 1-2h rebuild); folding the *output-determining* subset back in here
// keeps the cache correct while leaving the rest under the manual .ci-cache-epoch
// / [no-cache] controls.
//
// The hash is content-based and order-independent: it builds a manifest of
// `<sha256(content)>  <repo-relative-path>` lines, sorts them, and hashes the
// manifest. Identical on macOS (dev) and Linux (CI) given a normal LF checkout,
// so you can predict cache hits locally.
//
// This script hashes ITSELF (and therefore the INPUTS list below) too, so
// editing it busts the cache — intended: a change here means the set of
// cache-invalidating inputs changed.
//
// Usage:
//   node scripts/deploy/wasm-cache-hash.mjs              # full hex sha256 -> stdout
//   node scripts/deploy/wasm-cache-hash.mjs --short      # 16-char prefix
//   node scripts/deploy/wasm-cache-hash.mjs --short=12   # N-char prefix
//   node scripts/deploy/wasm-cache-hash.mjs --manifest   # per-file lines + total (stderr), hash on stdout
//
// In CI (the `keys` step, after checkout + setup-node):
//   echo "sc=$(node scripts/deploy/wasm-cache-hash.mjs)" >> "$GITHUB_OUTPUT"
//
// MAINTENANCE: to add or remove inputs, edit INPUTS below — that is the only
// place the set is defined.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

// --- The inputs that determine the cached wasm bytes -------------------------
// Each entry is one of:
//   { file: "<repo-relative path>" }            a single file (must exist)
//   { dir:  "<repo-relative dir>" }             every file under the dir, recursive
//   { dir:  "<repo-relative dir>", match: RE }  files under the dir whose BASENAME matches RE, recursive
// Paths are POSIX, relative to the repo root. This script always adds itself.
const INPUTS = [
  // Host-side post-processing — shapes the shipped glue.
  { file: "scripts/common/patch-env-shim.mjs" },
  // Link-time inputs baked into every editor app: the scheduler pre-js and
  // the promising-export census.
  { file: "scripts/common/shims/jspi-scheduler.js" },
  { file: "scripts/common/jspi-exports.txt" },
  // Single-sources DEPS_EH_FLAGS (the exception-model link flags).
  { file: "scripts/common/env.sh" },

  // Per-tool compile recipes (compile flags / emcc link options).
  { dir: "scripts/kicad", match: /^build-.*\.sh$/ },

  // The pcbjam-repo C++/CMake/shim sources compiled INTO the tools (bindings,
  // cli mains, kiplatform, gl1, stubs, editor glue). These live outside the
  // kicad/wx submodules, so without this entry a pure wasm/** edit (e.g. a
  // new kicad_tools subcommand) would cache-hit stale output — plugins 0002
  // shipped exactly that way before this entry existed.
  { dir: "wasm" },

  // Dependency builds (boost/cairo/occ/... — the sysroot the wasm links against).
  { dir: "scripts/deps" },

  // Docker toolchain (base image, emsdk, build driver).
  { file: "docker/Dockerfile" },
  { file: "docker/build.sh" },
  // Toolchain pins — EMSCRIPTEN_VERSION reaches the Dockerfile only as a build
  // ARG, so without this entry an emsdk bump alone would cache-hit wasm built
  // by the previous toolchain.
  { file: "scripts/common/versions.sh" },
];

// --- helpers -----------------------------------------------------------------
const ROOT = fileURLToPath(new URL("../..", import.meta.url)); // scripts/deploy -> repo root
const toPosix = (p) => p.split(sep).join("/");
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// Recursively collect repo-relative file paths under an absolute dir. Skips
// dotfiles/dot-dirs (no hidden files are intended inputs) and follows the
// optional basename matcher.
function walk(absDir, match) {
  const out = [];
  for (const ent of readdirSync(absDir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const abs = join(absDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(abs, match));
    } else if (ent.isFile()) {
      if (match && !match.test(ent.name)) continue;
      out.push(toPosix(relative(ROOT, abs)));
    }
  }
  return out;
}

// --- resolve the file set ----------------------------------------------------
const files = new Set();

for (const entry of INPUTS) {
  if (entry.file) {
    const abs = join(ROOT, entry.file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      // Hard error: a listed file vanished (renamed/moved). Silently dropping it
      // would weaken the key and serve a stale cache.
      console.error(`wasm-cache-hash: required input missing: ${entry.file}`);
      process.exit(1);
    }
    files.add(toPosix(entry.file));
  } else if (entry.dir) {
    const abs = join(ROOT, entry.dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(`wasm-cache-hash: required input dir missing: ${entry.dir}`);
      process.exit(1);
    }
    const found = walk(abs, entry.match);
    if (found.length === 0) {
      // Non-fatal: a dir/matcher that yields nothing is suspicious but
      // deterministic. Warn so a bad matcher doesn't go unnoticed.
      console.error(
        `wasm-cache-hash: warning: no files for ${entry.dir}` +
          (entry.match ? ` matching ${entry.match}` : "")
      );
    }
    for (const f of found) files.add(f);
  }
}

// Always include this script (and thus the INPUTS list).
files.add(toPosix(relative(ROOT, fileURLToPath(import.meta.url))));

// --- build the manifest and hash it ------------------------------------------
const manifest = [...files]
  .sort()
  .map((rel) => `${sha256hex(readFileSync(join(ROOT, rel)))}  ${rel}`)
  .join("\n");

const hash = sha256hex(Buffer.from(manifest, "utf8"));

// --- output ------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[1]);
  process.exit(0);
}
if (args.includes("--manifest")) {
  // Manifest to stderr so stdout stays a clean, capturable hash.
  console.error(manifest);
  console.error(`-- ${files.size} files --`);
}
const shortArg = args.find((a) => a === "--short" || a.startsWith("--short="));
const out = shortArg
  ? hash.slice(0, Number(shortArg.split("=")[1]) || 16)
  : hash;

process.stdout.write(out + "\n");
