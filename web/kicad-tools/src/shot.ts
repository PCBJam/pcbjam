/**
 * Schematic and board "shots" (mcp 0004 §11.2): KiCad's own plots, made to
 * look at — cropped to an area, on the editor's background, as PNG. The
 * plots come from kicad_tools (`--plot` / `--plot-board`); their SVG user
 * units are page millimetres, the same coordinates as the KiCad files, so a
 * crop is a viewBox.
 */

/** Board layer presets (draw order: later on top); null = every enabled layer, KiCad's plot order. */
export const BOARD_PRESETS: Record<"top" | "bottom" | "copper" | "editor", string[] | null> = {
  top: ["Edge.Cuts", "F.Fab", "F.Cu", "F.SilkS"],
  bottom: ["Edge.Cuts", "B.Fab", "B.Cu", "B.SilkS"],
  copper: ["Edge.Cuts", "B.Cu", "In4.Cu", "In3.Cu", "In2.Cu", "In1.Cu", "F.Cu"],
  editor: null,
};
export type BoardPreset = keyof typeof BOARD_PRESETS;

/** Editor backgrounds (KiCad default themes). */
export const BACKGROUND = { board: "#001023", schematic: "#F5F4EF" };

export interface CropMm {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

/** Crop (page mm) and put a background behind a KiCad plot SVG. */
export function prepareSvg(svg: string, opts: { crop?: CropMm | null; background?: string | null }): string {
  let out = svg;
  const vb = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(out);
  if (!vb) throw new Error("not a KiCad plot: no viewBox");
  let [x, y, w, h] = vb.slice(1).map(Number) as [number, number, number, number];
  if (opts.crop) {
    const c = opts.crop;
    [x, y, w, h] = [c.cx - c.halfW, c.cy - c.halfH, 2 * c.halfW, 2 * c.halfH];
    out = out
      .replace(vb[0], `viewBox="${x} ${y} ${w} ${h}"`)
      .replace(/width="[\d.]+mm"/, `width="${w}mm"`)
      .replace(/height="[\d.]+mm"/, `height="${h}mm"`);
  }
  if (opts.background) {
    // First drawn element: right after the root <svg …> open tag.
    const open = out.indexOf(">", out.indexOf("<svg"));
    out =
      out.slice(0, open + 1) +
      `\n<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${opts.background}"/>` +
      out.slice(open + 1);
  }
  return out;
}

/**
 * SVG → PNG of `widthPx` (keeps the aspect). sharp is an optional
 * dependency: without it only SVG output is available.
 */
export async function rasterize(svg: string, widthPx: number): Promise<Uint8Array> {
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error("PNG output needs the optional 'sharp' package (npm i sharp) — or ask for SVG");
  }
  const vb = /viewBox="[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+[-\d.]+"/.exec(svg);
  const widthMm = vb ? Number(vb[1]) : 297;
  // librsvg renders at `density` dpi; pick it so the result is ~widthPx wide.
  const density = Math.min(2400, Math.max(36, (widthPx / (widthMm / 25.4)) * 1.05));
  const png = await sharp(Buffer.from(svg), { density }).resize({ width: widthPx }).png().toBuffer();
  return new Uint8Array(png);
}

/** Parse "cx,cy,halfW,halfH" (mm). */
export function parseCrop(raw: string | undefined): CropMm | null {
  if (!raw) return null;
  const n = raw.split(",").map(Number);
  const [cx, cy, halfW, halfH] = n;
  if (
    n.length !== 4 ||
    cx === undefined ||
    cy === undefined ||
    halfW === undefined ||
    halfH === undefined ||
    n.some((v) => !Number.isFinite(v)) ||
    halfW <= 0 ||
    halfH <= 0
  ) {
    throw new Error(`--crop wants cx,cy,halfW,halfH in mm (got ${raw})`);
  }
  return { cx, cy, halfW, halfH };
}
