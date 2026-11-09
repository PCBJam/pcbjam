import { cssToWorld, glCanvasRect } from '@/wasm/canvas-coords';
import { readViewport, type ImportModule } from '@/wasm/import-item';

/**
 * A point on the open document for a plugin or an agent (plugins 0025 §5.4): the person's next
 * click on the canvas, in mm, snapped to the schematic grid (1.27 mm) on a sheet, or to
 * 0.01 mm on a board; with Alt held, exactly where the click was. A layer over the canvas takes
 * the click, so KiCad's own tools never see it. Escape, a click outside, or `signal` cancels.
 */

/** Internal units per mm: eeschema's schIUScale, pcbnew's pcbIUScale. */
const IU_PER_MM: Record<string, number> = { eeschema: 1e4, pcbnew: 1e6 };
const GRID_MM: Record<string, number> = { eeschema: 1.27 };

/** World IU → mm, snapped to the tool's grid unless `exact`. */
export function documentMm(world: { x: number; y: number }, tool: string, exact: boolean): { x: number; y: number } {
  const perMm = IU_PER_MM[tool] ?? 1e4;
  const grid = GRID_MM[tool];
  const round = (mm: number) =>
    exact || !grid ? Math.round(mm * 100) / 100 : Math.round(Math.round(mm / grid) * grid * 1000) / 1000;
  return { x: round(world.x / perMm), y: round(world.y / perMm) };
}

export function pickPoint(prompt: string, tool: string, signal: AbortSignal): Promise<{ x: number; y: number } | null> {
  const rect = glCanvasRect();
  const mod = (globalThis as { Module?: ImportModule }).Module;
  if (!rect || !mod || signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      cursor: 'crosshair',
      zIndex: '80',
      outline: '2px dashed var(--primary, #3b82f6)',
      outlineOffset: '-2px',
    });
    layer.setAttribute('aria-label', `${prompt} (Esc cancels)`);
    layer.dataset.testid = 'pick-point-layer';
    const hint = document.createElement('div');
    hint.textContent = `${prompt} · Alt: off-grid · Esc cancels`;
    Object.assign(hint.style, {
      position: 'absolute',
      left: '8px',
      top: '8px',
      padding: '2px 6px',
      font: '12px system-ui',
      background: 'rgba(0,0,0,.7)',
      color: '#fff',
      borderRadius: '4px',
      pointerEvents: 'none',
    });
    layer.appendChild(hint);
    const finish = (point: { x: number; y: number } | null) => {
      layer.remove();
      window.removeEventListener('keydown', onKey, true);
      signal.removeEventListener('abort', onAbort);
      resolve(point);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    const onAbort = () => finish(null);
    layer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The viewport as it is now: the person may have zoomed or panned since the layer went up.
      const vp = readViewport(mod);
      if (!vp) return finish(null);
      finish(documentMm(cssToWorld(vp, rect, { x: e.clientX, y: e.clientY }), tool, e.altKey));
    });
    window.addEventListener('keydown', onKey, true);
    signal.addEventListener('abort', onAbort, { once: true });
    document.body.appendChild(layer);
  });
}
