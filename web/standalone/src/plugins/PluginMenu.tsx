import * as React from 'react';
import { ExternalLink, Plus, Puzzle } from 'lucide-react';
import { APP_URL } from '@/lib/config';
import { OverlayMenuSection, overlayRowClass, useCloseOverlayMenu } from '@/components/OverlayMenu';
import { BUILTIN, hostedPlugins, pluginKey, type PluginCatalog, type PluginView } from './plugin-catalog';
import { Tip, Toggle } from "@pcbjam/ui";
import { cn } from "@/lib/utils";

export interface PluginMenuProps {
  tool: string;
  catalog: PluginCatalog;
  view: PluginView;
  onViewChange(view: PluginView): void;
}

export function PluginMenu({ tool, catalog, view, onViewChange }: PluginMenuProps) {
  const closeMenu = useCloseOverlayMenu();
  React.useEffect(() => { void catalog.refresh(); }, [catalog.refresh]);
  const open = (next: PluginView) => { onViewChange(next); closeMenu(); };
  const selected = view?.kind === 'plugin' ? view.id : '';
  return <OverlayMenuSection label="Plugins">
    <div data-testid="overlay-menu-plugins" className="flex flex-col gap-1">
      <div className="max-h-48 overflow-y-auto">
        {!hostedPlugins && tool === 'pcbnew' && <Toggle variant="ghost" size="row" className={overlayRowClass} pressed={selected === BUILTIN}
          onClick={() => open({ kind: 'plugin', id: BUILTIN })}>
          <Puzzle size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
          <span className="min-w-0 flex-1 truncate">Board Inspector</span><span className="text-[10px] text-neutral-400 dark:text-white/40">Bundled</span>
        </Toggle>}
        {catalog.plugins.filter(plugin => plugin.source !== 'tutorial').map(plugin => {
          const compatible = plugin.manifest.surfaces.includes('editor:' + tool);
          return <Tip content={compatible ? plugin.manifest.name : plugin.manifest.name + ' · Available in another editor'} key={pluginKey(plugin)}><Toggle variant="ghost" size="row" disabled={!compatible || plugin.enabled===false}
            // A disabled row keeps its pointer events: its tooltip says why it is off.
            className={cn(overlayRowClass, 'disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40')}
            pressed={selected === pluginKey(plugin)}
            onClick={() => open({ kind: 'plugin', id: pluginKey(plugin) })}>
            <Puzzle size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
            <span className="min-w-0 flex-1 truncate">{plugin.manifest.name}</span>
            {hostedPlugins && plugin.source === 'upload' && <span className="text-[10px] text-neutral-400 dark:text-white/40">Private</span>}
          </Toggle></Tip>;
        })}
        {!catalog.plugins.some(plugin => plugin.source !== 'tutorial') && (hostedPlugins || tool !== 'pcbnew') && <p className="px-2 py-1 text-xs text-neutral-500 dark:text-white/50">{catalog.loaded ? 'No plugins installed yet' : 'Loading plugins…'}</p>}
        {catalog.error && <p role="status" className="px-2 py-1 text-xs text-amber-700 dark:text-amber-200">Plugin list unavailable</p>}
      </div>
      {/* Everyone installs from the marketplace in the web app; the menu then
          lists what is installed (the catalog refreshes when this tab regains focus). */}
      {hostedPlugins && APP_URL && <a href={APP_URL + '/plugins'} target="_blank" rel="noopener noreferrer" className={overlayRowClass} onClick={closeMenu}>
        <Puzzle size={14} className="shrink-0 text-neutral-400 dark:text-white/50" /><span className="flex-1">Browse plugins…</span>
        <ExternalLink size={12} aria-hidden="true" className="text-neutral-400 dark:text-white/40" />
      </a>}
      {/* Private uploads are for accounts with developer access. */}
      {catalog.developer && <button type="button" className={overlayRowClass} onClick={() => open({ kind: 'manager' })}>
        <Plus size={14} className="shrink-0 text-neutral-400 dark:text-white/50" /><span>Add plugin…</span>
      </button>}
    </div>
  </OverlayMenuSection>;
}
