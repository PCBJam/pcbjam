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
import type { Options } from "./commands.ts";
import { moduleDir } from "./modules.ts";

const FORMATS: Record<string, string> = {
  step: "step",
  stepz: "stpz",
  stpz: "stpz",
  glb: "glb",
  stl: "stl",
  brep: "brep",
  ply: "ply",
  xao: "xao",
};
/** Where project-relative model refs are staged (bare relative refs reach
 *  the module's staged-model probe; ${KIPRJMOD} would not). */
const PROJECT_PREFIX = "kiprjmod";

export type ModelRef = { kind: "lib"; rel: string } | { kind: "project"; rel: string };

interface StagedModel {
  path: string;
  bytes: Uint8Array;
}

/** What occ_service's emscripten factory resolves to (the parts used here). */
interface OccModule {
  occExport(board: string, job: string, models: StagedModel[]): { ok: boolean; report?: string; bytes: Uint8Array };
}
type OccFactory = (opts: {
  locateFile: (f: string) => string;
  print: (s: string) => void;
  printErr: (s: string) => void;
}) => Promise<OccModule>;

export function modelRefs(board: string): string[] {
  return [...new Set([...board.matchAll(/\(model\s+"([^"]+)"/g)].map((m) => m[1] as string))];
}

export function classifyRef(ref: string): ModelRef | null {
  const lib = /^\$[{(][A-Z0-9_]*3DMODEL_DIR[})]\/+(.+)$/.exec(ref) ?? /^\$[{(]KISYS3DMOD[})]\/+(.+)$/.exec(ref);
  if (lib?.[1]) return { kind: "lib", rel: lib[1] };
  const prj = /^\$[{(]KIPRJMOD[})]\/+(.+)$/.exec(ref);
  if (prj?.[1]) return { kind: "project", rel: prj[1] };
  return null;
}

function fallbacks(rel: string): string[] {
  const m = /^(.*)\.(wrl|wrz|step|stp)$/i.exec(rel);
  if (!m) return [rel];
  return /wr/i.test(m[2] ?? "") ? [rel, `${m[1]}.step`, `${m[1]}.stp`] : [rel, `${m[1]}.wrl`];
}

/**
 * Library models from the model CDN: `<root>/<lib>/manifest` maps
 * `model3d/<name>.<ext>` → { hash }, bodies live at
 * `<root>/../blobs/sha256/<hash>`.
 * @param manifestUrl e.g. https://cdn.pcbjam.com/libs/kicad-models/10.0.3/manifest.json
 */
function cdnModels(manifestUrl: string): (rel: string) => Promise<Uint8Array | null> {
  const root = manifestUrl.replace(/\/manifest\.json$/, "");
  const blobs = `${root.replace(/\/[^/]+$/, "")}/blobs/sha256`;
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pcbjam", "models", "sha256");
  const libs = new Map<string, Promise<Record<string, { hash?: string }> | null>>();
  const libManifest = (lib: string) => {
    let p = libs.get(lib);
    if (!p) {
      p = fetch(`${root}/${encodeURIComponent(lib)}/manifest`)
        .then(async (r) => {
          if (!r.ok) return null;
          const m = (await r.json()) as { entries?: Record<string, { hash?: string }> } & Record<string, { hash?: string }>;
          return m.entries ?? m;
        })
        .catch(() => null);
      libs.set(lib, p);
    }
    return p;
  };
  // `<lib>.3dshapes/<name>.<ext>` → bytes or null
  return async (rel) => {
    const m = /^([^/]+)\.3dshapes\/(.+)$/.exec(rel);
    if (!m?.[1]) return null;
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

/** The board text ready for occ_service, its staged models and the refs not found. */
export interface PreparedBoard {
  board: string;
  models: StagedModel[];
  missing: string[];
}

/**
 * Read a board and stage the 3D models it references (library models from
 * `--models <dir>` or the model CDN, project models next to the board).
 * Throws a usage Error for `--models cdn` without a manifest URL.
 */
export async function prepareBoard(boardPath: string, opts: Options): Promise<PreparedBoard> {
  let board = await readFile(boardPath, "utf8");
  const models: StagedModel[] = [];
  const missing: string[] = [];
  const manifestUrl = opts["models-manifest"] ?? process.env.PCBJAM_MODELS_MANIFEST_URL;
  const fromCdn = opts.models === "cdn" && manifestUrl ? cdnModels(manifestUrl) : null;
  if (opts.models === "cdn" && !fromCdn) {
    throw new UsageError("--models cdn needs --models-manifest <url> or PCBJAM_MODELS_MANIFEST_URL");
  }
  // --models-dir: models fetched by someone else (e.g. the PCBJam runner for
  // team libraries), laid out as <lib>.3dshapes/<name>; tried before the CDN.
  const extraDir = opts["models-dir"];
  for (const ref of modelRefs(board)) {
    const c = classifyRef(ref);
    if (!c) continue;
    if (c.kind === "lib" && extraDir) {
      const hit = fallbacks(c.rel).find((rel) => existsSync(join(extraDir, rel)));
      if (hit) {
        models.push({ path: hit, bytes: new Uint8Array(await readFile(join(extraDir, hit))) });
        continue;
      }
    }
    if (c.kind === "lib" && fromCdn) {
      let found: StagedModel | null = null;
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
    models.push({ path: staged, bytes: new Uint8Array(await readFile(join(base, hit))) });
    if (c.kind === "project") board = board.split(`"${ref}"`).join(`"${PROJECT_PREFIX}/${c.rel}"`);
  }
  return { board, models, missing };
}

/** A bad invocation (exit code 2). */
export class UsageError extends Error {}

/**
 * Run occ_service's export (the official JOB_EXPORT_PCB_3D JSON fields).
 * Returns the bytes, or the module's report on failure.
 */
export async function occExport(
  prepared: PreparedBoard,
  job: Record<string, unknown>,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; report: string }> {
  const dir = await moduleDir("occ_service");
  const require = createRequire(import.meta.url);
  const factory = require(join(dir, "occ_service.js")) as OccFactory;
  const mod = await factory({
    locateFile: (f) => join(dir, f),
    print: () => {},
    printErr: (s) => {
      if (!/(^|: )Debug: /.test(s) && !s.startsWith("[occ_service]")) process.stderr.write(`${s}\n`);
    },
  });
  const res = mod.occExport(prepared.board, JSON.stringify({ overwrite: true, subst_models: true, ...job }), prepared.models);
  return res.ok ? { ok: true, bytes: res.bytes } : { ok: false, report: String(res.report ?? "") };
}

export async function stepExport(boardPath: string | undefined, outPath: string | undefined, opts: Options): Promise<number> {
  if (!boardPath || !outPath) {
    process.stderr.write("usage: pcbjam-tools step <file.kicad_pcb> <out> [--format step|stepz|glb|stl] [--models dir|cdn] [--models-dir dir]\n");
    return 2;
  }
  const format = FORMATS[(opts.format ?? "step").toLowerCase()];
  if (!format) {
    process.stderr.write(`unknown --format ${opts.format}\n`);
    return 2;
  }
  let prepared: PreparedBoard;
  try {
    prepared = await prepareBoard(boardPath, opts);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const res = await occExport(prepared, { format });
  if (!res.ok) {
    process.stderr.write(`${boardPath}: export failed\n${res.report}\n`);
    return 4;
  }
  await writeFile(outPath, res.bytes);
  for (const ref of prepared.missing) process.stderr.write(`missing model: ${ref}\n`);
  // The verdict line LAST (callers read the final stderr line as the summary).
  const { models, missing } = prepared;
  process.stderr.write(
    `${boardPath}: OK -> ${outPath} (${models.length} models${missing.length ? `, ${missing.length} missing` : ""})\n`,
  );
  return 0;
}
