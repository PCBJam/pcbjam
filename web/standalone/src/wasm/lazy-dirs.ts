import { dirOf } from "./stage-plan";

/**
 * Placeholder folders (project-sync 0003): a project folder that was not
 * staged exists in MEMFS, empty, and is filled the first time KiCad looks
 * into it — a file picker listing it, or any code opening a file in it.
 *
 * The hook sits on the Emscripten filesystem node, not in KiCad or wxWidgets:
 * a directory node's `readdir` (listing) and `lookup` (a name the cache does
 * not hold) run through per-node operations, so replacing those two on a
 * placeholder catches every reader — the generic file dialog, a typed path,
 * a library scan, a reference kind the stage plan does not parse — without a
 * C++ change. The cost: the fill runs INSIDE a synchronous filesystem call,
 * so the fetch must be synchronous too (lazy-fetch.ts). It blocks the page
 * for one request per folder, once.
 *
 * `lookup` only fills for a name the listing says is there: KiCad probing a
 * placeholder for a lock or cache file must not download the folder.
 */

interface FsNode {
  node_ops: {
    readdir(node: FsNode): string[];
    lookup(parent: FsNode, name: string): FsNode;
    [op: string]: unknown;
  };
}

/** The slice of the Emscripten FS this needs (structural; tests fake it). */
export interface LazyFs {
  mkdirTree(path: string): void;
  lookupPath(path: string): { node: FsNode };
  lookupNode(parent: FsNode, name: string): FsNode;
}

export interface LazyDirsOptions {
  fs: LazyFs;
  /** MEMFS directory of the project (`memfsProjectDir`). */
  root: string;
  /** Every folder of the listing (project-relative), so the tree exists. */
  dirs: readonly string[];
  /** Folder → its direct files that are not staged. */
  missing: Map<string, Set<string>>;
  /** Fetch the named files of one folder, synchronously. */
  fetchFolder: (dir: string, paths: string[]) => Array<[string, Uint8Array]>;
  /** Write one fetched file (the stage step: viewer filters, MEMFS write). */
  stage: (path: string, bytes: Uint8Array) => void;
  log: (msg: string) => void;
}

export interface LazyDirs {
  /**
   * A peer changed or added `path`: true when it is in MEMFS (or its folder
   * is fully loaded) and should be restaged now; false when its folder is
   * still a placeholder — it is remembered and arrives with the folder.
   */
  noteChanged(path: string): boolean;
  /** A peer removed `path`: a placeholder forgets it. */
  noteRemoved(path: string): void;
  /** Folders still waiting to be filled. */
  pending(): string[];
}

/** A failed fill is retried on the next look, this many times in all. */
const MAX_FILL_ATTEMPTS = 2;

export function installLazyDirs(opts: LazyDirsOptions): LazyDirs {
  const { fs, root, missing, log } = opts;
  const abs = (dir: string) => (dir ? `${root}/${dir}` : root);
  const hooked = new Map<string, { node: FsNode; original: FsNode["node_ops"]; attempts: number }>();

  const unhook = (dir: string): void => {
    const h = hooked.get(dir);
    if (!h) return;
    h.node.node_ops = h.original;
    hooked.delete(dir);
  };

  /** Fetch and stage what the folder still lacks. True when anything landed. */
  const fill = (dir: string): boolean => {
    const h = hooked.get(dir);
    const want = [...(missing.get(dir) ?? [])];
    if (!h || !want.length) {
      unhook(dir);
      return false;
    }
    // Unhook first: staging writes into this folder and must not re-enter.
    h.node.node_ops = h.original;
    h.attempts += 1;
    let staged = 0;
    try {
      for (const [path, bytes] of opts.fetchFolder(dir, want)) {
        if (!missing.get(dir)?.delete(path)) continue;
        opts.stage(path, bytes);
        staged += 1;
      }
      log(`[lazy] ${dir || "/"}: ${staged}/${want.length} file(s) loaded on demand`);
      // A file the server no longer has is not coming: the folder is done.
      missing.delete(dir);
      hooked.delete(dir);
    } catch (err) {
      log(`[lazy] ${dir || "/"} could not be loaded: ${String(err)}`);
      if (h.attempts < MAX_FILL_ATTEMPTS) h.node.node_ops = hookOps(dir, h.original);
      else hooked.delete(dir);
    }
    return staged > 0;
  };

  const hookOps = (dir: string, original: FsNode["node_ops"]): FsNode["node_ops"] => ({
    ...original,
    readdir(node) {
      fill(dir);
      return original.readdir(node);
    },
    lookup(parent, name) {
      const path = dir ? `${dir}/${name}` : name;
      if (missing.get(dir)?.has(path) && fill(dir)) return fs.lookupNode(parent, name);
      return original.lookup(parent, name);
    },
  });

  const hook = (dir: string): void => {
    if (hooked.has(dir)) return;
    fs.mkdirTree(abs(dir));
    const node = fs.lookupPath(abs(dir)).node;
    const original = node.node_ops;
    hooked.set(dir, { node, original, attempts: 0 });
    node.node_ops = hookOps(dir, original);
  };

  for (const dir of opts.dirs) fs.mkdirTree(abs(dir));
  for (const [dir, paths] of missing) if (paths.size) hook(dir);
  log(`[lazy] ${hooked.size} placeholder folder(s)`);

  return {
    noteChanged(path) {
      const dir = dirOf(path);
      if (!hooked.has(dir)) return true;
      const set = missing.get(dir)!;
      // Staged on its own (a referenced file in a folder not otherwise
      // loaded): restage it like any loaded file.
      if (!set.has(path) && isStaged(fs, abs(dir), path)) return true;
      set.add(path);
      return false;
    },
    noteRemoved(path) {
      const dir = dirOf(path);
      const set = missing.get(dir);
      if (!set?.delete(path)) return;
      if (!set.size) {
        unhook(dir);
        missing.delete(dir);
      }
    },
    pending: () => [...hooked.keys()],
  };
}

/** Is `path` already a node of its (placeholder) folder? Never triggers a fill. */
function isStaged(fs: LazyFs, absDir: string, path: string): boolean {
  try {
    const parent = fs.lookupPath(absDir).node;
    // Only names the listing still owes fill; a staged one is in the cache.
    fs.lookupNode(parent, path.slice(path.lastIndexOf("/") + 1));
    return true;
  } catch {
    return false;
  }
}
