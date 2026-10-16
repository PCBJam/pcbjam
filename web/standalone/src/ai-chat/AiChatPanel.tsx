import * as React from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from 'agents/chat/react';
import type { UIMessage } from 'ai';
import { Sparkles, X, Plus, Trash2, History, Square, Send, Wrench, Check, AlertTriangle, Loader2, ArrowDown } from 'lucide-react';
import { Badge, Button, Code, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, Tip, cn } from '@pcbjam/ui';
import { attachEditorBridge, type BridgeSocket } from '@/agent/bridge';
import type { ConfirmUpdatePcb } from '@/agent/executor';
import { AI_CHAT_URL } from '@/lib/config';
import { copySegment, currentCopyRef } from '@/lib/copy-context';
import { approvalOrder } from '@pcbjam/shared';
import { fileHref, otherFile, type PanelAt } from './links';

/**
 * In-editor AI chat (POC). The chat runs server-side, one Durable Object per
 * chat; this panel only renders it. It talks to the chat service over a
 * WebSocket with the session cookie, so the person's identity never passes
 * through here. The same socket carries the editor bridge: the agent's
 * schematic edits on the open file run here, through KiCad (one undo step
 * each), and edits on other files arrive through their document rooms. On a
 * board, an Update PCB that would remove or rewire anything waits for the
 * person's Apply here: the agent cannot answer it.
 *
 * Built on @pcbjam/ui (ui-components 0001): its controls, and theme tokens
 * for every colour, so a brand stylesheet and dark mode restyle it.
 */

interface ChatRow { id: string; title: string; updatedAt: number; file: string }

const MODEL_KEY = 'pcbjam:ai-chat:model';
const modelLabel = (id: string) =>
  id === 'mock' ? 'Scripted (mock)' : id.startsWith('ollama:') ? `${id.slice(7)} (local)` : id;
