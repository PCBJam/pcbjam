/**
 * Where the WebAssembly modules come from (mcp 0004 §11.5):
 *   1. KICAD_TOOLS_WASM_DIR — a directory holding kicad_tools.{js,wasm} (and
 *      occ_service.{js,wasm}): the runner image, a local build;
 *   2. the user cache (~/.cache/pcbjam/wasm/<tool>/<version>/), filled from
 *   3. the CDN, pinned by manifest.json (version + sha256 per file), checked
 *      before use.
 * occ_service (OpenCASCADE, ~60 MB) is only fetched by a 3D command.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** src/ or dist/ — both sit one level below the package root. */
const HERE = dirname(fileURLToPath(import.meta.url));

export type Tool = "kicad_tools" | "occ_service";

export interface ToolPin {
  ver: string;
  /** file name → "sha256:<hex>" */
  files: Record<string, string>;
}

export interface Manifest {
  version: string;
  cdn: string;
  tools: Partial<Record<Tool, ToolPin>>;
}

export async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(HERE, "..", "manifest.json"), "utf8")) as Manifest;
}

function cacheRoot(): string {
  return process.env.PCBJAM_TOOLS_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pcbjam", "wasm");
}

/** Dev fallback: running from the pcbjam repo with a local build. */
function repoOutputDir(): string | null {
  const dir = join(HERE, "..", "..", "..", "output");
  return existsSync(join(dir, "kicad_tools.js")) ? dir : null;
}

/**
 * The directory holding `<tool>.js` + `<tool>.wasm`, downloading and
 * verifying them first when needed.
 */
export async function moduleDir(tool: Tool): Promise<string> {
  const explicit = process.env.KICAD_TOOLS_WASM_DIR;
  if (explicit) {
    if (!existsSync(join(explicit, `${tool}.js`))) {
      throw new Error(`${tool}.js not found in KICAD_TOOLS_WASM_DIR (${explicit})`);
    }
    return explicit;
  }
  const manifest = await readManifest();
  const pin = manifest.tools[tool];
  if (!pin) {
    const dev = repoOutputDir();
    if (dev && existsSync(join(dev, `${tool}.js`))) return dev;
    throw new Error(
      `no ${tool} build pinned in this package (dev build?) — set KICAD_TOOLS_WASM_DIR to a directory with ${tool}.js/.wasm`,
    );
  }
  const dir = join(cacheRoot(), tool, pin.ver);
  const complete = Object.keys(pin.files).every((name) => existsSync(join(dir, name)));
  if (complete) return dir;
  await mkdir(dir, { recursive: true });
  for (const [name, digest] of Object.entries(pin.files)) {
    const url = `${manifest.cdn}/${tool}/${pin.ver}/${name}`;
    process.stderr.write(`pcbjam-tools: downloading ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (got !== digest) throw new Error(`checksum mismatch for ${url}: expected ${digest}, got ${got}`);
    const tmp = join(dir, `${name}.part`);
    await writeFile(tmp, bytes);
    await rename(tmp, join(dir, name));
  }
  return dir;
}

/**
 * Download (and verify) every pinned module, optionally copying them flat
 * into `to` — how an image pre-fills its WebAssembly (`pcbjam-tools fetch
 * --to /opt/pcbjam/wasm`, then KICAD_TOOLS_WASM_DIR points there).
 */
export async function fetchAll(to?: string): Promise<Record<string, string>> {
  const manifest = await readManifest();
  const tools = Object.keys(manifest.tools) as Tool[];
  if (tools.length === 0) throw new Error("this package pins no builds (a dev checkout?) — nothing to fetch");
  if (to) await mkdir(to, { recursive: true });
  const out: Record<string, string> = {};
  for (const tool of tools) {
    const dir = await moduleDir(tool);
    out[tool] = manifest.tools[tool]?.ver ?? "";
    if (to) for (const name of Object.keys(manifest.tools[tool]?.files ?? {})) await copyFile(join(dir, name), join(to, name));
  }
  return out;
}
