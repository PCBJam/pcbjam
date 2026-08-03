#!/usr/bin/env node
// Build the GPL standalone for the BACKED editor deployment (editor.pcbjam.com):
// remote mode against the closed API (projects, libs, auth session cookie) with
// Yjs board rooms on the same API host (path-routed to the sync worker), pinned
// to the same CDN WASM root + per-tag manifest as the demo. The mirror of the
// closed repo's scripts/dev-all.mjs standalone env, with prod origins.
//
//   node scripts/deploy/build-editor.mjs --tag v1.2.3 --api-base https://api.pcbjam.com
//
// Unlike build-demo.mjs there is NO static gallery, NO IDB project layer and NO
// CDN libs pin: projects and libraries come from the backend (VITE_LIBS_SOURCE=
// synced → the server's r2-idb-sync bridge). WASM still comes from the CDN.

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
    apiBase: null,
    repo: "https://github.com/PCBJam/pcbjam",
    // Yjs endpoint: defaults to the API origin — board rooms are path-routed
    // (`/parties/board-room/*`) to the sync worker on the same hostname, so the
    // same-site session cookie rides the WS handshake.
    yjsEndpoint: null,
    // kicad-packages3D snapshot (libs/kicad-models/<tag>/); omitted ⇒ 3D models off.
    modelsTag: null,
    plausible: null,
    // Better Stack error-tracking DSN (Sentry wire format). Omitted ⇒ no error
    // reporting from this build.
    errorsDsn: null,
    errorsEnv: "production",
    // Companion mgmt app origin; set ⇒ non-editor routes redirect there
    // (standalone-hardening 0006). Omitted ⇒ every route renders locally.
    appBase: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--tag": a.tag = next(); break;
      case "--cdn": a.cdn = next(); break;
      case "--api-base": a.apiBase = next(); break;
      case "--repo": a.repo = next(); break;
      case "--yjs-endpoint": a.yjsEndpoint = next(); break;
      case "--models-tag": a.modelsTag = next(); break;
      case "--plausible": a.plausible = next(); break;
      case "--errors-dsn": a.errorsDsn = next(); break;
      case "--errors-env": a.errorsEnv = next(); break;
      case "--app-base": a.appBase = next(); break;
      default: throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  if (!a.tag) throw new Error("--tag <release tag> is required");
  if (!a.apiBase) throw new Error("--api-base <closed API origin> is required");
  a.cdn = a.cdn.replace(/\/+$/, "");
  a.apiBase = a.apiBase.replace(/\/+$/, "");
  a.repo = a.repo.replace(/\/+$/, "");
  a.yjsEndpoint = (a.yjsEndpoint || a.apiBase).replace(/\/+$/, "");
  if (a.appBase) a.appBase = a.appBase.replace(/\/+$/, "");
  return a;
}

// Best-effort source commit for the version badge's corresponding-source link
// (GPLv3): empty string if git isn't available.
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
  const stash = join(standalone, "public/.wasm.editor-stashed");

  const env = {
    ...process.env,
    // Versioned CDN WASM — identical mechanism to the demo build.
    VITE_WASM_ROOT: `${a.cdn}/wasm`,
    VITE_WASM_MANIFEST: `manifest-${a.tag}.json`,
    // Remote mode: projects, files and auth all come from the closed API.
    // (No VITE_PROJECT_SOURCE ⇒ "remote"; no VITE_LOCAL_PROJECTS.)
    VITE_API_BASE_URL: a.apiBase,
    // Live collab: Y.Doc rooms on the sync worker, reached through the API
    // host's path route; documents load from their ydoc.
    VITE_YJS_PROVIDER: "partykit",
    VITE_YJS_ENDPOINT: a.yjsEndpoint,
    VITE_DOC_SOURCE: "ydoc",
    // Libraries through the server's r2-idb-sync bridge (one /bundle per lib,
    // IndexedDB-cached) — NOT the CDN static libs the demo uses.
    VITE_LIBS_SOURCE: "synced",
    // 3D models stay CDN-static when a snapshot tag is given (same as demo).
    ...(a.modelsTag
      ? {
          VITE_MODELS_MANIFEST_URL: `${a.cdn}/libs/kicad-models/${a.modelsTag}/manifest.json`,
        }
      : {}),
    // Build identity for the version badge (GPLv3 corresponding source).
    VITE_APP_TAG: a.tag,
    VITE_GIT_SHA: gitSha(repoRoot),
    VITE_REPO_URL: a.repo,
    ...(a.plausible ? { VITE_PLAUSIBLE_SRC: a.plausible } : {}),
    // Error tracking. The env tag rides along only when a DSN is given, so a
    // DSN-less build cannot report under a production label.
    ...(a.errorsDsn
      ? { VITE_ERRORS_DSN: a.errorsDsn, VITE_ERRORS_ENV: a.errorsEnv }
      : {}),
    // Non-editor surfaces bounce to the mgmt app (mirror of the closed repo's
    // VITE_STANDALONE_URL pointing the other way).
    ...(a.appBase ? { VITE_APP_URL: a.appBase } : {}),
  };

  console.log(`build-editor: tag=${a.tag} api=${a.apiBase} cdn=${a.cdn}`);
  console.log(`  VITE_WASM_ROOT=${env.VITE_WASM_ROOT}`);
  console.log(`  VITE_WASM_MANIFEST=${env.VITE_WASM_MANIFEST}`);
  console.log(`  VITE_API_BASE_URL=${env.VITE_API_BASE_URL}`);
  console.log(`  VITE_YJS_ENDPOINT=${env.VITE_YJS_ENDPOINT} (provider=${env.VITE_YJS_PROVIDER}, doc=${env.VITE_DOC_SOURCE})`);
  console.log(`  VITE_LIBS_SOURCE=${env.VITE_LIBS_SOURCE}`);
  console.log(`  VITE_MODELS_MANIFEST_URL=${env.VITE_MODELS_MANIFEST_URL ?? "(unset — 3D models off)"}`);
  console.log(`  VITE_APP_TAG=${env.VITE_APP_TAG} VITE_GIT_SHA=${env.VITE_GIT_SHA || "(none)"}`);
  console.log(`  VITE_PLAUSIBLE_SRC=${env.VITE_PLAUSIBLE_SRC || "(off)"}`);
  console.log(`  VITE_ERRORS_DSN=${env.VITE_ERRORS_DSN ? `(set, env=${env.VITE_ERRORS_ENV})` : "(off)"}`);
  console.log(`  VITE_APP_URL=${env.VITE_APP_URL || "(unset — no non-editor redirect)"}`);

  // Keep the dev-only WASM symlink out of the bundle (CDN serves it).
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

  // Same Pages headers as the demo: COOP/COEP for WASM threads (the API's CORS
  // satisfies COEP for credentialed cross-origin fetches) + SPA fallback.
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
