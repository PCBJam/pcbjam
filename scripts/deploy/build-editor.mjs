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
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    // 3D model backing override: "registry" serves the closed registry's
    // kind='model3d' origin libs (docs/features/libs/0016) instead of the CDN
    // snapshot; omitted ⇒ "cdn" when --models-tag is set, else models off.
    modelsSource: null,
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
      case "--models-source": a.modelsSource = next(); break;
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

async function main() {
  const a = parseArgs(process.argv);
  const repoRoot = resolve(process.cwd());
  const standalone = join(repoRoot, "web/standalone");
  const dist = join(standalone, "dist");
  const publicWasm = join(standalone, "public/wasm");
  // Keep the temporary symlink OUTSIDE public/. Vite copies every public entry,
  // including dot-directories; stashing it under public previously smuggled the
  // full local WASM tree into dist under `.wasm.editor-stashed/`.
  const stash = join(standalone, ".wasm.editor-stashed");

  const env = {
    ...process.env,
    // Versioned CDN WASM — identical mechanism to the demo build.
    VITE_WASM_ROOT: `${a.cdn}/wasm`,
    VITE_WASM_MANIFEST: `manifest-${a.tag}.json`,
    // Remote mode: projects, files and auth all come from the closed API.
    // (No VITE_PROJECT_SOURCE ⇒ "remote"; no VITE_LOCAL_PROJECTS.)
    VITE_API_BASE_URL: a.apiBase,
    // Hosted plugins and tutorials follow the API's per-session `plugins` /
    // `tutorials` toggles at runtime; only the dev-only local lab stays off.
    VITE_PLUGIN_POC: "0",
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
    ...(a.modelsSource ? { VITE_MODELS_SOURCE: a.modelsSource } : {}),
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
  console.log(`  VITE_MODELS_SOURCE=${env.VITE_MODELS_SOURCE ?? (env.VITE_MODELS_MANIFEST_URL ? "cdn" : "off")} VITE_MODELS_MANIFEST_URL=${env.VITE_MODELS_MANIFEST_URL ?? "(unset)"}`);
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
  rmSync(join(dist, ".wasm.editor-stashed"), { recursive: true, force: true });

  // Same Pages headers as the demo: COOP/COEP for WASM threads (the API's CORS
  // satisfies COEP for credentialed cross-origin fetches) + SPA fallback.
  for (const f of ["_headers", "_redirects"]) {
    copyFileSync(join(repoRoot, "deploy/demo", f), join(dist, f));
  }
  await writePagesRuntimeWorker(standalone, dist);

  console.log(`done → ${dist} (ready for: wrangler pages deploy)`);
}

// Plugin runtime files (pcbjam-private docs/features/plugins/0013): a missing
// or stale /plugin-runtime/* URL must answer 404, never the SPA index.html the
// `/*` fallback above serves. Pages advanced mode runs dist/_worker.js, and
// _routes.json limits it to those URLs; every other request stays static, with
// _headers/_redirects. It is the handler the staging editor Worker runs
// (wrangler.staging.jsonc `main`), bundled with its runtime list. A Workers
// Static Assets deploy must delete both files (deploy-staging.yml does).
async function writePagesRuntimeWorker(standalone, dist) {
  const require = createRequire(join(standalone, "package.json"));
  const vite = join(dirname(require.resolve("vite/package.json")), "dist/node/index.js");
  const { build } = await import(pathToFileURL(vite).href);
  const out = mkdtempSync(join(tmpdir(), "pcbjam-pages-worker-"));
  try {
    await build({
      configFile: false,
      root: standalone,
      publicDir: false,
      logLevel: "warn",
      ssr: { target: "webworker", noExternal: true },
      build: {
        ssr: join(standalone, "plugin-assets-worker.ts"),
        outDir: out,
        emptyOutDir: true,
        target: "es2022",
        minify: false,
        rollupOptions: { output: { format: "es", entryFileNames: "_worker.js" } },
      },
    });
    copyFileSync(join(out, "_worker.js"), join(dist, "_worker.js"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  writeFileSync(
    join(dist, "_routes.json"),
    JSON.stringify({ version: 1, include: ["/plugin-runtime/*"], exclude: [] }) + "\n",
  );
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

await main();
