import * as React from 'react';
import type * as Y from 'yjs';
import { Puzzle, X, Trash2, BookOpen, ExternalLink } from 'lucide-react';
import { BUILTIN, hostedPlugins, packageHost, type Descriptor, type PluginCatalog, type PluginView } from './plugin-catalog';
import { PluginFloatingPanel } from './PluginFloatingPanel';
import { getLocalSelection, subscribeLocalSelection } from '@/wasm/collab/local-selection';
import { inspectorSnapshot, type InspectorSnapshot } from './board-inspector-projection';
import { placementModule, validatePlacement, placeClipboard } from './placement';
import { selectModule, selectItems } from './selection';
import { geometryModule, openGeometry } from './board-geometry';
import { createDocumentAPI } from './document-api';
import { sessionIdentity } from '@/lib/session-identity';
import { API_BASE_URL } from '@/lib/config';
import { downloadBytes } from '@/lib/download';
import { verifyPluginAccount } from './verify-account';

interface InspectorHost {
  mountEditorPlugin(container: HTMLElement, options: {
    snapshot(scope: 'selection' | 'board'): InspectorSnapshot; signal: AbortSignal; onDisconnected(): void;
  }): Promise<{ dispose(): void }>;
}
// The confirmation authorizes the operation that matches what is being saved, from a closed table,
// never a method name carried in the request.
const SAVE_METHODS = { text: 'files.save', html: 'files.saveHtml', image: 'files.saveImage' } as const;
type Prompt = {kind:'download';name:string;content:'text'|'html'|'image';bytes:Uint8Array;finish(value:{status:'download-requested'|'cancelled'}):void;signal:AbortSignal;authorize():Promise<void>}
  | { kind: 'file'; extensions: string[]; finish(file: File | null): void }
  | { kind: 'placement'; label: string; sexpr: string; finish(value: { status: string }): void;fail(error:Error):void;signal:AbortSignal;authorize():Promise<void> };

