import * as React from 'react';

type Size = { width: number; height: number };
type Bounds = Size & { x: number; y: number };
type Settings = Size & { fx: number; fy: number };
type Gesture = 'drag' | 'left' | 'right';
const MARGIN = 8;
const HEADER_HEIGHT = 40;
const DEFAULT_SIZE = { width: 360, height: 560 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });
const validSize = (value: Size | null | undefined): value is Size => !!value &&
  Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0;

function restore(key: string): Settings | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    const fx = value?.fx, fy = value?.fy;
    if (validSize(value) && Number.isFinite(fx) && Number.isFinite(fy)) return { ...value, fx, fy };
  } catch { /* Storage can be unavailable or contain an obsolete value. */ }
  return null;
}

/** Host-owned geometry only; resizing never messages or remounts plugin code. */
export function usePluginPanelLayout(storageKey: string, preferredSize: Size | undefined, collapsed: boolean) {
  const [viewport, setViewport] = React.useState(viewportSize);
  const [settings, setSettings] = React.useState(() => restore(storageKey));
  const latest = React.useRef(settings);
  const [interacting, setInteracting] = React.useState(false);
  const gesture = React.useRef<{
    kind: Gesture; pointerId: number; startX: number; startY: number;
    base: Bounds; size: Size; moved: boolean;
  } | null>(null);
  const preferred = validSize(preferredSize) ? preferredSize : DEFAULT_SIZE;
  const requested = settings ?? preferred;
  const width = clamp(requested.width, Math.min(280, Math.max(1, viewport.width - 2 * MARGIN)), Math.max(1, viewport.width - 2 * MARGIN));
  const height = collapsed ? HEADER_HEIGHT : clamp(requested.height, Math.min(240, Math.max(1, viewport.height - 2 * MARGIN)), Math.max(1, viewport.height - 2 * MARGIN));
  const freeX = Math.max(0, viewport.width - width - 2 * MARGIN);
  const freeY = Math.max(0, viewport.height - height - 2 * MARGIN);
  // Use the header as the vertical anchor so collapsing does not move it.
  const headerFreeY = Math.max(0, viewport.height - HEADER_HEIGHT - 2 * MARGIN);
  const bounds: Bounds = {
    width, height,
    x: MARGIN + (settings ? clamp(settings.fx, 0, 1) * freeX : Math.max(0, freeX - 8)),
    y: MARGIN + Math.min(freeY, settings ? clamp(settings.fy, 0, 1) * headerFreeY : 64),
  };

  const persist = () => {
    if (!latest.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify(latest.current)); }
    catch { /* Keep the current layout when browser storage is unavailable. */ }
  };
  const finish = () => {
    if (gesture.current?.moved) persist();
    gesture.current = null;
    setInteracting(false);
  };
  React.useEffect(() => {
    const onResize = () => {
      // Stop an in-flight gesture whose starting rectangle is now obsolete.
      gesture.current = null;
      setInteracting(false);
      setViewport(viewportSize());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const update = (next: Bounds, size: Size = next) => {
    const roomX = Math.max(0, viewport.width - next.width - 2 * MARGIN);
    const roomY = Math.max(0, viewport.height - next.height - 2 * MARGIN);
    latest.current = { width: size.width, height: size.height,
      fx: roomX ? clamp((next.x - MARGIN) / roomX, 0, 1) : 0,
      fy: headerFreeY ? clamp(next.y - MARGIN, 0, roomY) / headerFreeY : 0 };
    setSettings(latest.current);
  };
  const resize = (base: Bounds, side: 'left' | 'right', dx: number, dy: number) => {
    const availableWidth = Math.max(1, side === 'left' ? base.x + base.width - MARGIN : viewport.width - base.x - MARGIN);
    const availableHeight = Math.max(1, viewport.height - base.y - MARGIN);
    const nextWidth = clamp(Math.round(base.width + (side === 'left' ? -dx : dx)), Math.min(280, availableWidth), availableWidth);
    const nextHeight = clamp(Math.round(base.height + dy), Math.min(240, availableHeight), availableHeight);
    update({ x: side === 'left' ? base.x + base.width - nextWidth : base.x, y: base.y, width: nextWidth, height: nextHeight });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLElement>, kind: Gesture) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (kind !== 'drag') event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      base: bounds, size: requested, moved: false };
    setInteracting(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    if (current.kind === 'drag') update({ ...current.base, x: current.base.x + dx, y: current.base.y + dy }, current.size);
    else resize(current.base, current.kind, dx, dy);
  };
  const onResizeKeyDown = (event: React.KeyboardEvent, side: 'left' | 'right') => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    resize(bounds, side, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    persist();
  };
  return { bounds, interacting, onPointerDown, onPointerMove, finish, onResizeKeyDown };
}
