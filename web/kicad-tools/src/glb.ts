/**
 * Minimal glTF 2.0 binary (GLB) reader for what occ_service writes
 * (OpenCASCADE RWGltf_CafWriter): node hierarchy with TRS/matrix, triangle
 * primitives with POSITION/NORMAL and indices, base colour materials. Yields
 * world-space triangles.
 */

interface GltfJson {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    children?: number[];
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
}

/** World-space triangle soup: 9 floats per triangle (positions), 9 (normals), one colour index each. */
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Per-triangle index into `colors`. */
  colorOf: Uint16Array;
  /** Linear RGB per material. */
  colors: Array<[number, number, number]>;
  triangles: number;
}

type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major multiply a·b. */
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * sx;
  m[1] = 2 * (x * y + z * w) * sx;
  m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy;
  m[5] = (1 - 2 * (x * x + z * z)) * sy;
  m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz;
  m[9] = 2 * (y * z - x * w) * sz;
  m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = t[0] as number;
  m[13] = t[1] as number;
  m[14] = t[2] as number;
  m[15] = 1;
  return m;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
  let at = 12;
  let json: GltfJson | null = null;
  let bin: DataView | null = null;
  while (at < bytes.length) {
    const len = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 8, at + 8 + len))) as GltfJson;
    else if (type === 0x004e4942) bin = new DataView(bytes.buffer, bytes.byteOffset + at + 8, len);
    at += 8 + len;
  }
  if (!json) throw new Error("GLB without JSON chunk");
  const g = json;

  const read = (index: number): number[] => {
    const acc = g.accessors?.[index];
    if (!acc || acc.bufferView === undefined || !bin) return [];
    const bv = g.bufferViews?.[acc.bufferView];
    if (!bv) return [];
    const n = COMPONENTS[acc.type] ?? 1;
    const size = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const stride = bv.byteStride ?? n * size;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out: number[] = new Array(acc.count * n);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < n; c++) {
        const o = base + i * stride + c * size;
        out[i * n + c] =
          acc.componentType === 5126
            ? bin.getFloat32(o, true)
            : acc.componentType === 5125
              ? bin.getUint32(o, true)
              : acc.componentType === 5123
                ? bin.getUint16(o, true)
                : bin.getUint8(o);
      }
    }
    return out;
  };

  const colors: Array<[number, number, number]> = (g.materials ?? []).map((m) => {
    const c = m.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    return [c[0] ?? 0.8, c[1] ?? 0.8, c[2] ?? 0.8];
  });
  const fallbackColor = colors.length;
  colors.push([0.7, 0.7, 0.7]);

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const meshCache = new Map<number, Array<{ p: number[]; n: number[]; idx: number[]; color: number }>>();

  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = g.nodes?.[nodeIndex];
    if (!node) return;
    const local = node.matrix ? Float64Array.from(node.matrix) : trs(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    if (node.mesh !== undefined) {
      let prims = meshCache.get(node.mesh);
      if (!prims) {
        prims = (g.meshes?.[node.mesh]?.primitives ?? [])
          .filter((p) => (p.mode ?? 4) === 4 && p.attributes.POSITION !== undefined)
          .map((p) => {
            const p3 = read(p.attributes.POSITION as number);
            const idx = p.indices !== undefined ? read(p.indices) : [...Array(p3.length / 3).keys()];
            return {
              p: p3,
              n: p.attributes.NORMAL !== undefined ? read(p.attributes.NORMAL) : [],
              idx,
              color: p.material ?? fallbackColor,
            };
          });
        meshCache.set(node.mesh, prims);
      }
      const w = world;
      for (const prim of prims) {
        for (let t = 0; t + 2 < prim.idx.length; t += 3) {
          for (let k = 0; k < 3; k++) {
            const v = prim.idx[t + k] as number;
            const x = prim.p[v * 3] as number;
            const y = prim.p[v * 3 + 1] as number;
            const z = prim.p[v * 3 + 2] as number;
            pos.push(
              (w[0] as number) * x + (w[4] as number) * y + (w[8] as number) * z + (w[12] as number),
              (w[1] as number) * x + (w[5] as number) * y + (w[9] as number) * z + (w[13] as number),
              (w[2] as number) * x + (w[6] as number) * y + (w[10] as number) * z + (w[14] as number),
            );
            if (prim.n.length) {
              const a = prim.n[v * 3] as number;
              const b = prim.n[v * 3 + 1] as number;
              const c = prim.n[v * 3 + 2] as number;
              const nx = (w[0] as number) * a + (w[4] as number) * b + (w[8] as number) * c;
              const ny = (w[1] as number) * a + (w[5] as number) * b + (w[9] as number) * c;
              const nz = (w[2] as number) * a + (w[6] as number) * b + (w[10] as number) * c;
              const l = Math.hypot(nx, ny, nz) || 1;
              nrm.push(nx / l, ny / l, nz / l);
            } else {
              nrm.push(0, 0, 0); // filled with the face normal below
            }
          }
          col.push(prim.color);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const scene = g.scenes?.[g.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, identity());

  const positions = Float32Array.from(pos);
  const normals = Float32Array.from(nrm);
  // Primitives without normals: flat face normals.
  for (let t = 0; t < col.length; t++) {
    const o = t * 9;
    if (normals[o] !== 0 || normals[o + 1] !== 0 || normals[o + 2] !== 0) continue;
    const ax = (positions[o + 3] as number) - (positions[o] as number);
    const ay = (positions[o + 4] as number) - (positions[o + 1] as number);
    const az = (positions[o + 5] as number) - (positions[o + 2] as number);
    const bx = (positions[o + 6] as number) - (positions[o] as number);
    const by = (positions[o + 7] as number) - (positions[o + 1] as number);
    const bz = (positions[o + 8] as number) - (positions[o + 2] as number);
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) normals.set([nx, ny, nz], o + k * 3);
  }
  return { positions, normals, colorOf: Uint16Array.from(col), colors, triangles: col.length };
}
