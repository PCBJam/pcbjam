import { sheetRefsOf } from "@pcbjam/shared";

/**
 * Which project files a tool needs before it opens (project-sync 0003).
 *
 * A project created from a Git repository carries everything under its root —
 * firmware, documents, other boards, libraries nobody uses. Staging all of it
 * made every open wait for all of it. The rule here needs no knowledge of
 * file types:
 *
 *  - the PROJECT FOLDER's own files (the folder holding the opened file's
 *    `.kicad_pro`), whatever they are — a file picker must find them;
 *  - what the design REFERENCES, wherever it lives: sub-sheets, the drawing
 *    sheet, project-local libraries, 3D model folders, simulation models;
 *  - every other folder exists as a placeholder that is filled when KiCad
 *    first looks into it (lazy-dirs.ts), so nothing here is load-bearing for
 *    correctness — a reference kind this file does not know only costs one
 *    blocking folder fetch instead of failing.
 *
 * A read-only viewer gets the bare minimum: the project file, the opened
 * file with its sheets, and its same-stem schematic / board and companions.
 *
 * Pure: paths in, paths out.
 */

/** Below this many files a project is staged whole: one bundle beats many small requests. */
export const SCOPED_STAGING_MIN_FILES = 48;

/**
 * Scoped or whole-tree staging for this open. `?stage=all` is the escape
 * hatch (a wrongly skipped file fails silently inside KiCad, so the old
 * behaviour stays one flag away); `?stage=scoped` forces the new one on a
 * small project.
 */
export function wantsScopedStaging(search: string, fileCount: number, deploymentAll = false): boolean {
  const flag = new URLSearchParams(search).get("stage");
  if (flag === "all") return false;
  if (flag === "scoped") return true;
  // `VITE_STAGE_ALL=1`: the whole deployment stages everything, as before.
  if (deploymentAll) return false;
  return fileCount > SCOPED_STAGING_MIN_FILES;
}

/** Directory of a project-relative path ("" = the project root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The folder holding the opened file's project: the nearest ancestor of the
 * target with a `.kicad_pro` directly in it, else the target's own folder.
 * Without a target (a library editor), the project root.
 */
export function projectDirFor(paths: readonly string[], targetPath?: string): string {
  if (!targetPath) return "";
  const proDirs = new Set(paths.filter((p) => p.endsWith(".kicad_pro")).map(dirOf));
  for (let dir = dirOf(targetPath); ; dir = dirOf(dir)) {
    if (proDirs.has(dir)) return dir;
    if (dir === "") break;
  }
  return dirOf(targetPath);
}

/** Extensions that travel with a design file of the same stem. */
const COMPANION_EXT = ["kicad_pro", "kicad_prl", "kicad_dru", "kicad_sch", "kicad_pcb"];

export interface StagePlanInput {
  /** Every project-relative path of the listing. */
  paths: readonly string[];
  targetPath?: string;
  /** Read-only / commenter session. */
  viewer: boolean;
  /** GerbView opens every layer beside the target (kicad-runner gerberSiblings). */
  gerbview?: boolean;
}

/** What is staged before anything is parsed. */
export function initialStageSet(input: StagePlanInput): { projectDir: string; paths: Set<string> } {
  const { paths, targetPath } = input;
  const known = new Set(paths);
  const projectDir = projectDirFor(paths, targetPath);
  const out = new Set<string>();
  if (targetPath) out.add(targetPath);

  // Same-stem companions of the target and of every project file in the
  // project folder — what lets a viewer move between schematic and board.
  const stems = new Set<string>();
  if (targetPath) stems.add(targetPath.replace(/\.[^./]+$/, ""));
  for (const p of paths) {
    if (dirOf(p) !== projectDir) continue;
    if (p.endsWith(".kicad_pro")) {
      out.add(p);
      stems.add(p.replace(/\.kicad_pro$/, ""));
    }
  }
  for (const stem of stems) {
    for (const ext of COMPANION_EXT) if (known.has(`${stem}.${ext}`)) out.add(`${stem}.${ext}`);
  }

  if (!input.viewer) {
    for (const p of paths) if (dirOf(p) === projectDir) out.add(p);
  }
  if (input.gerbview && targetPath) {
    const dir = dirOf(targetPath);
    for (const p of paths) if (dirOf(p) === dir) out.add(p);
  }
  return { projectDir, paths: out };
}

