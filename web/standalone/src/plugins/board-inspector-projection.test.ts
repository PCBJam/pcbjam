import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { fileToDoc, docToY, kicadItemsMap } from "@pcbjam/shared";
import { inspectorSnapshot } from "./board-inspector-projection";

const fixture = `(kicad_pcb (version 20250101) (net 1 "GND") (net 2 "PRIVATE")
(footprint "A" (uuid "f1") (at 10 20) (layer "F.Cu") (property "Reference" "R1")
 (pad "1" smd rect (uuid "p1") (at 1 2) (net 1 "GND") (layers "F.Cu")))
(footprint "B" (uuid "f2") (at 30 40) (layer "B.Cu")
 (pad "1" smd rect (uuid "p2") (at 3 4) (net 2 "PRIVATE") (layers "B.Cu")))
(segment (uuid "t1") (start 1 2) (end 3 4) (layer "F.Cu") (net 1))
(gr_line (uuid "g1") (start 0 0) (end 1 1) (layer "Edge.Cuts")))`;
function board() { const doc = new Y.Doc(); docToY(fileToDoc(fixture), doc); return doc; }

describe("live editor plugin projection", () => {
  it("limits a pad selection to its footprint, pads and referenced nets", () => {
    const doc = board();
    const snapshot = inspectorSnapshot(doc, ["p1", "f1", "g1", "missing"], "selection", 7);
    expect(snapshot.footprints).toEqual(["f1"]);
    expect(snapshot.tracks).toEqual([]);
    expect(snapshot.items.map(item => item.id)).toEqual(["f1", "p1"]);
    expect(snapshot.nets.map(net => net.id)).not.toContain("2");
    expect(snapshot.items.find(item => item.id === "p1")?.parent).toBe("f1");
    expect(snapshot.revision).toBe(7);
    doc.destroy();
  });
  it("uses real selection, including empty and track-only selections", () => {
    const doc = board();
    expect(inspectorSnapshot(doc, [], "selection", 1).items).toEqual([]);
    const tracks = inspectorSnapshot(doc, ["t1"], "selection", 1);
    expect(tracks.items.map(item => item.id)).toEqual(["t1"]);
    expect(tracks.nets).toEqual([{id:"1",name:"GND"}]);
    doc.destroy();
  });
  it("re-reads current document state and returns detached data", () => {
    const doc = board();
    const first = inspectorSnapshot(doc, [], "board", 1);
    expect(first.footprints).toEqual(["f1", "f2"]);
    expect(first.tracks).toEqual(["t1"]);
    first.items[0]!.reference = "Changed outside the editor";
    expect(inspectorSnapshot(doc, [], "board", 2).items[0]!.reference).toBe("R1");
    kicadItemsMap(doc).delete("t1");
    expect(inspectorSnapshot(doc, [], "board", 3).tracks).toEqual([]);
    expect(first.tracks).toEqual(["t1"]);
    expect(inspectorSnapshot(doc, [], "board", 3).items.some(item => item.id === "g1")).toBe(false);
    doc.destroy();
  });
});