function rememberedModel(): string | null {
  try { return localStorage.getItem(MODEL_KEY); } catch { return null; }
}
function rememberModel(id: string): void {
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* private window: not remembered */ }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AI_CHAT_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function AiChatPanel({ scope, project, file, tool }: { scope: string; project: string; file: string; tool: string }) {
  const [open, setOpen] = React.useState(false);
  const [chats, setChats] = React.useState<ChatRow[]>([]);
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [initial, setInitial] = React.useState<UIMessage[] | null>(null);
  const [showList, setShowList] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<string[]>([]);
  const [model, setModel] = React.useState<string | null>(null);
  const qs = `scope=${encodeURIComponent(scope)}&project=${encodeURIComponent(project)}`;

  const refresh = React.useCallback(async () => {
    const { chats } = await api<{ chats: ChatRow[] }>(`/chats?${qs}`);
    setChats(chats);
    return chats;
  }, [qs]);

  // Opening a chat = load its history first (the hook gets it as initial
  // messages, which keeps it off React 19's `use()` path), then connect.
  const openChat = React.useCallback(async (id: string) => {
    setError(null); setInitial(null); setChatId(id); setShowList(false);
    try {
      const res = await fetch(`${AI_CHAT_URL}/agents/chat-session/${id}/get-messages`, { credentials: 'include' });
      setInitial(res.ok ? ((await res.json()) as UIMessage[]) : []);
    } catch (e) { setError((e as Error).message); setInitial([]); }
  }, []);

  const newChat = React.useCallback(async () => {
    setError(null);
    try {
      const { chat } = await api<{ chat: ChatRow }>('/chats', { method: 'POST', body: JSON.stringify({ scope, project, file, copy: currentCopyRef()?.id }) });
      setChats((c) => [chat, ...c]);
      setChatId(chat.id); setInitial([]); setShowList(false);
    } catch (e) { setError((e as Error).message); }
  }, [scope, project, file]);

  const remove = async (id: string) => {
    try {
      await api(`/chats/${id}`, { method: 'DELETE' });
      const rest = await refresh();
      if (id === chatId) { if (rest[0]) void openChat(rest[0].id); else { setChatId(null); setInitial(null); } }
    } catch (e) { setError((e as Error).message); }
  };

  // The models this deploy offers; the last one picked is remembered per browser.
  React.useEffect(() => {
    if (!open || models.length) return;
    void api<{ models: string[] }>('/models').then(({ models }) => {
      setModels(models);
      const last = rememberedModel();
      setModel(last && models.includes(last) ? last : models[0] ?? null);
    }).catch(() => {});
  }, [open, models.length]);

  // First open: resume the latest chat on this project, or start one.
  React.useEffect(() => {
    if (!open || chatId) return;
    void refresh().then((list) => (list[0] ? openChat(list[0].id) : newChat())).catch((e) => setError((e as Error).message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = chats.find((c) => c.id === chatId)?.title ?? 'New chat';

  if (!open) {
    return (
      <div className="absolute bottom-12 right-4 z-[54]">
        <Tip content="AI chat">
          <Button type="button" aria-label="Open AI chat" onClick={() => setOpen(true)} size="icon" className="rounded-full shadow-lg">
            <Sparkles />
          </Button>
        </Tip>
      </div>
    );
  }

  return (
    <aside aria-label="AI chat" data-overlay-obstacle className="absolute inset-y-0 right-0 z-[56] flex flex-col border-l border-border bg-background text-foreground shadow-2xl" style={{ width: 'min(400px, 92vw)' }}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
        <Sparkles size={17} className="shrink-0 text-primary" />
        <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold" title={title}>{title}</h2>
        <Tip content="Chats"><Button type="button" aria-label="Chats" variant="ghost" size="icon-xs" className="p-2" onClick={() => { setShowList((s) => !s); void refresh(); }}><History size={16} /></Button></Tip>
        <Tip content="New chat"><Button type="button" aria-label="New chat" variant="ghost" size="icon-xs" className="p-2" onClick={() => void newChat()}><Plus size={16} /></Button></Tip>
        <Tip content="Close"><Button type="button" aria-label="Close AI chat" variant="ghost" size="icon-xs" className="p-2" onClick={() => setOpen(false)}><X size={16} /></Button></Tip>
      </header>

      {showList && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-border py-1 text-xs" aria-label="Chat list">
          {chats.length === 0 && <p className="px-4 py-2 text-muted-foreground">No chats on this project yet.</p>}
          {chats.map((c) => (
            <div key={c.id} className={cn('flex items-center gap-2 px-3', c.id === chatId && 'bg-accent text-accent-foreground')}>
              <Button type="button" variant="ghost" size="row" className="min-w-0 flex-1 truncate rounded-md px-1 py-1.5 text-xs" onClick={() => void openChat(c.id)}>
                {c.title}
              </Button>
              <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(c.updatedAt).toLocaleDateString()}</span>
              <Tip content="Delete chat"><Button type="button" aria-label={`Delete ${c.title}`} variant="ghost" size="icon-xs" className="p-1 text-muted-foreground" onClick={() => void remove(c.id)}><Trash2 size={13} /></Button></Tip>
            </div>
          ))}
        </div>
      )}

      {error && <p role="alert" className="m-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      {chatId && initial
        ? <ChatView key={chatId} chatId={chatId} initial={initial} scope={scope} project={project} file={file} tool={tool} onTurnEnd={() => void refresh().catch(() => {})}
            model={model} models={models} onModel={(m) => { setModel(m); rememberModel(m); }} />
        : <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 size={16} className="mr-2 animate-spin" />Loading chat…</div>}
    </aside>
  );
}

function ChatView({ chatId, initial, scope, project, file, tool, onTurnEnd, model, models, onModel }: {
  chatId: string; initial: UIMessage[]; scope: string; project: string; file: string; tool: string; onTurnEnd: () => void;
  model: string | null; models: string[]; onModel: (model: string) => void;
}) {
  // Deployed, the chat sits under the API's host at a path (`…/ai-chat`, ai-chat 0006 A4).
  const chatUrl = new URL(AI_CHAT_URL!);
  const prefix = chatUrl.pathname.replace(/^\/+|\/+$/g, '');
  const agent = useAgent({
    agent: 'chat-session',
    name: chatId,
    host: chatUrl.host,
    protocol: chatUrl.protocol === 'https:' ? 'wss' : 'ws',
    ...(prefix ? { basePath: `${prefix}/agents/chat-session/${chatId}` } : {}),
  } as never);
  // An Update PCB waiting for the person's OK (step 5b); Stop withdraws the question. Each
  // question is its own card (keyed), so a click meant for one never lands on the next.
  const [approval, setApproval] = React.useState<{ id: number; changes: string[]; answer: (ok: boolean) => void } | null>(null);
  const asked = React.useRef(0);
  const confirm = React.useCallback<ConfirmUpdatePcb>((changes, signal) => new Promise<boolean>((resolve) => {
    // Already stopped: an abort listener added now would never fire, and the card would outlive its run.
    if (signal.aborted) { resolve(false); return; }
    const id = ++asked.current;
    const answer = (ok: boolean) => {
      setApproval((shown) => (shown?.id === id ? null : shown));
      signal.removeEventListener('abort', stopped);
      resolve(ok);
    };
    const stopped = () => answer(false);
    signal.addEventListener('abort', stopped, { once: true });
    setApproval({ id, changes, answer });
  }), []);
  // Closing the panel or switching chats answers an open card "no": the run must not wait for ever.
  const approvalRef = React.useRef(approval);
  approvalRef.current = approval;
  React.useEffect(() => () => approvalRef.current?.answer(false), []);
  // The editor bridge (ai-chat 0003 step 5): the chat's schematic tools carry out their
  // edits on this tab's file here, with KiCad (one undo step each). Re-attached when the
  // shown file or editor changes.
  React.useEffect(
    () => attachEditorBridge(agent as unknown as BridgeSocket, () => ({ scope, project, copy: copySegment(), file, tool }), undefined, confirm),
    [agent, scope, project, file, tool, confirm],
  );
  const fileRef = React.useRef(file);
  fileRef.current = file;
  const toolRef = React.useRef(tool);
  toolRef.current = tool;
  const modelRef = React.useRef(model);
  modelRef.current = model;
  const { messages, sendMessage, status, stop } = useAgentChat({
    agent: agent as never,
    getInitialMessages: null,
    messages: initial,
    credentials: 'include',
    // The file open right now: the agent works on what the person looks at.
    // `editor`: which editor this tab shows (the agent's edits on its file run here, step 5's bridge).
    // `copy`: this tab's working copy, the chat's tools default to it (ai-chat 0006 A3).
    body: () => ({ file: fileRef.current, copy: currentCopyRef()?.id, editor: { tool: toolRef.current }, ...(modelRef.current ? { model: modelRef.current } : {}) }),
    // A finished turn may have named the chat (its first message): re-read the list.
    onTurnEnd,
  });
  const [draft, setDraft] = React.useState('');
  const busy = status === 'submitted' || status === 'streaming';

  // Follow the stream only while the person is at the bottom: scrolling up to
  // read stops it; scrolling back down, "Jump to latest" or sending resumes it.
  const scroller = React.useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = React.useState(true);
  const pinnedRef = React.useRef(true);
  const pin = (value: boolean) => { pinnedRef.current = value; setPinned(value); };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== pinnedRef.current) pin(atBottom);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  React.useLayoutEffect(() => { if (pinnedRef.current) toBottom(); }, [messages, status]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    pin(true);
    void sendMessage({ text });
  };

  return <>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[13px] leading-relaxed" aria-label="Messages">
        {messages.length === 0 && (
          <div className="mt-6 space-y-2 text-xs text-muted-foreground">
            <p>Ask me to work on this project. Try:</p>
            {['add a 10k resistor between +3V3 and SDA', 'what is connected to R1?', 'remove R7', 'run ERC'].map((s) => (
              <Button key={s} type="button" variant="outline" size="xs" className="mr-1 font-normal" onClick={() => setDraft(s)}>{s}</Button>
            ))}
          </div>
        )}
        {messages.map((m) => <Message key={m.id} message={m} at={{ scope, project, file }} />)}
        {status === 'submitted' && <p className="flex items-center text-xs text-muted-foreground"><Loader2 size={13} className="mr-1.5 animate-spin" />Thinking…</p>}
      </div>
      {!pinned && (
        <Button type="button" variant="outline" size="xs" className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-md" onClick={() => { pin(true); toBottom(); }}>
          <ArrowDown />{busy ? 'Jump to latest (streaming)' : 'Jump to latest'}
        </Button>
      )}
    </div>
    {approval && <UpdatePcbApproval key={approval.id} changes={approval.changes} answer={approval.answer} />}
    <form className="shrink-0 border-t border-border p-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {models.length > 1 && model && (
        <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Model</span>
          <Select value={model} onValueChange={onModel} disabled={busy}>
            <SelectTrigger aria-label="Model" className="h-6 w-auto gap-1 px-2 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[70]">
              {models.map((m) => <SelectItem key={m} value={m} className="text-xs">{modelLabel(m)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } e.stopPropagation(); }}
          onKeyUp={(e) => e.stopPropagation()}
          placeholder="Ask about this project…"
          className="max-h-40 min-h-[2.75rem] resize-none text-[13px]"
        />
        {busy
          ? <Tip content="Stop"><Button type="button" aria-label="Stop" size="icon" variant="outline" onClick={() => void stop()}><Square /></Button></Tip>
          : <Tip content="Send"><Button type="submit" aria-label="Send" size="icon" disabled={!draft.trim()}><Send /></Button></Tip>}
      </div>
    </form>
  </>;
}

/** Apply turns on this long after a card appears: a click aimed at what was there before misses it. */
const APPROVAL_ARM_MS = 500;

/**
 * The changes an Update PCB would make that the person must approve (step 5b): every line,
 * what can break a layout first, with counts (ai-chat 0006 S5). KiCad lists removals last,
 * so cutting the list off would hide exactly those.
 */
function UpdatePcbApproval({ changes, answer }: { changes: string[]; answer: (ok: boolean) => void }) {
  const { lines, counts } = approvalOrder(changes);
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => setArmed(true), APPROVAL_ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section aria-label="Confirm Update PCB" className="mx-2 mb-2 shrink-0 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
      <p className="font-medium">Update PCB would make {lines.length === 1 ? 'this change' : `these ${lines.length} changes`} to the board:</p>
      <p className="mt-0.5 text-muted-foreground">{counts.map((c) => `${c.count} ${c.kind}`).join(', ')}</p>
      <ul aria-label="Changes" className="my-1.5 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5">
        {lines.map((c, i) => <li key={i}>{c}</li>)}
      </ul>
      <p className="mb-2 text-muted-foreground">Undo reverts the whole update in one step.</p>
      <div className="flex gap-2">
        <Button type="button" size="xs" disabled={!armed} onClick={() => answer(true)}>Apply</Button>
        <Button type="button" size="xs" variant="outline" onClick={() => answer(false)}>Cancel</Button>
      </div>
    </section>
  );
}

