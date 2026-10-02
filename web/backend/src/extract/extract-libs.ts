import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSelfContainedLib,
  libHeader,
  type ParsedSymbol,
  parseSymbolFile,
} from "./kicad-symdir.js";
import { parseFootprintFile } from "./kicad-pretty.js";

/**
 * Extract a small curated set of real KiCad symbols + footprints into a fixtures
 * tree the GPL example backend (../server.ts) serves from LIBS_DIR. Produces the
 * PRE-BUILT self-contained bodies the backend hands the editor verbatim, so the
 * server itself stays parser-free at request time.
 *
 *   tsx src/extract/extract-libs.ts \
 *     --symbols-src <kicad-symbols checkout> \
 *     --footprints-src <kicad-footprints checkout> \
 *     --out <dir>
 *
 * Either source may be omitted to extract just the other kind. Layout written:
 *   <out>/<Lib>/index.json + <item>.kicad_sym|.kicad_mod + LICENSE.md
 *
 * This is the open analog of the closed apps/server extract-fixtures.ts +
 * extract-footprint-fixtures.ts; it runs at GPL dev time so a bare pcbjam clone
 * self-provisions example libs (see ensure-example-libs.ts). The exported
 * manifests double as the sparse-checkout pick list for the clone step.
 */

/** Curated symbol pick list: the common parts a first board needs. */
export const SYMBOL_MANIFEST: Record<string, string[]> = {
  // C_Polarized: the multivibrator tutorial's 10 µF capacitors.
  Device: ["R", "C", "C_Polarized", "L", "D", "LED", "D_Schottky", "D_Zener"],
  // 1N4148 extends 1N4001, 1N5817 extends SB120 — exercises extends-bundling.
  Diode: ["1N4001", "1N4148", "SB120", "1N5817"],
  Connector: ["Conn_01x02_Pin", "Conn_01x04_Pin"],
  // PWR_FLAG: tells ERC where a supply comes from — a clean ERC needs it on most first boards.
  power: ["GND", "GNDA", "VCC", "+5V", "+3V3", "PWR_FLAG"],
};

/** Curated footprint pick list: the common SMD parts a first board needs. */
export const FOOTPRINT_MANIFEST: Record<string, string[]> = {
  Resistor_SMD: ["R_0402_1005Metric", "R_0603_1608Metric", "R_0805_2012Metric"],
  Capacitor_SMD: ["C_0402_1005Metric", "C_0603_1608Metric"],
  LED_SMD: ["LED_0603_1608Metric", "LED_0805_2012Metric"],
  Diode_SMD: ["D_0603_1608Metric"],
  // The multivibrator tutorial's through-hole capacitors, SOT-23 transistors and 2-pin header.
  Capacitor_THT: ["CP_Radial_D5.0mm_P2.00mm"],
  Package_TO_SOT_SMD: ["SOT-23"],
  "Connector_PinHeader_2.54mm": ["PinHeader_1x02_P2.54mm_Vertical"],
};

interface IndexItem {
  kind: "symbol" | "footprint";
  name: string;
  description: string | null;
  keywords: string | null;
}

export interface ExtractOptions {
  /** Path to an unpacked kicad-symbols checkout (`<Lib>.kicad_symdir/`). */
  symbolsSrc?: string;
  /** Path to a kicad-footprints checkout (`<Lib>.pretty/`). */
  footprintsSrc?: string;
  /** Output LIBS_DIR to (re)create. */
  out: string;
}

async function writeLib(
  out: string,
  lib: string,
  items: IndexItem[],
  license: Uint8Array | null,
): Promise<void> {
  items.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(
    path.join(out, lib, "index.json"),
    `${JSON.stringify(
      { lib, description: `KiCad ${lib} (curated example subset)`, items },
      null,
      2,
    )}\n`,
  );
  if (license) await writeFile(path.join(out, lib, "LICENSE.md"), license);
}

