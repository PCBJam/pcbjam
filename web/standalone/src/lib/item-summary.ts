import { args, field, fields, scalar, type KicadItem, type Slot } from "@pcbjam/shared";

/**
 * Pure display-model extraction for the SelectionInspector (viewer-panels):
 * one selected item's kdoc slots → a titled row list. No React, no Yjs — the
 * caller supplies the item, an item resolver (nested pads/pins) and a net-name
 * resolver (pcbnew layout `(net N "name")` entries carry the names tracks and
 * vias reference by number only).
 */

export interface ItemSummary {
  uuid: string;
  /** s-expr head, e.g. "footprint" / "symbol" / "segment". */
  type: string;
  /** Human title, e.g. "R5 · 10k" / "Track" / 'Label "CLK"'. */
  title: string;
  rows: Array<{ label: string; value: string }>;
}

/** Strip the kept surrounding quotes of a string atom and unescape it. */
export function unq(atom: string | undefined): string {
  if (atom === undefined) return "";
  if (atom.length >= 2 && atom.startsWith('"') && atom.endsWith('"')) {
    return atom.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return atom;
}

/** File numbers verbatim are fine, but trim float noise ("1.270000" → "1.27"). */
function fmtNum(atom: string | undefined): string {
  if (atom === undefined) return "";
  const n = Number(atom);
  if (!Number.isFinite(n)) return atom;
  return String(Math.round(n * 10000) / 10000);
}

function pos(body: Slot[]): { x: string; y: string; rot?: string } | null {
  const at = field(body, "at");
  if (!at) return null;
  const a = args(at);
  if (a.length < 2) return null;
  const out: { x: string; y: string; rot?: string } = { x: fmtNum(a[0]), y: fmtNum(a[1]) };
  if (a[2] !== undefined && Number(a[2]) !== 0) out.rot = fmtNum(a[2]);
  return out;
}

function pushPos(rows: ItemSummary["rows"], body: Slot[]): void {
  const p = pos(body);
  if (!p) return;
  rows.push({ label: "Position", value: `${p.x}, ${p.y} mm` });
  if (p.rot) rows.push({ label: "Rotation", value: `${p.rot}°` });
}

function pushLayer(rows: ItemSummary["rows"], body: Slot[]): void {
  const layer = scalar(body, "layer");
  if (layer) rows.push({ label: "Layer", value: unq(layer) });
  const layersField = field(body, "layers");
  if (layersField) {
    rows.push({ label: "Layers", value: args(layersField).map(unq).join(", ") });
  }
}

/**
 * `(property "Name" "Value" …)` pairs, internal `ki_*` ones skipped. Board
 * properties carry uuids, so the kdoc flattening hoists them into child ITEMS
 * (`{item}` refs); schematic ones stay inline as `{k:"property"}` slots —
 * read both shapes.
 */
function properties(
  body: Slot[],
  itemOf: (uuid: string) => KicadItem | undefined,
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const push = (v: Slot[]) => {
    const a = args(v);
    const name = unq(a[0]);
    if (!name || name.startsWith("ki_")) return;
    out.push({ name, value: unq(a[1]) });
  };
  for (const v of fields(body, "property")) push(v);
  for (const s of body) {
    if (!("item" in s)) continue;
    const child = itemOf(s.item);
    if (child?.type === "property") push(child.body);
  }
  return out;
}

function netRow(
  body: Slot[],
  netName: (num: string) => string | undefined,
): { label: string; value: string } | null {
  const net = field(body, "net");
  if (!net) return null;
  const a = args(net);
  const name = a[1] !== undefined ? unq(a[1]) : netName(a[0] ?? "");
  return { label: "Net", value: name ? name : a[0] !== undefined ? `#${a[0]}` : "" };
}

export function summarizeItem(opts: {
  uuid: string;
  item: KicadItem;
  itemOf: (uuid: string) => KicadItem | undefined;
  netName: (num: string) => string | undefined;
}): ItemSummary {
  const { uuid, item, itemOf, netName } = opts;
  const body = item.body;
  const rows: ItemSummary["rows"] = [];
  let title = item.type.charAt(0).toUpperCase() + item.type.slice(1).replace(/_/g, " ");

  const childrenOfType = (type: string): KicadItem[] =>
    body.flatMap((s) => {
      if (!("item" in s)) return [];
      const child = itemOf(s.item);
      return child && child.type === type ? [child] : [];
    });

  switch (item.type) {
    case "footprint": {
      const props = properties(body, itemOf);
      const ref = props.find((p) => p.name === "Reference")?.value;
      const value = props.find((p) => p.name === "Value")?.value;
      title = ref ? (value ? `${ref} · ${value}` : ref) : "Footprint";
      rows.push({ label: "Footprint", value: unq(args(body)[0]) });
      pushPos(rows, body);
      pushLayer(rows, body);
      for (const p of props) {
        if (p.name === "Reference" || p.name === "Value") continue;
        if (p.value) rows.push({ label: p.name, value: p.value });
      }
      const pads = childrenOfType("pad");
      if (pads.length) {
        rows.push({ label: "Pads", value: String(pads.length) });
        const nets = new Set<string>();
        for (const pad of pads) {
          const r = netRow(pad.body, netName);
          if (r?.value) nets.add(r.value);
        }
        if (nets.size) rows.push({ label: "Nets", value: [...nets].join(", ") });
      }
      break;
    }

    case "symbol": {
      const props = properties(body, itemOf);
      const ref = props.find((p) => p.name === "Reference")?.value;
      const value = props.find((p) => p.name === "Value")?.value;
      title = ref ? (value ? `${ref} · ${value}` : ref) : "Symbol";
      const libId = scalar(body, "lib_id");
      if (libId) rows.push({ label: "Symbol", value: unq(libId) });
      pushPos(rows, body);
      const unit = scalar(body, "unit");
      if (unit && unit !== "1") rows.push({ label: "Unit", value: unit });
      for (const p of props) {
        if (p.name === "Reference" || p.name === "Value") continue;
        if (p.value) rows.push({ label: p.name, value: p.value });
      }
      break;
    }

    case "segment":
    case "arc": {
      title = item.type === "arc" ? "Track (arc)" : "Track";
      const start = args(field(body, "start") ?? []);
      const end = args(field(body, "end") ?? []);
      if (start.length >= 2 && end.length >= 2) {
        rows.push({ label: "Start", value: `${fmtNum(start[0])}, ${fmtNum(start[1])} mm` });
        rows.push({ label: "End", value: `${fmtNum(end[0])}, ${fmtNum(end[1])} mm` });
        const dx = Number(end[0]) - Number(start[0]);
        const dy = Number(end[1]) - Number(start[1]);
        if (item.type === "segment" && Number.isFinite(dx) && Number.isFinite(dy)) {
          rows.push({ label: "Length", value: `${fmtNum(String(Math.hypot(dx, dy)))} mm` });
        }
      }
      const width = scalar(body, "width");
      if (width) rows.push({ label: "Width", value: `${fmtNum(width)} mm` });
      pushLayer(rows, body);
      const net = netRow(body, netName);
      if (net) rows.push(net);
      break;
    }

    case "via": {
      title = "Via";
      pushPos(rows, body);
      const size = scalar(body, "size");
      if (size) rows.push({ label: "Size", value: `${fmtNum(size)} mm` });
      const drill = scalar(body, "drill");
      if (drill) rows.push({ label: "Drill", value: `${fmtNum(drill)} mm` });
      pushLayer(rows, body);
      const net = netRow(body, netName);
      if (net) rows.push(net);
      break;
    }

    case "zone": {
      const name = scalar(body, "net_name");
      title = name ? `Zone ${unq(name)}` : "Zone";
      const net = netRow(body, netName);
      if (net) rows.push(net);
      pushLayer(rows, body);
      break;
    }

    case "gr_text":
    case "text": {
      const text = unq(args(body)[0]);
      title = text ? `Text "${text.length > 24 ? text.slice(0, 24) + "…" : text}"` : "Text";
      pushPos(rows, body);
      pushLayer(rows, body);
      break;
    }

    case "label":
    case "global_label":
    case "hierarchical_label": {
      const text = unq(args(body)[0]);
      const kind =
        item.type === "global_label"
          ? "Global label"
          : item.type === "hierarchical_label"
            ? "Hierarchical label"
            : "Label";
      title = text ? `${kind} "${text}"` : kind;
      pushPos(rows, body);
      break;
    }

    case "wire":
    case "bus": {
      title = item.type === "wire" ? "Wire" : "Bus";
      const pts = field(body, "pts");
      if (pts) {
        const xys = fields(pts, "xy");
        if (xys.length >= 2) {
          const first = args(xys[0]!);
          const last = args(xys[xys.length - 1]!);
          rows.push({ label: "From", value: `${fmtNum(first[0])}, ${fmtNum(first[1])} mm` });
          rows.push({ label: "To", value: `${fmtNum(last[0])}, ${fmtNum(last[1])} mm` });
        }
      }
      break;
    }

    case "sheet": {
      const props = properties(body, itemOf);
      const name = props.find((p) => p.name === "Sheetname")?.value;
      title = name ? `Sheet ${name}` : "Sheet";
      for (const p of props) if (p.value) rows.push({ label: p.name, value: p.value });
      pushPos(rows, body);
      break;
    }

    default: {
      pushPos(rows, body);
      pushLayer(rows, body);
      const net = netRow(body, netName);
      if (net) rows.push(net);
    }
  }

  return { uuid, type: item.type, title, rows };
}

/**
 * Net-number → name resolver over the document layout's `(net N "name")`
 * entries (pcbnew; eeschema layouts have none — resolves nothing there).
 */
export function netNameResolver(layout: Slot[]): (num: string) => string | undefined {
  let map: Map<string, string> | null = null;
  return (num) => {
    if (!map) {
      map = new Map();
      for (const v of fields(layout, "net")) {
        const a = args(v);
        if (a[0] !== undefined && a[1] !== undefined) map.set(a[0], unq(a[1]));
      }
    }
    const name = map.get(num);
    return name === "" ? undefined : name;
  };
}
