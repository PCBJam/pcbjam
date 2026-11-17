import { createHash } from "node:crypto";
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

/** A CDN made of a table: path under BASE -> JSON body, or bytes as they are. Counts what was asked. */
function cdn(files: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(`${BASE}/`)) throw new Error(`unexpected request: ${url}`);
    const path = url.slice(BASE.length + 1);
    asked.push(path);
    if (!(path in files)) return new Response("not found", { status: 404 });
    const body = files[path];
    return new Response(body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

const published = () => ({
  "current.json": { schema: 1, version: SNAPSHOT },
  [`${SNAPSHOT}/index.json`]: INDEX,
});

const editor = (answer: unknown = SCHEMATIC) => ({ kicadSimSymbols: () => JSON.stringify(answer) });

// KiCad's netlist of SCHEMATIC, the shape of the editor's second answer
// (wasm/bindings/sim_netlist.h): a real line for the resistor, placeholders for the two
// switches (KiCad has no model for them), and KiCad's guess for the LED.
const item = (ref: string, text: string) => ({ text, ref, kind: "item" });
const NETLIST = {
  lines: [
    { text: ".title KiCad schematic" },
    item("SW1", "SW1 __SW1"),
    item("D1", "D1 GND /LED red"),
    item("R1", "R1 /LED +5V 330"),
    item("K1", "K1 __K1"),
    { text: ".end" },
  ],
  items: [
    { ref: "SW1", name: "SW1", device: "", type: "" },
    { ref: "D1", name: "D1", device: "SPICE", type: "" },
    { ref: "R1", name: "R1", device: "R", type: "" },
    { ref: "K1", name: "K1", device: "", type: "" },
  ],
  messages: [],
  ok: true,
};
const editorWithNetlist = (netlist: unknown = NETLIST, symbols: unknown = SCHEMATIC) => ({
  kicadSimSymbols: () => JSON.stringify(symbols),
  kicadSimNetlist: () => JSON.stringify(netlist),
});

// A snapshot with the two parts' files, so that parts can be loaded: the index lists every
// file with its checksum, as the publish step does.
const BUTTON_MODEL = `.subckt PJ_BUTTON 1 2
Vctl ctl 0 dc 0
R1 1 2 r = '100meg * exp(-20.7 * V(ctl))'
.ends PJ_BUTTON
`;
const LED_MODEL = `.subckt PJ_LED A K
Vsense A a1 dc 0
D1 a1 K PJLED
.model PJLED D(IS=1e-18 N=2 RS=10)
.ends PJ_LED
`;
function publishedWithFiles() {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const files: Record<string, unknown> = { "current.json": { schema: 1, version: SNAPSHOT } };
  const parts = INDEX.parts.map((p) => {
    const manifest = p.id === "led"
      ? { schema: 1, id: p.id, version: 1, title: p.title, fits: p.fits, pins: p.pins, analog: { file: "model.lib", subckt: "PJ_LED" }, signals: [{ name: "current", current: "Vsense" }] }
      : { schema: 1, id: p.id, version: 1, title: p.title, fits: p.fits, pins: p.pins, analog: { file: "model.lib", subckt: "PJ_BUTTON" }, inputs: [{ name: "pressed", type: "momentary", source: "Vctl", released: 0, held: 1 }] };
    const own: [string, Uint8Array][] = [["part.json", utf8(JSON.stringify(manifest))], ["model.lib", utf8(p.id === "led" ? LED_MODEL : BUTTON_MODEL)]];
    for (const [name, bytes] of own) files[`${SNAPSHOT}/parts/${p.id}/${name}`] = bytes;
    return { ...p, files: own.map(([name, bytes]) => ({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })) };
  });
  files[`${SNAPSHOT}/index.json`] = { ...INDEX, parts };
  return files;
}

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

  it("asks the editor's netlist which symbols KiCad runs itself", async () => {
    const { fetchImpl } = cdn(published());
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist());
    expect(got.kicadModelsKnown).toBe(true);
    expect(got.netlist?.items.map((i) => i.ref)).toEqual(["SW1", "D1", "R1", "K1"]);
    expect(got.matches.map((m) => [m.ref, m.status])).toEqual([
      ["SW1", "matched"],
      ["D1", "matched"],   // a library part beats KiCad's line
      ["R1", "kicad"],
      ["K1", "suggested"],
    ]);
    expect(got.problems).toEqual([]);
    expect(simPartRows(got).map((r) => [r.ref, r.label])).toEqual([
      ["D1", "live"],
      ["K1", "suggestion"],
      ["SW1", "live"],
      ["R1", "KiCad's model"],
      ["R9", "excluded"],
    ]);
  });

  it("says a symbol is not simulated when neither the library nor KiCad has a model", async () => {
    const { fetchImpl } = cdn(published());
    const symbols = { symbols: [...SCHEMATIC.symbols, sym("U7", "My:Chip", "X", { "1": { name: "" } })] };
    const netlist = {
      ...NETLIST,
      lines: [...NETLIST.lines.slice(0, -1), item("U7", "U7 __U7"), { text: ".end" }],
      items: [...NETLIST.items, { ref: "U7", name: "U7", device: "", type: "" }],
    };
    const rows = simPartRows(await simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist(netlist, symbols)));
    expect(rows.find((r) => r.ref === "U7")).toMatchObject({ state: "none", label: "not simulated" });
  });

  it("passes on what KiCad's netlist export complained about", async () => {
    const { fetchImpl } = cdn(published());
    const netlist = {
      ...NETLIST,
      ok: false,
      messages: [
        { severity: "error", text: "Simulation model library not found at '/p/lost.lib'" },
        { severity: "info", text: "nothing to see" },
        { severity: "warning", text: "a warning" },
      ],
    };
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist(netlist));
    expect(got.problems).toEqual(["Simulation model library not found at '/p/lost.lib'", "a warning"]);
  });

  it("a netlist that could not be written fails the read, in words", async () => {
    const { fetchImpl } = cdn(published());
    await expect(
      simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist({ error: "boom" })),
    ).rejects.toThrow("the netlist could not be written: boom");
  });

  it("prepares the circuit that runs: KiCad's netlist with the library parts in it", async () => {
    const { asked, fetchImpl } = cdn(publishedWithFiles());
    const run = await simPartsReader(BASE, { fetch: fetchImpl }).prepare(editorWithNetlist());

    expect(run.errors).toEqual([]);
    expect(run.deck).toEqual([
      ".title KiCad schematic",
      `.include "/sim-library/led/model.lib"`,
      `.include "/sim-library/push-button/model.lib"`,
      "R1 /LED +5V 330",
      "XD1 /LED GND PJ_LED",
      "XSW1 GND /BTN PJ_BUTTON",
      // the nets of the symbols without a line (K1, and R9 that KiCad excludes) get a path to ground
      "Rpj_left_1 /KEY 0 1g",
      "Rpj_left_2 /X 0 1g",
      // the schematic draws no source: the wire +5V is powered by its name
      "Vpj_supply_1 pj_supply_1 0 DC 5",
      "Rpj_supply_1 pj_supply_1 +5V 10m",
      ".tran 1m 100000 0 1m",
      ".end",
    ]);
    expect(run.power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: [], assumed: [], noPower: [], unfed: [] });
    // K1 is only a suggestion: it is left out, and so is its placeholder line.
    expect(run.notSimulated).toEqual(["K1"]);
    expect(run.placed.map((p) => [p.ref, p.partId, p.name])).toEqual([["D1", "led", "XD1"], ["SW1", "push-button", "XSW1"]]);
    expect(run.inputs).toMatchObject([{ ref: "SW1", vector: "v.xsw1.vctl", initial: 0 }]);
    expect(run.signals).toEqual([{ ref: "D1", partId: "led", name: "current", vector: "v.xd1.vsense#branch" }]);
    // live: the button's source is one the app sets while it runs
    expect(run.files.find((f) => f.path.includes("push-button"))?.text).toContain("Vctl ctl 0 dc 0 external");
    // only the parts that are used were downloaded
    expect(asked.filter((a) => a.includes("/parts/")).sort()).toEqual([
      `${SNAPSHOT}/parts/led/model.lib`,
      `${SNAPSHOT}/parts/led/part.json`,
      `${SNAPSHOT}/parts/push-button/model.lib`,
      `${SNAPSHOT}/parts/push-button/part.json`,
    ]);

    // a pick that is not on the symbol yet, and the plain circuit
    const picked = await simPartsReader(BASE, { fetch: fetchImpl }).prepare(editorWithNetlist(), { overrides: { "uuid-K1": "push-button" }, live: false });
    expect(picked.deck.slice(-6)).toEqual([
      "XK1 GND /KEY PJ_BUTTON", "XSW1 GND /BTN PJ_BUTTON", "Rpj_left_1 /X 0 1g",
      "Vpj_supply_1 pj_supply_1 0 DC 5", "Rpj_supply_1 pj_supply_1 +5V 10m", ".end",
    ]);
    expect(picked.notSimulated).toEqual([]);
    expect(picked.files.find((f) => f.path.includes("push-button"))?.text).toBe(BUTTON_MODEL);
  });

  it("cannot prepare a run with an editor build that has no netlist read", async () => {
    const { fetchImpl } = cdn(published());
    await expect(simPartsReader(BASE, { fetch: fetchImpl }).prepare(editor())).rejects.toThrow("this editor build cannot write the netlist");
  });

  it("knows an editor build with the read from one without", () => {
    expect(hasSimSymbols(editor())).toBe(true);
    expect(hasSimSymbols({})).toBe(false);
    expect(hasSimSymbols(undefined)).toBe(false);
  });
});
