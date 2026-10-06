import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runKicadTools } from "./kicad-tools.ts";
import { BACKGROUND, BOARD_PRESETS, parseCrop, prepareSvg, rasterize, type BoardPreset } from "./shot.ts";

/** Parsed `--name value` options of a command. */
export type Options = Record<string, string | undefined>;

async function writeShot(svg: string, out: string, opts: Options, defaultBackground: string): Promise<void> {
  const background = opts.background === "none" ? null : (opts.background ?? defaultBackground);
  const prepared = prepareSvg(svg, { crop: parseCrop(opts.crop), background });
  if (out.toLowerCase().endsWith(".svg")) {
    await writeFile(out, prepared);
  } else {
    await writeFile(out, await rasterize(prepared, Number(opts.width ?? 1600)));
  }
}

export async function boardShot(pcb: string | undefined, out: string | undefined, opts: Options): Promise<number> {
  if (!pcb || !out) {
    process.stderr.write("usage: pcbjam-tools board-shot <file.kicad_pcb> <out.png|svg> [--preset …] [--crop …]\n");
    return 2;
  }
  const preset = opts.preset ?? "editor";
  if (!(preset in BOARD_PRESETS)) {
    process.stderr.write(`unknown --preset ${preset} (top|bottom|copper|editor)\n`);
    return 2;
  }
  const layers = opts.layers ?? BOARD_PRESETS[preset as BoardPreset]?.join(",");
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

export async function schematicShot(sch: string | undefined, out: string | undefined, opts: Options): Promise<number> {
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
    const sheet = opts.sheet?.toLowerCase().replace(/\.kicad_sch$/, "");
    const pick = sheet ? svgs.find((f) => f.toLowerCase().includes(sheet)) : (svgs.find((f) => f === `${root}.svg`) ?? svgs[0]);
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
