import * as React from 'react';
import { GraduationCap, Loader2 } from 'lucide-react';
import { OverlayMenuSection, overlayRowClass, useCloseOverlayMenu } from '@/components/OverlayMenu';
import { hostedPlugins, pluginKey } from './plugin-catalog';
import { useSessionFeature } from '@/lib/session-identity';
import type { PluginMenuProps } from './PluginMenu';
import { listTutorials, startTutorial, tutorialUrl, TUTORIAL_LEVEL, type Tutorial } from './tutorials';
import { Tip } from "@pcbjam/ui";

/** "Open here": sized to its label. The shared row class is full width and would cover the title. */
const openHereClass =
  'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-neutral-800 transition-colors hover:bg-black/5 ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-black/30 disabled:opacity-60 ' +
  'dark:text-white/90 dark:hover:bg-white/10 dark:focus-visible:ring-white/40';

/**
 * The Session menu's Tutorials (overlay-system 0005): a row starts the tutorial in a new project;
 * "Open here" runs it in this one when the account already has it. Hidden where the backend's
 * `tutorials` toggle is off for this session — `plugins` is not needed (plugins 0021).
 */
export function TutorialMenu({ tool, catalog, onViewChange }: PluginMenuProps) {
  const closeMenu = useCloseOverlayMenu();
  const [list, setList] = React.useState<Tutorial[] | null | undefined>(undefined);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const on = useSessionFeature('tutorials') && hostedPlugins;
  React.useEffect(() => {
    if (!on) return;
    let live = true;
    listTutorials().then(l => { if (live) setList(l); }, () => { if (live) setList(null); });
    return () => { live = false; };
  }, [on]);
  if (!on || list === null || (list && !list.length)) return null;
  const start = async (tutorial: Tutorial) => {
    setBusy(tutorial.slug);
    setError('');
    try {
      window.location.assign(tutorialUrl(await startTutorial(tutorial.slug)));
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  };
  return <OverlayMenuSection label="Tutorials">
    <div data-testid="overlay-menu-tutorials" className="flex flex-col gap-1">
      {list === undefined && <p className="px-2 py-1 text-xs text-neutral-500 dark:text-white/50">Loading tutorials…</p>}
      {list?.map(tutorial => {
        const here = catalog.plugins.find(p => p.pluginId === tutorial.pluginId && p.manifest.surfaces.includes('editor:' + tool));
        return <div key={tutorial.slug} className="flex items-center gap-1">
          <Tip content={`${tutorial.summary ? tutorial.summary + ' · ' : ''}Starts in a new project`}>
            <button type="button" className={overlayRowClass + ' min-w-0 flex-1 disabled:opacity-60'} disabled={!!busy} onClick={() => void start(tutorial)}>
              {busy === tutorial.slug
                ? <Loader2 size={14} className="shrink-0 animate-spin text-neutral-400 dark:text-white/50" />
                : <GraduationCap size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{tutorial.title}</span>
                <span className="truncate text-[10px] text-neutral-400 dark:text-white/40">{TUTORIAL_LEVEL[tutorial.level] ?? tutorial.level} · {tutorial.minutes} min</span>
              </span>
            </button>
          </Tip>
          {here && <button type="button" className={openHereClass} disabled={!!busy}
            aria-label={`Open ${tutorial.title} in this project`}
            onClick={() => { onViewChange({ kind: 'plugin', id: pluginKey(here) }); closeMenu(); }}>Open here</button>}
        </div>;
      })}
      {error && <p role="status" className="px-2 py-1 text-xs text-amber-700 dark:text-amber-200">{error}</p>}
    </div>
  </OverlayMenuSection>;
}
