import * as React from 'react';
import { ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react';
import { usePluginPanelLayout } from './usePluginPanelLayout';
import { Tip } from "@pcbjam/ui";

/** Host-owned chrome. Collapse hides the iframe without restarting its runtime. */
export function PluginFloatingPanel({ title, storageKey, preferredSize, forceExpanded, hidden = false, collapseSignal = 0, onRestart, onClose, children }: {
  title: string;
  storageKey: string;
  preferredSize?: { width: number; height: number };
  forceExpanded: boolean;
  /** Keep the plugin running with no panel on screen (its guided tour goes on). */
  hidden?: boolean;
  /** Each increment collapses the panel to its header (a tour starting). */
  collapseSignal?: number;
  onRestart(): void;
  onClose(): void;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const layout = usePluginPanelLayout(storageKey, preferredSize, collapsed);
  const resizeHint = React.useId();
  React.useEffect(() => { if (forceExpanded) setCollapsed(false); }, [forceExpanded]);
  React.useEffect(() => { if (collapseSignal > 0 && !forceExpanded) setCollapsed(true); }, [collapseSignal]);
  React.useEffect(() => { root.current?.focus(); }, []);
  const iconButton = 'rounded p-1 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white';
  // data-overlay-obstacle: guide cards are placed around the panel, not over it.
  return <div ref={root} role="region" aria-label={title + ' plugin'} tabIndex={-1} data-testid="plugin-panel" data-overlay-obstacle=""
    className="absolute z-40 flex flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl outline-none ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
    style={{
      left: layout.bounds.x, top: layout.bounds.y,
      width: layout.bounds.width, height: layout.bounds.height,
      // Inline, not the `hidden` attribute: Tailwind's `flex` would override it. The iframe
      // stays mounted, so the plugin keeps running.
      display: hidden ? 'none' : undefined,
    }}>
    <div data-testid="plugin-panel-header" title={title + ' — drag to move'}
      className="flex h-10 shrink-0 cursor-grab select-none items-center gap-2 px-3 text-xs font-semibold active:cursor-grabbing"
      style={{ touchAction: 'none' }}
      onPointerDown={event => layout.onPointerDown(event, 'drag')}
      onPointerMove={layout.onPointerMove}
      onPointerUp={layout.finish}
      onPointerCancel={layout.finish}
      onLostPointerCapture={layout.finish}>
      <Tip content={collapsed ? 'Expand' : 'Collapse to header'}>
        <button type="button" className={iconButton} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand plugin' : 'Collapse plugin'}
          disabled={forceExpanded} onPointerDown={event => event.stopPropagation()} onClick={() => setCollapsed(value => !value)}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </Tip>
      <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
      <span className="flex gap-0.5" onPointerDown={event => event.stopPropagation()}>
        <Tip content="Restart plugin">
          <button type="button" className={iconButton} aria-label="Restart plugin" onClick={onRestart}><RotateCcw size={14} /></button>
        </Tip>
        <Tip content="Close plugin">
          <button type="button" className={iconButton} aria-label="Close plugin" onClick={onClose}><X size={16} /></button>
        </Tip>
      </span>
    </div>
    <div className={collapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'} style={{ pointerEvents: layout.interacting ? 'none' : undefined }}>{children}</div>
    {!collapsed && <>
      <span id={resizeHint} className="sr-only">Drag to resize, or use the arrow keys. Hold Shift for larger steps.</span>
      {(['left', 'right'] as const).map(side => <Tip content="Drag to resize; arrow keys when focused" key={side}><button type="button"
        aria-label={`Resize plugin from bottom ${side}`} aria-describedby={resizeHint}
        className={`absolute bottom-0 z-10 flex h-6 w-6 items-end justify-end rounded-sm p-1 text-neutral-500 hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 dark:text-white/60 dark:hover:bg-white/10 ${side === 'left' ? 'left-0 cursor-nesw-resize' : 'right-0 cursor-nwse-resize'}`}
        style={{ touchAction: 'none' }}
        onPointerDown={event => layout.onPointerDown(event, side)} onPointerMove={layout.onPointerMove}
        onPointerUp={layout.finish} onPointerCancel={layout.finish} onLostPointerCapture={layout.finish}
        onKeyDown={event => layout.onResizeKeyDown(event, side)}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" style={{ transform: side === 'left' ? 'scaleX(-1)' : undefined }}>
          <path d="M3 10 10 3M7 10l3-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button></Tip>)}
    </>}
  </div>;
}
