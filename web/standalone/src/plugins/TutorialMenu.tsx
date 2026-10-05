import * as React from 'react';
import { GraduationCap, Loader2 } from 'lucide-react';
import { OverlayMenuSection, overlayRowClass, useCloseOverlayMenu } from '@/components/OverlayMenu';
import { hostedPlugins, pluginKey } from './plugin-catalog';
import { useSessionFeature } from '@/lib/session-identity';
import type { PluginMenuProps } from './PluginMenu';
import { listTutorials, startTutorial, tutorialUrl, TUTORIAL_LEVEL, type Tutorial } from './tutorials';

/**
 * The Session menu's Tutorials (overlay-system 0005): a row starts the tutorial in a new project;
 * "Open here" runs it in this one when the account already has it. Hidden where the backend's
 * `tutorials` toggle is off for this session (it requires `plugins`).
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
          <button type="button" className={overlayRowClass + ' min-w-0 flex-1 disabled:opacity-60'} disabled={!!busy}
            title={`${tutorial.summary ? tutorial.summary + ' · ' : ''}Starts in a new project`} onClick={() => void start(tutorial)}>
            {busy === tutorial.slug
              ? <Loader2 size={14} className="shrink-0 animate-spin text-neutral-400 dark:text-white/50" />
              : <GraduationCap size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />}
            <span className="min-w-0 flex-1 truncate">{tutorial.title}</span>
            <span className="shrink-0 text-[10px] text-neutral-400 dark:text-white/40">{TUTORIAL_LEVEL[tutorial.level] ?? tutorial.level} · {tutorial.minutes} min</span>
          </button>
          {here && <button type="button" className={overlayRowClass + ' shrink-0 text-xs'} disabled={!!busy}
            aria-label={`Open ${tutorial.title} in this project`}
            onClick={() => { onViewChange({ kind: 'plugin', id: pluginKey(here) }); closeMenu(); }}>Open here</button>}
        </div>;
      })}
      {error && <p role="status" className="px-2 py-1 text-xs text-amber-700 dark:text-amber-200">{error}</p>}
    </div>
  </OverlayMenuSection>;
}
