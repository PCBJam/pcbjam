import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hasSimSymbols, notLoadedSentence, sheetsNotLoaded, simPartRows, simPartsReader } from "./sim-parts";

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

  it("says which wires a part's thermal pins are on, for the parts that have such pins", async () => {
    const index = {
      ...INDEX,
      parts: [
        ...INDEX.parts,
        { id: "heater", version: 1, title: "Heater", description: "", fits: [{ symbol: "Device:Heater" }], pins: ["1", "2"], code: false, thermal: ["heat"], files: [] },
        { id: "fan", version: 1, title: "Fan", description: "", fits: [{ symbol: "Motor:Fan" }], pins: ["1", "2"], code: false, thermal: ["air"], files: [] },
      ],
    };
    const { fetchImpl } = cdn({ ...published(), [`${SNAPSHOT}/index.json`]: index });
    const two = { "1": { name: "", node: "+12V" }, "2": { name: "", node: "GND" } };
    const drawn = {
      symbols: [
        sym("C1", "Device:C", "5", { "1": { name: "", node: "/BOX" }, "2": { name: "", node: "GND" } }),
        sym("R9", "Device:R", "4", { "1": { name: "", node: "/OUTSIDE" }, "2": { name: "", node: "/BOX" } }),
        sym("R5", "Device:Heater", "12V 5W", two, { fields: { Value: "12V 5W", "PCBJam.SimThermal": " box " } }),
        sym("R6", "Device:Heater", "Heater", two),
        sym("R7", "Device:Heater", "Heater", two, { fields: { Value: "Heater", "PCBJam.SimThermal": "OVEN" } }),
        sym("M1", "Motor:Fan", "12V", two, { fields: { Value: "12V", "PCBJam.SimThermal": "BOX OUTSIDE" } }),
        sym("M2", "Motor:Fan", "12V", two, { fields: { Value: "12V", "PCBJam.SimThermal": "BOX" } }),
        // a part without a thermal pin has no line for one, whatever its symbol says
        sym("D1", "Device:LED", "red", { "1": { name: "K", node: "GND" }, "2": { name: "A", node: "/LED" } }, { fields: { Value: "red", "PCBJam.SimThermal": "BOX" } }),
      ],
    };
    const rows = simPartRows(await simPartsReader(BASE, { fetch: fetchImpl }).read(editor(drawn)));
    const heats = [{ pin: "PJTH", does: "heats" }];
    const air = [{ pin: "PJTA", does: "air" }, { pin: "PJTB", does: "air" }];
    expect(rows.filter((r) => r.state === "live").map((r) => [r.ref, r.thermal])).toEqual([
      ["D1", undefined],
      ["M1", { pins: air, wires: ["BOX", "OUTSIDE"] }],
      ["M2", { pins: air, wires: ["BOX"], problem: "M2 is on no heat wires: Fan has 2 thermal pins, so it takes the names of 2 wires." }],
      ["R5", { pins: heats, wires: ["box"] }],
      ["R6", { pins: heats, wires: [] }],
      ["R7", { pins: heats, wires: ["OVEN"], problem: 'R7 is on no heat wire: no wire of the schematic is called "OVEN". A wire has the name of the label on it, and something has to be connected to it.' }],
    ]);
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

  it("says which value runs when a Value says its ratings too, and leaves out one it cannot read", async () => {
    const { fetchImpl } = cdn(published());
    const pins = { "1": { name: "", node: "+5V" }, "2": { name: "", node: "GND" } };
    const symbols = {
      symbols: [...SCHEMATIC.symbols, sym("C3", "Device:C", "22uF/25V", pins), sym("R20", "Device:R", "10k 1% 0603", pins), sym("R21", "Device:R", "10k/22k", pins)],
    };
    // KiCad hands a Value it does not read as a plain value to the simulator as it is: the line's type is "="
    const netlist = {
      ...NETLIST,
      lines: [...NETLIST.lines.slice(0, -1), item("C3", "C3 +5V GND 22uF/25V"), item("R20", "R20 +5V GND 10k 1% 0603"), item("R21", "R21 +5V GND 10k/22k"), { text: ".end" }],
      items: [...NETLIST.items, { ref: "C3", name: "C3", device: "C", type: "=" }, { ref: "R20", name: "R20", device: "R", type: "=" }, { ref: "R21", name: "R21", device: "R", type: "=" }],
    };
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist(netlist, symbols));
    expect([...got.valuesRead.keys()]).toEqual(["C3", "R20"]);
    const rows = simPartRows(got);
    expect(rows.find((r) => r.ref === "C3")).toMatchObject({
      state: "kicad", value: "22uF/25V", label: "KiCad's model, as 22uF",
      note: "Runs with KiCad's own model, as 22uF. Its Value says a rating too (25V), which is no part of the circuit.",
    });
    expect(rows.find((r) => r.ref === "R20")).toMatchObject({
      state: "kicad", label: "KiCad's model, as 10k",
      note: "Runs with KiCad's own model, as 10k. Its Value says ratings too (1%, 0603), which are no part of the circuit.",
    });
    expect(rows.find((r) => r.ref === "R21")).toMatchObject({
      state: "none", label: "no value", reason: "no-value",
      note: 'R21: its Value "10k/22k" is not read as one value. Type the value alone (10k) and it runs.',
    });
    // a plain value says nothing more
    expect(rows.find((r) => r.ref === "R1")).toMatchObject({ label: "KiCad's model", note: "Runs with KiCad's own model." });
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
    expect(rows.find((r) => r.ref === "U7")).toMatchObject({
      state: "none", label: "no part", reason: "no-part",
      note: "U7 (X) is not simulated: the library has no part for it. The rest runs without it.",
    });
  });

  it("says why a run leaves a symbol out, by the rules a run uses", async () => {
    const { fetchImpl } = cdn(published());
    const two = (a: string, b: string) => ({ "1": { name: "", node: a }, "2": { name: "", node: b } });
    const more = [
      sym("R2", "Device:R", "R", two("/A", "GND")),
      sym("H1", "Mechanical:MountingHole_Pad", "MountingHole_Pad", { "1": { name: "1", node: "GND" } }),
      sym("J1", "Connector_Generic:Conn_01x02", "Conn_01x02", two("/A", "GND")),
      sym("U7", "My:Chip", "X", { "1": { name: "" } }),
      sym("R5", "Device:R", "1k", two("/A", "GND"), { fields: { Value: "1k", "PCBJam.SimPart": "off" } }),
    ];
    const symbols = { symbols: [...SCHEMATIC.symbols, ...more] };
    const netlist = {
      ...NETLIST,
      lines: [...NETLIST.lines.slice(0, -1), item("R2", "R2 /A GND R"), item("R5", "R5 /A GND 1k"), item("U7", "U7 __U7"), item("H1", "H1 __H1"), item("J1", "J1 __J1"), { text: ".end" }],
      items: [
        ...NETLIST.items,
        { ref: "R2", name: "R2", device: "R", type: "" }, { ref: "R5", name: "R5", device: "R", type: "" },
        ...["U7", "H1", "J1"].map((ref) => ({ ref, name: ref, device: "", type: "" })),
      ],
    };
    const got = await simPartsReader(BASE, { fetch: fetchImpl }).read(editorWithNetlist(netlist, symbols));
    expect(got.leftOut.map((s) => [s.ref, s.reason])).toEqual([
      ["H1", "nothing"], ["J1", "nothing"], ["K1", "no-part"], ["R2", "no-value"], ["R5", "off"], ["R9", "off"], ["U7", "no-part"],
    ]);
    const rows = simPartRows(got);
    const row = (ref: string) => rows.find((r) => r.ref === ref);
    expect(row("R2")).toMatchObject({ state: "none", label: "no value", reason: "no-value", note: "R2 has no value. Type one (10k) and it runs." });
    expect(row("H1")).toMatchObject({ state: "none", label: "nothing to simulate", reason: "nothing" });
    expect(row("R5")).toMatchObject({ state: "off", label: "switched off", reason: "off", note: "R5 is switched off on its symbol (PCBJam.SimPart: off). KiCad's own model runs in its place." });
    expect(row("R9")).toMatchObject({ state: "excluded", label: "excluded", reason: "off" });
    // a suggestion keeps its own row: the user decides there
    expect(row("K1")).toMatchObject({ state: "suggested", label: "suggestion", reason: "no-part" });
    // a symbol that runs has no reason
    expect([row("SW1")?.reason, row("R1")?.reason]).toEqual([undefined, undefined]);
    // among the symbols nothing runs: what the user can mend first, what has nothing to simulate last
    expect(rows.filter((r) => r.state === "none").map((r) => r.ref)).toEqual(["R2", "U7", "H1", "J1"]);
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
    expect(run.power).toEqual({ byName: [{ net: "+5V", volts: 5 }], noVolts: [], assumed: [], noPower: [], unfed: [], sockets: [] });
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

  it("finds the sheets whose file the editor could not load", () => {
    const tree = {
      current: "/",
      sheets: [
        { path: "/", parent: "", name: "board", file: "/project/board.kicad_sch", page: "1", depth: 0 },
        { path: "/a/", parent: "/", name: "Power", file: "/project/power.kicad_sch", page: "2", depth: 1 },
        { path: "/b/", parent: "/", name: "Key 1", file: "/project/sub/key.kicad_sch", page: "3", depth: 1 },
        { path: "/c/", parent: "/", name: "Key 2", file: "/project/sub/key.kicad_sch", page: "4", depth: 1 },
      ],
    };
    const mod = { kicadSimSymbols: () => "{}", kicadSheetsGetTree: () => JSON.stringify(tree) };
    const has = (...files: string[]) => (path: string) => files.includes(path);
    expect(sheetsNotLoaded(mod, has("/project/board.kicad_sch", "/project/power.kicad_sch", "/project/sub/key.kicad_sch"))).toEqual([]);
    expect(sheetsNotLoaded(mod, has("/project/board.kicad_sch", "/project/sub/key.kicad_sch"))).toEqual([{ name: "Power", file: "power.kicad_sch" }]);
    // a file that is used twice is one file to add; the root sheet is the schematic that is open
    expect(sheetsNotLoaded(mod, has())).toEqual([{ name: "Power", file: "power.kicad_sch" }, { name: "Key 1", file: "key.kicad_sch" }]);
    // nothing to look with, or an editor that cannot list its sheets: nothing is said
    expect(sheetsNotLoaded(mod)).toEqual([]);
    expect(sheetsNotLoaded({ kicadSimSymbols: () => "{}" }, has())).toEqual([]);
    expect(sheetsNotLoaded({ kicadSimSymbols: () => "{}", kicadSheetsGetTree: () => "not json" }, has())).toEqual([]);
    expect(sheetsNotLoaded(mod, () => { throw new Error("no file system"); })).toEqual([]);
  });

  it("says a sheet that did not load in words, with what to do", () => {
    expect(notLoadedSentence([{ name: "Power", file: "power.kicad_sch" }])).toBe(
      'the sheet "Power" is not loaded: its file power.kicad_sch is not in the project. Its symbols cannot be simulated, or even counted. Add the file to the project, or delete the sheet.',
    );
    expect(notLoadedSentence([{ name: "Power", file: "power.kicad_sch" }, { name: "Key 1", file: "key.kicad_sch" }])).toBe(
      '2 sheets are not loaded, their files are not in the project: "Power" (power.kicad_sch), "Key 1" (key.kicad_sch). Their symbols cannot be simulated, or even counted. Add the files to the project, or delete the sheets.',
    );
  });

  it("does not prepare a run of a schematic with a sheet that did not load, and lists it for the parts list", async () => {
    const { fetchImpl } = cdn(published());
    const tree = { current: "/", sheets: [{ path: "/a/", parent: "/", name: "Power", file: "/project/power.kicad_sch", page: "2", depth: 1 }] };
    const mod = { ...editorWithNetlist(NETLIST), kicadSheetsGetTree: () => JSON.stringify(tree) };
    const reader = simPartsReader(BASE, { fetch: fetchImpl, fileExists: () => false });
    await expect(reader.prepare(mod)).rejects.toThrow('the sheet "Power" is not loaded: its file power.kicad_sch is not in the project.');
    expect((await reader.read(mod)).notLoaded).toEqual([{ name: "Power", file: "power.kicad_sch" }]);
    // with the file there, the same schematic is prepared
    const whole = simPartsReader(BASE, { fetch: fetchImpl, fileExists: () => true });
    expect((await whole.read(mod)).notLoaded).toEqual([]);
  });

  it("knows an editor build with the read from one without", () => {
    expect(hasSimSymbols(editor())).toBe(true);
    expect(hasSimSymbols({})).toBe(false);
    expect(hasSimSymbols(undefined)).toBe(false);
  });
});
