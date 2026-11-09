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

/** A box to draw on a shot, page mm, with a short label (a check's issue numbers, say). */
export interface MarkMm {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/** At most this many marks on one shot. */
export const MAX_MARKS = 50;

/**
 * Parse `--marks` (a JSON array of {x, y, w, h, label}, page mm). Labels are
 * 1-8 letters or digits, so nothing but a number or a word reaches the SVG.
 */
export function parseMarks(raw: string | undefined): MarkMm[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("--marks wants a JSON array of {x, y, w, h, label}");
  }
  if (!Array.isArray(list) || list.length > MAX_MARKS) throw new Error(`--marks wants at most ${MAX_MARKS} marks`);
  return list.map((m: Record<string, unknown>) => {
    const [x, y, w, h] = [m?.x, m?.y, m?.w, m?.h].map(Number) as [number, number, number, number];
    const label = String(m?.label ?? "");
    const sane = (v: number) => Number.isFinite(v) && Math.abs(v) <= 10000;
    if (![x, y, w, h].every(sane) || w <= 0 || h <= 0 || !/^[A-Za-z0-9]{1,8}$/.test(label)) {
      throw new Error("--marks: each mark is {x, y, w, h} in mm (w, h above 0) and a label of 1-8 letters or digits");
    }
    return { x, y, w, h, label };
  });
}

/** Crop (page mm), put a background behind a KiCad plot SVG, and draw `marks` on top. */
export function prepareSvg(svg: string, opts: { crop?: CropMm | null; background?: string | null; marks?: MarkMm[] }): string {
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
  if (opts.marks?.length) {
    // Last drawn: right before the root's closing tag, so the boxes sit on top of the plot.
    const boxes = opts.marks
      .map(
        (m) =>
          `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="none" stroke="#D62828" stroke-width="0.4"/>` +
          `<text x="${m.x}" y="${m.y - 0.6}" fill="#D62828" font-family="sans-serif" font-weight="bold" font-size="2.5">${m.label}</text>`,
      )
      .join("\n");
    const close = out.lastIndexOf("</svg>");
    out = `${out.slice(0, close)}<g id="pcbjam-marks">\n${boxes}\n</g>\n${out.slice(close)}`;
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
  const input = Buffer.from(svg);
  // Pick the density that renders ~widthPx wide, then resize to exactly that.
  // For a plot sized in mm the rendered width grows with density² (librsvg
  // turns mm into pixels at `density`, sharp scales by density/72 again), so
  // a formula linear in density overshot ~10× on small crops and tripped
  // sharp's pixel limit ("Input image exceeds pixel limit"). Measure the width
  // at two densities (header only, nothing is rendered) and solve instead.
  const widthAt = async (density: number) => (await sharp(input, { density }).metadata()).width ?? 0;
  const base = await widthAt(72);
  let density = 150;
  if (base > 0) {
    const exponent = Math.max(1, Math.round(Math.log2((await widthAt(144)) / base)));
    density = 72 * ((widthPx * 1.05) / base) ** (1 / exponent);
  }
  density = Math.min(2400, Math.max(36, density));
  const png = await sharp(input, { density }).resize({ width: widthPx }).png().toBuffer();
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
