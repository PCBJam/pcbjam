import { describe, expect, it } from "vitest";
import { hasSimSymbols, simPartRows, simPartsReader } from "./sim-parts";

const BASE = "https://cdn.example.com/sim-library";
const SNAPSHOT = "0123456789ab";

// A library with two parts, the way a published snapshot's index describes them.
const INDEX = {
  schema: 1,
  version: SNAPSHOT,
  parts: [
    {
      id: "push-button", version: 1, title: "Push button", description: "",
      fits: [{ symbol: "Switch:SW_Push" }, { value: "BTN*" }],
      pins: ["1", "2"], code: false, files: [],
    },
    {
      id: "led", version: 1, title: "LED", description: "",
      fits: [{ symbol: "Device:LED", pins: "name" }],
      pins: ["A", "K"], code: false, files: [],
    },
  ],
  emulators: [],
};

// The shape of the editor's answer (wasm/bindings/sim_symbols.h).
const sym = (ref: string, libId: string, value: string, pins: Record<string, { name: string; node?: string }>, more: object = {}) => ({
  uuid: `uuid-${ref}`, ref, libId, value, sheet: "/", sheetPath: "/", fields: { Value: value }, pins, ...more,
});
const SCHEMATIC = {
  symbols: [
    sym("SW1", "Switch:SW_Push", "SW_Push", { "1": { name: "1", node: "GND" }, "2": { name: "2", node: "/BTN" } }),
    sym("D1", "Device:LED", "red", { "1": { name: "K", node: "GND" }, "2": { name: "A", node: "/LED" } }),
    sym("R1", "Device:R", "330", { "1": { name: "", node: "/LED" }, "2": { name: "", node: "+5V" } }),
    sym("K1", "My:Key", "BTN_SMALL", { "1": { name: "", node: "GND" }, "2": { name: "", node: "/KEY" } }),
    sym("R9", "Device:R", "1k", { "1": { name: "", node: "/X" }, "2": { name: "" } }, { excluded: true }),
  ],
};

/** A CDN made of a table: path under BASE -> JSON body. Counts what was asked. */
function cdn(files: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(`${BASE}/`)) throw new Error(`unexpected request: ${url}`);
    const path = url.slice(BASE.length + 1);
    asked.push(path);
    return path in files
      ? new Response(JSON.stringify(files[path]), { status: 200 })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

const published = () => ({
  "current.json": { schema: 1, version: SNAPSHOT },
  [`${SNAPSHOT}/index.json`]: INDEX,
});

const editor = (answer: unknown = SCHEMATIC) => ({ kicadSimSymbols: () => JSON.stringify(answer) });

