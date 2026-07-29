import { describe, expect, it } from "vitest";
import { encodeBundle, sha256Hex, type SyncManifest } from "@pcbjam/shared";
import { memStore, type LayerStore } from "@pcbjam/sync-client";
import { cdnLibsSource } from "./cdn-source";

const MANIFEST_URL = "https://cdn.test/libs/kicad/9.0.0/manifest.json";
const BASE = "https://cdn.test/libs/kicad/9.0.0";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a static-origin snapshot (per-lib manifest + bundle) the way
 *  publish-libs will, using the REAL wire codecs — so this pins the format. */
async function makeLib(items: Record<string, string>) {
  const bodies = Object.entries(items).map(
    ([path, text]): [string, Uint8Array] => [path, enc.encode(text)],
  );
  const entries: SyncManifest["entries"] = {};
  for (const [path, body] of bodies) {
    entries[path] = { hash: await sha256Hex(body), size: body.length, mtime: 0 };
  }
  const manifest: SyncManifest = { version: 1, entries };
  return { manifest, bundle: encodeBundle(manifest, bodies) };
}

async function fakeCdn(opts?: { sizes?: boolean }) {
  const device = await makeLib({
    "symbol/R": "(kicad_symbol_lib (symbol R))",
    "symbol/C": "(kicad_symbol_lib (symbol C))",
  });
  const resistors = await makeLib({
    "footprint/R_0402_1005Metric": "(footprint R_0402)",
  });
  const top = {
    schema: 1,
    tag: "9.0.0",
    libs: [
      { id: "Device", name: "Device", kind: "symbol", itemCount: 2 },
      { id: "Resistor_SMD", name: "Resistor_SMD", kind: "footprint", itemCount: 1 },
    ],
  };
  // Publish-time bundle byte counts (sizes.json) — served unless disabled to
  // model a tag published before the file existed.
  const sizes = {
    schema: 1,
    tag: "9.0.0",
    libs: { Device: device.bundle.byteLength, Resistor_SMD: resistors.bundle.byteLength },
  };
  const json = (obj: unknown) => ({ ok: true, json: async () => obj });
  const bin = (bytes: Uint8Array) => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  });
  const fetchImpl = (async (url: string) => {
    if (url === MANIFEST_URL) return json(top);
    if (url === `${BASE}/sizes.json` && opts?.sizes !== false) return json(sizes);
    if (url === `${BASE}/Device/manifest`) return json(device.manifest);
    if (url === `${BASE}/Device/bundle`) return bin(device.bundle);
    if (url === `${BASE}/Resistor_SMD/manifest`) return json(resistors.manifest);
    if (url === `${BASE}/Resistor_SMD/bundle`) return bin(resistors.bundle);
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;
  // Namespace-keyed persistent stores — the "browser's IDB": syncState's
  // read-only peek must observe the same cache presync/openStack warmed.
  const stores = new Map<string, LayerStore>();
  const src = cdnLibsSource(MANIFEST_URL, {
    fetchImpl,
    storeFactory: (ns) => {
      let s = stores.get(ns);
      if (!s) stores.set(ns, (s = memStore()));
      return s;
    },
  });
  return Object.assign(src, { __sizes: sizes });
}

describe("cdn libs source", () => {
  it("lists libs from the top manifest, filtered by kind", async () => {
    const src = await fakeCdn();
    expect((await src.listLibs()).map((l) => l.id)).toEqual([
      "Device",
      "Resistor_SMD",
    ]);
    expect((await src.listLibs("symbol")).map((l) => l.id)).toEqual(["Device"]);
    expect((await src.listLibs("footprint")).map((l) => l.id)).toEqual([
      "Resistor_SMD",
    ]);
  });

  it("lists a lib's items from one cold bundle fetch", async () => {
    const src = await fakeCdn();
    const items = await src.listItems("Device");
    expect(items.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { kind: "symbol", name: "C" },
      { kind: "symbol", name: "R" },
    ]);
  });

  it("returns a self-contained item body by kind/name", async () => {
    const src = await fakeCdn();
    expect(await src.getItemBody("Device", "symbol", "R")).toBe(
      "(kicad_symbol_lib (symbol R))",
    );
    expect(
      await src.getItemBody("Resistor_SMD", "footprint", "R_0402_1005Metric"),
    ).toBe("(footprint R_0402)");
    expect(await src.getItemBody("Device", "symbol", "Nope")).toBeNull();
  });

  it("getAllItems returns every item with its (raw-bytes) body in one shot (fat list)", async () => {
    const src = await fakeCdn();
    const all = (await src.getAllItems!("Device")).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    // "Copy as-is": bodies come back as raw Uint8Array (no TextDecoder) so the
    // provider can frame + memcpy them across the bridge unescaped.
    expect(
      all.map((i) => ({ kind: i.kind, name: i.name, body: dec.decode(i.body) })),
    ).toEqual([
      { kind: "symbol", name: "C", body: "(kicad_symbol_lib (symbol C))" },
      { kind: "symbol", name: "R", body: "(kicad_symbol_lib (symbol R))" },
    ]);
    // Bodies (decoded) match the per-item getItemBody for the same kind/name.
    for (const it of all) {
      expect(dec.decode(it.body)).toBe(
        await src.getItemBody("Device", it.kind, it.name),
      );
    }
  });

  it("presync warms a kind's lib bundles and reports per-lib progress", async () => {
    const src = await fakeCdn();
    const events: Array<{ done: number; total: number; current: string }> = [];
    await src.presync!({ kind: "symbol", onProgress: (p) => events.push({ ...p }) });

    const last = events[events.length - 1]!;
    expect(last.total).toBe(1); // one symbol lib (Device)
    expect(last.done).toBe(1); // completed
    expect(events.some((e) => e.current === "Device")).toBe(true);
    // Warmed: items are served from the opened stack.
    expect((await src.listItems("Device")).length).toBe(2);
  });

  it("presync without a kind warms every lib", async () => {
    const src = await fakeCdn();
    let total = 0;
    await src.presync!({ onProgress: (p) => (total = p.total) });
    expect(total).toBe(2); // Device (symbol) + Resistor_SMD (footprint)
  });

  it("is read-only (no save path)", async () => {
    const src = await fakeCdn();
    expect(src.saveItemBody).toBeUndefined();
  });

  it("syncState reports cold bytes from sizes.json without downloading", async () => {
    const src = await fakeCdn();
    const cold = await src.syncState!("symbol");
    expect(cold).toEqual({
      total: 1,
      warm: 0,
      coldBytes: src.__sizes.libs.Device,
      sizesKnown: true,
    });
    // The probe itself must not have warmed anything (no bundle fetch).
    expect((await src.syncState!("symbol"))!.warm).toBe(0);
  });

  it("syncState sees presync's warmth; the other kind stays cold", async () => {
    const src = await fakeCdn();
    await src.presync!({ kind: "symbol" });
    expect(await src.syncState!("symbol")).toEqual({
      total: 1,
      warm: 1,
      coldBytes: 0,
      sizesKnown: true,
    });
    expect(await src.syncState!("footprint")).toEqual({
      total: 1,
      warm: 0,
      coldBytes: src.__sizes.libs.Resistor_SMD,
      sizesKnown: true,
    });
  });

  it("syncState on a tag without sizes.json: counts right, sizesKnown false", async () => {
    const src = await fakeCdn({ sizes: false });
    expect(await src.syncState!("footprint")).toEqual({
      total: 1,
      warm: 0,
      coldBytes: 0,
      sizesKnown: false,
    });
  });

  it("getFpIndex fetches fp-index.json as raw text, null on 404", async () => {
    const INDEX = { schema: 1, tag: "9.0.0", libs: { Resistor_SMD: [["R_0402_1005Metric", 2]] } };
    let indexFetches = 0;
    const fetchImpl = (async (url: string) => {
      if (url === `${BASE}/fp-index.json`) {
        indexFetches++;
        return { ok: true, status: 200, text: async () => JSON.stringify(INDEX) };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    const src = cdnLibsSource(MANIFEST_URL, { fetchImpl, storeFactory: () => memStore() });
    expect(JSON.parse((await src.getFpIndex!())!)).toEqual(INDEX);
    await src.getFpIndex!(); // cached — no second fetch
    expect(indexFetches).toBe(1);

    // A tag published without an index resolves null (fallback path).
    const noIndex = cdnLibsSource(MANIFEST_URL, {
      fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
      storeFactory: () => memStore(),
    });
    expect(await noIndex.getFpIndex!()).toBeNull();
  });
});
