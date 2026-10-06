/**
 * Software renderer for board GLBs (mcp 0004 §11.4, `board-3d-shot`): an
 * orthographic z-buffer rasterizer with two-light Lambert shading, depth
 * outlines and 2× supersampling. No GPU, no native dependency — a board of a
 * few hundred thousand triangles renders in seconds.
 *
 * World frame (occ_service GLB): metres, Y up = the board's top side,
 * X = board x, Z = board y (so board millimetres map to X·1000, Z·1000).
 */
import type { Mesh } from "./glb.ts";
import type { CropMm } from "./shot.ts";

export interface View3d {
  /** Degrees around the vertical axis; 0 = looking from the board's bottom edge (+y side). */
  azimuth: number;
  /** Degrees above the board plane; 90 = straight down on the top side, -90 = from below. */
  elevation: number;
}

export const VIEWS: Record<string, View3d> = {
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
  iso: { azimuth: -35, elevation: 35 },
  "iso-back": { azimuth: 145, elevation: 35 },
  front: { azimuth: 0, elevation: 8 },
};

/** KiCad 3D viewer default background (sRGB, top → bottom). */
export const BACKGROUND_3D: [[number, number, number], [number, number, number]] = [
  [0.8, 0.8, 0.9],
  [0.4, 0.4, 0.5],
];

