#!/usr/bin/env node
// Build the GPL standalone for the no-backend demo (demo.pcbjam.com): pin it to
// the CDN WASM root + this tag's manifests + the static gallery, run the vite
// build, and drop the Cloudflare Pages _headers/_redirects into dist/. The
// resulting pcbjam/web/standalone/dist/ is what `wrangler pages deploy` ships.
// See docs/features/demo-deploy/ (P4).
//
//   node scripts/build-demo.mjs --tag 2.7.7 [--cdn https://cdn.pcbjam.com]
//
// WASM + example bytes come from the CDN at runtime, so the local public/wasm
// symlink (dev only) is kept OUT of the bundle (temporarily moved aside during
// the build; in CI it doesn't exist at all).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const a = {
    tag: null,
    cdn: "https://cdn.pcbjam.com",
    repo: "https://github.com/emergence-engineering/pcbjam",
    libTag: null,
    // Marketing site the version badge links to; the in-editor waitlist form
    // cross-posts to <landing>/api/waitlist unless --waitlist overrides it.
    landing: "https://pcbjam.com",
    waitlist: null,
    // Plausible pa-*.js script URL. Off unless given (or VITE_PLAUSIBLE_SRC
    // is already in the environment, which passes straight through).
    plausible: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--tag": a.tag = next(); break;
      case "--cdn": a.cdn = next(); break;
      case "--repo": a.repo = next(); break;
      // KiCad library snapshot tag (published once to libs/kicad/<libTag>/).
      // Omitted ⇒ the offline built-in example symbols (back-compat).
      case "--lib-tag": a.libTag = next(); break;
      // kicad-packages3D snapshot tag (published once to
      // libs/kicad-models/<modelsTag>/). Omitted ⇒ 3D component models off
      // (the viewer renders bare boards, exactly as before the feature).
      case "--models-tag": a.modelsTag = next(); break;
      case "--landing": a.landing = next(); break;
      case "--waitlist": a.waitlist = next(); break;
      case "--plausible": a.plausible = next(); break;
      default: throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  if (!a.tag) throw new Error("--tag <release tag> is required");
  a.cdn = a.cdn.replace(/\/+$/, "");
  a.repo = a.repo.replace(/\/+$/, "");
  a.landing = a.landing.replace(/\/+$/, "");
  // The cross-origin demo POSTs the waitlist to the marketing site's endpoint (a
  // Cloudflare Pages Function). Always target the canonical www host: a CORS
  // preflight cannot follow a redirect, so aiming at a host that might ever
  // redirect is a latent breakage. Derive from --landing for custom/staging
  // hosts, but pin the production apex to www. (The landing/version-badge link
  // stays on the apex.)
  const waitlistHost =
    a.landing === "https://pcbjam.com" ? "https://www.pcbjam.com" : a.landing;
  a.waitlist = a.waitlist || `${waitlistHost}/api/waitlist`;
  return a;
}

