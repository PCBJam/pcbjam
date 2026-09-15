import * as React from 'react';
import type * as Y from 'yjs';
import { Puzzle, RotateCcw, X, Trash2, BookOpen, ExternalLink } from 'lucide-react';
import { getLocalSelection, subscribeLocalSelection } from '@/wasm/collab/local-selection';
import { inspectorSnapshot, type InspectorSnapshot } from './board-inspector-projection';
import { placementModule, validatePlacement } from './placement';
import { createDocumentAPI } from './document-api';
import { sessionIdentity } from '@/lib/session-identity';
import { API_BASE_URL } from '@/lib/config';
import { downloadBytes } from '@/lib/download';
import { verifyPluginAccount } from './verify-account';

interface Descriptor { digest: string; manifest: { id: string; name: string; version: string; description: string; surfaces: string[]; permissions: string[] } }
interface PackageHost {
  listPlugins(): Promise<{ plugins: Descriptor[]; permissions: Record<string, string> }>;
  preparePlugin(files: File[], zip: boolean): Promise<Descriptor>;
  installPlugin(digest: string): Promise<Descriptor>;
  removePlugin(id: string): Promise<void>;
  mountPackagePlugin(container: HTMLElement, options: {
    plugin: Descriptor; signal: AbortSignal;
    context(): { tool: string; fileName: string; readOnly: boolean; canPlaceItems: boolean };
    chooseFile(extensions: string[], signal: AbortSignal): Promise<File | null>;
    requestPlacement(proposal: { label: string; sexpr: string }, signal: AbortSignal): Promise<{ status: string }>;
    onDisconnected(message: string): void;
    documents?: ReturnType<typeof createDocumentAPI>;
    storageBinding?(): string | null;
    authorize?(signal: AbortSignal): Promise<void>;
    saveFile?(proposal:{name:string;text:string}, signal:AbortSignal):Promise<{status:'download-requested'|'cancelled'}>;
  }): Promise<{ dispose(): void }>;
}
interface InspectorHost {
  mountEditorPlugin(container: HTMLElement, options: {
    snapshot(scope: 'selection' | 'board'): InspectorSnapshot; signal: AbortSignal; onDisconnected(): void;
  }): Promise<{ dispose(): void }>;
}
type Prompt = {kind:'download';name:string;text:string;finish(value:{status:'download-requested'|'cancelled'}):void;signal:AbortSignal;authorize():Promise<void>}
  | { kind: 'file'; extensions: string[]; finish(file: File | null): void }
  | { kind: 'placement'; label: string; sexpr: string; finish(value: { status: string }): void;signal:AbortSignal;authorize():Promise<void> };
const BUILTIN = '__board-inspector';
const packageHost = (): Promise<PackageHost> => { const url = '/plugin-runtime/package-host.js'; return import(/* @vite-ignore */ url); };

