import { dirOf } from "../stage-plan";
import { installLazyDirs, type LazyDirs, type LazyFs } from "../lazy-dirs";
import { blockingGet } from "../lazy-fetch";
import { LIB_ROOTS_DIR } from "./models-bridge";

/**
 * Team-library datasheets (libs 0020 F): every `doc` item of a library with a
 * datasheets folder appears under `${<NICK>_DIR}` in MEMFS
 * (`/pcbjam/libroots/<VAR>/<docsDir>/<name>`) as a placeholder folder of the
 * project-sync 0003 kind. KiCad's datasheet open stats the expanded path; the
 * folder hook then fetches the files (one blocking GET each, once), so a
 * session downloads only the datasheets someone opens.
 */
export function installLibDocPlaceholders(opts: {
  fs: LazyFs & { writeFile(path: string, data: Uint8Array): void };
  lib: { id: string; paths: { pathVar: string; docsDir: string } };
  /** Doc item names (sub-folder paths relative to the datasheets folder). */
  names: readonly string[];
  /** The REST body URL of one library item. */
  itemUrl: (libId: string, kind: string, name: string) => string;
  log: (msg: string) => void;
  /** Test seam. */
  request?: typeof blockingGet;
}): LazyDirs | null {
  const docsDir = opts.lib.paths.docsDir.replace(/^\/+|\/+$/g, "");
  if (!docsDir || !opts.names.length) return null;
  const root = `${LIB_ROOTS_DIR}/${opts.lib.paths.pathVar}`;
  const get = opts.request ?? blockingGet;
  const missing = new Map<string, Set<string>>();
  for (const name of opts.names) {
    const path = `${docsDir}/${name}`;
    const dir = dirOf(path);
    let set = missing.get(dir);
    if (!set) missing.set(dir, (set = new Set()));
    set.add(path);
  }
  return installLazyDirs({
    fs: opts.fs,
    root,
    dirs: [...missing.keys()],
    missing,
    fetchFolder: (_dir, paths) => {
      const out: Array<[string, Uint8Array]> = [];
      for (const path of paths) {
        const name = path.slice(docsDir.length + 1);
        const res = get(opts.itemUrl(opts.lib.id, "doc", name));
        if (res.status === 404) continue;
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`datasheet download failed (${res.status}): ${name}`);
        }
        out.push([path, res.body]);
      }
      return out;
    },
    stage: (path, bytes) => opts.fs.writeFile(`${root}/${path}`, bytes),
    log: opts.log,
  });
}
