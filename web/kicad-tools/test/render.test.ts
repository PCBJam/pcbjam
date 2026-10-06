import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Mesh } from "../src/glb.ts";
import { encodePng } from "../src/png.ts";
import { render, VIEWS } from "../src/render3d.ts";

/** One red square (two triangles) lying on the board plane, 10 mm wide, at board (5, 5) mm. */
function square(): Mesh {
  const a = [0, 0, 0];
  const b = [0.01, 0, 0];
  const c = [0.01, 0, 0.01];
  const d = [0, 0, 0.01];
  const up = [0, 1, 0];
  return {
    positions: Float32Array.from([...a, ...b, ...c, ...a, ...c, ...d]),
    normals: Float32Array.from([...up, ...up, ...up, ...up, ...up, ...up]),
    colorOf: Uint16Array.from([0, 0]),
    colors: [[1, 0, 0]],
    triangles: 2,
  };
}

describe("3D shots", () => {
  it("encodes a valid PNG", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const png = encodePng(rgba, 2, 1);
    expect(Buffer.from(png.subarray(1, 4)).toString()).toBe("PNG");
    const view = Buffer.from(png);
    expect(view.readUInt32BE(16)).toBe(2);
    expect(view.readUInt32BE(20)).toBe(1);
    const idat = view.indexOf("IDAT");
    const len = view.readUInt32BE(idat - 4);
    const raw = inflateSync(view.subarray(idat + 4, idat + 4 + len));
    expect([...raw]).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("renders the top view: the board plane fills the frame, lit, on a transparent background", () => {
    const img = render(square(), { view: VIEWS.top!, widthPx: 100, background: null });
    expect(img.width).toBe(100);
    expect(img.height).toBe(100);
    const at = (x: number, y: number) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    const [r, g, b, alpha] = at(50, 50);
    expect(alpha).toBe(255);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(at(0, 0)[3]).toBe(0); // the 4 % margin stays background
  });

  it("frames a crop in board millimetres", () => {
    // A crop from x = -2.5 to 7.5 mm: the square starts at 0, so the left quarter is empty.
    const img = render(square(), { view: VIEWS.top!, widthPx: 100, background: null, crop: { cx: 2.5, cy: 5, halfW: 5, halfH: 5 } });
    const alphaAt = (x: number) => img.rgba[(50 * img.width + x) * 4 + 3];
    expect(alphaAt(5)).toBe(0);
    expect(alphaAt(60)).toBe(255);
    expect(alphaAt(95)).toBe(255);
  });
});
