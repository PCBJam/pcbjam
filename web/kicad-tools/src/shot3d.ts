import { writeFile } from "node:fs/promises";
import type { Options } from "./commands.ts";
import { readGlb } from "./glb.ts";
import { encodePng } from "./png.ts";
import { BACKGROUND_3D, render, VIEWS, type View3d } from "./render3d.ts";
import { parseCrop } from "./shot.ts";
import { occExport, prepareBoard, UsageError } from "./step.ts";

function parseColor(raw: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * board-3d-shot: the board with its components (occ_service GLB, the same
 * models STEP export uses) rendered in software to PNG.
 */
export async function board3dShot(pcb: string | undefined, out: string | undefined, opts: Options): Promise<number> {
  if (!pcb || !out) {
    process.stderr.write(
      "usage: pcbjam-tools board-3d-shot <file.kicad_pcb> <out.png> [--view top|bottom|iso|iso-back|front] [--azimuth deg --elevation deg] [--crop cx,cy,halfW,halfH] [--width px] [--background color|none] [--models dir|cdn] [--models-dir dir]\n",
    );
    return 2;
  }
  let view: View3d | undefined = VIEWS[opts.view ?? "iso"];
  if (!view) {
    process.stderr.write(`unknown --view ${opts.view} (${Object.keys(VIEWS).join("|")})\n`);
    return 2;
  }
  if (opts.azimuth !== undefined || opts.elevation !== undefined) {
    view = { azimuth: Number(opts.azimuth ?? view.azimuth), elevation: Number(opts.elevation ?? view.elevation) };
    if (!Number.isFinite(view.azimuth) || !Number.isFinite(view.elevation)) {
      process.stderr.write("--azimuth/--elevation want degrees\n");
      return 2;
    }
  }
  let background: [number, number, number] | typeof BACKGROUND_3D | null = BACKGROUND_3D;
  if (opts.background === "none") background = null;
  else if (opts.background && opts.background !== "default") {
    background = parseColor(opts.background);
    if (!background) {
      process.stderr.write(`--background wants #rrggbb, none or default (got ${opts.background})\n`);
      return 2;
    }
  }

  let prepared;
  try {
    prepared = await prepareBoard(pcb, opts);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const res = await occExport(prepared, {
    format: "glb",
    export_tracks: true,
    export_pads: true,
    export_zones: true,
    export_silkscreen: true,
    export_soldermask: true,
  });
  if (!res.ok) {
    process.stderr.write(`${pcb}: export failed\n${res.report}\n`);
    return 4;
  }
  const mesh = readGlb(res.bytes);
  const img = render(mesh, { view, widthPx: Number(opts.width ?? 1600), crop: parseCrop(opts.crop), background });
  await writeFile(out, encodePng(img.rgba, img.width, img.height));
  for (const ref of prepared.missing) process.stderr.write(`missing model: ${ref}\n`);
  const { models, missing } = prepared;
  process.stderr.write(
    `${pcb}: OK -> ${out} (${img.width}x${img.height}, ${mesh.triangles} triangles, ${models.length} models${missing.length ? `, ${missing.length} missing` : ""})\n`,
  );
  return 0;
}
