#!/usr/bin/env node
// Publish the KiCad WASM artifacts to the versioned CDN (cdn.pcbjam.com, R2
// `pcbjam-cdn`). Implements docs/features/demo-deploy/0001-wasm-cdn-versioning.md:
// per-tool, content-addressed, self-contained folders + a per-release manifest
// the standalone reads at runtime, with a `registry.json` for hash-dedupe.
//
//   node scripts/publish-wasm.mjs --tag 2.7.7 --src pcbjam/output --driver local --out /tmp/cdn
//   node scripts/publish-wasm.mjs --tag 2.7.7 --src pcbjam/output --driver r2 --bucket pcbjam-cdn --remote
//
// Properties (see 0001): ONE atomic job; idempotent; content-addressed folders
// are immutable; meta.json is written LAST as the completeness marker; an
// unchanged tool is never re-uploaded; the build↔upload race is impossible.
//
// The `local` driver writes the exact bucket layout to --out (+ a sidecar
// `_uploads.json` recording every object's HTTP metadata) so the whole thing is
// verifiable offline. The `r2` driver shells `wrangler r2 object {get,put}` and
// needs only CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID).

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  compressBytesAsync,
  IMMUTABLE,
  makeStore,
  NO_STORE,
  putJSON,
  sha256hex,
} from "./lib/cdn-store.mjs";

// Compression fans out over the libuv threadpool (compressBytesAsync); size it
// to the machine BEFORE the first async zlib call or the default of 4 sticks.
process.env.UV_THREADPOOL_SIZE ||= String(Math.max(4, availableParallelism()));

// --- tools & per-file rules ---------------------------------------------------

// Bundles served to the browser editor. The four editor tools (pcbnew, eeschema,
// footprint_editor, symbol_editor) are ALL served by the ONE merged kicad_editor
// bundle, booted with a runtime --frame flag (editor-unification Part 2) — none of
// them publishes anything of its own. The frontend maps tools onto bundles via
// TOOL_BUNDLE. sym_convert is a node CLI, not served.
// occ_service is the lazy OCC worker module (STEP export + STEP/IGES model
// parsing for the PCB frames, docs/features/occ-split/) — served, but headless:
// no wx glue, no image archive.
const TOOLS = [
  "kicad_editor",
  "pl_editor",
  "gerbview",
  "calculator",
  "occ_service",
  "ngspice_service",
];

// Files that make up a self-contained tool bundle. `<tool>` is substituted.
const SHARED_FILES = ["wx.js", "wx-dom.js", "images.tar.gz"];
const toolFiles = (tool) =>
  tool === "occ_service" || tool === "ngspice_service"
    ? [`${tool}.wasm`, `${tool}.js`]
    : [`${tool}.wasm`, `${tool}.js`, ...SHARED_FILES];

// Per-file HTTP rules (see the 0001 header matrix). `compress` is whether the
// publisher compresses + sets Content-Encoding; images.tar.gz must stay RAW
// gzip (KiCad gunzips it in JS) so it is octet-stream with NO encoding.
function fileRule(name) {
  if (name.endsWith(".wasm"))
    return { contentType: "application/wasm", compress: true, cacheControl: IMMUTABLE };
  if (name.endsWith(".js"))
    return { contentType: "text/javascript", compress: true, cacheControl: IMMUTABLE };
  if (name === "images.tar.gz")
    return { contentType: "application/octet-stream", compress: false, cacheControl: IMMUTABLE };
  if (name.endsWith(".json"))
    return { contentType: "application/json", compress: false, cacheControl: IMMUTABLE };
  return { contentType: "application/octet-stream", compress: false, cacheControl: IMMUTABLE };
}

