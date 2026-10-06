// @ts-check
/**
 * 3D export through occ_service (mcp 0004 §11.3): the board text plus the
 * 3D model bodies it references go in, STEP (or STEPZ/GLB/STL/BREP/PLY/XAO)
 * comes out — the same `occExport` the browser editor's worker calls.
 *
 * Models: `--models <dir>` holds the library models as
 * `<lib>.3dshapes/<name>.<ext>` (the official KiCad layout), or
 * `--models cdn` fetches them from PCBJam's model CDN (3d-models 0003:
 * per-library manifests + sha256-addressed bodies; the manifest root from
 * `--models-manifest` / PCBJAM_MODELS_MANIFEST_URL), cached by hash. Project
 * models (`${KIPRJMOD}/…`) are read next to the board. Only referenced models
 * are read, with the .wrl ⇄ .step fallback the module applies. Missing models
 * are listed in the report, never silently dropped.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { moduleDir } from "./modules.mjs";

const FORMATS = { step: "step", stepz: "stpz", stpz: "stpz", glb: "glb", stl: "stl", brep: "brep", ply: "ply", xao: "xao" };
/** Where project-relative model refs are staged (bare relative refs reach
 *  the module's staged-model probe; ${KIPRJMOD} would not). */
const PROJECT_PREFIX = "kiprjmod";

