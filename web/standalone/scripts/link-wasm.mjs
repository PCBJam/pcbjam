#!/usr/bin/env node
// Make the WASM runtime artifacts available SAME-ORIGIN to the app without a
// third copy: symlink standalone/public/wasm -> the synced artifact dir
// (tests/apps/kicad, populated by tests/scripts/setup-kicad-wasm.sh). Vite then
// serves them at /wasm from the app's own origin — required because KiCad WASM
// (a COEP/cross-origin-isolated document) refuses to load its
// glue/wasm from a different origin.
//
// No bytes are duplicated; the link points straight at the synced dir.
// Override the target with WASM_SRC_DIR (absolute, or relative to cwd).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(scriptDir, "../public");
const linkPath = path.join(publicDir, "wasm");
// scriptDir = web/standalone/scripts → repo root is three levels up.
const repoRoot = path.resolve(scriptDir, "../../..");
const setupScript = path.join(repoRoot, "tests/scripts/setup-kicad-wasm.sh");

const targetAbs = process.env.WASM_SRC_DIR
  ? path.resolve(process.cwd(), process.env.WASM_SRC_DIR)
  : path.join(repoRoot, "tests/apps/kicad");

// Sync freshly-built artifacts from output/ into tests/apps/kicad before
// linking, so `npm run dev` always serves the latest build instead of whatever
// was synced last. Skipped when WASM_SRC_DIR overrides the target: the setup
// script only writes to tests/apps/kicad, so running it would be a no-op there
// (and would mislead by syncing a dir we're not even linking to).
// Non-fatal: a missing/empty build must not block the dev server from starting.
// The setup script exits non-zero when no artifacts exist anywhere; we warn and
// fall through to the symlink, which already degrades gracefully (see below).
function syncArtifacts() {
  if (process.env.WASM_SRC_DIR) {
    console.log("[link-wasm] WASM_SRC_DIR set — skipping output/ sync");
    return;
  }
  const res = spawnSync("bash", [setupScript], { stdio: "inherit" });
  if (res.error) {
    console.warn(
      `[link-wasm] could not run setup-kicad-wasm.sh: ${res.error.message}`,
    );
  } else if (res.status !== 0) {
    console.warn(
      `[link-wasm] setup-kicad-wasm.sh exited ${res.status} — ` +
        `serving whatever is already in ${path.relative(repoRoot, targetAbs)}`,
    );
  }
}
// Relative link so it stays valid if the repo moves.
const targetRel = path.relative(publicDir, targetAbs);

async function statOrNull(p, { follow = true } = {}) {
  try {
    return follow ? await fs.stat(p) : await fs.lstat(p);
  } catch {
    return null;
  }
}

async function main() {
  syncArtifacts();

  await fs.mkdir(publicDir, { recursive: true });

  const link = await statOrNull(linkPath, { follow: false });
  if (link?.isSymbolicLink()) {
    const current = await fs.readlink(linkPath);
    if (path.resolve(publicDir, current) === targetAbs) {
      // already correct
    } else {
      await fs.rm(linkPath);
      await fs.symlink(targetRel, linkPath, "dir");
    }
  } else if (link) {
    // A real dir/file (e.g. an earlier copy) — remove and link.
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(targetRel, linkPath, "dir");
  } else {
    await fs.symlink(targetRel, linkPath, "dir");
  }

  const target = await statOrNull(targetAbs);
  if (!target?.isDirectory()) {
    console.warn(
      `[link-wasm] target not found: ${targetAbs}\n` +
        `[link-wasm] run tests/scripts/setup-kicad-wasm.sh (or set WASM_SRC_DIR). ` +
        `App will run but tools won't load.`,
    );
    return;
  }
  const hasWx = await statOrNull(path.join(targetAbs, "wx.js"));
  console.log(
    `[link-wasm] public/wasm -> ${path.relative(repoRoot, targetAbs)}` +
      (hasWx ? "" : "  (warning: wx.js missing in target)"),
  );
}

main().catch((err) => {
  console.error("[link-wasm]", err);
  process.exit(1);
});
