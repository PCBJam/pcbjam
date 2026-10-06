// @ts-check
/**
 * Schematic and board "shots" (mcp 0004 §11.2): KiCad's own plots, made to
 * look at — cropped to an area, on the editor's background, as PNG. The
 * plots come from kicad_tools (`--plot` / `--plot-board`); their SVG user
 * units are page millimetres, the same coordinates as the KiCad files, so a
 * crop is a viewBox.
 */

/** Board layer presets (draw order: later on top). */
export const BOARD_PRESETS = {
  top: ["Edge.Cuts", "F.Fab", "F.Cu", "F.SilkS"],
  bottom: ["Edge.Cuts", "B.Fab", "B.Cu", "B.SilkS"],
  copper: ["Edge.Cuts", "B.Cu", "In4.Cu", "In3.Cu", "In2.Cu", "In1.Cu", "F.Cu"],
  /** null = every enabled layer, KiCad's plot order. */
  editor: null,
};

/** Editor backgrounds (KiCad default themes). */
export const BACKGROUND = { board: "#001023", schematic: "#F5F4EF" };

/** @typedef {{ cx: number, cy: number, halfW: number, halfH: number }} CropMm */

/**
 * Crop (page mm) and put a background behind a KiCad plot SVG.
 * @param {string} svg
 * @param {{ crop?: CropMm | null, background?: string | null }} opts
 */
export function prepareSvg(svg, opts) {
  let out = svg;
  const vb = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(out);
  if (!vb) throw new Error("not a KiCad plot: no viewBox");
  let [x, y, w, h] = vb.slice(1).map(Number);
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
 * @param {string} svg
 * @param {number} widthPx
 * @returns {Promise<Uint8Array>}
 */
export async function rasterize(svg, widthPx) {
  let sharp;
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

/**
 * Parse "cx,cy,halfW,halfH" (mm).
 * @param {string | undefined} raw
 * @returns {CropMm | null}
 */
export function parseCrop(raw) {
  if (!raw) return null;
  const n = raw.split(",").map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) {
    throw new Error(`--crop wants cx,cy,halfW,halfH in mm (got ${raw})`);
  }
  return { cx: n[0], cy: n[1], halfW: n[2], halfH: n[3] };
}