// Best-effort source commit for the version badge's corresponding-source link;
// empty string if git isn't available (CI shallow checkout etc.) — the badge
// then falls back to the tag's release page.
function gitSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function main() {
  const a = parseArgs(process.argv);
  const repoRoot = resolve(process.cwd());
  const standalone = join(repoRoot, "web/standalone");
  const dist = join(standalone, "dist");
  const publicWasm = join(standalone, "public/wasm");
  const stash = join(standalone, "public/.wasm.demo-stashed");

  const env = {
    ...process.env,
    // Versioned CDN: each tool resolves to wasm/<tool>/<ver>/ via this manifest.
    VITE_WASM_ROOT: `${a.cdn}/wasm`,
    VITE_WASM_MANIFEST: `manifest-${a.tag}.json`,
    // Read-only example gallery, saves download to local.
    VITE_PROJECT_SOURCE: "static",
    VITE_PROJECT_MANIFEST_URL: `${a.cdn}/content/${a.tag}/manifest.json`,
    // Loaded folders import into a browser-local (IndexedDB) project — editable,
    // persistent, exported via Download .zip — layered over the gallery.
    VITE_LOCAL_PROJECTS: "idb",
    // Libraries: the full KiCad set from versioned CDN static origins when a
    // --lib-tag is given (read-only, IDB-cached); else built-in offline symbols.
    ...(a.libTag
      ? {
          VITE_LIBS_SOURCE: "cdn",
          VITE_LIBS_MANIFEST_URL: `${a.cdn}/libs/kicad/${a.libTag}/manifest.json`,
        }
      : { VITE_LIBS_SOURCE: "static" }),
    // 3D models: lazy per-board sparse fetch from the versioned models CDN
    // (docs/features/3d-models). Off unless a --models-tag is given.
    ...(a.modelsTag
      ? {
          VITE_MODELS_MANIFEST_URL: `${a.cdn}/libs/kicad-models/${a.modelsTag}/manifest.json`,
        }
      : {}),
    VITE_YJS_PROVIDER: "broadcastchannel",
    // Build identity for the version badge. The commit is the GPLv3
    // corresponding-source pointer (pins the kicad + wxwidgets submodules).
    VITE_APP_TAG: a.tag,
    VITE_GIT_SHA: gitSha(repoRoot),
    VITE_REPO_URL: a.repo,
    // Version-badge "pcbjam.com" link + the in-editor waitlist form's POST target.
    VITE_LANDING_URL: a.landing,
    VITE_WAITLIST_URL: a.waitlist,
    // Plausible analytics: explicit --plausible wins, else any env-provided value.
    ...(a.plausible ? { VITE_PLAUSIBLE_SRC: a.plausible } : {}),
  };

  console.log(`build-demo: tag=${a.tag} cdn=${a.cdn}`);
  console.log(`  VITE_WASM_ROOT=${env.VITE_WASM_ROOT}`);
  console.log(`  VITE_WASM_MANIFEST=${env.VITE_WASM_MANIFEST}`);
  console.log(`  VITE_PROJECT_MANIFEST_URL=${env.VITE_PROJECT_MANIFEST_URL}`);
  console.log(`  VITE_APP_TAG=${env.VITE_APP_TAG} VITE_GIT_SHA=${env.VITE_GIT_SHA || "(none)"}`);
  console.log(`  VITE_LIBS_SOURCE=${env.VITE_LIBS_SOURCE}${env.VITE_LIBS_MANIFEST_URL ? ` (${env.VITE_LIBS_MANIFEST_URL})` : ""}`);
  console.log(`  VITE_MODELS_MANIFEST_URL=${env.VITE_MODELS_MANIFEST_URL ?? "(unset — 3D models off)"}`);
  console.log(`  VITE_LANDING_URL=${env.VITE_LANDING_URL} VITE_WAITLIST_URL=${env.VITE_WAITLIST_URL}`);
  console.log(`  VITE_PLAUSIBLE_SRC=${env.VITE_PLAUSIBLE_SRC || "(off)"}`);

  // Keep the dev-only WASM symlink out of the bundle (it'd copy 100s of MB into
  // dist/; the CDN serves it). In CI it isn't present, so this is a no-op there.
  const hadWasm = existsSync(publicWasm) || isSymlink(publicWasm);
  if (hadWasm) renameSync(publicWasm, stash);
  try {
    execFileSync(
      "pnpm",
      ["--dir", "web", "--filter", "@pcbjam/standalone", "build"],
      { cwd: repoRoot, env, stdio: "inherit" },
    );
  } finally {
    if (hadWasm) renameSync(stash, publicWasm);
  }

  // Belt-and-suspenders: never ship local wasm even if a copy slipped through.
  rmSync(join(dist, "wasm"), { recursive: true, force: true });

  for (const f of ["_headers", "_redirects"]) {
    copyFileSync(join(repoRoot, "deploy/demo", f), join(dist, f));
  }

  console.log(`done → ${dist} (ready for: wrangler pages deploy)`);
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

main();