/** @param {string} board */
export function modelRefs(board) {
  return [...new Set([...board.matchAll(/\(model\s+"([^"]+)"/g)].map((m) => m[1]))];
}

/**
 * @param {string} ref
 * @returns {{ kind: "lib", rel: string } | { kind: "project", rel: string } | null}
 */
export function classifyRef(ref) {
  const lib = /^\$[{(][A-Z0-9_]*3DMODEL_DIR[})]\/+(.+)$/.exec(ref) ?? /^\$[{(]KISYS3DMOD[})]\/+(.+)$/.exec(ref);
  if (lib) return { kind: "lib", rel: lib[1] };
  const prj = /^\$[{(]KIPRJMOD[})]\/+(.+)$/.exec(ref);
  if (prj) return { kind: "project", rel: prj[1] };
  return null;
}

/** @param {string} rel */
function fallbacks(rel) {
  const m = /^(.*)\.(wrl|wrz|step|stp)$/i.exec(rel);
  if (!m) return [rel];
  return /wr/i.test(m[2]) ? [rel, `${m[1]}.step`, `${m[1]}.stp`] : [rel, `${m[1]}.wrl`];
}

/**
 * Library models from the model CDN: `<root>/<lib>/manifest` maps
 * `model3d/<name>.<ext>` → { hash }, bodies live at
 * `<root>/../blobs/sha256/<hash>`.
 * @param {string} manifestUrl e.g. https://cdn.pcbjam.com/libs/kicad-models/10.0.3/manifest.json
 */
function cdnModels(manifestUrl) {
  const root = manifestUrl.replace(/\/manifest\.json$/, "");
  const blobs = `${root.replace(/\/[^/]+$/, "")}/blobs/sha256`;
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pcbjam", "models", "sha256");
  /** @type {Map<string, Promise<Record<string, { hash: string }> | null>>} */
  const libs = new Map();
  const libManifest = (/** @type {string} */ lib) => {
    let p = libs.get(lib);
    if (!p) {
      p = fetch(`${root}/${encodeURIComponent(lib)}/manifest`)
        .then(async (r) => {
          if (!r.ok) return null;
          const m = /** @type {any} */ (await r.json());
          return m.entries ?? m;
        })
        .catch(() => null);
      libs.set(lib, p);
    }
    return p;
  };
  /** @param {string} rel `<lib>.3dshapes/<name>.<ext>` → bytes or null */
  return async (rel) => {
    const m = /^([^/]+)\.3dshapes\/(.+)$/.exec(rel);
    if (!m) return null;
    const entries = await libManifest(m[1]);
    const entry = entries?.[`model3d/${m[2]}`];
    if (!entry?.hash) return null;
    const hash = String(entry.hash).replace(/^sha256:/, "");
    const cached = join(cache, hash);
    if (existsSync(cached)) return new Uint8Array(await readFile(cached));
    const res = await fetch(`${blobs}/${hash}`);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return null;
    await mkdir(cache, { recursive: true });
    await writeFile(`${cached}.part`, bytes);
    await rename(`${cached}.part`, cached);
    return bytes;
  };
}

/**
 * @param {string} boardPath
 * @param {string} outPath
 * @param {Record<string, string>} opts
 */
export async function stepExport(boardPath, outPath, opts) {
  if (!boardPath || !outPath) {
    process.stderr.write("usage: pcbjam-tools step <file.kicad_pcb> <out> [--format step|stepz|glb|stl] [--models dir]\n");
    return 2;
  }
  const format = FORMATS[(opts.format ?? "step").toLowerCase()];
  if (!format) {
    process.stderr.write(`unknown --format ${opts.format}\n`);
    return 2;
  }
  let board = await readFile(boardPath, "utf8");
  /** @type {Array<{ path: string, bytes: Uint8Array }>} */
  const models = [];
  const missing = [];
  const manifestUrl = opts["models-manifest"] ?? process.env.PCBJAM_MODELS_MANIFEST_URL;
  const fromCdn = opts.models === "cdn" ? (manifestUrl ? cdnModels(manifestUrl) : null) : null;
  if (opts.models === "cdn" && !fromCdn) {
    process.stderr.write("--models cdn needs --models-manifest <url> or PCBJAM_MODELS_MANIFEST_URL\n");
    return 2;
  }
  for (const ref of modelRefs(board)) {
    const c = classifyRef(ref);
    if (!c) continue;
    if (c.kind === "lib" && fromCdn) {
      let found = null;
      for (const rel of fallbacks(c.rel)) {
        const bytes = await fromCdn(rel);
        if (bytes) {
          found = { path: rel, bytes };
          break;
        }
      }
      if (found) models.push(found);
      else missing.push(ref);
      continue;
    }
    const base = c.kind === "lib" ? opts.models : dirname(boardPath);
    const hit = base ? fallbacks(c.rel).find((rel) => existsSync(join(base, rel))) : undefined;
    if (!base || !hit) {
      missing.push(ref);
      continue;
    }
    const staged = c.kind === "lib" ? hit : `${PROJECT_PREFIX}/${hit}`;
    models.push({ path: staged, bytes: new Uint8Array(await readFile(join(/** @type {string} */ (base), hit))) });
    if (c.kind === "project") board = board.split(`"${ref}"`).join(`"${PROJECT_PREFIX}/${c.rel}"`);
  }

  const dir = await moduleDir("occ_service");
  const require = createRequire(import.meta.url);
  const factory = require(join(dir, "occ_service.js"));
  const mod = await factory({
    locateFile: (/** @type {string} */ f) => join(dir, f),
    print: () => {},
    printErr: (/** @type {string} */ s) => {
      if (!/(^|: )Debug: /.test(s) && !s.startsWith("[occ_service]")) process.stderr.write(`${s}\n`);
    },
  });
  const res = mod.occExport(board, JSON.stringify({ format, overwrite: true, subst_models: true }), models);
  const report = String(res.report ?? "");
  if (!res.ok) {
    process.stderr.write(`${boardPath}: export failed\n${report}\n`);
    return 4;
  }
  await writeFile(outPath, res.bytes);
  for (const ref of missing) process.stderr.write(`missing model: ${ref}\n`);
  // The verdict line LAST (callers read the final stderr line as the summary).
  process.stderr.write(
    `${boardPath}: OK -> ${outPath} (${models.length} models${missing.length ? `, ${missing.length} missing` : ""})\n`,
  );
  return 0;
}