/** Trusted install/permission/file/placement controls stay outside publisher UI. */
export function PluginSidebar({ doc, tool, readOnly, fileName, project, projectFiles, open, onOpen, onClose }: {
  project?: {id:string;scope:string;name:string};projectFiles?:readonly {path:string}[];
  doc: Y.Doc | null; tool: string; readOnly: boolean; fileName: string; open: boolean; onOpen(): void; onClose(): void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const zipInput = React.useRef<HTMLInputElement>(null), folderInput = React.useRef<HTMLInputElement>(null);
  const selection = React.useSyncExternalStore(subscribeLocalSelection, getLocalSelection);
  const [attempt, restart] = React.useReducer((n: number) => n + 1, 0);
  const [plugins, setPlugins] = React.useState<Descriptor[]>([]);
  const [permissions, setPermissions] = React.useState<Record<string, string>>({});
  const [selected, setSelected] = React.useState(tool === 'pcbnew' ? BUILTIN : '');
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
  const refresh = React.useCallback(async () => {
    const result = await (await packageHost()).listPlugins();
    setPlugins(result.plugins); setPermissions(result.permissions);
  }, []);
  React.useEffect(() => { if (open) void refresh().catch(() => setNotice('Start the plugin development server to install ZIPs or folders.')); }, [open, refresh]);
  React.useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, [open]);

  function requestUser<T>(signal: AbortSignal, make: (finish: (value: T) => void) => Prompt): Promise<T> {
    if (promptRef.current) return Promise.reject(new Error('Another host interaction is pending'));
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const clear = () => { signal.removeEventListener('abort', abort); promptRef.current = null; setPrompt(null); };
      const abort = () => { clear(); reject(new Error('Plugin stopped')); };
      const next = make(value => { if (signal.aborted) return; clear(); resolve(value); });
      promptRef.current = next; setPrompt(next); signal.addEventListener('abort', abort, { once: true });
    });
  }
  React.useEffect(() => {
    if (!open || !doc || !container.current || (!active && selected !== BUILTIN)) return;
    const target = container.current, abort = new AbortController();
    let instance: { dispose(): void } | undefined, revision = 1;
    const changed = () => { revision++; }; doc.on('update', changed);
    setStatus('Starting plugin…');
    const fail = (message: string) => { if (!abort.signal.aborted) {setStatus(message);abort.abort();} };
    void (async () => {
      if (selected === BUILTIN) {
        if (tool !== 'pcbnew') return;
        const url = '/plugin-runtime/editor-host.js';
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
        const documents = project ? createDocumentAPI({doc,project,fileName,files:projectFiles ?? [],signal:abort.signal,
          selection:()=>getLocalSelection().uuids,subscribeSelection:subscribeLocalSelection}) : undefined;
        instance = await host.mountPackagePlugin(target, {
          plugin: active, signal: abort.signal, documents, authorize,
          storageBinding: () => {
            const user=sessionIdentity()?.slug;
            return user && project ? JSON.stringify([API_BASE_URL,user,project.scope,project.id]) : null;
          },
          saveFile: (proposal, signal) => requestUser<{status:'download-requested'|'cancelled'}>(signal,finish=>({kind:'download',...proposal,finish,signal,authorize})),
          context: () => ({ tool, fileName, readOnly, canPlaceItems: !readOnly && !!placementModule() }),
          chooseFile: (extensions, signal) => requestUser<File | null>(signal, finish => ({ kind: 'file', extensions, finish })),
          requestPlacement: (proposal, signal) => {
            if (readOnly) throw new Error('This document is read-only');
            validatePlacement(proposal.sexpr, tool);
            return requestUser<{ status: string }>(signal, finish => ({ kind: 'placement', ...proposal, finish, signal, authorize }));
          },
          onDisconnected: fail,
        });
      }
      if (abort.signal.aborted) instance?.dispose();
      else setStatus(selected === BUILTIN ? 'Read only · Current board' : 'Local development plugin');
    })().catch(error => fail(error instanceof Error ? error.message : 'Plugin could not start'));
    return () => { abort.abort(); instance?.dispose(); doc.off('update', changed); };
  }, [doc, fileName, tool, readOnly, open, attempt, selected, active?.digest, project?.id, project?.scope, project?.name, projectFiles]);

  const prepare = async (files: File[], zip: boolean) => {
    setBusy(true); setNotice(''); setCandidate(null);
    try { setCandidate(await (await packageHost()).preparePlugin(files, zip)); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!candidate) return; setBusy(true);
    try {
      await (await packageHost()).installPlugin(candidate.digest); await refresh();
      if (compatible(candidate)) { setSelected(candidate.manifest.id); restart(); }
      else setNotice('Installed. Open a compatible editor to use this plugin.');
      setCandidate(null);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!active) return;
    try { await (await packageHost()).removePlugin(active.manifest.id); setSelected(tool === 'pcbnew' ? BUILTIN : ''); await refresh(); }
    catch (error) { setNotice((error as Error).message); }
  };
  const place = async () => {
    if (prompt?.kind !== 'placement' || placing.current) return;
    placing.current = true; setPlacementBusy(true);
    try {
      await prompt.authorize();prompt.signal.throwIfAborted();if(promptRef.current!==prompt)return;
      if (readOnly) throw new Error('This document is read-only');
      validatePlacement(prompt.sexpr, tool);
      const mod = placementModule(); if (!mod || mod.kicadOpenFileBusy?.()) throw new Error('The editor is not ready for placement');
      const result = JSON.parse(await mod.kicadPlaceImportedItem(prompt.sexpr));
      if (!result.ok) throw new Error(result.error ?? 'Placement was refused');
      prompt.finish({ status: 'queued' });
      setNotice('Move onto the canvas and click to place. Esc cancels; Undo removes a placed item.');
    } catch (error) { setNotice((error as Error).message); }
    finally { placing.current = false; setPlacementBusy(false); }
  };
  const button = 'rounded border border-slate-600 px-2 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40';
  if (!open) return <button type="button" onClick={onOpen} title="Open plugins" aria-label="Open plugins" className="absolute right-0 top-28 z-50 flex items-center gap-2 rounded-l-lg border border-r-0 border-slate-600 bg-slate-900 px-3 py-3 text-xs font-medium text-slate-100 shadow-lg"><Puzzle size={16} /> Plugins</button>;
  return <aside aria-label="Plugins sidebar" className="absolute inset-y-0 right-0 z-[55] flex flex-col border-l border-slate-700 bg-[#121a25] text-slate-100 shadow-2xl" style={{ width: 'min(360px, 90vw)' }}>
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-700 px-4">
      <Puzzle size={17} className="text-sky-300" /><h2 className="flex-1 text-sm font-semibold">Plugins</h2>
      <button type="button" title="Restart plugin" aria-label="Restart plugin" onClick={restart} className="rounded p-2 hover:bg-slate-800"><RotateCcw size={15} /></button>
      <button type="button" title="Close plugins" aria-label="Close plugins" onClick={onClose} className="rounded p-2 hover:bg-slate-800"><X size={17} /></button>
    </header>
    <div className="max-h-[55%] shrink-0 overflow-y-auto border-b border-slate-700 px-4 py-3 text-xs">
      <a href="/plugin-dev/guide" target="_blank" rel="noopener noreferrer" className="mb-3 flex w-fit items-center gap-1.5 rounded text-sky-300 hover:text-sky-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" title="Open the plugin developer guide in a new tab"><BookOpen size={14} /> Developer guide <ExternalLink size={12} aria-hidden="true" /></a>
      <p className="truncate text-slate-200" title={fileName}>{fileName}</p>
      <p className="mt-1 text-slate-400">{selection.uuids.length} selected in the editor</p>
      <div className="mt-3 flex gap-2">
        <button className={button} disabled={busy} onClick={() => zipInput.current?.click()}>Install ZIP</button>
        <button className={button} disabled={busy} onClick={() => folderInput.current?.click()}>Install folder</button>
        <input ref={zipInput} type="file" accept=".zip" aria-label="Plugin ZIP" className="hidden" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void prepare(files, true); }} />
        <input ref={folderInput} type="file" multiple aria-label="Plugin folder" className="hidden" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void prepare(files, false); }} />
      </div>
      <div className="mt-3 flex gap-2">
        <select aria-label="Active plugin" value={selected} onChange={event => { setSelected(event.target.value); setNotice(''); }} className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-900 p-2">
          <option value="">Choose a plugin</option>
          {tool === 'pcbnew' && <option value={BUILTIN}>Board Inspector · bundled</option>}
          {plugins.map(plugin => <option key={plugin.manifest.id} value={plugin.manifest.id} disabled={!compatible(plugin)}>{plugin.manifest.name}{compatible(plugin) ? '' : ' · another editor'}</option>)}
        </select>
        {active && <button className={button} onClick={() => void remove()} title="Remove plugin" aria-label="Remove plugin"><Trash2 size={14} /></button>}
      </div>
      {candidate && <section aria-label="Review plugin permissions" className="mt-3 rounded border border-sky-700 bg-slate-900 p-3">
        <h3 className="font-semibold">Install {candidate.manifest.name} {candidate.manifest.version}?</h3>
        <p className="mt-2 text-slate-300">{candidate.manifest.description}</p>
        <p className="mt-2 text-amber-200">Local package · publisher not verified</p>
        <ul className="my-2 list-disc space-y-1 pl-4">{candidate.manifest.permissions.map(permission => <li key={permission}>{permissions[permission] ?? permission}</li>)}</ul>
        <p className="mb-3 text-slate-400">Install only code you trust. Custom UI receives the data returned by its plugin logic.</p>
        <button className={button} disabled={busy} onClick={() => void install()}>Install plugin</button>{' '}<button className={button} onClick={() => setCandidate(null)}>Cancel</button>
      </section>}
      {prompt?.kind === 'file' && <section aria-label="Plugin file request" className="mt-3 rounded border border-sky-700 p-3">
        <p className="mb-2">{active?.manifest.name} wants a file you choose.</p>
        <input type="file" aria-label="Choose file for plugin" accept={prompt.extensions.join(',')} className="max-w-full text-xs" onChange={event => { const file = event.target.files?.[0]; if (file) prompt.finish(file); }} />
        <button className={button + ' mt-2'} onClick={() => prompt.finish(null)}>Cancel file request</button>
      </section>}
      {prompt?.kind === 'download' && <section aria-label="Confirm plugin download" className="mt-3 rounded border border-sky-700 p-3">
        <p>{active?.manifest.name} requests a download of <strong>{prompt.name}</strong>.</p>
        <p className="my-2 text-slate-400">{new TextEncoder().encode(prompt.text).length.toLocaleString()} bytes. This downloads a file; it does not save changes to your project.</p>
        <button className={button} disabled={placementBusy} onClick={async () => {
          if(placing.current)return;placing.current=true;setPlacementBusy(true);
          try {await prompt.authorize();prompt.signal.throwIfAborted();if(promptRef.current!==prompt)return;
            downloadBytes(prompt.name,new TextEncoder().encode(prompt.text));prompt.finish({status:'download-requested'});
          }catch(error){setNotice((error as Error).message);}finally{placing.current=false;setPlacementBusy(false);}
        }}>Download file</button>{' '}
        <button className={button} disabled={placementBusy} onClick={()=>prompt.finish({status:'cancelled'})}>Cancel download</button>
      </section>}
      {prompt?.kind === 'placement' && <section aria-label="Confirm plugin placement" className="mt-3 rounded border border-sky-700 p-3">
        <p>{active?.manifest.name} requests placement of <strong>{prompt.label}</strong>.</p>
        <p className="my-2 text-slate-400">This starts the editor's placement tool. You choose the position on the canvas.</p>
        <details className="mb-2"><summary>View clipboard data</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">{prompt.sexpr}</pre></details>
        <button className={button} disabled={placementBusy} onClick={() => void place()}>Place on canvas</button>{' '}<button className={button} disabled={placementBusy} onClick={() => prompt.finish({ status: 'cancelled' })}>Cancel placement</button>
      </section>}
      {notice && <p role="alert" className="mt-3 text-amber-200">{notice}</p>}
    </div>
    <div ref={container} className="min-h-0 flex-1" />
    {!selected && <p className="px-4 py-4 text-sm text-slate-300">Install a plugin ZIP or folder to get started.</p>}
    <footer className="shrink-0 border-t border-slate-700 px-4 py-3 text-[11px] text-slate-400" role="status">{!doc ? 'Waiting for the editor document…' : status || 'Local development plugins'}</footer>
  </aside>;
}