// --- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    tag: null,
    src: "output",
    driver: "local",
    out: null,
    bucket: "pcbjam-cdn",
    remote: false,
    compress: "gzip", // gzip | br | none
    quality: null,
    tools: TOOLS,
    prefix: "wasm",
    builtAt: process.env.SOURCE_DATE || null,
    // Snapshot mode: write manifest-<tag>.json pinning the CURRENT registry
    // versions, with NO build/upload (the tag deploy reuses prebuilt WASM).
    fromRegistry: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--tag": a.tag = next(); break;
      case "--src": a.src = next(); break;
      case "--driver": a.driver = next(); break;
      case "--out": a.out = next(); break;
      case "--bucket": a.bucket = next(); break;
      case "--remote": a.remote = true; break;
      case "--compress": a.compress = next(); break;
      case "--quality": a.quality = Number(next()); break;
      case "--tools": a.tools = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--prefix": a.prefix = next(); break;
      case "--from-registry": a.fromRegistry = true; break;
      default: throw new Error(`unknown arg: ${k}`);
    }
  }
  if (!a.tag) throw new Error("--tag <release tag> is required");
  if (a.driver === "local" && !a.out) a.out = ".cdn-out";
  if (a.compress !== "gzip" && a.compress !== "br" && a.compress !== "none")
    throw new Error(`--compress must be gzip|br|none (got ${a.compress})`);
  return a;
}

// --- tool identity ------------------------------------------------------------

// Identity of a tool = sha256 over the sorted (name: sha256(uncompressed bytes))
// of its bundle files. Hash the SOURCE bytes, never the compressed upload, so
// changing the compression level can never change a tool's version.
function toolContentHash(files) {
  const lines = files
    .map((f) => `${f.name}:${sha256hex(f.bytes)}`)
    .sort();
  return "sha256:" + sha256hex(Buffer.from(lines.join("\n")));
}

// --- publish ------------------------------------------------------------------

function gather(tool, srcDir) {
  return toolFiles(tool).map((name) => {
    const p = join(srcDir, name);
    if (!existsSync(p)) throw new Error(`missing artifact: ${p}`);
    return { name, bytes: readFileSync(p) };
  });
}

// Compress a gathered file in place (adds .body/.encoding). Async so the whole
// upload set compresses concurrently on the threadpool — brotli q11 over the
// ~300MB wasm set is BY FAR the slow step of a publish, and serially it took
// sum-of-files; in parallel it takes roughly the largest single file.
async function compressFile(f, compress, quality) {
  const rule = fileRule(f.name);
  if (rule.compress && compress !== "none") {
    const c = await compressBytesAsync(f.bytes, compress, quality);
    f.body = c.bytes;
    f.encoding = c.encoding;
  } else {
    f.body = f.bytes;
    f.encoding = null;
  }
}

function putFile(store, key, f) {
  const rule = fileRule(f.name);
  store.put(key, f.body, {
    contentType: rule.contentType,
    contentEncoding: f.encoding,
    cacheControl: rule.cacheControl,
  });
  return { name: f.name, raw: f.bytes.length, stored: f.body.length, encoding: f.encoding };
}

