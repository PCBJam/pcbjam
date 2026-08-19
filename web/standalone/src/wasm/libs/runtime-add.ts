import type { LibsSource } from "./source";
import type { LibSetChangedDetail } from "./source";
import { libUri } from "./uri";

/**
 * Load a mid-session-announced library into the RUNNING editor — the action
 * behind the LIB_SET_CHANGED_EVENT toast. The lib set is otherwise frozen at
 * boot (sym/fp-lib-table written once in preRun), so this:
 *   1. re-lists the source per kind to find the announced lib (and its
 *      display name — the announce payload's name is advisory),
 *   2. creates the `/mnt/pcbjam/<id>` MEMFS placeholder the post-save stat
 *      path needs (boot creates these for boot-time libs only),
 *   3. calls the `kicadLibsAddEntry` bridge, which inserts the lib-table row
 *      into the live in-memory table, loads the lib through the provider and
 *      re-syncs any open editor tree.
 * Returns true when at least one kind actually added the lib. False ⇒ the
 * bridge is missing (pre-addEntry wasm build) or the lib isn't listed for
 * this session — the caller falls back to suggesting a reload.
 */
export async function addAnnouncedLib(
  source: LibsSource,
  detail: LibSetChangedDetail,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  const win = globalThis as {
    Module?: Record<string, unknown>;
    FS?: { writeFile?: (path: string, data: string) => void; analyzePath?: (p: string) => { exists: boolean } };
  };
  const addEntry = win.Module?.kicadLibsAddEntry as
    | ((kind: string, nickname: string, uri: string) => void)
    | undefined;
  if (typeof addEntry !== "function") {
    log(`[libs] addAnnouncedLib: kicadLibsAddEntry bridge missing`);
    return false;
  }

  let added = false;
  for (const kind of ["symbol", "footprint"]) {
    let libs;
    try {
      libs = await source.listLibs(kind);
    } catch (e) {
      log(`[libs] addAnnouncedLib: listLibs(${kind}) failed: ${String(e)}`);
      continue;
    }
    const lib = libs.find((l) => l.id === detail.libId);
    if (!lib) continue;

    const uri = libUri(lib.id);
    try {
      // The empty placeholder file the save flow's stat()s need; harmless if
      // another kind's pass (or a same-session retry) already wrote it.
      if (!win.FS?.analyzePath?.(uri)?.exists) {
        win.FS?.writeFile?.(uri, "");
      }
    } catch (e) {
      log(`[libs] addAnnouncedLib: placeholder write failed: ${String(e)}`);
    }

    try {
      addEntry(kind, lib.name, uri);
      log(`[libs] added ${kind} lib "${lib.name}" at runtime`);
      added = true;
    } catch (e) {
      log(`[libs] addAnnouncedLib: bridge failed for ${kind}: ${String(e)}`);
    }
  }
  return added;
}
