/**
 * Every visible canvas drawn at its on-screen rect, synchronously. The GAL
 * canvas keeps its drawing buffer (`preserveDrawingBuffer`) and every wx
 * window paints a 2D canvas, so this shows the board and the panels, without
 * DOM chrome. Dependency-free on purpose: the DOM crash floor
 * (wasm/fatal-screen.ts) calls it at the moment of a crash, before React can
 * take the editor's DOM with it.
 */

const MAX_WIDTH = 1920;

/** Scale that keeps a viewport capture at most MAX_WIDTH wide. */
export function viewportScale(): number {
  return Math.min(1, MAX_WIDTH / Math.max(1, window.innerWidth));
}

/** Null when no canvas was visible (e.g. a crash before the editor drew). */
export function compositeCanvases(): HTMLCanvasElement | null {
  const scale = viewportScale();
  const out = document.createElement("canvas");
  out.width = Math.round(window.innerWidth * scale);
  out.height = Math.round(window.innerHeight * scale);
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  let drawn = 0;
  for (const canvas of document.querySelectorAll("canvas")) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || canvas.width === 0 || canvas.height === 0) continue;
    const style = getComputedStyle(canvas);
    if (style.visibility === "hidden" || style.display === "none") continue;
    try {
      ctx.drawImage(canvas, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
      drawn++;
    } catch {
      /* a tainted or lost context: skip that canvas */
    }
  }
  return drawn > 0 ? out : null;
}