export interface RenderOptions {
  view: View3d;
  widthPx: number;
  /** Board-mm area to frame; the whole board when absent. */
  crop?: CropMm | null;
  /** sRGB 0..1, a gradient pair, or null for transparent. */
  background: [number, number, number] | [[number, number, number], [number, number, number]] | null;
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function render(mesh: Mesh, opts: RenderOptions): { rgba: Uint8Array; width: number; height: number } {
  const az = (opts.view.azimuth * Math.PI) / 180;
  const el = (opts.view.elevation * Math.PI) / 180;
  // Camera basis: c points from the scene towards the camera.
  const c: V3 = norm([Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]);
  const f: V3 = [-c[0], -c[1], -c[2]];
  const worldUp: V3 = Math.abs(opts.view.elevation) > 89 ? [0, 0, -1] : [0, 1, 0];
  const r = norm(cross(f, worldUp));
  const u = norm(cross(r, f));

  // Frame: the crop box (board mm) or the scene bounds, projected.
  const P = mesh.positions;
  let minY = Infinity;
  let maxY = -Infinity;
  let box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] as number;
    const y = P[i + 1] as number;
    const z = P[i + 2] as number;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < box.x0) box.x0 = x;
    if (x > box.x1) box.x1 = x;
    if (z < box.z0) box.z0 = z;
    if (z > box.z1) box.z1 = z;
  }
  if (!Number.isFinite(minY)) throw new Error("nothing to render: the export has no geometry");
  if (opts.crop) {
    const k = opts.crop;
    box = { x0: (k.cx - k.halfW) / 1000, x1: (k.cx + k.halfW) / 1000, z0: (k.cy - k.halfH) / 1000, z1: (k.cy + k.halfH) / 1000 };
  }
  let sx0 = Infinity;
  let sx1 = -Infinity;
  let sy0 = Infinity;
  let sy1 = -Infinity;
  for (const x of [box.x0, box.x1]) {
    for (const y of [minY, maxY]) {
      for (const z of [box.z0, box.z1]) {
        const p: V3 = [x, y, z];
        const a = dot(p, r);
        const b = dot(p, u);
        sx0 = Math.min(sx0, a);
        sx1 = Math.max(sx1, a);
        sy0 = Math.min(sy0, b);
        sy1 = Math.max(sy1, b);
      }
    }
  }
  const pad = 0.04 * Math.max(sx1 - sx0, sy1 - sy0);
  sx0 -= pad;
  sx1 += pad;
  sy0 -= pad;
  sy1 += pad;

  const SS = 2;
  const width = Math.max(16, Math.round(opts.widthPx));
  const height = Math.max(16, Math.min(4 * width, Math.round((width * (sy1 - sy0)) / (sx1 - sx0))));
  const W = width * SS;
  const H = height * SS;
  const scale = W / (sx1 - sx0);

  const depth = new Float32Array(W * H).fill(-Infinity);
  const color = new Float32Array(W * H * 3);

  const key = norm(add(add(c, u, 0.8), r, -0.5));
  const fill = norm(add(add(c, u, -0.3), r, 0.6));
  const N = mesh.normals;

  for (let t = 0; t < mesh.triangles; t++) {
    const o = t * 9;
    const xs = [0, 0, 0];
    const ys = [0, 0, 0];
    const ds = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p: V3 = [P[o + k * 3] as number, P[o + k * 3 + 1] as number, P[o + k * 3 + 2] as number];
      xs[k] = (dot(p, r) - sx0) * scale;
      ys[k] = (sy1 - dot(p, u)) * scale;
      ds[k] = dot(p, c);
    }
    const [x0, x1, x2] = xs as [number, number, number];
    const [y0, y1, y2] = ys as [number, number, number];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxPy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minPy > maxPy) continue;
    const base = mesh.colors[mesh.colorOf[t] as number] ?? [0.7, 0.7, 0.7];
    for (let py = minPy; py <= maxPy; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * (ds[0] as number) + w1 * (ds[1] as number) + w2 * (ds[2] as number);
        const i = py * W + px;
        if (d <= (depth[i] as number)) continue;
        depth[i] = d;
        let n: V3 = norm([
          w0 * (N[o] as number) + w1 * (N[o + 3] as number) + w2 * (N[o + 6] as number),
          w0 * (N[o + 1] as number) + w1 * (N[o + 4] as number) + w2 * (N[o + 7] as number),
          w0 * (N[o + 2] as number) + w1 * (N[o + 5] as number) + w2 * (N[o + 8] as number),
        ]);
        if (dot(n, c) < 0) n = [-n[0], -n[1], -n[2]]; // double-sided
        const shade = 0.32 + 0.58 * Math.max(0, dot(n, key)) + 0.22 * Math.max(0, dot(n, fill));
        const spec = 0.12 * Math.max(0, dot(n, norm(add(key, c)))) ** 24;
        color[i * 3] = base[0] * shade + spec;
        color[i * 3 + 1] = base[1] * shade + spec;
        color[i * 3 + 2] = base[2] * shade + spec;
      }
    }
  }

  // Depth outlines: darken where the surface jumps (component edges).
  const edge = 0.0004 * SS;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      for (let j = 0; j < SS; j++) {
        for (let k = 0; k < SS; k++) {
          const px = x * SS + k;
          const py = y * SS + j;
          const i = py * W + px;
          const d = depth[i] as number;
          let pr: number;
          let pg: number;
          let pb: number;
          let pa = 1;
          if (d === -Infinity) {
            const bg = opts.background;
            if (bg === null) {
              pr = pg = pb = 0;
              pa = 0;
            } else if (Array.isArray(bg[0])) {
              const [top, bottom] = bg as [V3, V3];
              const s = py / H;
              pr = top[0] + (bottom[0] - top[0]) * s;
              pg = top[1] + (bottom[1] - top[1]) * s;
              pb = top[2] + (bottom[2] - top[2]) * s;
            } else {
              [pr, pg, pb] = bg as V3;
            }
          } else {
            let dim = 1;
            for (const [nx, ny] of [
              [px + 1, py],
              [px, py + 1],
              [px - 1, py],
              [px, py - 1],
            ] as const) {
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const nd = depth[ny * W + nx] as number;
              if (nd === -Infinity || nd - d > edge / scale / 0.001) dim = 0.62;
            }
            pr = toSrgb(Math.min(1, (color[i * 3] as number) * dim));
            pg = toSrgb(Math.min(1, (color[i * 3 + 1] as number) * dim));
            pb = toSrgb(Math.min(1, (color[i * 3 + 2] as number) * dim));
          }
          rr += pr * pa;
          gg += pg * pa;
          bb += pb * pa;
          aa += pa;
        }
      }
      const o = (y * width + x) * 4;
      const n = SS * SS;
      out[o] = aa ? Math.round((rr / aa) * 255) : 0;
      out[o + 1] = aa ? Math.round((gg / aa) * 255) : 0;
      out[o + 2] = aa ? Math.round((bb / aa) * 255) : 0;
      out[o + 3] = Math.round((aa / n) * 255);
    }
  }
  return { rgba: out, width, height };
}