async function readSymbol(
  symdir: string,
  name: string,
): Promise<{ src: string; sym: ParsedSymbol }> {
  const src = await readFile(path.join(symdir, `${name}.kicad_sym`), "utf8");
  return { src, sym: parseSymbolFile(src) };
}

/** Resolve a symbol's extends chain (root-first) by reading sibling files. */
async function resolveChain(
  symdir: string,
  sym: ParsedSymbol,
): Promise<ParsedSymbol[]> {
  const chain: ParsedSymbol[] = [];
  const seen = new Set<string>([sym.name]);
  let cur = sym;
  while (cur.extends) {
    if (seen.has(cur.extends)) throw new Error(`extends cycle at ${cur.extends}`);
    seen.add(cur.extends);
    const { sym: parent } = await readSymbol(symdir, cur.extends);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

async function extractSymbols(src: string, out: string): Promise<number> {
  const license = await readFile(path.join(src, "LICENSE.md")).catch(() => null);
  let total = 0;
  for (const [lib, names] of Object.entries(SYMBOL_MANIFEST)) {
    const symdir = path.join(src, `${lib}.kicad_symdir`);
    await mkdir(path.join(out, lib), { recursive: true });
    const items: IndexItem[] = [];
    for (const name of names) {
      const { src: fileSrc, sym } = await readSymbol(symdir, name);
      const parents = await resolveChain(symdir, sym);
      const body = buildSelfContainedLib(
        libHeader(fileSrc),
        parents.map((p) => p.block),
        sym.block,
      );
      await writeFile(path.join(out, lib, `${name}.kicad_sym`), body);
      items.push({
        kind: "symbol",
        name: sym.name,
        description: sym.description,
        keywords: sym.keywords,
      });
      total += 1;
    }
    await writeLib(out, lib, items, license);
    console.log(`  ${lib.padEnd(16)} ${items.length} symbols`);
  }
  return total;
}

async function extractFootprints(src: string, out: string): Promise<number> {
  const license = await readFile(path.join(src, "LICENSE.md")).catch(() => null);
  let total = 0;
  for (const [lib, names] of Object.entries(FOOTPRINT_MANIFEST)) {
    const pretty = path.join(src, `${lib}.pretty`);
    await mkdir(path.join(out, lib), { recursive: true });
    const items: IndexItem[] = [];
    for (const name of names) {
      const file = path.join(pretty, `${name}.kicad_mod`);
      const fileSrc = await readFile(file, "utf8").catch(() => {
        throw new Error(`footprint not found: ${lib}.pretty/${name}.kicad_mod`);
      });
      const fp = parseFootprintFile(fileSrc, name);
      await writeFile(path.join(out, lib, `${name}.kicad_mod`), fp.body);
      items.push({
        kind: "footprint",
        name: fp.name,
        description: fp.description,
        keywords: fp.keywords,
      });
      total += 1;
    }
    await writeLib(out, lib, items, license);
    console.log(`  ${lib.padEnd(16)} ${items.length} footprints`);
  }
  return total;
}

/** Build the combined fixtures tree. Clears `out` once, then writes every lib. */
export async function extractAll(
  opts: ExtractOptions,
): Promise<{ libs: number; symbols: number; footprints: number }> {
  const { symbolsSrc, footprintsSrc, out } = opts;
  if (!symbolsSrc && !footprintsSrc) {
    throw new Error("at least one of symbolsSrc / footprintsSrc is required");
  }
  // Clear the output ONCE, then write every lib (symbol + footprint) into it —
  // the closed extractors each rm their own --out, which can't share a tree.
  await rm(out, { recursive: true, force: true });

  let libs = 0;
  let symbols = 0;
  let footprints = 0;
  if (symbolsSrc) {
    symbols = await extractSymbols(symbolsSrc, out);
    libs += Object.keys(SYMBOL_MANIFEST).length;
  }
  if (footprintsSrc) {
    footprints = await extractFootprints(footprintsSrc, out);
    libs += Object.keys(FOOTPRINT_MANIFEST).length;
  }
  return { libs, symbols, footprints };
}

/* ----------------------------------------------------- full-set extraction --
 * The CURATED extractAll above provisions a small example tree on disk. For the
 * demo CDN we instead want EVERY lib, in memory, to publish as r2-idb-sync
 * snapshots (see scripts/deploy/publish-libs.ts) — same per-item parse/extends
 * resolution, no on-disk serve tree.
 */

export interface ExtractedItem {
  kind: "symbol" | "footprint";
  name: string;
  /** Complete self-contained s-expr body (extends inlined for symbols). */
  body: string;
  description: string | null;
  keywords: string | null;
}
export interface ExtractedLib {
  lib: string;
  kind: "symbol" | "footprint";
  items: ExtractedItem[];
}

/** Extract EVERY lib present under the source dirs into in-memory bodies:
 *  each `<Lib>.kicad_symdir/<name>.kicad_sym` (resolved + self-contained) and
 *  each `<Lib>.pretty/<name>.kicad_mod`. Libs with no items are skipped. */
export async function extractAllLibs(opts: {
  symbolsSrc?: string;
  footprintsSrc?: string;
}): Promise<ExtractedLib[]> {
  const out: ExtractedLib[] = [];

  if (opts.symbolsSrc) {
    const dirs = (await readdir(opts.symbolsSrc, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.endsWith(".kicad_symdir"))
      .map((e) => e.name)
      .sort();
    for (const dirName of dirs) {
      const lib = dirName.slice(0, -".kicad_symdir".length);
      const symdir = path.join(opts.symbolsSrc, dirName);
      const names = (await readdir(symdir))
        .filter((f) => f.endsWith(".kicad_sym"))
        .map((f) => f.slice(0, -".kicad_sym".length))
        .sort();
      const items: ExtractedItem[] = [];
      for (const name of names) {
        const { src: fileSrc, sym } = await readSymbol(symdir, name);
        const parents = await resolveChain(symdir, sym);
        items.push({
          kind: "symbol",
          name: sym.name,
          body: buildSelfContainedLib(
            libHeader(fileSrc),
            parents.map((p) => p.block),
            sym.block,
          ),
          description: sym.description,
          keywords: sym.keywords,
        });
      }
      if (items.length) out.push({ lib, kind: "symbol", items });
    }
  }

  if (opts.footprintsSrc) {
    const dirs = (await readdir(opts.footprintsSrc, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.endsWith(".pretty"))
      .map((e) => e.name)
      .sort();
    for (const dirName of dirs) {
      const lib = dirName.slice(0, -".pretty".length);
      const pretty = path.join(opts.footprintsSrc, dirName);
      const names = (await readdir(pretty))
        .filter((f) => f.endsWith(".kicad_mod"))
        .map((f) => f.slice(0, -".kicad_mod".length))
        .sort();
      const items: ExtractedItem[] = [];
      for (const name of names) {
        const fileSrc = await readFile(path.join(pretty, `${name}.kicad_mod`), "utf8");
        const fp = parseFootprintFile(fileSrc, name);
        items.push({
          kind: "footprint",
          name: fp.name,
          body: fp.body,
          description: fp.description,
          keywords: fp.keywords,
        });
      }
      if (items.length) out.push({ lib, kind: "footprint", items });
    }
  }

  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg("out");
  if (!out) throw new Error("--out <dir> is required");
  const { libs, symbols, footprints } = await extractAll({
    symbolsSrc: arg("symbols-src"),
    footprintsSrc: arg("footprints-src"),
    out,
  });
  console.log(
    `\nextracted ${libs} lib(s), ${symbols} symbols + ${footprints} footprints -> ${out}`,
  );
}

// Run as a CLI only when invoked directly (not when imported by ensure-example-libs).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
