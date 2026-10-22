import { decodeBundle } from "@pcbjam/shared";
import { describe, expect, it, vi } from "vitest";
import { mirrorListEnabled, withMirrorList, type PreloadedMirrorList } from "./mirror-list-fetch";

const ROOM = "https://api.test/parties/sync-room/scope:s1";
const bundleUrl = (ns: string) => `${ROOM}/libs/${encodeURIComponent(ns)}/bundle`;
const LIST = {
  complete: true,
  mirrors: [{ ns: "mirror:s1:full", v: 3, digest: "d" }],
  dirty: ["mirror:s1:dirty"],
};

function server(opts: { list?: unknown; listStatus?: number; listDelayMs?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.replace(ROOM, ""));
    if (url === `${ROOM}/mirrors`) {
      if (opts.listDelayMs) await new Promise((r) => setTimeout(r, opts.listDelayMs));
      if (opts.listStatus && opts.listStatus !== 200) return new Response("x", { status: opts.listStatus });
      return Response.json(opts.list ?? LIST);
    }
    return new Response(`network ${url.replace(ROOM, "")}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const text = async (r: Response) => new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
const isLocalEmpty = async (r: Response) => {
  const { manifest, bodies } = decodeBundle(new Uint8Array(await r.arrayBuffer()));
  return manifest.version === 0 && Object.keys(manifest.entries).length === 0 && bodies.length === 0;
};

describe("withMirrorList (libs 0030)", () => {
  it("boot list: content and dirty overlays go to the network, absent ones are answered empty locally", async () => {
    const { fetchImpl, calls } = server();
    const preloaded: PreloadedMirrorList = { scopeId: "s1", ...LIST };
    const f = withMirrorList(fetchImpl, { preloaded });
    expect(await text(await f(bundleUrl("mirror:s1:full")))).toBe(
      `network /libs/${encodeURIComponent("mirror:s1:full")}/bundle`,
    );
    expect(await text(await f(bundleUrl("mirror:s1:dirty")))).toContain("network");
    expect(await isLocalEmpty(await f(bundleUrl("mirror:s1:empty")))).toBe(true);
    // Each local answer is a fresh body.
    expect(await isLocalEmpty(await f(bundleUrl("mirror:s1:empty")))).toBe(true);
    expect(calls, "no list fetch (boot carried it), no empty-overlay request").toEqual([
      `/libs/${encodeURIComponent("mirror:s1:full")}/bundle`,
      `/libs/${encodeURIComponent("mirror:s1:dirty")}/bundle`,
    ]);
  });

  it("an incomplete list fetches every overlay, as before", async () => {
    const { fetchImpl, calls } = server();
    const f = withMirrorList(fetchImpl, {
      preloaded: { scopeId: "s1", complete: false, mirrors: [], dirty: [] },
    });
    expect(await text(await f(bundleUrl("mirror:s1:empty")))).toContain("network");
    expect(calls).toHaveLength(1);
  });

  it("no boot list: ONE list fetch shared by concurrent overlay requests", async () => {
    const { fetchImpl, calls } = server({ listDelayMs: 5 });
    const f = withMirrorList(fetchImpl);
    const answers = await Promise.all(
      ["a", "b", "c", "d"].map((l) => f(bundleUrl(`mirror:s1:${l}`))),
    );
    for (const r of answers) expect(await isLocalEmpty(r)).toBe(true);
    expect(calls).toEqual(["/mirrors"]);
    await f(bundleUrl("mirror:s1:e"));
    expect(calls).toEqual(["/mirrors"]); // still one
  });

  it("a failed or malformed list fetch falls back to per-library requests", async () => {
    for (const opts of [{ listStatus: 404 }, { list: { nope: true } }]) {
      const { fetchImpl, calls } = server(opts);
      const f = withMirrorList(fetchImpl);
      expect(await text(await f(bundleUrl("mirror:s1:x")))).toContain("network");
      expect(await text(await f(bundleUrl("mirror:s1:y")))).toContain("network");
      expect(calls.filter((c) => c === "/mirrors")).toHaveLength(1);
      expect(calls).toHaveLength(3);
    }
  });

  it("leaves org:, mirror-direct:, other scopes' overlays, writes and other URLs alone", async () => {
    const { fetchImpl, calls } = server();
    const f = withMirrorList(fetchImpl, { preloaded: { scopeId: "s1", ...LIST } });
    await f(bundleUrl("org:lib1"));
    await f(bundleUrl("mirror-direct:lib2"));
    await f(bundleUrl("mirror:s2:lib3")); // not this room's scope
    await f(`${ROOM}/libs/${encodeURIComponent("mirror:s1:empty")}/manifest`);
    await f(`${ROOM}/libs/${encodeURIComponent("mirror:s1:empty")}/body/x`, { method: "PUT", body: "x" });
    expect(calls).toHaveLength(5);
  });

  it("?mirrorlist=0 opts out", () => {
    expect(mirrorListEnabled("")).toBe(true);
    expect(mirrorListEnabled("?libpack=0")).toBe(true);
    expect(mirrorListEnabled("?mirrorlist=0")).toBe(false);
  });
});
