import { indexFootprintItem } from "@pcbjam/shared";

/**
 * Footprint index rows for the project's own `.pretty` libraries (libs 0029
 * section 3.2): the C++ side names the directories of the table's native rows,
 * and this reads them from MEMFS (the global `FS`; this build doesn't export
 * `Module.FS`), so the Add Symbol footprint list never parses those libraries
 * inside the modal pump. A file is parsed again only when its size or mtime
 * changes (the footprint editor saves into MEMFS).
 */

interface MemFs {
  readdir(path: string): string[];
  stat(path: string): { size: number; mtime: Date | number; mode: number };
  readFile(path: string, opts: { encoding: "utf8" }): string;
  isDir(mode: number): boolean;
}

const cache = new Map<string, { size: number; mtime: number; row: [string, number] | null }>();

export interface ProjectFpLib {
  /** The directory, as the C++ side sent it (its lookup key). */
  dir: string;
  /** `[name, uniquePads]`, the 0014 index shape. */
  rows: Array<[string, number]>;
  /** Changes when any file of the directory does. */
  token: string;
}

export function projectFootprintRows(dirs: readonly string[]): ProjectFpLib[] {
  const fs = (globalThis as { FS?: MemFs }).FS;
  if (!fs) return [];
  const out: ProjectFpLib[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      if (!fs.isDir(fs.stat(dir).mode)) continue;
      names = fs.readdir(dir).filter((n) => n.endsWith(".kicad_mod")).sort();
    } catch {
      continue; // gone, or not readable here: the native parse path answers it
    }
    const rows: Array<[string, number]> = [];
    let token = dir;
    for (const file of names) {
      const path = `${dir.replace(/\/+$/, "")}/${file}`;
      try {
        const st = fs.stat(path);
        const mtime = typeof st.mtime === "number" ? st.mtime : st.mtime.getTime();
        let hit = cache.get(path);
        if (!hit || hit.size !== st.size || hit.mtime !== mtime) {
          const name = file.slice(0, -".kicad_mod".length);
          const row = indexFootprintItem(name, fs.readFile(path, { encoding: "utf8" }));
          hit = { size: st.size, mtime, row: row ? [row.n, row.up] : null };
          cache.set(path, hit);
        }
        if (hit.row) rows.push(hit.row);
        token += `\n${file}\t${st.size}\t${mtime}`;
      } catch {
        // an unreadable file is left out, like KiCad skips a footprint that won't load
      }
    }
    out.push({ dir, rows, token });
  }
  return out;
}
