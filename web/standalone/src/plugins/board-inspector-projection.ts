import type * as Y from "yjs";
import { args, field, fields, scalar, unquoteAtom, kicadItemsMap, yToItemUnchecked, Y_KDOC_LAYOUT, type KicadItem, type Slot } from "@pcbjam/shared";

/** Data-only POC contract. The plugin never receives the editor's Y.Doc. */
export interface InspectorSnapshot {
  revision: number;
  footprints: string[];
  tracks: string[];
  items: {
    id: string; type: string; parent: string | null; reference: string; number: string;
    net: string; x: number; y: number; endX: number; endY: number; layer: string; pads: string[];
  }[];
  nets: { id: string; name: string }[];
}
const isFootprint = (type: unknown) => type === "footprint" || type === "module";
const isTrack = (type: unknown) => type === "segment" || type === "arc" || type === "via";

export function inspectorSnapshot(doc: Y.Doc, selection: readonly string[], scope: "selection" | "board", revision: number): InspectorSnapshot {
  const source = kicadItemsMap(doc);
  const footprints = new Set<string>();
  const tracks = new Set<string>();
  const pads = new Map<string, string[]>();
  if (scope === "board") {
    source.forEach((item, id) => {
      if (isFootprint(item.get("type"))) footprints.add(id);
      if (isTrack(item.get("type"))) tracks.add(id);
    });
  } else {
    for (const id of selection) {
      const item = source.get(id);
      if (!item) continue;
      if (isFootprint(item.get("type"))) footprints.add(id);
      if (isTrack(item.get("type"))) tracks.add(id);
      if (item.get("type") === "pad") {
        const parent = item.get("parent");
        if (typeof parent === "string" && isFootprint(source.get(parent)?.get("type"))) footprints.add(parent);
      }
    }
  }
  // Resolve pads only for approved footprints; unrelated items never cross the boundary.
  source.forEach((item, id) => {
    const parent = item.get("parent");
    if (item.get("type") !== "pad" || typeof parent !== "string" || !footprints.has(parent)) return;
    const list = pads.get(parent) ?? [];
    list.push(id); pads.set(parent, list);
  });
  for (const list of pads.values()) list.sort();
  const netNames = new Map<string, string>([["0", "(unassigned)"]]);
  for (const slot of fields(doc.getArray<Slot>(Y_KDOC_LAYOUT).toArray(), "net")) {
    const values = args(slot);
    netNames.set(unquoteAtom(values[0] ?? "0"), unquoteAtom(values[1] ?? values[0] ?? ""));
  }
  const footprintIds = [...footprints].sort(), trackIds = [...tracks].sort();
  const ids = [...footprintIds, ...footprintIds.flatMap(id => pads.get(id) ?? []), ...trackIds];
  const coordinate = (item: KicadItem, key: string, index: number) => {
    const value = Number(args(field(item.body, key) ?? [])[index] ?? 0);
    if (!Number.isFinite(value)) throw new Error("Invalid coordinate");
    return value;
  };
  const items = ids.map(id => {
    const item = yToItemUnchecked(source.get(id)!);
    const reference = fields(item.body, "property").find(s => unquoteAtom(args(s)[0] ?? "") === "Reference");
    const netArgs = args(field(item.body, "net") ?? []);
    const net = unquoteAtom(netArgs[0] ?? "0");
    if (netArgs[1]) netNames.set(net, unquoteAtom(netArgs[1]));
    const point = item.type === "segment" || item.type === "arc" ? "start" : "at";
    return {
      id, type: item.type, parent: item.parent,
      reference: reference ? unquoteAtom(args(reference)[1] ?? "") : "",
      number: item.type === "pad" ? unquoteAtom(args(item.body)[0] ?? "") : "",
      net, x: coordinate(item, point, 0), y: coordinate(item, point, 1),
      endX: coordinate(item, "end", 0), endY: coordinate(item, "end", 1),
      layer: unquoteAtom(scalar(item.body, "layer") ?? args(field(item.body, "layers") ?? [])[0] ?? ""),
      pads: pads.get(id) ?? [],
    };
  });
  return {
    revision, footprints: footprintIds, tracks: trackIds, items,
    nets: [...new Set(items.map(item => item.net))].sort().map(id => ({ id, name: netNames.get(id) ?? id })),
  };
}
