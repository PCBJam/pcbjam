import * as React from 'react';
import { ExternalLink, Plus, Puzzle, Sparkles } from 'lucide-react';
import { APP_URL } from '@/lib/config';
import { OverlayMenuSub, overlayRowClass, useCloseOverlayMenu } from '@/components/OverlayMenu';
import { AI_CHAT_PLUGIN as AI_CHAT, BUILTIN, hostedPlugins, pluginKey, type Descriptor, type PluginCatalog, type PluginView } from './plugin-catalog';
import { NewDot, ProBadge } from '@/components/whats-new/SidePanel';
import { Button, Tip, Toggle } from "@pcbjam/ui";
import { cn } from "@/lib/utils";

export interface PluginMenuProps {
  tool: string;
  catalog: PluginCatalog;
  view: PluginView;
  onViewChange(view: PluginView): void;
  /**
   * What's new for PCBJam AI's row. `fresh`: a release announced it and the person hasn't
   * opened it, so the row has a dot. `offer`: the person is on Free and PCBJam AI is part of
   * Pro, so they don't have the plugin: the row is there all the same, with the Pro badge, and
   * opens the offer (`onOffer`) where the chat would be.
   */
  ai?: { fresh: boolean; offer: boolean; offerOpen: boolean; onOffer(): void };
}

export function PluginMenu({ tool, catalog, view, onViewChange, ai: aiRow }: PluginMenuProps) {
  const closeMenu = useCloseOverlayMenu();
  React.useEffect(() => { void catalog.refresh(); }, [catalog.refresh]);
  const open = (next: PluginView) => { onViewChange(next); closeMenu(); };
  const selected = view?.kind === 'plugin' ? view.id : '';
  const listed = catalog.plugins.filter(plugin => plugin.source !== 'tutorial');
  // The AI chat has a row of its own, above the Plugins child menu with the rest.
  const ai = listed.find(plugin => plugin.manifest.id === AI_CHAT);
  const others = listed.filter(plugin => plugin !== ai);
  const row = (plugin: Descriptor, Icon: typeof Puzzle) => {
    const compatible = plugin.manifest.surfaces.includes('editor:' + tool);
    return <Tip content={compatible ? plugin.manifest.name : plugin.manifest.name + ' · Available in another editor'} key={pluginKey(plugin)}><Toggle variant="ghost" size="row" disabled={!compatible || plugin.enabled===false}
      className={cn(overlayRowClass, 'disabled:cursor-not-allowed disabled:opacity-40')}
      pressed={selected === pluginKey(plugin)}
      onClick={() => open({ kind: 'plugin', id: pluginKey(plugin) })}>
      <Icon size={14} className={cn('shrink-0', Icon === Sparkles ? 'text-violet-500 dark:text-violet-300' : 'text-neutral-400 dark:text-white/50')} />
      <span className="min-w-0 flex-1 truncate">{plugin.manifest.name}</span>
      {hostedPlugins && plugin.source === 'upload' && <span className="text-[10px] text-neutral-400 dark:text-white/40">Private</span>}
      {Icon === Sparkles && aiRow?.fresh && <NewDot />}
    </Toggle></Tip>;
  };
  return <div data-testid="overlay-menu-plugins" className="flex flex-col gap-1">
    {ai && row(ai, Sparkles)}
    {!ai && aiRow?.offer && <Tip content="PCBJam AI is part of Pro"><Toggle variant="ghost" size="row" data-testid="ai-offer-row"
      className={overlayRowClass} pressed={aiRow.offerOpen}
      onClick={() => { aiRow.onOffer(); closeMenu(); }}>
      <Sparkles size={14} className="shrink-0 text-violet-500 dark:text-violet-300" />
      <span className="min-w-0 flex-1 truncate">PCBJam AI</span>
      <ProBadge />
      {aiRow.fresh && <NewDot />}
    </Toggle></Tip>}
    <OverlayMenuSub id="plugins" label="Plugins" icon={Puzzle}>
      <div className="max-h-48 overflow-y-auto">
        {!hostedPlugins && tool === 'pcbnew' && <Toggle variant="ghost" size="row" className={overlayRowClass} pressed={selected === BUILTIN}
          onClick={() => open({ kind: 'plugin', id: BUILTIN })}>
          <Puzzle size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
          <span className="min-w-0 flex-1 truncate">Board Inspector</span><span className="text-[10px] text-neutral-400 dark:text-white/40">Bundled</span>
        </Toggle>}
        {others.map(plugin => row(plugin, Puzzle))}
        {!others.length && (hostedPlugins || tool !== 'pcbnew') && <p className="px-2 py-1 text-xs text-neutral-500 dark:text-white/50">{catalog.loaded ? (ai ? 'No other plugins installed yet' : 'No plugins installed yet') : 'Loading plugins…'}</p>}
        {catalog.error && <p role="status" className="px-2 py-1 text-xs text-amber-700 dark:text-amber-200">Plugin list unavailable</p>}
      </div>
      {/* Everyone installs from the marketplace in the web app; the menu then
          lists what is installed (the catalog refreshes when this tab regains focus). */}
      {hostedPlugins && APP_URL && <a href={APP_URL + '/plugins'} target="_blank" rel="noopener noreferrer" className={overlayRowClass} onClick={closeMenu}>
        <Puzzle size={14} className="shrink-0 text-neutral-400 dark:text-white/50" /><span className="flex-1">Browse plugins…</span>
        <ExternalLink size={12} aria-hidden="true" className="text-neutral-400 dark:text-white/40" />
      </a>}
      {/* Private uploads are for accounts with developer access. */}
      {catalog.developer && <Button type="button" variant="plain" size="row" className={overlayRowClass} onClick={() => open({ kind: 'manager' })}>
        <Plus size={14} className="shrink-0 text-neutral-400 dark:text-white/50" /><span>Add plugin…</span>
      </Button>}
    </OverlayMenuSub>
  </div>;
}