async function main() {
  const a = parseArgs(process.argv);
  const builtAt = a.builtAt || new Date().toISOString();
  const store = makeStore(a.driver, a);
  const P = a.prefix;

  const registry = store.getJSON(`${P}/registry.json`) || {
    schema: 1,
    tools: {},
    index: {},
  };
  registry.index ||= {};
  registry.tools ||= {};

  // schema 2: adds `sizes` — per-tool byte counts the standalone's download
  // consent dialog + progress bar read (standalone-load-ux 0001). `wasm` is the
  // RAW (decoded) size (matches the byte-counting progress stream), `wasmStored`
  // / `totalStored` are over-the-wire (post-br/gzip) sizes. Additive: old
  // clients read only `tools`; new clients tolerate a missing/partial `sizes`
  // (tools published before this schema carry none in the registry).
  const manifest = { schema: 2, tag: a.tag, builtAt, tools: {}, sizes: {} };

  // Snapshot mode (the tag deploy): pin manifest-<tag> to the CURRENT published
  // per-tool versions and STOP — no build, no upload. Honors "reuse prebuilt":
  // app releases that didn't change the WASM never re-touch the WASM blobs.
  if (a.fromRegistry) {
    for (const tool of a.tools) {
      const entry = registry.tools[tool];
      if (!entry)
        throw new Error(
          `tool "${tool}" not in ${P}/registry.json — publish the WASM (full ` +
            `mode) before snapshotting a release manifest`,
        );
      manifest.tools[tool] = entry.version;
      if (entry.sizes) manifest.sizes[tool] = entry.sizes;
    }
    putJSON(store, `${P}/manifest-${a.tag}.json`, manifest, NO_STORE);
    console.log(
      `snapshot: manifest-${a.tag}.json ← registry (${a.tools.length} tools, no upload)`,
    );
    return;
  }

  console.log(
    `publish-wasm: tag=${a.tag} src=${a.src} driver=${store.kind} compress=${a.compress}`,
  );

  let reused = 0;

  // Per-tool sizes destined for manifest.sizes + the registry entry. Reused
  // tools inherit the registry's stored sizes when they match this version
  // (compression is skipped on reuse, so stored sizes can't be recomputed);
  // pre-schema-2 registry entries yield a raw-only partial the client treats
  // as "stored size unknown".
  const sizesByTool = {};

  // Plan: hash every tool, decide reuse vs upload (moved-tag guard included).
  const plan = [];
  for (const tool of a.tools) {
    const files = gather(tool, a.src);
    const hash = toolContentHash(files);
    const idx = (registry.index[tool] ||= {});
    const rawWasm = files.find((f) => f.name === `${tool}.wasm`).bytes.length;

    let ver = idx[hash];
    if (ver) {
      reused++;
      const prev = registry.tools[tool];
      sizesByTool[tool] =
        prev?.version === ver && prev.sizes ? prev.sizes : { wasm: rawWasm };
      console.log(`  ${tool}: reuse ${ver} (${hash.slice(0, 19)}…)`);
    } else {
      ver = a.tag;
      const existing = store.getJSON(`${P}/${tool}/${ver}/meta.json`)?.hash ?? null;
      if (existing && existing !== hash) {
        throw new Error(
          `moved-tag guard: ${P}/${tool}/${ver}/ already holds ${existing} ` +
            `but this build is ${hash}. Re-tag with a NEW version, never ` +
            `overwrite an immutable folder.`,
        );
      }
      plan.push({ tool, files, hash, ver });
      idx[hash] = ver;
    }
    registry.tools[tool] = { version: ver, hash };
    manifest.tools[tool] = ver;
  }

  // Compress every to-be-uploaded file concurrently, then upload. Uploads stay
  // sequential per tool with meta.json LAST — its presence marks the bundle
  // complete — and the registry is only written after every bundle is.
  await Promise.all(
    plan.flatMap(({ files }) => files.map((f) => compressFile(f, a.compress, a.quality))),
  );

  for (const { tool, files, hash, ver } of plan) {
    const sizes = files.map((f) => putFile(store, `${P}/${tool}/${ver}/${f.name}`, f));
    const wasmFile = sizes.find((s) => s.name === `${tool}.wasm`);
    sizesByTool[tool] = {
      wasm: wasmFile.raw,
      wasmStored: wasmFile.stored,
      totalStored: sizes.reduce((s, x) => s + x.stored, 0),
    };
    putJSON(
      store,
      `${P}/${tool}/${ver}/meta.json`,
      {
        tool,
        ver,
        hash,
        builtAt,
        files: Object.fromEntries(files.map((f) => [f.name, "sha256:" + sha256hex(f.bytes)])),
      },
      IMMUTABLE,
    );
    const tot = sizes.reduce((s, x) => s + x.stored, 0);
    console.log(
      `  ${tool}: UPLOAD ${ver} (${hash.slice(0, 19)}…) ` +
        `${(tot / 1e6).toFixed(1)}MB stored`,
    );
  }
  const uploaded = plan.length;

  for (const tool of a.tools) {
    const s = sizesByTool[tool];
    if (!s) continue;
    manifest.sizes[tool] = s;
    registry.tools[tool].sizes = s;
  }

  // Browser-facing manifest + convenience pointer, both uncached.
  putJSON(store, `${P}/manifest-${a.tag}.json`, manifest, NO_STORE);
  putJSON(store, `${P}/manifest-latest.json`, { tag: a.tag }, NO_STORE);
  // registry LAST, after every tool's meta.json exists.
  putJSON(store, `${P}/registry.json`, registry, NO_STORE);

  console.log(
    `done: ${uploaded} uploaded, ${reused} reused → manifest-${a.tag}.json`,
  );
  if (store.kind === "local") console.log(`local layout under: ${a.out}`);
}

await main();