type Part = UIMessage['parts'][number];
type ToolPart = { type: string; toolName?: string; state: string; input?: unknown; output?: unknown; errorText?: string };

function Message({ message, at }: { message: UIMessage; at: PanelAt }) {
  if (message.role === 'user') {
    const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    return <div className="ml-8 whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2">{text}</div>;
  }
  const model = (message.metadata as { model?: string } | undefined)?.model;
  return <div className="space-y-1.5">
    {message.parts.map((p, i) => <AssistantPart key={i} part={p} at={at} />)}
    {model && <Badge size="sm">{modelLabel(model)}</Badge>}
  </div>;
}

function AssistantPart({ part, at }: { part: Part; at: PanelAt }) {
  if (part.type === 'text') return <Markdown text={(part as { text: string }).text} />;
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) return <ToolCall part={part as unknown as ToolPart} at={at} />;
  return null;
}

const TOOL_LABELS: Record<string, string> = {
  list_parts: 'Reading the parts', list_nets: 'Reading the connections', place_part: 'Placing parts',
  connect: 'Connecting pins', remove_part: 'Removing parts', set_field: 'Changing a field', move_part: 'Moving parts',
  run_check: 'Running the check', search_lib_items: 'Searching the libraries', get_lib_item: 'Reading a library part',
  list_files: 'Listing files', read_file: 'Reading the file', board_shot: 'Taking a board shot',
  schematic_shot: 'Taking a schematic shot', tool_search: 'Looking for a tool', load_skill: 'Reading a skill',
  update_pcb: 'Updating the board from the schematic', wire: 'Drawing a wire',
};

