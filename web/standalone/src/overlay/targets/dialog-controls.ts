/**
 * Finding a control inside an open KiCad dialog (overlay-system 0002 M3).
 *
 * Two registry kinds live under a dialog:
 *   - wx windows (`elements`): native controls, typeName "wxButton",
 *     "wxTextCtrl", … — each records its dialog as `topLevelId` (container
 *     panels are not registered, so `parentId` chains break at the first
 *     panel; they are only a fallback for registries without topLevelId);
 *   - owner-drawn items (`renderedElements`): search fields, tree rows, tool
 *     buttons — `parentId` is the window that painted them.
 * A control spec `{type, label?}` matches either: `type` against the window
 * class without its "wx" prefix, or the rendered item's elementType
 * (case-insensitive); `label` against the normalized label/name. Windows are
 * tried first: their registry rects follow every move/resize, while an
 * owner-drawn item keeps the rect of its last paint (stale after a dialog
 * move or before the first post-layout paint).
 */
import { normalizeUiLabel } from "./parse";

type Rectish = { screenX: number; screenY: number; width: number; height: number };

const MAX_DEPTH = 64;

/** True when window `id` is `ancestor`, belongs to it, or sits below it. */
export function isWithin(
  id: string | null | undefined,
  ancestor: string,
  windows: Map<string, WxElementInfo>,
): boolean {
  let cur = id ?? null;
  for (let i = 0; cur && i < MAX_DEPTH; i++) {
    if (cur === ancestor) return true;
    const w = windows.get(cur);
    if (w?.topLevelId === ancestor) return true;
    cur = w?.parentId ?? null;
  }
  return false;
}

const typeKey = (s: string) => s.toLowerCase().replace(/^wx/, "");

export function findDialogControl(
  dialogPtr: string,
  control: { type: string; label?: string },
  windows: Map<string, WxElementInfo>,
  rendered: WxRenderedElementInfo[],
): Rectish | null {
  const type = typeKey(control.type);
  const label = control.label === undefined ? null : normalizeUiLabel(control.label);
  const labelOk = (...candidates: (string | undefined)[]) =>
    label === null || candidates.some((c) => c !== undefined && normalizeUiLabel(c) === label);

  for (const w of windows.values()) {
    if (w.id === dialogPtr || !w.visible || w.width <= 0 || w.height <= 0) continue;
    if (typeKey(w.typeName ?? "") !== type) continue;
    if (!labelOk(w.label, w.name)) continue;
    if (w.topLevelId === dialogPtr || isWithin(w.parentId, dialogPtr, windows)) return w;
  }
  for (const r of rendered) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (typeKey(r.elementType) !== type) continue;
    if (!labelOk(r.label, r.tooltip)) continue;
    if (windows.get(r.parentId)?.visible === false) continue;
    if (isWithin(r.parentId, dialogPtr, windows)) return r;
  }
  return null;
}
