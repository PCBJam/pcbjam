/**
 * Project-sidecar sweep (proposal 21, WP-0 S6).
 *
 * KiCad writes some project sidecars OUTSIDE the three save chokepoints that
 * fire `kicadCollab.onSave`: the Custom Rules panel writes `<board>.kicad_dru`
 * straight to MEMFS on OK, and `SavePcbFile` routes only the board and the
 * `.kicad_pro`. Nothing uploaded the rules file, so browser-edited custom
 * rules were lost on reload and never reached peers.
 *
 * The sweep remembers each sidecar's bytes as staged, and on every `sweep()`
 * re-reads them from MEMFS; a changed file is handed to the existing save
 * hook (`kicadCollab.onSave(absPath)`), so it takes the normal persistence
 * path — per-path lanes, CAS, the save-blocked banner. Triggers: a board save
 * (the Board Setup dialog-close trigger joins in proposal 21 WP4).
 *
 * `noteRestaged` records a peer's version as "seen" so restaging it never
 * echoes back as an upload.
 */
import { memfsFilePath } from "../constants";

interface SweepWindow {
  FS?: { readFile(path: string): Uint8Array };
  kicadCollab?: { onSave?: (absPath: string) => void };
}

export interface SidecarSweep {
  /** Re-read every sidecar; hand changed ones to the save hook. Returns the changed paths. */
  sweep(reason: string): string[];
  /** A peer's version landed in MEMFS (files-watch restage): it is the new "seen" state. */
  noteRestaged(relPath: string, bytes: Uint8Array): void;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Sidecars of a board: the rules file KiCad keys off the board's stem. */
export function boardSidecarPaths(boardRelPath: string): string[] {
  if (!boardRelPath.endsWith(".kicad_pcb")) return [];
  return [boardRelPath.replace(/\.kicad_pcb$/, ".kicad_dru")];
}

export function createSidecarSweep(opts: {
  win: SweepWindow;
  slug: string;
  paths: readonly string[];
  log: (m: string) => void;
}): SidecarSweep {
  const read = (relPath: string): Uint8Array | null => {
    try {
      const bytes = opts.win.FS?.readFile(memfsFilePath(opts.slug, relPath));
      return bytes ? new Uint8Array(bytes) : null;
    } catch {
      return null; // not created (yet) — KiCad writes the rules file on first use
    }
  };
  const seen = new Map<string, Uint8Array | null>();
  for (const p of opts.paths) seen.set(p, read(p));

  return {
    sweep(reason) {
      const changed: string[] = [];
      for (const p of opts.paths) {
        const now = read(p);
        if (now === null || sameBytes(now, seen.get(p) ?? null)) continue;
        seen.set(p, now);
        changed.push(p);
        opts.log(`[sidecar] ${p} changed (${reason}) → save hook`);
        opts.win.kicadCollab?.onSave?.(memfsFilePath(opts.slug, p));
      }
      return changed;
    },
    noteRestaged(relPath, bytes) {
      if (seen.has(relPath)) seen.set(relPath, new Uint8Array(bytes));
    },
  };
}
