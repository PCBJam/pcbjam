import { describe, expect, it } from "vitest";
import { parseBoardStatus } from "./board-status";

const RAW = JSON.stringify({
  outlineClosed: true,
  activeLayer: "Edge.Cuts",
  tracks: 5,
  vias: 1,
  unrouted: 2,
  footprints: [
    { uuid: "ABC-1", ref: "J1", fpid: "plugin_x:USB_A_PCB_Edge", x: 1000, y: 2000, side: "front", inside: true },
    { uuid: "abc-2", ref: "R1", fpid: "Resistor_SMD:R_0805_2012Metric", x: 3, y: 4, side: "back", inside: false },
    { ref: "BROKEN" },
  ],
});

describe("parseBoardStatus", () => {
  it("reads the binding's payload, lower-casing uuids and dropping malformed footprints", () => {
    expect(parseBoardStatus(RAW)).toEqual({
      outlineClosed: true,
      activeLayer: "Edge.Cuts",
      tracks: 5,
      vias: 1,
      unrouted: 2,
      footprints: [
        { uuid: "abc-1", ref: "J1", fpid: "plugin_x:USB_A_PCB_Edge", x: 1000, y: 2000, side: "front", inside: true },
        { uuid: "abc-2", ref: "R1", fpid: "Resistor_SMD:R_0805_2012Metric", x: 3, y: 4, side: "back", inside: false },
      ],
      zones: [],
    });
  });

  it("reads copper zones (overlay-system 0006); older engines send none", () => {
    const base = { outlineClosed: true, activeLayer: "F.Cu", tracks: 0, vias: 2, unrouted: 0, footprints: [] };
    const z = parseBoardStatus(JSON.stringify({ ...base, zones: [{ net: "GND", layers: ["B.Cu", 3], filled: true }, { layers: "x" }, null] }));
    expect(z?.zones).toEqual([{ net: "GND", layers: ["B.Cu"], filled: true }, { net: "", layers: [], filled: false }]);
    expect(z?.vias).toBe(2);
    expect(parseBoardStatus(JSON.stringify(base))?.zones).toEqual([]);
  });

  it("is null without a board ('{}' on the schematic page) or for garbage", () => {
    expect(parseBoardStatus("{}")).toBeNull();
    expect(parseBoardStatus("")).toBeNull();
    expect(parseBoardStatus("not json")).toBeNull();
    expect(parseBoardStatus(undefined)).toBeNull();
    expect(parseBoardStatus(JSON.stringify({ outlineClosed: "yes", footprints: [] }))).toBeNull();
  });
});
