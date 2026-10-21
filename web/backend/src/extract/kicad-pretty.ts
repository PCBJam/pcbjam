/**
 * Parsing helpers for KiCad's footprint-library format (`.pretty` directories).
 *
 * A footprint library is a directory `<Name>.pretty/` holding one
 * `<Footprint>.kicad_mod` file per footprint; each file is a complete,
 * self-contained `(footprint "<Name>" …)` s-expr document — there is no
 * inheritance (unlike symbols' `extends`), so no parent-bundling step. The
 * library item name is the FILE name (without `.kicad_mod`), which is what
 * KiCad uses as the footprint's lib id.
 *
 * Like symbols, we don't need a full parser: a brace-matching scanner that
 * respects quoted strings (shared with `kicad-symdir`) is enough to walk the
 * footprint's direct children and read `(descr …)`, `(tags …)`, and `(model …)`.
 *
 * Ported from the closed ingest pipeline so the GPL reference backend can build
 * its own example-lib fixtures at dev time. The fork-version cap tracks the
 * WASM fork that lives in this same repo.
 */

import { matchParen, unescape } from "./kicad-symdir.js";

export interface ParsedFootprint {
  /** Item name (from the file name, e.g. "R_0402_1005Metric"). */
  name: string;
  description: string | null;
  keywords: string | null;
  /** 3D model reference paths from `(model "…")` forms (bytes never fetched). */
  modelRefs: string[];
  /** The fork-loadable body (version capped; see capFootprintVersionForFork). */
  body: string;
}

/**
 * Max board/footprint file-format version the WASM fork parses
 * (SEXPR_BOARD_FILE_VERSION in pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h).
 * A `.kicad_mod` declaring a NEWER version is rejected up front with
 * FUTURE_FORMAT_ERROR. The KiCad-10.0.3 footprint data declares a newer version
 * (e.g. 20260206) but introduces NO new structural tokens over this fork (every
 * token in the data is in the fork's pcb.keywords) — so capping the version is
 * sufficient and lossless, no token stripping (unlike the symbol side). Bump
 * alongside the fork.
 */
export const FORK_MAX_BOARD_VERSION = 20251028;

/** Cap the `(version NNNN)` header so the fork doesn't reject it as future-format. */
export function capFootprintVersionForFork(body: string): string {
  return body.replace(/\(\s*version\s+(\d+)\s*\)/, (m, v) =>
    Number(v) > FORK_MAX_BOARD_VERSION ? `(version ${FORK_MAX_BOARD_VERSION})` : m,
  );
}

/** Find [start, end) of the top-level `(footprint …)` block. */
function findTopFootprint(src: string): [number, number] {
  const m = src.match(/\(\s*footprint\b/);
  if (!m || m.index === undefined) {
    throw new Error("no (footprint …) found");
  }
  return matchParen(src, m.index);
}

/**
 * Unique electrical pad count, as `FOOTPRINT::GetUniquePadCount( DO_NOT_INCLUDE_NPTH )`.
 * It lives in `@pcbjam/shared` (libs 0028) so the demo fp-index and the platform
 * library index count pads the same way.
 */
export { countUniquePads } from "@pcbjam/shared";

/**
 * Parse one `.kicad_mod` document. `name` is the file-derived item name. Walks
 * the footprint's direct children (depth 1) so a `descr`/`tags`/`model` word
 * inside a quoted string can't be mistaken for a real token.
 */
export function parseFootprintFile(src: string, name: string): ParsedFootprint {
  const [s, e] = findTopFootprint(src);
  const block = src.slice(s, e);

  let description: string | null = null;
  let keywords: string | null = null;
  const modelRefs: string[] = [];

  let i = block.indexOf("(", 1); // first child form
  while (i >= 0 && i < block.length) {
    const [cs, ce] = matchParen(block, i);
    const form = block.slice(cs, ce);

    const d = form.match(/^\(\s*descr\s+"((?:[^"\\]|\\.)*)"/);
    if (d && description === null) description = unescape(d[1]!);
    const t = form.match(/^\(\s*tags\s+"((?:[^"\\]|\\.)*)"/);
    if (t && keywords === null) keywords = unescape(t[1]!);
    const mo = form.match(/^\(\s*model\s+"((?:[^"\\]|\\.)*)"/);
    if (mo) modelRefs.push(unescape(mo[1]!));

    i = block.indexOf("(", ce); // next sibling
  }

  return {
    name,
    description,
    keywords,
    modelRefs,
    // Store the capped full document (the .kicad_mod IS the footprint s-expr).
    body: capFootprintVersionForFork(src),
  };
}