/** Trusted install/permission/file/placement controls stay outside publisher UI. */
export function PluginSidebar({ doc, tool, readOnly, fileName, project, projectFiles, view, onViewChange, catalog }: {
  project?: {id:string;scope:string;name:string};projectFiles?:readonly {path:string}[];
  doc: Y.Doc | null; tool: string; readOnly: boolean; fileName: string;
  view: PluginView; onViewChange(view: PluginView): void; catalog: PluginCatalog;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const zipInput = React.useRef<HTMLInputElement>(null), folderInput = React.useRef<HTMLInputElement>(null);
  const selection = React.useSyncExternalStore(subscribeLocalSelection, getLocalSelection);
  const [attempt, restart] = React.useReducer((n: number) => n + 1, 0);
  const { plugins, permissions, refresh } = catalog;
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const open = view?.kind === 'manager';
  const selected = view?.kind === 'plugin' ? view.id : '';
  const onClose = () => onViewChange(null);
  const openPlugin = (id: string) => { setNotice(''); onViewChange({ kind: 'plugin', id }); };
  const [candidate, setCandidate] = React.useState<Descriptor | null>(null);
  const [notice, setNotice] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const placing = React.useRef(false);
  const [placementBusy, setPlacementBusy] = React.useState(false);
  const [prompt, setPrompt] = React.useState<Prompt | null>(null);
  const promptRef = React.useRef<Prompt | null>(null);
  const active = plugins.find(plugin => plugin.manifest.id === selected);
  const compatible = (plugin: Descriptor) => plugin.manifest.surfaces.includes('editor:' + tool);
  React.useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  React.useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, [open]);
  React.useEffect(() => { setNotice(''); }, [selected, open]);
  React.useEffect(() => {
    if (selected === BUILTIN && tool !== 'pcbnew' || active && !compatible(active)) onViewChange(null);
  }, [selected, active?.digest, tool, onViewChange]);

  function requestUser<T>(signal: AbortSignal, make: (finish: (value: T) => void, fail:(error:Error)=>void) => Prompt): Promise<T> {
    if (promptRef.current) return Promise.reject(new Error('Another host interaction is pending'));
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const clear = () => { signal.removeEventListener('abort', abort); promptRef.current = null; setPrompt(null); };
      const abort = () => { clear(); reject(new Error('Plugin stopped')); };
      const next = make(value => { if (signal.aborted) return; clear(); resolve(value); },error=>{clear();reject(error);});
      promptRef.current = next; setPrompt(next); signal.addEventListener('abort', abort, { once: true });
    });
  }
  React.useEffect(() => {
    if (active?.enabled===false) {setStatus('Plugin disabled');return;}
    if (!selected || !doc || !container.current || (!active && selected !== BUILTIN)) return;
    const target = container.current, abort = new AbortController();
    let instance: { dispose(): void } | undefined, revision = 1;
    const changed = () => { revision++; }; doc.on('update', changed);
    setStatus('Starting plugin…');
    const fail = (message: string) => { if (!abort.signal.aborted) {setStatus(message);abort.abort();} };
    void (async () => {
      if (selected === BUILTIN) {
        if (tool !== 'pcbnew') return;
        const url = (import.meta.env.VITE_PLUGIN_RUNTIME_BASE ?? '/plugin-runtime/') + 'editor-host.js';
        const host: InspectorHost = await import(/* @vite-ignore */ url);
        if (abort.signal.aborted) return;
        instance = await host.mountEditorPlugin(target, {
          signal: abort.signal, snapshot: scope => inspectorSnapshot(doc, getLocalSelection().uuids, scope, revision),
          onDisconnected: () => fail('Plugin stopped. Restart to reconnect.'),
        });
      } else if (active) {
        const host = await packageHost(); if (abort.signal.aborted) return;
        const account = sessionIdentity()?.slug ?? null;
        const authorize = () => account ? verifyPluginAccount(API_BASE_URL, account, abort.signal) : Promise.resolve();
        let authorizeOperation:(method:string)=>Promise<void> = async()=>{if(hostedPlugins)throw new Error('Plugin is still starting');await authorize();};
        const documents = project ? createDocumentAPI({doc,project,fileName,files:projectFiles ?? [],signal:abort.signal,
          selection:()=>getLocalSelection().uuids,subscribeSelection:subscribeLocalSelection,geometry:openGeometry}) : undefined;
        instance = await host.mountPackagePlugin(target, {
          plugin: active, signal: abort.signal, documents, authorize,
          onAuthorizationReady:check=>{authorizeOperation=check;},
          storageBinding: () => {
            const user=sessionIdentity()?.slug;
            return user && project ? JSON.stringify([API_BASE_URL,user,project.scope,project.id]) : null;
          },
          saveFile: (proposal, signal) => requestUser<{status:'download-requested'|'cancelled'}>(signal,finish=>({kind:'download',name:proposal.name,content:proposal.kind,bytes:proposal.bytes,finish,signal,authorize:()=>authorizeOperation(SAVE_METHODS[proposal.kind])})),
          context: () => ({ tool, fileName, readOnly, canSelectItems: !!selectModule(), canReadGeometry: tool === 'pcbnew' && !!geometryModule(), canPlaceItems: !readOnly && !!placementModule() && (!hostedPlugins || tool==='eeschema' && placementModule()?.kicadPluginPlacementVersion?.()===1) }),
          selectItems: ids => selectItems(ids),
          chooseFile: (extensions, signal) => requestUser<File | null>(signal, finish => ({ kind: 'file', extensions, finish })),
          requestPlacement: (proposal, signal) => {
            if (readOnly) throw new Error('This document is read-only');
            validatePlacement(proposal.sexpr, tool);
            return requestUser<{ status: string }>(signal, (finish,fail) => ({ kind: 'placement', ...proposal, finish, fail, signal, authorize:()=>authorizeOperation('editor.requestPlacement') }));
          },
          onDisconnected: fail,
        });
      }
      if (abort.signal.aborted) instance?.dispose();
      else setStatus(selected === BUILTIN ? 'Read only · Current board' : hostedPlugins ? 'Private plugin · Signed in' : 'Local development plugin');
    })().catch(error => fail(error instanceof Error ? error.message : 'Plugin could not start'));
    return () => { abort.abort(); instance?.dispose(); doc.off('update', changed); };
  }, [doc, fileName, tool, readOnly, attempt, selected, active?.digest, active?.generation, active?.enabled, project?.id, project?.scope, project?.name, projectFiles]);

  const prepare = async (files: File[], zip: boolean) => {
    setBusy(true); setNotice(''); setCandidate(null);
    try { setCandidate(await (await packageHost()).preparePlugin(files, zip)); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!candidate) return; setBusy(true);
    const installationView = view;
    try {
      await (await packageHost()).installPlugin(candidate); await refresh();
      if (viewRef.current === installationView) {
        if (compatible(candidate)) { openPlugin(candidate.manifest.id); restart(); }
        else setNotice('Installed. Open a compatible editor to use this plugin.');
      }
      setCandidate(null);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };
  const remove = async (plugin: Descriptor) => {
    setBusy(true);
    try { await (await packageHost()).removePlugin(plugin.pluginId ?? plugin.manifest.id); await refresh(); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const place = async () => {
    if (prompt?.kind !== 'placement' || placing.current) return;
    placing.current = true; setPlacementBusy(true);
    try {
      await prompt.authorize();prompt.signal.throwIfAborted();if(promptRef.current!==prompt)return;
      if (readOnly) throw new Error('This document is read-only');
      if(hostedPlugins){
        const result=await placeClipboard(prompt.sexpr,tool,prompt.signal,{beforeNative:async()=>{
          await prompt.authorize();prompt.signal.throwIfAborted();
          if(promptRef.current!==prompt)throw new Error('Placement superseded');
          setNotice('Move onto the canvas and click to place. Esc cancels.');
        }});
        prompt.finish(result);setNotice(result.status==='placed'?'Symbol placed. Undo removes it.':'Placement cancelled.');return;
      }
      validatePlacement(prompt.sexpr, tool);
      const mod = placementModule(); if (!mod || mod.kicadOpenFileBusy?.()) throw new Error('The editor is not ready for placement');
      const result = JSON.parse(await mod.kicadPlaceImportedItem(prompt.sexpr));
      if (!result.ok) throw new Error(result.error ?? 'Placement was refused');
      prompt.finish({ status: 'queued' });
      setNotice('Move onto the canvas and click to place. Esc cancels; Undo removes a placed item.');
    } catch (error) { const failure=error instanceof Error?error:new Error('Placement failed');setNotice(failure.message);prompt.fail(failure); }
    finally { placing.current = false; setPlacementBusy(false); }
  };
  const [resetCandidate,setResetCandidate]=React.useState<Descriptor|null>(null);
  const button = 'rounded border border-neutral-300 px-2 py-1.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10';
  const title = selected === BUILTIN ? 'Board Inspector' : active?.manifest.name ?? 'Plugin unavailable';
  const panelStorageKey = 'pcbjam:plugin-panel-layout:' + JSON.stringify([API_BASE_URL, sessionIdentity()?.slug ?? null, active?.pluginId ?? selected]);
  return <>
    {open && <aside aria-label="Plugins sidebar" className="absolute inset-y-0 right-0 z-[55] flex flex-col border-l border-black/10 bg-white text-neutral-900 shadow-2xl dark:border-white/15 dark:bg-neutral-950 dark:text-white" style={{ width: 'min(360px, 90vw)' }}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-black/10 px-4 dark:border-white/10">
        <Puzzle size={17} className="text-sky-500" /><h2 className="flex-1 text-sm font-semibold">Plugins</h2>
        <button type="button" title="Close plugins" aria-label="Close plugins" onClick={onClose} className="rounded p-2 hover:bg-black/5 dark:hover:bg-white/10"><X size={17} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-xs">
        <a href="/plugin-guide/" target="_blank" rel="noopener noreferrer" className="mb-4 flex w-fit items-center gap-1.5 rounded text-sky-600 hover:underline dark:text-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"><BookOpen size={14} /> Developer guide <ExternalLink size={12} aria-hidden="true" /></a>
        <h3 className="text-sm font-semibold">Add a plugin</h3>
        <p className="mt-1 text-neutral-500 dark:text-white/60">Choose a built plugin ZIP or folder. Review its permissions before installing.</p>
        <div className="mt-3 flex gap-2">
          <button className={button} disabled={busy} onClick={() => zipInput.current?.click()}>Install ZIP</button>
          <button className={button} disabled={busy} onClick={() => folderInput.current?.click()}>Install folder</button>
          <input ref={zipInput} type="file" accept=".zip" aria-label="Plugin ZIP" className="hidden" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void prepare(files, true); }} />
          <input ref={folderInput} type="file" multiple aria-label="Plugin folder" className="hidden" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void prepare(files, false); }} />
        </div>
        {candidate && <section aria-label="Review plugin permissions" className="mt-4 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3">
          <h3 className="font-semibold">Install {candidate.manifest.name} {candidate.manifest.version}?</h3>
          <p className="mt-2">{candidate.manifest.description}</p>
          <p className="mt-2 text-amber-700 dark:text-amber-200">{hostedPlugins ? "Private upload · Publisher not verified" : "Local package · Publisher not verified"}</p>
          <ul className="my-2 list-disc space-y-1 pl-4">{candidate.manifest.permissions.map(permission => <li key={permission}>{permissions[permission] ?? permission}</li>)}</ul>
          <p className="mb-3 text-neutral-500 dark:text-white/60">Install only code you trust. Custom UI receives the data returned by its plugin logic.</p>
          {candidate.backends?.map(backend=><div key={backend.endpoint} className="my-3 rounded border border-amber-500/40 p-2">
            <p className="break-all font-semibold">{backend.origin}</p>
            <p>{backend.methods.join(', ')}: {backend.paths.join(', ')}</p>
            <p>This plugin can send data it is allowed to read to this backend.</p>
            <p>{backend.auth==='pcbjam-user'?'The backend can recognize you using a stable ID unique to this plugin. Your email and PCBJam account ID are not shared.':'No PCBJam identity is attached.'}</p>
            <p>{backend.ready?'Approved by PCBJam':backend.status==='approved'?'Awaiting PCBJam setup or renewed domain verification.':'Not ready: '+backend.status+' — ask PCBJam to review this backend.'}</p>
            <p className="mt-1 break-all text-[10px]">Plugin: {candidate.pluginId}</p>
          </div>)}
          <button className={button} disabled={busy || candidate.backends?.some(b=>!b.ready)} onClick={() => void install()}>Install plugin</button>{' '}<button className={button} disabled={busy} onClick={() => setCandidate(null)}>Cancel</button>
        </section>}
        {resetCandidate && <section aria-label="Reset plugin data" className="mt-4 rounded border border-amber-500 p-3">
          <p>Reset local data for {resetCandidate.manifest.name}? Data is cleared in this browser and in other browsers the next time they connect.</p>
          <button className={button} disabled={busy} onClick={async()=>{setBusy(true);try{await (await packageHost()).resetPluginData(resetCandidate.pluginId!);await refresh();setResetCandidate(null);}catch(error){setNotice((error as Error).message);}finally{setBusy(false);}}}>Reset plugin data</button>{' '}
          <button className={button} onClick={()=>setResetCandidate(null)}>Cancel</button>
        </section>}
        <section aria-label="Installed plugins" className="mt-6 border-t border-black/10 pt-4 dark:border-white/10">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">Installed plugins</h3>
          {!plugins.length && <p className="text-neutral-500 dark:text-white/60">{catalog.loaded ? 'No added plugins yet.' : 'Loading plugins…'}</p>}
          {plugins.map(plugin => <div key={plugin.manifest.id} className="flex items-center gap-2 border-b border-black/5 py-3 last:border-0 dark:border-white/5">
            <div className="min-w-0 flex-1"><p className="truncate font-medium" title={plugin.manifest.name}>{plugin.manifest.name}</p><p className="mt-1 text-neutral-500 dark:text-white/50">{plugin.manifest.version}{compatible(plugin) ? '' : ' · Available in another editor'}</p></div>
            <button className={button} disabled={busy || !compatible(plugin) || plugin.enabled===false} onClick={() => openPlugin(plugin.manifest.id)}>Open</button>
            {hostedPlugins && <button className={button} disabled={busy} onClick={async()=>{setBusy(true);try{await (await packageHost()).setPluginEnabled(plugin,plugin.enabled===false);await refresh();}catch(error){setNotice((error as Error).message);}finally{setBusy(false);}}}>{plugin.enabled===false?'Enable':'Disable'}</button>}
            {hostedPlugins && <button className={button} disabled={busy} onClick={()=>setResetCandidate(plugin)}>Reset data</button>}
            <button className={button} disabled={busy} onClick={() => void remove(plugin)} title={'Remove ' + plugin.manifest.name} aria-label={'Remove ' + plugin.manifest.name}><Trash2 size={14} /></button>
          </div>)}
        </section>
        {(notice || catalog.error) && <p role="alert" className="mt-3 text-amber-700 dark:text-amber-200">{notice || catalog.error}</p>}
      </div>
    </aside>}
    {selected && <PluginFloatingPanel key={panelStorageKey} storageKey={panelStorageKey} preferredSize={active?.manifest.uiSize} title={title} forceExpanded={!!prompt} onRestart={restart} onClose={onClose}>
      <div className="max-h-[55%] shrink-0 overflow-y-auto border-b border-black/10 px-3 py-2 text-xs dark:border-white/10">
        <p className="truncate text-neutral-500 dark:text-white/60" title={fileName}>{fileName} · {selection.uuids.length} selected</p>
      {prompt?.kind === 'file' && <section aria-label="Plugin file request" className="mt-3 rounded border border-sky-500/40 p-3">
        <p className="mb-2">{active?.manifest.name} wants a file you choose.</p>
        <input type="file" aria-label="Choose file for plugin" accept={prompt.extensions.join(',')} className="max-w-full text-xs" onChange={event => { const file = event.target.files?.[0]; if (file) prompt.finish(file); }} />
        <button className={button + ' mt-2'} onClick={() => prompt.finish(null)}>Cancel file request</button>
      </section>}
      {prompt?.kind === 'download' && <section aria-label="Confirm plugin download" className="mt-3 rounded border border-sky-500/40 p-3">
        <p>{active?.manifest.name} requests a download of <strong>{prompt.name}</strong>.</p>
        <p className="my-2 text-neutral-500 dark:text-white/60">{prompt.bytes.length.toLocaleString()} bytes. This downloads a file; it does not save changes to your project.</p>
        {prompt.content === 'html' && <p className="my-2 text-neutral-500 dark:text-white/60">This is a web page containing code from this plugin and data from your design. The code runs when you open the file. PCBJam blocks the page from loading or sending anything over the network.</p>}
        <button className={button} disabled={placementBusy} onClick={async () => {
          if(placing.current)return;placing.current=true;setPlacementBusy(true);
          try {await prompt.authorize();prompt.signal.throwIfAborted();if(promptRef.current!==prompt)return;
            downloadBytes(prompt.name,prompt.bytes);prompt.finish({status:'download-requested'});
          }catch(error){setNotice((error as Error).message);}finally{placing.current=false;setPlacementBusy(false);}
        }}>Download file</button>{' '}
        <button className={button} disabled={placementBusy} onClick={()=>prompt.finish({status:'cancelled'})}>Cancel download</button>
      </section>}
      {prompt?.kind === 'placement' && <section aria-label="Confirm plugin placement" className="mt-3 rounded border border-sky-500/40 p-3">
        <p>{active?.manifest.name} requests placement of <strong>{prompt.label}</strong>.</p>
        <p className="my-2 text-neutral-500 dark:text-white/60">This starts the editor's placement tool. You choose the position on the canvas.</p>
        <details className="mb-2"><summary>View clipboard data</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">{prompt.sexpr}</pre></details>
        <button className={button} disabled={placementBusy} onClick={() => void place()}>Place on canvas</button>{' '}<button className={button} disabled={placementBusy} onClick={() => prompt.finish({ status: 'cancelled' })}>Cancel placement</button>
      </section>}
        {notice && <p role="alert" className="mt-3 text-amber-700 dark:text-amber-200">{notice}</p>}
      </div>
      <div ref={container} className="min-h-0 flex-1" />
      <footer className="shrink-0 border-t border-black/10 px-7 py-2 text-[11px] text-neutral-500 dark:border-white/10 dark:text-white/50" role="status">{!doc ? 'Waiting for the editor document…' : status || 'Starting plugin…'}</footer>
    </PluginFloatingPanel>}
  </>;
}
