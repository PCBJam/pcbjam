import * as React from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from 'agents/chat/react';
import type { UIMessage } from 'ai';
import { Sparkles, X, Plus, Trash2, History, Square, Send, Wrench, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { Button, Tip } from '@pcbjam/ui';
import { AI_CHAT_URL } from '@/lib/config';

/**
 * In-editor AI chat (POC). The chat runs server-side, one Durable Object per
 * chat; this panel only renders it. It talks to the chat service over a
 * WebSocket with the session cookie, so the person's identity never passes
 * through here. Edits the agent makes arrive through the document room like
 * any collaborator's.
 */

interface ChatRow { id: string; title: string; updatedAt: number; file: string }

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

export function AiChatPanel({ scope, project, file }: { scope: string; project: string; file: string }) {
  const [open, setOpen] = React.useState(false);
  const [chats, setChats] = React.useState<ChatRow[]>([]);
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [initial, setInitial] = React.useState<UIMessage[] | null>(null);
  const [showList, setShowList] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
      const { chat } = await api<{ chat: ChatRow }>('/chats', { method: 'POST', body: JSON.stringify({ scope, project, file }) });
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

  // First open: resume the latest chat on this project, or start one.
  React.useEffect(() => {
    if (!open || chatId) return;
    void refresh().then((list) => (list[0] ? openChat(list[0].id) : newChat())).catch((e) => setError((e as Error).message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = chats.find((c) => c.id === chatId)?.title ?? 'New chat';

  if (!open) {
    return (
      <div className="absolute bottom-4 right-4 z-[54]">
        <Tip content="AI chat">
          <Button type="button" aria-label="Open AI chat" onClick={() => setOpen(true)} size="icon" className="rounded-full shadow-lg">
            <Sparkles size={18} />
          </Button>
        </Tip>
      </div>
    );
  }

  return (
    <aside aria-label="AI chat" data-overlay-obstacle className="absolute inset-y-0 right-0 z-[56] flex flex-col border-l border-black/10 bg-white text-neutral-900 shadow-2xl dark:border-white/15 dark:bg-neutral-950 dark:text-white" style={{ width: 'min(400px, 92vw)' }}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-black/10 px-3 dark:border-white/10">
        <Sparkles size={17} className="shrink-0 text-violet-500" />
        <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold" title={title}>{title}</h2>
        <Tip content="Chats"><Button type="button" aria-label="Chats" variant="plain" size="icon-xs" className="p-2 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { setShowList((s) => !s); void refresh(); }}><History size={16} /></Button></Tip>
        <Tip content="New chat"><Button type="button" aria-label="New chat" variant="plain" size="icon-xs" className="p-2 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void newChat()}><Plus size={16} /></Button></Tip>
        <Tip content="Close"><Button type="button" aria-label="Close AI chat" variant="plain" size="icon-xs" className="p-2 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setOpen(false)}><X size={16} /></Button></Tip>
      </header>

      {showList && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-black/10 py-1 text-xs dark:border-white/10" aria-label="Chat list">
          {chats.length === 0 && <p className="px-4 py-2 text-neutral-500">No chats on this project yet.</p>}
          {chats.map((c) => (
            <div key={c.id} className={`group flex items-center gap-2 px-3 py-1.5 ${c.id === chatId ? 'bg-violet-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
              <Button type="button" variant="plain" className="min-w-0 flex-1 justify-start truncate px-1 text-left text-xs font-normal" onClick={() => void openChat(c.id)}>
                {c.title}
              </Button>
              <span className="shrink-0 text-[10px] text-neutral-400">{new Date(c.updatedAt).toLocaleDateString()}</span>
              <Tip content="Delete chat"><Button type="button" aria-label={`Delete ${c.title}`} variant="plain" size="icon-xs" className="p-1 opacity-60 hover:opacity-100" onClick={() => void remove(c.id)}><Trash2 size={13} /></Button></Tip>
            </div>
          ))}
        </div>
      )}

      {error && <p role="alert" className="m-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>}

      {chatId && initial
        ? <ChatView key={chatId} chatId={chatId} initial={initial} file={file} onTurnEnd={() => void refresh().catch(() => {})} />
        : <div className="flex flex-1 items-center justify-center text-xs text-neutral-500"><Loader2 size={16} className="mr-2 animate-spin" />Loading chat…</div>}
    </aside>
  );
}

function ChatView({ chatId, initial, file, onTurnEnd }: { chatId: string; initial: UIMessage[]; file: string; onTurnEnd: () => void }) {
  const host = new URL(AI_CHAT_URL!).host;
  const agent = useAgent({ agent: 'chat-session', name: chatId, host, protocol: AI_CHAT_URL!.startsWith('https') ? 'wss' : 'ws' } as never);
  const fileRef = React.useRef(file);
  fileRef.current = file;
  const { messages, sendMessage, status, stop } = useAgentChat({
    agent: agent as never,
    getInitialMessages: null,
    messages: initial,
    credentials: 'include',
    // The file open right now: the agent works on what the person looks at.
    body: () => ({ file: fileRef.current }),
    // A finished turn may have named the chat (its first message): re-read the list.
    onTurnEnd,
  });
  const [draft, setDraft] = React.useState('');
  const busy = status === 'submitted' || status === 'streaming';
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void sendMessage({ text });
  };

  return <>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[13px] leading-relaxed" aria-label="Messages">
      {messages.length === 0 && (
        <div className="mt-6 space-y-2 text-xs text-neutral-500">
          <p>Ask me to work on this project. Try:</p>
          {['add a 10k resistor between +3V3 and SDA', 'remove R7', 'run ERC and explain the errors', 'show me the board'].map((s) => (
            <Button key={s} type="button" variant="outline" size="xs" className="mr-1 font-normal" onClick={() => setDraft(s)}>{s}</Button>
          ))}
        </div>
      )}
      {messages.map((m) => <Message key={m.id} message={m} />)}
      {status === 'submitted' && <p className="flex items-center text-xs text-neutral-500"><Loader2 size={13} className="mr-1.5 animate-spin" />Thinking…</p>}
      <div ref={end} />
    </div>
    <form className="shrink-0 border-t border-black/10 p-2 dark:border-white/10" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="flex items-end gap-2 rounded-md border border-black/15 bg-white px-2 py-1.5 focus-within:border-violet-500 dark:border-white/15 dark:bg-neutral-900">
        <textarea
          aria-label="Message"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } e.stopPropagation(); }}
          onKeyUp={(e) => e.stopPropagation()}
          placeholder="Ask about this project…"
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
        />
        {busy
          ? <Tip content="Stop"><Button type="button" aria-label="Stop" size="icon-xs" variant="outline" onClick={() => void stop()}><Square size={13} /></Button></Tip>
          : <Tip content="Send"><Button type="submit" aria-label="Send" size="icon-xs" disabled={!draft.trim()}><Send size={13} /></Button></Tip>}
      </div>
    </form>
  </>;
}

type Part = UIMessage['parts'][number];
type ToolPart = { type: string; toolName?: string; state: string; input?: unknown; output?: unknown; errorText?: string };

function Message({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    return <div className="ml-8 whitespace-pre-wrap rounded-lg bg-violet-500/10 px-3 py-2">{text}</div>;
  }
  return <div className="space-y-1.5">{message.parts.map((p, i) => <AssistantPart key={i} part={p} />)}</div>;
}

function AssistantPart({ part }: { part: Part }) {
  if (part.type === 'text') return <Markdown text={(part as { text: string }).text} />;
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) return <ToolCall part={part as unknown as ToolPart} />;
  return null;
}

const TOOL_LABELS: Record<string, string> = {
  list_files: 'Listing files', read_file: 'Reading the file', get_document: 'Reading the document',
  list_libs: 'Looking up libraries', add_part_to_project: 'Getting the part ready', apply_edits: 'Editing the document',
  run_kicad_tool: 'Running the check', board_shot: 'Taking a board shot', schematic_shot: 'Taking a schematic shot',
};

function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = React.useState(false);
  const name = part.toolName ?? part.type.replace(/^tool-/, '');
  const done = part.state === 'output-available';
  const failed = part.state === 'output-error' || (done && (part.output as { isError?: boolean })?.isError === true);
  const images = done ? ((part.output as { content?: Array<{ type: string; data?: string; mimeType?: string }> })?.content ?? []).filter((c) => c.type === 'image' && c.data) : [];
  return (
    <div className="rounded border border-black/10 text-xs dark:border-white/10">
      <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-neutral-600 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/5" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {failed ? <AlertTriangle size={12} className="text-amber-500" /> : done ? <Check size={12} className="text-emerald-500" /> : <Loader2 size={12} className="animate-spin" />}
        <Wrench size={11} className="opacity-50" />
        <span className="flex-1 truncate">{TOOL_LABELS[name] ?? name}</span>
        <code className="text-[10px] opacity-50">{name}</code>
      </button>
      {images.map((img, i) => <img key={i} alt={`${name} result`} className="block w-full border-t border-black/10 dark:border-white/10" src={`data:${img.mimeType};base64,${img.data}`} />)}
      {open && (
        <pre className="max-h-48 overflow-auto border-t border-black/10 bg-black/[0.03] p-2 text-[10px] leading-snug dark:border-white/10 dark:bg-white/[0.03]">
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
      : t.startsWith('`') ? <code key={i} className="rounded bg-black/5 px-1 text-[12px] dark:bg-white/10">{t.slice(1, -1)}</code>
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
