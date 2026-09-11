/**
 * Viewer local settings (comments-ux 0003 / read-only-viewer): a project's
 * `.kicad_prl` carries per-user UI state, including the SELECTION FILTER
 * (`board.selection_filter`, `schematic.selection_filter`). A viewer or
 * commenter gets the frame chrome-less, so they can neither see nor change
 * that panel — an owner who saved with every category off would leave them
 * unable to select anything. Strip the filters when staging a read-only
 * session; KiCad then falls back to its default (everything selectable).
 * Everything else in the file (layer presets, viewports, opacities) stays.
 */
export function viewerLocalSettings(bytes: Uint8Array): Uint8Array {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return bytes; // not JSON — leave it to KiCad
  }
  if (!json || typeof json !== "object") return bytes;
  let changed = false;
  for (const section of ["board", "schematic"]) {
    const s = json[section];
    if (s && typeof s === "object" && "selection_filter" in (s as object)) {
      delete (s as Record<string, unknown>).selection_filter;
      changed = true;
    }
  }
  return changed ? new TextEncoder().encode(JSON.stringify(json, null, 2)) : bytes;
}

export const isLocalSettingsPath = (path: string): boolean => path.endsWith(".kicad_prl");
