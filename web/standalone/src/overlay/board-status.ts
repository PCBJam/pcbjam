/**
 * `Module.kicadBoardStatus()` (overlay-system 0004 H3): the board as a guided
 * tour reads it — a pure engine read, "{}" while the schematic frame is live.
 * Positions are in board IU (nm).
 */

export interface BoardFootprint {
  uuid: string;
  ref: string;
  fpid: string;
  x: number;
  y: number;
  side: "front" | "back";
  /** Every pad lies inside the closed board outline. */
  inside: boolean;
}

export interface BoardStatus {
  /** Edge.Cuts forms at least one closed outline. */
  outlineClosed: boolean;
  /** Canonical name of the active layer, e.g. "F.Cu", "Edge.Cuts". */
  activeLayer: string;
  tracks: number;
  vias: number;
  /** Connections the ratsnest still shows. */
  unrouted: number;
  footprints: BoardFootprint[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse the binding's payload; null when there is no board (or it is malformed). */
export function parseBoardStatus(raw: unknown): BoardStatus | null {
  if (typeof raw !== "string" || !raw) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || typeof r.outlineClosed !== "boolean" || !Array.isArray(r.footprints)) return null;
  const footprints: BoardFootprint[] = [];
  for (const f of r.footprints as Record<string, unknown>[]) {
    const uuid = typeof f?.uuid === "string" ? f.uuid : null;
    const x = num(f?.x);
    const y = num(f?.y);
    if (!uuid || x === null || y === null) continue;
    footprints.push({
      uuid: uuid.toLowerCase(),
      ref: typeof f.ref === "string" ? f.ref : "",
      fpid: typeof f.fpid === "string" ? f.fpid : "",
      x,
      y,
      side: f.side === "back" ? "back" : "front",
      inside: f.inside === true,
    });
  }
  return {
    outlineClosed: r.outlineClosed,
    activeLayer: typeof r.activeLayer === "string" ? r.activeLayer : "",
    tracks: num(r.tracks) ?? 0,
    vias: num(r.vias) ?? 0,
    unrouted: num(r.unrouted) ?? 0,
    footprints,
  };
}

/** The live board, or null (no board frame, or no engine yet). */
export function readBoardStatus(): BoardStatus | null {
  const mod = (globalThis as { Module?: { kicadBoardStatus?: () => unknown } }).Module;
  return parseBoardStatus(mod?.kicadBoardStatus?.());
}