/** The label while a tool runs: a placement by click waits for the person. */
function toolLabel(name: string, input: unknown, running: boolean): string {
  if (name === 'place_part' && running && (input as { click?: boolean } | undefined)?.click) return 'Click where it goes (Esc cancels)';
  return TOOL_LABELS[name] ?? name;
}

function ToolCall({ part, at }: { part: ToolPart; at: PanelAt }) {
  const [open, setOpen] = React.useState(false);
  const name = part.toolName ?? part.type.replace(/^tool-/, '');
  const done = part.state === 'output-available';
  const elsewhere = otherFile(part.input, at);
  const failed = part.state === 'output-error' || (done && (part.output as { isError?: boolean })?.isError === true);
  const images = done ? ((part.output as { content?: Array<{ type: string; data?: string; mimeType?: string }> })?.content ?? []).filter((c) => c.type === 'image' && c.data) : [];
  return (
    <div className="overflow-hidden rounded-md border border-border text-xs">
      <Button type="button" variant="ghost" size="row" className="items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {failed ? <AlertTriangle size={12} className="text-warning" /> : done ? <Check size={12} className="text-success" /> : <Loader2 size={12} className="animate-spin" />}
        <Wrench size={11} />
        <span className="flex-1 truncate">{toolLabel(name, part.input, !done && part.state !== 'output-error')}</span>
        <Code className="px-1 py-0 text-[10px]">{name}</Code>
      </Button>
      {elsewhere && (
        <div className="flex items-center gap-1.5 border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
          <span className="flex-1 truncate">On {elsewhere}</span>
          <Button asChild variant="outline" size="xs"><a href={fileHref(at, elsewhere, window.location.search)}>Open it</a></Button>
        </div>
      )}
      {images.map((img, i) => <img key={i} alt={`${name} result`} className="block w-full border-t border-border" src={`data:${img.mimeType};base64,${img.data}`} />)}
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-border bg-muted p-2 text-[10px] leading-snug">
          {JSON.stringify({ input: part.input, output: summarizeOutput(part.output), error: part.errorText }, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Tool output for the details view, without base64 image payloads. */
function summarizeOutput(output: unknown): unknown {
  const content = (output as { content?: Array<{ type: string; text?: string; data?: string }> })?.content;
  if (!content) return output;
  return content.map((c) => (c.type === 'text' ? (c.text ?? '').slice(0, 4000) : { type: c.type, bytes: c.data?.length }));
}

/** Just enough Markdown for the replies: paragraphs, bullets, **bold**, `code`. */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((t, i) =>
    t.startsWith('**') ? <strong key={i}>{t.slice(2, -2)}</strong>
      : t.startsWith('`') ? <Code key={i}>{t.slice(1, -1)}</Code>
        : t);
  const blocks = text.split(/\n{2,}/);
  return <div className="space-y-2">{blocks.map((b, i) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return <ul key={i} className="list-disc space-y-0.5 pl-5">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*-\s+/, ''))}</li>)}</ul>;
    }
    return <p key={i} className="whitespace-pre-wrap">{inline(b)}</p>;
  })}</div>;
}
