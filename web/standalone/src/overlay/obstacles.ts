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

/**
 * True when `inner` lies within one of `rects` (±1 px): a step's target that sits inside an
 * open dialog or tool frame — the simulator's Run button — is where the user works, not
 * something the dialog covers (overlay-system 0006).
 */
export function insideAny(inner: CssRect, rects: readonly CssRect[]): boolean {
  return rects.some(
    (r) => inner.x >= r.x - 1 && inner.y >= r.y - 1 && inner.x + inner.width <= r.x + r.width + 1 && inner.y + inner.height <= r.y + r.height + 1,
  );
}