function unescapeSexpr(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Resolve a path KiCad would read from a project: `${KIPRJMOD}/…` and plain
 * relative paths are project-folder relative (`base` when given — a sheet's
 * own folder). Absolute paths, URLs and other variables are not project
 * files: null. Also null when the path escapes the root.
 */
export function resolveProjectRef(projectDir: string, raw: string, base?: string): string | null {
  let r = unescapeSexpr(raw).trim().replace(/\\/g, "/");
  if (!r) return null;
  let from = base ?? projectDir;
  if (r.startsWith("${KIPRJMOD}")) {
    r = r.slice("${KIPRJMOD}".length);
    from = projectDir;
  } else if (r.startsWith("/") || r.includes("${") || /^[a-z][a-z0-9+.-]*:/i.test(r)) {
    return null;
  }
  const out = from ? from.split("/") : [];
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** A reference found in a staged file. */
export type StageRef =
  /** One file. */
  | { kind: "file"; path: string }
  /** A library: the file itself, or everything under the folder. */
  | { kind: "tree"; path: string }
  /** A folder's own files (a 3D model with its neighbours). */
  | { kind: "dir"; dir: string };

const SIM_LIBRARY_RE = /\(property\s+"Sim\.Library"\s+"((?:[^"\\]|\\.)*)"/g;
const MODEL_RE = /\(model\s+"((?:[^"\\]|\\.)*)"/g;
const LIB_URI_RE = /\(uri\s+(?:"((?:[^"\\]|\\.)*)"|([^\s)]+))\s*\)/g;
const DRAWING_SHEET_RE = /"page_layout_descr_file"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const LIB_TABLE_NAMES = new Set(["sym-lib-table", "fp-lib-table", "design-block-lib-table"]);

/** Files whose text is worth reading for references. */
export function hasReferences(path: string, viewer: boolean): boolean {
  if (path.endsWith(".kicad_sch") || path.endsWith(".kicad_pro")) return true;
  if (viewer) return false;
  return path.endsWith(".kicad_pcb") || path.endsWith(".kicad_mod") || LIB_TABLE_NAMES.has(baseOf(path));
}

/**
 * What a staged file points at. Text scans, not parses: a stray match only
 * stages one file more, and a miss is caught by the placeholder folders.
 */
export function referencesIn(
  path: string,
  text: string,
  ctx: { projectDir: string; viewer: boolean },
): StageRef[] {
  const out: StageRef[] = [];
  const file = (raw: string, base?: string) => {
    const p = resolveProjectRef(ctx.projectDir, raw, base);
    if (p) out.push({ kind: "file", path: p });
  };
  if (path.endsWith(".kicad_sch")) {
    for (const ref of sheetRefsOf(path, text)) if (ref.path) out.push({ kind: "file", path: ref.path });
    if (!ctx.viewer) for (const m of text.matchAll(SIM_LIBRARY_RE)) file(m[1]!);
  } else if (path.endsWith(".kicad_pro")) {
    for (const m of text.matchAll(DRAWING_SHEET_RE)) file(m[1]!.replace(/\\\\/g, "/"));
  }
  if (ctx.viewer) return out;
  if (path.endsWith(".kicad_pcb") || path.endsWith(".kicad_mod")) {
    for (const m of text.matchAll(MODEL_RE)) {
      const p = resolveProjectRef(ctx.projectDir, m[1]!);
      if (p) out.push({ kind: "dir", dir: dirOf(p) });
    }
  } else if (LIB_TABLE_NAMES.has(baseOf(path)) && dirOf(path) === ctx.projectDir) {
    for (const m of text.matchAll(LIB_URI_RE)) {
      const p = resolveProjectRef(ctx.projectDir, m[1] ?? m[2]!);
      if (p) out.push({ kind: "tree", path: p });
    }
  }
  return out;
}

/** The listed paths a set of references names. */
export function expandRefs(refs: readonly StageRef[], paths: readonly string[]): string[] {
  if (!refs.length) return [];
  const known = new Set(paths);
  const out = new Set<string>();
  const trees: string[] = [];
  const dirs = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === "file") {
      if (known.has(ref.path)) out.add(ref.path);
    } else if (ref.kind === "tree") {
      if (known.has(ref.path)) out.add(ref.path);
      else trees.push(`${ref.path}/`);
    } else {
      dirs.add(ref.dir);
    }
  }
  if (trees.length || dirs.size) {
    for (const p of paths) {
      if (dirs.has(dirOf(p)) || trees.some((t) => p.startsWith(t))) out.add(p);
    }
  }
  return [...out];
}

/**
 * Folders that still have unstaged files, each with those files — the
 * placeholders. Also every folder of the listing, so the tree exists.
 */
export function placeholderDirs(
  paths: readonly string[],
  staged: ReadonlySet<string>,
): { dirs: string[]; missing: Map<string, Set<string>> } {
  const dirs = new Set<string>();
  const missing = new Map<string, Set<string>>();
  for (const p of paths) {
    const dir = dirOf(p);
    for (let d = dir; d !== ""; d = dirOf(d)) dirs.add(d);
    if (staged.has(p)) continue;
    let set = missing.get(dir);
    if (!set) missing.set(dir, (set = new Set()));
    set.add(p);
  }
  return { dirs: [...dirs].sort(), missing };
}
