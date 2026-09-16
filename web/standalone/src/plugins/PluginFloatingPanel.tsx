import * as React from 'react';
import { ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react';
import { useDraggablePanel } from '@/components/useDraggablePanel';

/** Host-owned chrome. Collapse hides the iframe without restarting its runtime. */
export function PluginFloatingPanel({ title, forceExpanded, onRestart, onClose, children }: {
  title: string;
  forceExpanded: boolean;
  onRestart(): void;
  onClose(): void;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel({ storageKey: 'pcbjam:plugin-panel-pos', handleWidth: 360, handleHeight: 40 });
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => { if (forceExpanded) setCollapsed(false); }, [forceExpanded]);
  React.useEffect(() => { root.current?.focus(); }, []);
  const iconButton = 'rounded p-1 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white';
  return <div ref={root} role="region" aria-label={title + ' plugin'} tabIndex={-1} data-testid="plugin-panel"
    className="absolute z-40 flex flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl outline-none ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
    style={{
      ...(drag.pos ? { left: drag.pos.x, top: drag.pos.y } : { right: 16, top: 72 }),
      width: 'min(360px, calc(100vw - 24px))',
      height: collapsed ? undefined : 'min(560px, calc(100dvh - 88px))',
      maxHeight: `calc(100dvh - ${drag.pos?.y ?? 72}px - 8px)`,
    }}>
    <div data-testid="plugin-panel-header" title={title + ' — drag to move'}
      className="flex h-10 shrink-0 cursor-grab select-none items-center gap-2 px-3 text-xs font-semibold active:cursor-grabbing"
      style={{ touchAction: 'none' }}
      onPointerDown={event => drag.onPointerDown(event, root.current!.getBoundingClientRect())}
      onPointerMove={event => void drag.onPointerMove(event)}
      onPointerUp={() => void drag.onPointerUp()}
      onPointerCancel={() => void drag.onPointerUp()}>
      <button type="button" className={iconButton} aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand plugin' : 'Collapse plugin'} title={collapsed ? 'Expand' : 'Collapse to header'}
        disabled={forceExpanded} onPointerDown={event => event.stopPropagation()} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
      <span className="flex gap-0.5" onPointerDown={event => event.stopPropagation()}>
        <button type="button" className={iconButton} title="Restart plugin" aria-label="Restart plugin" onClick={onRestart}><RotateCcw size={14} /></button>
        <button type="button" className={iconButton} title="Close plugin" aria-label="Close plugin" onClick={onClose}><X size={16} /></button>
      </span>
    </div>
    <div className={collapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>{children}</div>
  </div>;
}
