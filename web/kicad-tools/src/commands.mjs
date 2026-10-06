// @ts-check
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runKicadTools } from "./kicad-tools.mjs";
import { BACKGROUND, BOARD_PRESETS, parseCrop, prepareSvg, rasterize } from "./shot.mjs";

/**
 * @param {string} svg
 * @param {string} out
 * @param {Record<string, string>} opts
 * @param {string} defaultBackground
 */
async function writeShot(svg, out, opts, defaultBackground) {
  const background = opts.background === "none" ? null : (opts.background ?? defaultBackground);
  const prepared = prepareSvg(svg, { crop: parseCrop(opts.crop), background });
  if (out.toLowerCase().endsWith(".svg")) {
    await writeFile(out, prepared);
  } else {
    await writeFile(out, await rasterize(prepared, Number(opts.width ?? 1600)));
  }
}

/**
 * @param {string} pcb
 * @param {string} out
 * @param {Record<string, string>} opts
 */
export async function boardShot(pcb, out, opts) {
  if (!pcb || !out) {
    process.stderr.write("usage: pcbjam-tools board-shot <file.kicad_pcb> <out.png|svg> [--preset …] [--crop …]\n");
    return 2;
  }
  const preset = opts.preset ?? "editor";
  if (!(preset in BOARD_PRESETS)) {
    process.stderr.write(`unknown --preset ${preset} (top|bottom|copper|editor)\n`);
    return 2;
  }
  const layers = opts.layers ?? BOARD_PRESETS[/** @type {keyof typeof BOARD_PRESETS} */ (preset)]?.join(",");
  const dir = await mkdtemp(join(tmpdir(), "pcbjam-shot-"));
  try {
    const svgPath = join(dir, "board.svg");
    const run = await runKicadTools(["--plot-board", ...(layers ? ["--layers", layers] : []), pcb, svgPath]);
    if (run.exitCode !== 0) {
      process.stderr.write(run.stderr);
      return run.exitCode;
    }
    await writeShot(await readFile(svgPath, "utf8"), out, opts, BACKGROUND.board);
    process.stderr.write(`${pcb}: OK -> ${out}\n`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} sch
 * @param {string} out
 * @param {Record<string, string>} opts
 */
export async function schematicShot(sch, out, opts) {
  if (!sch || !out) {
    process.stderr.write("usage: pcbjam-tools schematic-shot <file.kicad_sch> <out.png|svg> [--sheet …] [--crop …]\n");
    return 2;
  }
  const dir = await mkdtemp(join(tmpdir(), "pcbjam-shot-"));
  try {
    const run = await runKicadTools(["--plot", sch, dir]);
    if (run.exitCode !== 0) {
      process.stderr.write(run.stderr);
      return run.exitCode;
    }
    // One SVG per sheet: <root>.svg, <root>-<sheet>.svg …
    const svgs = (await readdir(dir)).filter((f) => f.endsWith(".svg")).sort((a, b) => a.length - b.length);
    const root = basename(sch).replace(/\.kicad_sch$/, "");
    const pick = opts.sheet
      ? svgs.find((f) => f.toLowerCase().includes(opts.sheet.toLowerCase().replace(/\.kicad_sch$/, "")))
      : (svgs.find((f) => f === `${root}.svg`) ?? svgs[0]);
    if (!pick) {
      process.stderr.write(`${sch}: no sheet ${opts.sheet ?? ""} in the plot (have: ${svgs.join(", ")})\n`);
      return 2;
    }
    await writeShot(await readFile(join(dir, pick), "utf8"), out, opts, BACKGROUND.schematic);
    process.stderr.write(`${sch}: OK (${pick}) -> ${out}\n`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