describe("the parts of the open schematic", () => {
  it("matches what the editor reports against the published library", async () => {
    const { fetchImpl } = cdn(published());
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editor());

    expect(got.library.version).toBe(SNAPSHOT);
    expect(got.symbols.map((s) => s.ref)).toEqual(["SW1", "D1", "R1", "K1"]);
    expect(got.excluded.map((s) => s.ref)).toEqual(["R9"]);
    expect(got.matches.map((m) => [m.ref, m.status])).toEqual([
      ["SW1", "matched"],
      ["D1", "matched"],
      ["R1", "none"],
      ["K1", "suggested"],
    ]);
    // the LED part names its pins A and K; the symbol has them on 2 and 1
    expect(got.matches[1]).toMatchObject({ partId: "led", pinMap: ["2", "1"] });
    expect(got.kicadModelsKnown).toBe(false);
  });

  it("passes on a pick and KiCad's own models", async () => {
    const { fetchImpl } = cdn(published());
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editor(), {
      overrides: { "uuid-K1": "push-button", "uuid-SW1": "off" },
      kicadModels: new Set(["R1"]),
    });
    expect(got.matches.map((m) => [m.ref, m.status])).toEqual([
      ["SW1", "off"],
      ["D1", "matched"],
      ["R1", "kicad"],
      ["K1", "matched"],
    ]);
    expect(got.kicadModelsKnown).toBe(true);
  });

  it("opens the library once and reads the schematic every time", async () => {
    const { asked, fetchImpl } = cdn(published());
    const reader = simPartsReader(BASE, { fetch: fetchImpl });
    let drawn: unknown = SCHEMATIC;
    const mod = { kicadSimSymbols: () => JSON.stringify(drawn) };

    const [a, b] = await Promise.all([reader.read(mod), reader.read(mod)]);
    expect(a.matches).toEqual(b.matches);
    drawn = { symbols: SCHEMATIC.symbols.slice(0, 1) };
    expect((await reader.read(mod)).symbols.map((s) => s.ref)).toEqual(["SW1"]);

    expect(asked).toEqual(["current.json", `${SNAPSHOT}/index.json`]);
  });

  it("does not keep a failed open: the next read tries again", async () => {
    const files: Record<string, unknown> = {};
    const { asked, fetchImpl } = cdn(files);
    const reader = simPartsReader(BASE, { fetch: fetchImpl });

    await expect(reader.read(editor())).rejects.toThrow("simulation library: current.json: HTTP 404");
    Object.assign(files, published());
    expect((await reader.read(editor())).library.version).toBe(SNAPSHOT);
    expect(asked).toEqual(["current.json", "current.json", `${SNAPSHOT}/index.json`]);
  });

  it("says so when the editor has no schematic open", async () => {
    const { fetchImpl } = cdn(published());
    await expect(
      simPartsReader(BASE, { fetch: fetchImpl }).read(editor({ error: "no schematic frame" })),
    ).rejects.toThrow("the schematic could not be read: no schematic frame");
  });

  it("turns the answer into the rows of the parts list", async () => {
    const { fetchImpl } = cdn(published());
    const reader = simPartsReader(BASE, { fetch: fetchImpl });
    const rows = simPartRows(await reader.read(editor()));
    expect(rows.map((r) => [r.ref, r.state, r.part, r.label])).toEqual([
      ["D1", "live", "LED", "live"],
      ["K1", "suggested", "Push button", "suggestion"],
      ["SW1", "live", "Push button", "live"],
      ["R1", "none", "", "no library part"],
      ["R9", "excluded", "", "excluded"],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[3]?.note).toBe("The library has no part for this symbol. KiCad's own model is used when the symbol has one.");
  });

  it("says in the rows what was set by hand, and what KiCad runs", async () => {
    const { fetchImpl } = cdn(published());
    const reader = simPartsReader(BASE, { fetch: fetchImpl });
    const drawn = {
      symbols: [
        ...SCHEMATIC.symbols,
        sym("R10", "Device:R", "10k", { "1": { name: "" }, "2": { name: "" } }),
        sym("R2", "Device:R", "1k", { "1": { name: "" }, "2": { name: "" } }, { fields: { Value: "1k", "PCBJam.SimPart": "led" } }),
        sym("Q1", "Device:Q_NPN", "BC547", { "1": { name: "" } }, { fields: { Value: "BC547", "Sim.Library": "bc547.lib" } }),
        sym("U7", "My:Chip", "X", { "1": { name: "" } }),
      ],
    };
    const rows = simPartRows(await reader.read(editor(drawn), {
      overrides: { "uuid-K1": "push-button", "uuid-SW1": "off" },
      kicadModels: new Set(["R1", "R10"]),
    }));
    expect(rows.map((r) => [r.ref, r.label])).toEqual([
      ["D1", "live"],
      ["K1", "live, set by hand"],
      ["R2", "cannot be used"],
      ["SW1", "switched off"],
      ["Q1", "own SPICE model"],
      ["R1", "KiCad's model"],
      ["R10", "KiCad's model"],
      ["U7", "not simulated"],
      ["R9", "excluded"],
    ]);
    expect(rows[2]?.note).toBe('"led" does not fit this symbol: the symbol has no pin for A, K.');
  });

  it("knows an editor build with the read from one without", () => {
    expect(hasSimSymbols(editor())).toBe(true);
    expect(hasSimSymbols({})).toBe(false);
    expect(hasSimSymbols(undefined)).toBe(false);
  });
});
