import { describe, expect, it, vi } from "vitest";
import { encodeLibPack } from "@pcbjam/shared";
import { withLibPack } from "./lib-pack-fetch";

const BASE = "https://api.test/api/scopes/s/libs/origins";
const text = (s: string) => new TextEncoder().encode(s);

function server(opts: { pack?: boolean } = {}) {
  const pack = encodeLibPack([{ libId: "a", versionId: "1", name: "Device", bundle: text("bundle a1") }]);
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.replace(BASE, ""));
    if (url === `${BASE}/_pack`) {
      return opts.pack === false
        ? new Response("{}", { status: 404 })
        : Response.json({ id: "f".repeat(64), bytes: pack.byteLength, libs: 1, builtAt: "now" });
    }
    if (url === `${BASE}/_pack/${"f".repeat(64)}`) return new Response(pack as Uint8Array<ArrayBuffer>);
    return new Response(`network ${url.replace(BASE, "")}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const body = async (r: Response) => new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));

describe("withLibPack", () => {
  it("answers a packed library's bundle from one pack download", async () => {
    const { fetchImpl, calls } = server();
    const f = withLibPack(fetchImpl, BASE);
    const [r1, r2] = await Promise.all([f(`${BASE}/a/1/bundle`), f(`${BASE}/a/1/bundle`)]);
    expect(await body(r1)).toBe("bundle a1");
    expect(await body(r2)).toBe("bundle a1");
    expect(calls, "pointer + pack once, no per-library request").toEqual(["/_pack", `/_pack/${"f".repeat(64)}`]);
  });

  it("fetches libraries and versions the pack does not hold, and everything else, as before", async () => {
    const { fetchImpl, calls } = server();
    const f = withLibPack(fetchImpl, BASE);
    expect(await body(await f(`${BASE}/a/2/bundle`))).toBe("network /a/2/bundle");
    expect(await body(await f(`${BASE}/b/1/bundle`))).toBe("network /b/1/bundle");
    expect(await body(await f(`${BASE}/a/1/manifest`))).toBe("network /a/1/manifest");
    expect(calls.filter((c) => c.startsWith("/_pack")).length, "the pack is fetched once").toBe(2);
  });

  it("falls back to per-library bundles when no pack is published", async () => {
    const { fetchImpl, calls } = server({ pack: false });
    const f = withLibPack(fetchImpl, BASE);
    expect(await body(await f(`${BASE}/a/1/bundle`))).toBe("network /a/1/bundle");
    expect(await body(await f(`${BASE}/a/1/bundle`))).toBe("network /a/1/bundle");
    expect(calls).toEqual(["/_pack", "/a/1/bundle", "/a/1/bundle"]);
  });
});
