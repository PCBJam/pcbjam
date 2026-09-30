/** What the step card must keep clear of, besides host panels (overlay-system 0004). */
import type { CssRect } from "@/wasm/canvas-coords";
import { wxRectToPage } from "./targets/resolve";

/**
 * Open KiCad dialogs, in page px: the card must not cover what the user is asked to fill in or
 * confirm (a field dialog's OK button under the card swallows the click). Registry coords are
 * `#canvas`-relative.
 */
export function dialogRects(
  ptrs: readonly string[],
  windows: Map<string, WxElementInfo> | undefined,
  origin: { x: number; y: number },
): CssRect[] {
  const out: CssRect[] = [];
  for (const ptr of ptrs) {
    const w = windows?.get(ptr);
    if (w && w.visible !== false && w.width > 0 && w.height > 0) out.push(wxRectToPage(w, origin));
  }
  return out;
}
